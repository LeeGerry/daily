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
 * POST /api/x-queue:media_self 定稿时把当天的 X 帖子写进上面的队列(带 INTERNAL_TOKEN)。
 *
 * 流水线跑在 GitHub Actions 上(本仓库的 .github/workflows/pipeline.yml),这里负责叫醒它:
 * - 每天 PIPELINE_HOUR 点(PIPELINE_TZ 时区)启动一次流水线。PIPELINE_HOUR 留空就不启动。
 * - POST /api/telegram 是审稿机器人的 webhook。消息先存进 Inbox,机器人不在线就启动一个,
 *   它用 /api/review/pull 和 /api/review/ack 来取消息(带 INTERNAL_TOKEN)。
 */

import { DurableObject } from 'cloudflare:workers';

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
  INBOX: DurableObjectNamespace<Inbox>;
  TG_WEBHOOK_SECRET: string;
  GH_TOKEN: string;
  GH_REPO: string;
  GH_REF: string;
  PIPELINE_HOUR: string;
  PIPELINE_TZ: string;
}

type Post = { id: string; due: string; text: string; image?: string };

const LATE_MS = 6 * 3600 * 1000;
// 机器人每 2 秒来取一次消息,超过这么久没来就算下线了
const ONLINE_MS = 15 * 1000;
// 启动一个机器人要半分钟到一分钟,这段时间里再来消息不重复启动
const STARTING_MS = 3 * 60 * 1000;

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/subscribe') return subscribe(req, env, ctx);
    if (url.pathname === '/api/x-search') return xSearch(req, env);
    if (url.pathname === '/api/x-queue') return xQueue(req, env);
    if (url.pathname === '/api/telegram') return telegram(req, env, ctx);
    if (url.pathname === '/api/review/pull' || url.pathname === '/api/review/ack') return review(req, env, url.pathname);
    return env.ASSETS.fetch(req);
  },
  scheduled: (_e: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(Promise.all([run(env), pipeline(env)])),
};

/**
 * 审稿收件箱。Telegram 的消息先存在这里,等审稿机器人来取。
 * Durable Object 单线程、强一致,存进去马上取得到;KV 在不同机房之间要等上一分钟才同步。
 */
export class Inbox extends DurableObject {
  /** 存一条消息,返回机器人现在在不在线、要不要启动一个 */
  async push(update: { update_id: number }): Promise<{ online: boolean; start: boolean }> {
    const s = this.ctx.storage;
    await s.put(key(update.update_id), update);
    const now = Date.now();
    const online = now - ((await s.get<number>('polled')) ?? 0) < ONLINE_MS;
    const start = !online && now - ((await s.get<number>('started')) ?? 0) > STARTING_MS;
    if (start) await s.put('started', now);
    return { online, start };
  }

  /** 机器人来取消息。closing 表示它准备下线,这之后来的消息会再启动一个新的 */
  async pull(closing: boolean): Promise<unknown[]> {
    await this.ctx.storage.put('polled', closing ? 0 : Date.now());
    return [...(await this.ctx.storage.list({ prefix: 'u:' })).values()];
  }

  async ack(ids: number[]): Promise<void> {
    if (ids.length) await this.ctx.storage.delete(ids.map(key));
  }

  /** 同一个 name 只有第一次返回 true,用来保证每天只启动一次流水线 */
  async claim(name: string): Promise<boolean> {
    if (await this.ctx.storage.get(name)) return false;
    await this.ctx.storage.put(name, Date.now());
    return true;
  }

  async release(name: string): Promise<void> {
    await this.ctx.storage.delete(name);
  }
}

const key = (id: number) => `u:${String(id).padStart(12, '0')}`;
const inbox = (env: Env) => env.INBOX.get(env.INBOX.idFromName('review'));

/** 到点启动当天的流水线。Cron 每 15 分钟来一次,过了点还没启动的(比如上次失败了)会接着试 */
async function pipeline(env: Env) {
  if (!env.PIPELINE_HOUR) return;
  const now: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: env.PIPELINE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  if (Number(now.hour) < Number(env.PIPELINE_HOUR)) return;
  const name = `pipeline:${now.year}-${now.month}-${now.day}`;
  if (!(await inbox(env).claim(name))) return;
  try {
    await dispatch(env, 'pipeline');
  } catch (err) {
    await inbox(env).release(name);
    await notify(env, `❌ 今天的流水线没启动起来,15 分钟后再试:${String(err).slice(0, 300)}`);
  }
}

