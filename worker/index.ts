/**
 * daily.gaiya.cc 的 Worker:平时只把请求交给静态资源;定时任务负责按时发 X。
 *
 * 发帖队列由 media_self 在审核定稿时写进 KV:
 *   queue:YYYY-MM-DD  →  { posts: [{ id, due, text, image }] }   due 是 UTC 时间
 *   done:YYYY-MM-DD:<id> → 已发出的推文 id(防止重复发)
 * 每 15 分钟跑一次,把到点、还没发、没超过 6 小时的帖子发出去。错过太久的不补发,只通知。
 * 卡片图直接从本站的静态资源里读。
 *
 * POST /api/subscribe:网站上的订阅框。把邮箱写进 Resend 对应语言的名单(segment),发一封欢迎信。
 * 每天的邮件由 media_self 定稿时在 Resend 上排好,到 publishAt 自动发出,这里不管。
 *
 * POST /api/x-search:只给 media_self 用(带 INTERNAL_TOKEN),代它搜 X 上值得去回复的帖子。
 * X 的密钥只存在这里,不用再复制一份到本机。
 */

interface Env {
  ASSETS: Fetcher;
  SOCIAL: KVNamespace;
  X_API_KEY: string;
  X_API_SECRET: string;
  X_ACCESS_TOKEN: string;
  X_ACCESS_SECRET: string;
  TG_TOKEN: string;
  TG_CHAT: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  RESEND_SEGMENT_EN: string;
  RESEND_SEGMENT_ZH: string;
  INTERNAL_TOKEN: string;
}

type Post = { id: string; due: string; text: string; image?: string };

const LATE_MS = 6 * 3600 * 1000;

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/subscribe') return subscribe(req, env, ctx);
    if (url.pathname === '/api/x-search') return xSearch(req, env);
    return env.ASSETS.fetch(req);
  },
  scheduled: (_e: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(run(env)),
};

async function run(env: Env) {
  const now = Date.now();
  const { keys } = await env.SOCIAL.list({ prefix: 'queue:' });
  for (const { name } of keys) {
    const date = name.slice('queue:'.length);
    const queue = await env.SOCIAL.get<{ posts: Post[] }>(name, 'json');
    if (!queue) continue;
    let pending = 0;
    for (const p of queue.posts) {
      const doneKey = `done:${date}:${p.id}`;
      if (await env.SOCIAL.get(doneKey)) continue;
      const due = Date.parse(p.due);
      if (due > now) { pending++; continue; }
      if (now - due > LATE_MS) {
        await env.SOCIAL.put(doneKey, 'skipped');
        await notify(env, `⚠️ ${date} 的 ${p.id} 错过发帖时间超过 6 小时,没有补发。`);
        continue;
      }
      try {
        const tweet = await postToX(env, p);
        await env.SOCIAL.put(doneKey, tweet);
        await notify(env, `✅ 已发 X(${p.id}):https://x.com/gaiya_l/status/${tweet}`);
      } catch (err) {
        // 不标记为已发,15 分钟后自动重试,直到超过 6 小时
        await notify(env, `❌ ${date} 的 ${p.id} 发 X 失败,15 分钟后重试:${String(err).slice(0, 300)}`);
      }
    }
    // 整个队列处理完就删掉,list 保持很短
    if (pending === 0) await env.SOCIAL.delete(name);
  }
}

