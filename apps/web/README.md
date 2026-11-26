# @we/web · Web 客户端

真实玩家在浏览器里使用的 Web 版（不是模拟器）：一个页面只运行一个 app 实例，Canvas 占满屏幕，注册与微信入口相同的游戏。

浏览器无法使用局域网 UDP，因此 **只支持联网模式**：经 [apps/server](../server) 中继，房主创建房间后得到 6 位房间号，其他玩家点「输入房间号加入」。

## 命令

```bash
pnpm dev:server    # 另开一个终端：中继服务器 :8787
pnpm dev:web       # 在仓库根目录运行，http://localhost:5174
pnpm build:web     # 输出到 dist/web（静态文件）
```

在本目录下也可以直接用 `pnpm dev` / `pnpm build` / `pnpm preview`（preview 端口 4174）。

## 结构

```text
index.html       全屏页面：#app 容器、Canvas 与文本输入浮层；禁止缩放，viewport-fit=cover
vite.config.ts   构建输出 ../../dist/web；dev / preview 把 /relay 代理到 localhost:8787
src/main.ts      入口：createWebPlatform({ page: true }) + createRelayTransport + createGameInstance({ network: 'online' })
src/style.css    页面样式与文本输入浮层样式
```

## 行为

- **布局**：手机上占满屏幕；宽屏（PC）上居中显示为最宽 480px、最高 960px 的竖屏。逻辑尺寸跟随 Canvas 的显示尺寸（`createWebPlatform` 不传 `logicalSize`），安全区读取 CSS `env(safe-area-inset-*)`。
- **中继地址**：默认与页面同源的 `/relay`（https 页面使用 `wss`）。开发和 preview 时由 Vite 代理到本地服务器；生产部署时由反向代理把 `/relay`（WebSocket）转发到 `apps/server`。可在构建时用 `VITE_RELAY_URL` 指定其他地址。
- **存储**：昵称与断线恢复凭证保存在 `localStorage`（前缀 `we-together:`），刷新页面后可在 app 首页「恢复连接」回到原座位。同一浏览器的多个标签页共享这份存储，请每台设备只开一个标签页。
- **页面生命周期**：`page: true` 时，切到后台或锁屏会触发 `onVisibility`（与微信 onHide / onShow 相同的暂停与隐私处理）；房主对局中通过 Screen Wake Lock API 保持屏幕常亮（浏览器不支持时忽略）。
- 不传 `debug`：没有 Inspector、Host 完整状态与 Debug Port，也不依赖 `@we/testing`。

## 部署示例

把 `dist/web` 作为静态站点发布，并把 `/relay` 转发到中继服务器，例如 Nginx：

```nginx
location /relay {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```