/** 启动 GitHub Actions 上的一次运行。GH_TOKEN 只需要本仓库的 Actions 写权限 */
async function dispatch(env: Env, task: 'pipeline' | 'review') {
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/pipeline.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'daily.gaiya.cc',
    },
    body: JSON.stringify({ ref: env.GH_REF, inputs: { task } }),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** Telegram 的 webhook。只收你自己的消息,陌生人发来的直接丢掉,也不会为它启动机器人 */
async function telegram(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (req.method !== 'POST' || !env.TG_WEBHOOK_SECRET || !(await same(secret, env.TG_WEBHOOK_SECRET))) {
    return new Response('Unauthorized', { status: 401 });
  }
  const u: any = await req.json();
  const chat = u.callback_query?.message?.chat?.id ?? u.message?.chat?.id;
  if (String(chat) !== String(env.TG_CHAT)) return new Response('ok');
  const { online, start } = await inbox(env).push(u);
  if (!online) {
    // 按钮要在十几秒内应答,机器人还没起来,先替它说一声
    if (u.callback_query) {
      ctx.waitUntil(tg(env, 'answerCallbackQuery', {
        callback_query_id: u.callback_query.id, text: '收到。审稿机器人正在启动,大约 1 分钟后生效',
      }));
    }
    if (start) {
      ctx.waitUntil(dispatch(env, 'review').catch((err) =>
        notify(env, `❌ 审稿机器人没启动起来,过 3 分钟再点一次试试:${String(err).slice(0, 300)}`)));
    }
  }
  return new Response('ok');
}

async function review(req: Request, env: Env, path: string): Promise<Response> {
  if (!(await internal(req, env))) return new Response('Unauthorized', { status: 401 });
  const body = await req.json<{ closing?: boolean; ids?: number[] }>();
  if (path.endsWith('/pull')) return Response.json({ updates: await inbox(env).pull(Boolean(body.closing)) });
  await inbox(env).ack(body.ids ?? []);
  return Response.json({ ok: true });
}

async function xQueue(req: Request, env: Env): Promise<Response> {
  if (!(await internal(req, env))) return new Response('Unauthorized', { status: 401 });
  const q = await req.json<{ date: string; posts: Post[] }>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date ?? '') || !Array.isArray(q.posts)) {
    return new Response('Bad queue', { status: 400 });
  }
  await env.SOCIAL.put(`queue:${q.date}`, JSON.stringify(q));
  return Response.json({ ok: true, posts: q.posts.length });
}

/** media_self 调用的接口都带 Bearer INTERNAL_TOKEN */
async function internal(req: Request, env: Env): Promise<boolean> {
  if (req.method !== 'POST' || !env.INTERNAL_TOKEN) return false;
  return same(req.headers.get('Authorization') ?? '', `Bearer ${env.INTERNAL_TOKEN}`);
}

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
  if (!(await internal(req, env))) return new Response('Unauthorized', { status: 401 });
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

// 欢迎信走单封发送,Resend 只在群发里替换 {{{RESEND_UNSUBSCRIBE_URL}}},所以这里不放退订链接
const WELCOME = {
  en: {
    subject: "You're subscribed to Gaiya Daily",
    html: `<p>Thanks for subscribing.</p>
<p>Every morning around 7am Eastern you'll get five AI stories for people who make their own products: what changed, in plain words, and what you can do with it.</p>
<p>Today's issue is always at <a href="https://daily.gaiya.cc">daily.gaiya.cc</a>. If this wasn't you, reply and we'll remove the address. Every daily email also has a one-click unsubscribe. Questions or corrections: just reply.</p>
<p>Gaiya Lab</p>`,
  },
  zh: {
    subject: '订阅 Gaiya Daily 成功',
    html: `<p>谢谢订阅。</p>
<p>每天早上(北京时间晚上 7 点左右)会收到 5 条写给自己做产品的人的 AI 新闻:变了什么,用大白话讲清楚,再说今天能做点什么。</p>
<p>当天这期随时可以在 <a href="https://daily.gaiya.cc/zh/">daily.gaiya.cc/zh</a> 看。如果不是你本人订的,回信告诉我们,会把邮箱删掉。每天的日报邮件底部也都能一键退订。有问题或发现错误,直接回信就行。</p>
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
  if (!env.TG_CHAT) return;
  await tg(env, 'sendMessage', { chat_id: env.TG_CHAT, text, disable_web_page_preview: false });
}

async function tg(env: Env, method: string, body: unknown) {
  if (!env.TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}
