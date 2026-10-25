/**
 * 每期一个 JSON:src/data/issues/YYYY-MM-DD.json,由 media_self 流水线在审核定稿后写入。
 * 定稿时间在前一天傍晚,上线时间是 publishAt(美西早上 4 点)。构建时只收已到时间的期数,
 * 所以提前推进仓库也不会提前上线。
 */
import { marked } from 'marked';
import type { Locale } from '../i18n';

export type Source = { title: string; url: string; site: string };
export type Item = {
  n: number;
  headline: string;
  takeaway: string;
  body: string;
  note: string | null;
  category: string;
  card: string;
  sources: Source[];
};
export type Edition = {
  intro: string;
  items: Item[];
  deep: { n: number; headline: string; body: string } | null;
};
export type Issue = {
  date: string;
  publishAt: string;
  number: number;
  en: Edition;
  zh: Edition;
  lab: { title: string; url: string; feed: string }[];
};

const files = import.meta.glob<{ default: Omit<Issue, 'number'> }>('../data/issues/*.json', { eager: true });

// 本地预览想看还没到时间的期数:SHOW_SCHEDULED=1 npm run dev
const showAll = import.meta.env.SHOW_SCHEDULED === '1' || process.env.SHOW_SCHEDULED === '1';
const now = Date.now();

/** 已上线的期数,最新在前。期号按日期顺序从 1 开始数 */
export const issues: Issue[] = Object.values(files)
  .map((m) => m.default)
  .filter((i) => showAll || Date.parse(i.publishAt) <= now)
  .sort((a, b) => a.date.localeCompare(b.date))
  .map((i, k) => ({ ...i, number: k + 1 }))
  .reverse();

export const md = (s: string): string => marked.parse(s, { async: false }) as string;

export const edition = (i: Issue, lang: Locale): Edition => i[lang];
