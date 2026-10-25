import rss from '@astrojs/rss';
import { path, fmtDate, type Locale } from '../i18n';
import { issues, md } from './issues';

/** 每期一条。正文放完整的 5 条,订阅的人在阅读器里就能读完 */
export const feed = (lang: Locale, site: URL) =>
  rss({
    title: lang === 'zh' ? 'Gaiya Daily 中文版' : 'Gaiya Daily',
    description:
      lang === 'zh'
        ? '每天 5 条 AI 新闻,写给自己做产品的人。'
        : 'Five AI stories a day for people who make their own products.',
    site,
    items: issues.slice(0, 30).map((i) => {
      const e = i[lang];
      return {
        title: `${fmtDate(i.date, lang)}: ${e.items[0]?.headline ?? ''}`,
        description: e.intro,
        pubDate: new Date(i.publishAt),
        link: path(lang, `/${i.date}/`),
        content: e.items
          .map((it) => `<h2>${it.headline}</h2>${md(it.body)}${it.note ? `<blockquote>${it.note}</blockquote>` : ''}`)
          .join(''),
      };
    }),
    customData: `<language>${lang === 'zh' ? 'zh-CN' : 'en-us'}</language>`,
  });
