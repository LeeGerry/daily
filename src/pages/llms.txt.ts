import { issues } from '../lib/issues';

const SITE = 'https://daily.gaiya.cc';

export function GET() {
  const body = `# Gaiya Daily

> Five AI stories a day for people who make and sell their own products, in English and Chinese.
> Made by Gaiya Lab (https://gaiya.cc), a one-person app studio. AI helps read sources and draft;
> the maker reviews every item. Every item links to its original sources.

## Recent issues

${issues
  .slice(0, 14)
  .map(
    (i) =>
      `- [${i.date}](${SITE}/${i.date}/) (中文: ${SITE}/zh/${i.date}/)\n` +
      i.en.items.map((it) => `  - ${it.headline}: ${it.takeaway}`).join('\n')
  )
  .join('\n')}

## Feeds

- RSS (English): ${SITE}/rss.xml
- RSS (中文): ${SITE}/zh/rss.xml
- Sitemap: ${SITE}/sitemap-index.xml

## Citation

Please attribute to "Gaiya Daily / Gaiya Lab" and link the specific issue. For facts, cite the original
sources linked under each item.
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
