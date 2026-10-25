// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://daily.gaiya.cc',
  integrations: [sitemap()],
  build: { format: 'directory' },
});
