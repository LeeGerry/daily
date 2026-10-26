/**
 * 两个语言版本。英文是默认语言,走根路径;中文加 /zh 前缀。
 * 每期内容在同一个 JSON 里同时带 en 和 zh,所以两个版本永远一一对应。
 */
export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** 默认语言不加前缀,其余加 /<lang> */
export const path = (lang: Locale, rest = '/'): string =>
  lang === DEFAULT_LOCALE ? rest : `/${lang}${rest}`;

/** 当前页面在另一个语言下的地址 */
export const swap = (lang: Locale, rest = '/'): string => path(lang === 'en' ? 'zh' : 'en', rest);

export const LANG_LABEL: Record<Locale, string> = { en: 'EN', zh: '中文' };

/** 日期固定按 UTC 解析和显示,本机和 CI 时区不同也不会差一天 */
export const fmtDate = (iso: string, lang: Locale): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return lang === 'zh'
    ? `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`
    : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

export const STRINGS = {
  en: {
    siteDescription:
      'Five AI stories a day for people who make their own products. What changed, in plain words, and what you can do with it.',
    nav: { today: 'Today', archive: 'Archive', about: 'About' },
    skip: 'Skip to content',
    switchTheme: 'Switch theme',
    switchLang: '阅读中文版',
    issue: 'Issue',
    deepRead: 'Deep read',
    readDeep: 'Read the deep read',
    makerNote: "Maker's note",
    sources: 'Sources',
    fromLab: 'From the Lab',
    fromLabNote: 'What Gaiya Lab shipped or wrote this week.',
    backToIssue: 'Back to the issue',
    recent: 'Earlier issues',
    allIssues: 'All issues',
    empty: 'The first issue is on its way.',
    archive: { title: 'Archive', lede: 'Every issue, newest first.' },
    sub: {
      title: 'Get it by email',
      lede: 'The five stories land in your inbox at 7am Eastern. Free, no ads, unsubscribe in one click.',
      placeholder: 'you@example.com',
      button: 'Subscribe',
      sending: 'Subscribing…',
      done: "You're in. Check your inbox for a welcome note.",
      failed: "That didn't work. Check the address and try again.",
    },
  },
  zh: {
    siteDescription: '每天 5 条 AI 新闻,写给自己做产品的人。用大白话讲清变了什么,以及你能拿它做什么。',
    nav: { today: '今天', archive: '往期', about: '关于' },
    skip: '跳到正文',
    switchTheme: '切换主题',
    switchLang: 'Read in English',
    issue: '第',
    deepRead: '深读',
    readDeep: '读今天的深读',
    makerNote: '作者按',
    sources: '来源',
    fromLab: '工作室近况',
    fromLabNote: 'Gaiya Lab 这周发布或写下的东西。',
    backToIssue: '回到当期',
    recent: '往期',
    allIssues: '全部往期',
    empty: '第一期正在路上。',
    archive: { title: '往期', lede: '所有期数,最新的在前。' },
    sub: {
      title: '用邮件订阅',
      lede: '每天早上把这 5 条送到你的邮箱(北京时间晚上 7 点左右)。免费,没有广告,一键退订。',
      placeholder: '你的邮箱',
      button: '订阅',
      sending: '正在订阅…',
      done: '订好了。邮箱里有一封欢迎信。',
      failed: '没订上。检查一下邮箱地址再试一次。',
    },
  },
} as const;

export const t = (lang: Locale) => STRINGS[lang];
