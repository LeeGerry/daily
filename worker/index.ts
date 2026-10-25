/**
 * daily.gaiya.cc 的 Worker:平时只把请求交给静态资源;定时任务负责按时发 X。
 *
 * 发帖队列由 media_self 在审核定稿时写进 KV:
 *   queue:YYYY-MM-DD  →  { posts: [{ id, due, text, image }] }   due 是 UTC 时间
 *   done:YYYY-MM-DD:<id> → 已发出的推文 id(防止重复发)
 * 每 15 分钟跑一次,把到点、还没发、没超过 6 小时的帖子发出去。错过太久的不补发,只通知。
 * 卡片图直接从本站的静态资源里读。
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
}

type Post = { id: string; due: string; text: string; image?: string };

const LATE_MS = 6 * 3600 * 1000;

export default {
  fetch: (req: Request, env: Env) => env.ASSETS.fetch(req),
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

/** OAuth 1.0a 签名。JSON 和 multipart 的请求体不参与签名,只签 oauth_* 参数 */
export async function oauth(env: Env, method: string, url: string): Promise<string> {
  const q = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const p: Record<string, string> = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const params = Object.keys(p).sort().map((k) => `${q(k)}=${q(p[k])}`).join('&');
  const base = [method, q(url), q(params)].join('&');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`${q(env.X_API_SECRET)}&${q(env.X_ACCESS_SECRET)}`),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  p.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return 'OAuth ' + Object.keys(p).map((k) => `${q(k)}="${q(p[k])}"`).join(', ');
}

async function notify(env: Env, text: string) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text, disable_web_page_preview: false }),
  }).catch(() => {});
}
