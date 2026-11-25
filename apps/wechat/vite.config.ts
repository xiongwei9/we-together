import { defineConfig } from 'vite';

/**
 * 微信构建：打包为单个 IIFE game.js，不依赖 DOM / Node built-ins / 远程 JS。
 * `vite build` → dist/wechat；`vite build --mode poc` → dist/wechat-poc（Gate 0 UDP ping/pong PoC）。
 * game.json / project.config.json 放在 public/，原样复制到输出目录。
 * `vite build` 默认 NODE_ENV=production，`import.meta.env.DEV` 为 false，调试工具不会进入构建。
 */
export default defineConfig(({ mode }) => {
  const poc = mode === 'poc';
  return {
    build: {
      outDir: poc ? '../../dist/wechat-poc' : '../../dist/wechat',
      emptyOutDir: true,
      target: 'es2017',
      minify: 'esbuild',
      sourcemap: false,
      lib: {
        entry: poc ? 'src/poc/udp-ping.ts' : 'src/main.ts',
        formats: ['iife'],
        name: 'WeTogether',
        fileName: () => 'game.js',
      },
    },
    esbuild: { legalComments: 'none' },
  };
});
