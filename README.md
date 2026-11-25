# we-together · 本地多人小游戏框架（狼人杀原型）

按 [docs/local-multiplayer-game-design-v0.2.md](docs/local-multiplayer-game-design-v0.2.md) 实现的 P0 原型：
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

1. **一键开房+加入**：实例 1 创建房间（工具栏「房间密码」可选），其余实例与真实玩家一样通过局域网广播发现房间并加入，无需输入地址。手动兜底地址形如 `mem:sim-1/p1`，也可简写为 `p1`。
2. **全员准备** → **开始**。也可以直接在各 Canvas 里点按钮操作。
3. **Bot 一步 / 自动 Bot**：每个实例依据自己的授权视图提交命令，走完整协议链路。
4. 每个 Tile 的工具条：断网/恢复、切后台（模拟 onHide）、重启（保留 Storage 中的恢复凭证，新 endpoint generation）、静音、放大。
5. 右侧 Inspector：Room/Phase、Host 完整状态（测试专用）、单实例的 PlayerSnapshot 与命令状态、节点断网与单方向链路故障；下方 Packet Inspector 可按实例/类型/结果筛选。
6. 「下一局固定角色」是 Debug Port，仅模拟器开启；微信入口不传 `debug`。

## 微信小游戏

1. `pnpm build:wechat`，在微信开发者工具中导入 `dist/wechat`，把 `project.config.json` 的 `appid` 换成自己的测试 AppID。
2. 房主点「创建房间」时可选设置房间密码（留空则不设）。其他玩家点「加入房间」即可看到同一 Wi-Fi 下的房间列表，点击加入；有密码的房间会提示输入密码。
   局域网广播被路由器隔离时，可点「手动输入地址」，填写房主大厅里显示的 `IP:端口`。
3. **Gate 0 先行**：`pnpm build:wechat-poc` 导入 `dist/wechat-poc`，两台真机互填地址发送 100 次 ping，记录成功率、RTT P50/P95、错误；可切换 1200 字节数据报（G10）。按设计 §14.1 填写 G01–G11 记录。

## 结构

```text
apps/web/                 Vite + React PC 工作台（simulator/controller.ts 为实例管理器）
apps/wechat/              微信入口 main.ts、UDP Transport、Gate 0 PoC（Vite lib 模式打包单文件 game.js）
packages/platform/        Platform ports；web/ 与 wechat/ 适配（核心不引用 DOM / wx 类型）
packages/framework/       Canvas 2D 节点树、flex 布局、渲染、命中测试、Scene、Toast
packages/multiplayer/     协议与 schema、可靠消息/分片、DeviceNet、Host Authority、Player Client、规则契约
packages/game-app/        可重入 createGameInstance + 公共场景（首页/加入/大厅/暂停/关闭）
packages/werewolf/        rules/（纯规则、投影、Bot）与 scenes/（表现插件）
packages/testing/         VirtualNetwork、Memory Transport、手动时钟、seeded RNG、无头设备夹具
tests/                    跨包集成测试（VirtualNetwork 完整对局、命令语义、六实例 UI E2E）
```

各子项目的说明见其目录下的 README.md。

## 与设计的对应与偏差

