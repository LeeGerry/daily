/**
 * 构建前的小检查。目前只守一条规则,但这条被踩过两次:
 *
 *   根元素(html)的 background-color 必须是字面量,不能用 var()。
 *   Chrome 在根元素上不会因自定义属性变化重新求值,
 *   写成 var(--ground) 会导致切换主题后画布背景卡在旧色
 *   —— 内容区已经变暗,橡皮筋拉出来的那块还是亮的。
 *
 * 同时校验字面量和 :root 里的 --ground 没有写岔。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles/global.css'),
  'utf8'
);
const fail = (msg) => { console.error(`✗ CSS 检查未通过:${msg}`); process.exit(1); };

const grab = (re, what) => {
  const m = css.match(re);
  if (!m) fail(`找不到${what}`);
  return m[1].toLowerCase();
};

const htmlBlock = css.match(/^html \{[\s\S]*?\}/m);
if (!htmlBlock) fail('找不到 html 规则块');
if (/background-color:\s*var\(/.test(htmlBlock[0])) {
  fail('html 的 background-color 用了 var()。见 global.css 里那段注释 —— 必须写字面量。');
}

const pairs = [
  ['浅色', grab(/:root\s*\{[\s\S]*?--ground:\s*(#[0-9a-f]{6})/i, ':root 的 --ground'),
           grab(/^html \{[\s\S]*?background-color:\s*(#[0-9a-f]{6})/im, 'html 的浅色背景')],
  ['暗色', grab(/:root\[data-theme='dark'\]\s*\{[\s\S]*?--ground:\s*(#[0-9a-f]{6})/i, "[data-theme='dark'] 的 --ground"),
           grab(/html\[data-theme='dark'\]\s*\{\s*background-color:\s*(#[0-9a-f]{6})/i, 'html 暗色背景')],
];

for (const [name, token, literal] of pairs) {
  if (token !== literal) fail(`${name}下 token(${token}) 与 html 字面量(${literal}) 不一致`);
}

console.log('✓ CSS 检查通过:根元素背景为字面量,且与 token 一致');
