# @we/server · 联网中继服务器

联网模式的 WebSocket 中继，使用 Fastify + `@fastify/websocket` + TypeScript。**只转发数据包，不运行游戏规则**：房间、会话与权威游戏状态仍在房主设备上（Host Authority），局域网和联网共用同一套协议、可靠层与游戏插件。Web 客户端（[apps/web](../web)）只使用联网模式（浏览器无法使用局域网）；微信版只使用局域网，不连接本服务器。

不依赖任何 `@we/*` 运行时包；`@we/*` 只作为测试的 devDependencies。

## 命令

```bash
pnpm dev:server     # 在仓库根目录运行：tsx watch，默认 ws://localhost:8787/relay
pnpm build:server   # 编译到 apps/server/dist
pnpm --filter @we/server start   # node dist/main.js
```

环境变量：`PORT`（默认 8787）、`HOST`（默认 0.0.0.0）。

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /health` | `{ ok, online, reserved, forwarded, dropped }` |
| `GET /relay`（WebSocket） | 中继连接；重连时带 `?id=<原编号>&token=<令牌>` |

## 工作方式

- 每条连接分配一个 6 位编号，通过文本帧 `{"type":"welcome","id":"123456","token":"…"}` 告知客户端。**房主的编号就是联网房间号**，玩家输入房间号即可向房主发包。
- 二进制帧格式 `[1 字节编号长度][编号 ASCII][数据]`：客户端发出时写目标编号，服务器转发时改写为来源编号。数据内容不解析、不记录。
- 与 UDP 语义一致：目标不存在、离线、帧格式非法或超出限速时静默丢弃，由客户端可靠层重发。
- 断线后编号保留 60 秒，客户端凭令牌重连可找回原编号（房间号不变）；旧连接若仍挂着会被替换。
- 限制：单帧 4 KB（可靠层数据报 ≤ 1200 字节）、每连接 200 帧/秒（突发 400）、在线连接 5000。日志中的请求 URL 去掉查询串（含令牌）。

客户端实现见 `packages/multiplayer/src/relay-transport.ts`（线格式与本服务一致）。

## 结构

```text
src/hub.ts     中继核心：编号分配、转发、保留与找回、限速（不依赖 Fastify，可单测）
src/server.ts  buildServer：Fastify 路由 /health、/relay
src/main.ts    入口：读取 PORT / HOST 并监听
tests/         hub 单测；真实服务器 + 中继 Transport 完整对局；app 联网模式 Canvas UI 端到端
```

## 尚未覆盖

- TLS（生产需在反向代理上终止 wss）、来源校验、跨实例扩展（编号表在单进程内存中）。
- 房间号只有 6 位：知道房间号的人都能向房主发 JOIN，敏感场景请设置房间密码。
