# @we/wechat · 微信小游戏入口

微信小游戏的入口、UDP Transport 和 Gate 0 UDP PoC。用 Vite lib 模式打包成单个 IIFE `game.js`，不依赖 DOM、Node built-ins 或远程 JS。

## 命令

```bash
pnpm build:wechat       # 在仓库根目录运行，输出 dist/wechat
pnpm build:wechat-poc   # Gate 0 PoC，输出 dist/wechat-poc
```

在本目录下对应 `pnpm build`（`vite build`）和 `pnpm build:poc`（`vite build --mode poc`）。

构建完成后，在微信开发者工具中导入输出目录，并把 `project.config.json` 里的 `appid` 换成自己的测试 AppID。

## 结构

```text
vite.config.ts            构建配置：入口按 mode 切换，target es2017，单文件 game.js
public/game.json          小游戏配置，原样复制到输出目录
public/project.config.json
src/main.ts               正式入口：createGameInstance + 微信平台 + UDP Transport + 狼人杀、失落的城市
src/udp-transport.ts      createWechatUdpTransport：微信 UDP socket 实现的 Transport
src/poc/udp-ping.ts       Gate 0：两台真机互填地址收发 ping/pong，统计成功率、RTT 和错误
```

## UDP Transport 要点

- 每台设备只有一个活动 socket，优先绑定发现端口 20000，失败时绑定随机端口。
- 来源端点取自 `remoteInfo`，不信任消息里自报的地址。
- 发送时按 `byteOffset` / `length` 截出独立的 buffer，避免把整个底层 ArrayBuffer 发出去。
- 房间发现时，广播同时发往子网广播地址和 `255.255.255.255`。`setBroadcast` 需要基础库 2.24.0+。

## 约束

- 入口不传 `debug`，Inspector、Debug Port、`setFixture` 都不能进入微信构建。`vite build` 默认 `NODE_ENV=production`，`import.meta.env.DEV` 为 `false`。
- 新增微信 API 前，先核对真实小游戏文档和 `minigame-api-typings`。
- 类型检查使用 `tsconfig.json`（lib 只有 ES2022，加上 `minigame-api-typings`），由根目录 `pnpm typecheck` 执行。
