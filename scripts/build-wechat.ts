import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 微信构建：esbuild 打包为单个 game.js，不依赖 DOM / Node built-ins / 远程 JS。
 * `--poc` 构建 Gate 0 UDP ping/pong PoC 到 dist/wechat-poc。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const poc = process.argv.includes('--poc');
const out = resolve(root, poc ? 'dist/wechat-poc' : 'dist/wechat');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(root, poc ? 'apps/wechat/src/poc/udp-ping.ts' : 'apps/wechat/src/main.ts')],
  outfile: resolve(out, 'game.js'),
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2017',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  // 调试工具不得进入微信构建
  define: { 'import.meta.env.DEV': 'false' },
});

for (const f of ['game.json', 'project.config.json']) copyFileSync(resolve(root, 'apps/wechat', f), resolve(out, f));
console.log(`WeChat build ready: ${out}`);
