import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite 只提供静态资源与 HMR；游戏数据完全留在浏览器内
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: { port: 5173 },
});