- 构建统一使用 Vite：Web 为常规应用构建，微信为 lib 模式 IIFE 单文件（设计中微信为 esbuild 单独构建）。
- 设计允许初期合并 `game-contract` 与 `multiplayer`：规则契约位于 `packages/multiplayer/src/contract.ts`。狼人杀放在 `packages/werewolf`（而非 `packages/games/werewolf`）。
- 新增 `packages/game-app` 承载 Web 与微信共用的 `createGameInstance`；游戏模块由入口静态注册（`games: [werewolfGame]`），因此 game-app 不依赖具体游戏。
- 未引入 Zod：消息 schema 为手写校验（`protocol.ts`），避免微信包体积；整个微信 `game.js` 约 110 KB。
- 协议在设计表格基础上补充了 `RESUME_REJECT` 与 `SESSION_REJECT`（会话失效/旧 epoch）。
- **加入房间不需要地址，房间密码可选**（替代设计中的「IP:端口 + 邀请码」）：Client 周期性向发现端口 20000 广播 `DISCOVER`，Host 单播回复 `ROOM_INFO`（房主昵称、人数、是否有密码、状态），回复地址取自数据报来源。设计中 F11 网络自动发现原为 P2，因此提前实现；手动输入地址保留为兜底。密码只做入房访问控制，不是加密密钥。
- 微信 UDP 优先绑定 20000 端口；广播同时发往子网广播地址与 `255.255.255.255`，`setBroadcast` 需要基础库 2.24.0+。
- **狼人杀规则以 [packages/werewolf/werewolf-6-9-rules.md](packages/werewolf/werewolf-6-9-rules.md) 为准**（取代设计 §11 的固定六人原型）：6 人预女局 / 9 人预女猎局、屠边、暗牌；夜间顺序狼人 → 女巫 → 预言家后统一结算；狼刀最高票并列重投一次；白天按座位轮流发言 → 放逐投票 → 平票一次 PK；首夜与放逐有遗言；猎人（狼刀 / 放逐可开枪、毒杀不可）；发言阶段可自爆；死亡技能结算后统一判胜负，同批次双方达成判平局；连续 3 个完整昼夜无人死亡判无结果结束。
- **开房时可自定义规则**：房主开房后先进入「房间规则」页（大厅中也可随时修改，开局后锁定）：板子（6 / 9 人，房间人数上限随之变化）、警长（首日竞选，警长放逐计 1.5 票、决定发言方向并最后发言、出局时移交或撕毁警徽）、女巫自救（不可 / 仅首夜 / 全程）、狼刀决策（最高票 / 全体一致）、狼人自爆（允许 / 禁止）、发言时长（60 / 90 / 120 秒 / 不计时；不计时时竞选发言、发言、PK 发言与遗言都不限时，由发言者结束或房主「跳过当前发言」——公共控制 `SKIP_SPEECH`）。规则修改后其他玩家需重新准备。由 GamePlugin 的 `playerCount(config)` / `ruleOptions` / `setRuleOption` 与房间命令 `set-rule` 实现。
- 计时采用规则文档 §13 的默认时限：白天阶段（发言、投票、遗言、警长相关）公开倒计时；夜间与猎人技能阶段使用 Host 隐藏计时（行动者本地显示时限）。角色已出局（或本批次无人可开枪）时，其阶段照常播报，随机停留 `deadRoleDelayMs`（默认 3–8 秒，由 Host 私有种子决定）后推进，避免通过界面或时长推断神职存活。同一阶段内的计时步骤（预言家结果展示、狼刀重投）通过 `timer().step` 切换，不改变 phaseId。
- 昵称：首次启动从内置昵称池随机分配并保存在本机，首页 / 加入页可「🎲 换一个」或手动修改。
- `JOIN_REQUEST` 可带期望座位 `seat`（空闲且不超过人数上限时使用，否则分配最小空位）；Web 模拟器用它让实例 pN 固定坐 N 号。缩小板子时，超出新上限的座位会移入空位。
- 微信没有内置 TTS：公共播报默认只在屏幕上展示，`createWechatPlatform({ audioClips })` 可按文本映射预录音频。Web 使用 `speechSynthesis`，默认只有 Host 实例出声。
- Host 切后台后暂停游戏，回到前台仍保持暂停，需要房主点「继续游戏」（设计 §9.3）。玩家断线自动暂停，全部重连后自动恢复。

## 已验证 / 未验证

已验证（本地）：`pnpm typecheck`、`pnpm test`（38 项）、三套构建；在 Chrome 中跑通模拟器的开房（含密码）、房间列表发现与加入、准备、开始、翻牌、Bot 对局、断网暂停与恢复。

**未验证**：任何微信真机或开发者工具中的运行（Gate 0 是阻断项）、UDP 绑定、**真机局域网广播发现**（iOS/Android、路由器 AP 隔离、热点）、`wx.showKeyboard` 输入、真机字体与 DPR。P1 项（二维码加入、认证加密、Bot 脚本回放）未实现。明文 UDP 仅适用于可信隔离 Wi-Fi 内测。
