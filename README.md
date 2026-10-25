# Gaiya Daily

`daily.gaiya.cc` — 每天 5 条 AI 新闻,写给自己做产品的人。中英文两版,英文在根路径,中文在 `/zh`。

内容由 `../media_self` 流水线产出:选题 → 起草 → 质检 → Telegram 审核 → 定稿后写进
`src/data/issues/YYYY-MM-DD.json`,卡片图进 `public/cards/YYYY-MM-DD/`,自动 commit 并 push。

## 上线时间

每期 JSON 里有 `publishAt`(第二天美西早上 4 点,UTC 表示)。构建时只收已到时间的期数,
GitHub Actions 每天 UTC 11:05 和 12:05 各构建一次(覆盖夏令时和冬令时),所以前一晚推进来的
新一期会在早上自动出现,Mac 关机也没关系。push 到 main 也会触发一次构建。

## 本地

```bash
npm install
npm run dev                          # http://localhost:4321
SHOW_SCHEDULED=1 npm run dev         # 连还没到上线时间的期数一起看
npm run deploy                       # 手动构建并部署(用本机 wrangler 登录)
```

## 结构

```
src/
├── data/issues/       每期一个 JSON(流水线写入,必须提交)
├── lib/issues.ts      读取、按上线时间过滤、编期号
├── lib/feed.ts        RSS(英文 /rss.xml,中文 /zh/rss.xml)
├── views/             Issue · Deep · Archive · About,中英文共用
├── pages/             路由;zh/ 下是同一套视图
├── layouts/Base.astro SEO、hreflang、主题
└── styles/global.css  设计 token,和 teardown、gaiya.cc 同一套
```

## 部署

和 gaiya.cc 一样是 Worker 静态资源 + 自定义域(`wrangler.jsonc`),部署时 wrangler 自动建好
daily.gaiya.cc 的 DNS。GitHub Actions 需要两个 secret:`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

## 自动发 X

`worker/index.ts` 是这个站的 Worker 脚本,网页请求直接走静态资源,脚本只跑定时任务:每 15 分钟
读 KV 里的发帖队列(`queue:YYYY-MM-DD`,由 media_self 定稿时写入),把到点的帖子连同卡片图发到
@gaiya_l,发完在 Telegram 通知。超过 6 小时没发出去的不补发,只通知。

密钥都在 Worker secrets 里:`X_API_KEY` `X_API_SECRET` `X_ACCESS_TOKEN` `X_ACCESS_SECRET`
`TG_TOKEN` `TG_CHAT`。看日志:`npx wrangler tail`。

取消某天还没发的帖子:`npx wrangler kv key delete queue:YYYY-MM-DD --binding SOCIAL --remote`