export async function postToX(env: Env, p: Post): Promise<string> {
  const body: Record<string, unknown> = { text: p.text };
  if (p.image) {
    const img = await env.ASSETS.fetch(new Request(`https://daily.gaiya.cc${p.image}`));
    if (!img.ok) throw new Error(`卡片图读不到:${p.image} ${img.status}`);
    const form = new FormData();
    form.append('media', new Blob([await img.arrayBuffer()], { type: 'image/png' }), 'card.png');
    form.append('media_category', 'tweet_image');
    form.append('media_type', 'image/png');
    const url = 'https://api.x.com/2/media/upload';
    const r = await fetch(url, { method: 'POST', headers: { Authorization: await oauth(env, 'POST', url) }, body: form });
    const j: any = await r.json();
    if (!r.ok || !j?.data?.id) throw new Error(`上传图片失败 ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    body.media = { media_ids: [j.data.id] };
  }
  const url = 'https://api.x.com/2/tweets';
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: await oauth(env, 'POST', url), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j: any = await r.json();
  if (!r.ok || !j?.data?.id) throw new Error(`发帖失败 ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data.id;
}

/** 按 X 的 recent search 搜帖子。每返回一条按读取计费(约 $0.005),所以条数由调用方控制 */
async function xSearch(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const auth = req.headers.get('Authorization') ?? '';
  if (!env.INTERNAL_TOKEN || !(await same(auth, `Bearer ${env.INTERNAL_TOKEN}`))) {
    return new Response('Unauthorized', { status: 401 });
  }
  const { query, max_results = 10 } = await req.json<{ query: string; max_results?: number }>();
  const params: Record<string, string> = {
    query,
    max_results: String(Math.min(Math.max(max_results, 10), 50)),
    sort_order: 'relevancy',
    'tweet.fields': 'public_metrics,created_at,author_id,lang',
  };
  const url = 'https://api.x.com/2/tweets/search/recent';
  const r = await fetch(`${url}?${new URLSearchParams(params)}`, { headers: { Authorization: await oauth(env, 'GET', url, params) } });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
}

/** 比较两个字符串,耗时和内容无关 */
async function same(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

/** OAuth 1.0a 签名。JSON 和 multipart 的请求体不参与签名;GET 的查询参数要一起签 */
export async function oauth(env: Env, method: string, url: string, query: Record<string, string> = {}): Promise<string> {
  const q = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const p: Record<string, string> = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const all: Record<string, string> = { ...query, ...p };
  const params = Object.keys(all).sort().map((k) => `${q(k)}=${q(all[k])}`).join('&');
  const base = [method, q(url), q(params)].join('&');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`${q(env.X_API_SECRET)}&${q(env.X_ACCESS_SECRET)}`),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  p.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return 'OAuth ' + Object.keys(p).map((k) => `${q(k)}="${q(p[k])}"`).join(', ');
}

const WELCOME = {
  en: {
    subject: "You're subscribed to Gaiya Daily",
    html: `<p>Thanks for subscribing.</p>
<p>Every morning around 7am Eastern you'll get five AI stories for people who make their own products: what changed, in plain words, and what you can do with it.</p>
<p>Today's issue is always at <a href="https://daily.gaiya.cc">daily.gaiya.cc</a>. If this wasn't you, ignore this email or <a href="{{{RESEND_UNSUBSCRIBE_URL}}}">unsubscribe</a>.</p>
<p>Gaiya Lab</p>`,
  },
  zh: {
    subject: '订阅 Gaiya Daily 成功',
    html: `<p>谢谢订阅。</p>
<p>每天早上(北京时间晚上 7 点左右)会收到 5 条写给自己做产品的人的 AI 新闻:变了什么,用大白话讲清楚,再说今天能做点什么。</p>
<p>当天这期随时可以在 <a href="https://daily.gaiya.cc/zh/">daily.gaiya.cc/zh</a> 看。如果不是你本人订的,忽略这封信或者<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">退订</a>。</p>
<p>Gaiya Lab</p>`,
  },
};

async function subscribe(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const wantsJson = (req.headers.get('Accept') ?? '').includes('application/json');
  const reply = (ok: boolean, status = ok ? 200 : 400) => wantsJson
    ? Response.json({ ok }, { status })
    : new Response(ok ? 'Subscribed. Check your inbox.' : 'Please check the email address and try again.', { status });

  let form: FormData;
  try { form = await req.formData(); } catch { return reply(false); }
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const lang = form.get('lang') === 'zh' ? 'zh' : 'en';
  // 机器人会把隐藏字段也填上:假装成功,什么都不做
  if (form.get('website')) return reply(true);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(false);
  if (!env.RESEND_API_KEY) return reply(false, 503);

  const segment = lang === 'zh' ? env.RESEND_SEGMENT_ZH : env.RESEND_SEGMENT_EN;
  try {
    const created = await resend(env, 'POST', '/contacts', { email, unsubscribed: false, segments: [{ id: segment }] });
    if (!created.ok) {
      // 已经是联系人(订过另一种语言,或者退订过又回来):重新打开订阅,再加进这个语言的名单
      await resend(env, 'PATCH', `/contacts/${encodeURIComponent(email)}`, { unsubscribed: false });
      const added = await resend(env, 'POST', `/contacts/${encodeURIComponent(email)}/segments/${segment}`);
      if (!added.ok) throw new Error(`Resend ${added.status}: ${(await added.text()).slice(0, 200)}`);
    }
  } catch (err) {
    ctx.waitUntil(notify(env, `❌ 订阅失败(${lang}):${String(err).slice(0, 300)}`));
    return reply(false, 502);
  }
  ctx.waitUntil((async () => {
    const w = WELCOME[lang];
    const sent = await resend(env, 'POST', '/emails', { from: env.RESEND_FROM, to: [email], subject: w.subject, html: w.html });
    await notify(env, `📬 新订阅(${lang === 'zh' ? '中文' : '英文'})${sent.ok ? '' : `,欢迎信没发出:${sent.status}`}`);
  })());
  return reply(true);
}

function resend(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`https://api.resend.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function notify(env: Env, text: string) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text, disable_web_page_preview: false }),
  }).catch(() => {});
}
