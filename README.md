# we-together · 本地多人小游戏框架（狼人杀原型）

按 [local-multiplayer-game-design-v0.2.md](local-multiplayer-game-design-v0.2.md) 实现的 P0 原型：
微信小游戏 LAN UDP + PC Web 单页面多实例模拟器，共享同一套规则、协议与 Canvas UI，无业务服务器。

## 快速开始

```bash
pnpm install
pnpm dev:web          # PC 模拟器 http://localhost:5173
pnpm test             # Vitest：规则、投影、可靠传输、房间/命令语义、六实例 UI E2E
pnpm typecheck        # 核心(无 DOM) / 测试 / Web / 微信 四套 tsconfig
pnpm build:web        # dist/web
pnpm build:wechat     # dist/wechat（game.js + game.json + project.config.json）
pnpm build:wechat-poc # dist/wechat-poc：Gate 0 UDP ping/pong PoC
```

## PC Web 模拟器

打开页面会自动创建 6 个实例（每个实例独立 Canvas、Runtime、Client、会话、Storage 与 Memory Transport endpoint，不用 iframe / Tab / WebSocket）。

1. **一键开房+加入**：实例 1 通过正常 Client API 创建房间，其余实例用正常 JOIN 加入（地址形如 `mem:sim-1/p1`，手动输入时也可简写为 `p1`）。
2. **全员准备** → **开始**。也可以直接在各 Canvas 里点按钮操作。
3. **Bot 一步 / 自动 Bot**：每个实例依据自己的授权视图提交命令，走完整协议链路。
4. 每个 Tile 的工具条：断网/恢复、切后台（模拟 onHide）、重启（保留 Storage 中的恢复凭证，新 endpoint generation）、静音、放大。
5. 右侧 Inspector：Room/Phase、Host 完整状态（测试专用）、单实例的 PlayerSnapshot 与命令状态、节点断网与单方向链路故障；下方 Packet Inspector 可按实例/类型/结果筛选。
6. 「下一局固定角色」是 Debug Port，仅模拟器开启；微信入口不传 `debug`。

## 微信小游戏

1. `pnpm build:wechat`，在微信开发者工具中导入 `dist/wechat`，把 `project.config.json` 的 `appid` 换成自己的测试 AppID。
2. 房主点「创建房间」后显示 `IP:端口` 与 6 位邀请码；其他玩家在「加入房间」手动输入。
3. **Gate 0 先行**：`pnpm build:wechat-poc` 导入 `dist/wechat-poc`，两台真机互填地址发送 100 次 ping，记录成功率、RTT P50/P95、错误；可切换 1200 字节数据报（G10）。按设计 §14.1 填写 G01–G11 记录。

## 结构

```text
apps/web/                 Vite + React PC 工作台（simulator/controller.ts 为实例管理器）
apps/wechat/              微信入口 main.ts、UDP Transport、Gate 0 PoC
packages/platform/        Platform ports；web/ 与 wechat/ 适配（核心不引用 DOM / wx 类型）
packages/framework/       Canvas 2D 节点树、flex 布局、渲染、命中测试、Scene、Toast
packages/multiplayer/     协议与 schema、可靠消息/分片、DeviceNet、Host Authority、Player Client、规则契约
packages/game-app/        可重入 createGameInstance + 公共场景（首页/加入/大厅/暂停/关闭）
packages/werewolf/        rules/（纯规则、投影、Bot）与 scenes/（表现插件）
packages/testing/         VirtualNetwork、Memory Transport、手动时钟、seeded RNG、无头设备夹具
tests/                    跨包集成测试（VirtualNetwork 完整对局、命令语义、六实例 UI E2E）
```

## 与设计的对应与偏差

- 设计允许初期合并 `game-contract` 与 `multiplayer`：规则契约位于 `packages/multiplayer/src/contract.ts`。狼人杀放在 `packages/werewolf`（而非 `packages/games/werewolf`）。
- 新增 `packages/game-app` 承载 Web 与微信共用的 `createGameInstance`；游戏模块由入口静态注册（`games: [werewolfGame]`），因此 game-app 不依赖具体游戏。
- 未引入 Zod：消息 schema 为手写校验（`protocol.ts`），避免微信包体积；整个微信 `game.js` 约 80 KB。
- 协议在设计表格基础上补充了 `RESUME_REJECT` 与 `SESSION_REJECT`（会话失效/旧 epoch）。
- `night-resolve` / `day-resolve` 为瞬时结算阶段，不停留。已死亡角色的夜间阶段按 `deadRolePhaseMs` 固定时长运行，不提前跳过。
- 微信没有内置 TTS：公共播报默认只在屏幕上展示，`createWechatPlatform({ audioClips })` 可按文本映射预录音频。Web 使用 `speechSynthesis`，默认只有 Host 实例出声。
- Host 切后台后暂停计时，回到前台仍保持暂停，需要房主点「继续游戏」（设计 §9.3）。玩家断线自动暂停，全部重连后自动恢复。

## 已验证 / 未验证

已验证（本地）：`pnpm typecheck`、`pnpm test`（32 项）、三套构建；在 Chrome 中跑通模拟器的开房、加入、准备、开始、翻牌、Bot 对局、断网暂停与恢复。

**未验证**：任何微信真机或开发者工具中的运行（Gate 0 是阻断项）、UDP 绑定/广播/热点、`wx.showKeyboard` 输入、真机字体与 DPR。P1 项（二维码加入、认证加密、Bot 脚本回放）未实现。明文 UDP 仅适用于可信隔离 Wi-Fi 内测。
