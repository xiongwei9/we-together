import { defineConfig } from 'vite';

/**
 * Web 客户端（真实玩家使用，非模拟器）：单个 app 实例占满页面，只支持联网模式。
 * 中继地址默认与页面同源的 `/relay`：开发与 preview 时由 Vite 代理到本地中继服务器（`pnpm dev:server`），
 * 生产部署时由反向代理把 `/relay` 转发到 apps/server。
 */
const relayProxy = { '/relay': { target: 'http://localhost:8787', ws: true } };

export default defineConfig({
  build: { outDir: '../../dist/web', emptyOutDir: true, target: 'es2020' },
  server: { port: 5174, proxy: relayProxy },
  preview: { port: 4174, proxy: relayProxy },
});
