# 实施清单（Checklist）

对照 [local-multiplayer-game-design-v0.2.md](local-multiplayer-game-design-v0.2.md)。更新日期：2026-11-25。

- `[x]` 已完成并在本地验证
- `[~]` 部分完成，见备注
- `[ ]` 待办

---

## 一、已完成

### 工程与构建（M1）

- [x] pnpm workspace monorepo，TypeScript strict
- [x] 四套 tsconfig：核心（仅 ES2022，无 DOM / wx）、测试、Web、微信；`pnpm typecheck` 通过
- [x] `pnpm build:web` → `dist/web`（Vite + React）
- [x] `pnpm build:wechat` → `dist/wechat`（esbuild 单文件 `game.js` 约 78 KB，无 DOM / 模拟器代码）
- [x] `pnpm build:wechat-poc` → `dist/wechat-poc`（Gate 0 PoC）
- [x] README.md（运行方法、结构、与设计的偏差）、AGENTS.md（§17.1 约束）
- [x] 导出审计：只 export 被其他文件使用的符号

### 平台适配（§6.1）

- [x] Platform ports：Viewport / Clock / RandomSource / StoragePort / Canvas2D / Pointer / TextInput / Audio
- [x] Web 适配：每实例独立 Canvas、Pointer Events 按自身矩形映射逻辑坐标、DOM 文本输入 overlay、页面级单个 RAF 调度器、ResizeObserver、`speechSynthesis` 播报、`crypto.getRandomValues`
- [x] 微信适配：`wx.createCanvas`、触摸事件、`onShow/onHide`、`showKeyboard`、`setKeepScreenOn`、Storage、`getUserCryptoManager` 随机数（不可用时报错，不回退 Math.random）
- [x] 微信 UDP Transport：绑定端口（优先 20000，失败随机）、`getLocalIPAddress`、来源取自 `remoteInfo`、发送时按 byteOffset/length 截取独立 buffer

### 轻量 Canvas UI 框架（§6.2）

- [x] 节点树 + 工厂函数：row / column / text / button / card / list / modal / pressable / spacer / stack
- [x] 简单 flex 布局：padding / gap / 固定尺寸 / flex / 对齐 / 分布 / 叠放 / 安全区
- [x] 文本测量缓存、自动换行、maxLines 省略
- [x] 逻辑坐标 + DPR 渲染；按需重绘，倒计时期间才周期调度
- [x] 命中测试按层级逆序，弹窗拦截底层点击；按下态反馈
- [x] Scene 生命周期 enter / render / exit；Toast

### 多人房间、协议与可靠传输（§7–§9）

- [x] Endpoint 显式建模（udp / memory），地址编解码（`IP:端口` / `mem:<net>/<node>`）
- [x] Envelope + 手写 schema 校验（Host 与 Client 双向）
- [x] 纯 TS UTF-8 编解码
- [x] 可靠消息：ACK + 重发（300ms 起，指数退避至 2s，最多 5 次），失败回调；重复包回 ACK 不重复交付
- [x] 应用层分片：1200 字节数据报预算、32 KiB 消息上限、每 peer 8 个并发重组、5s 回收、总缓存上限、非法/越界分片丢弃
- [x] DeviceNet：同一 socket 区分 Host / Client 角色；Host 本机玩家走 loopback（仍编码解码）
- [x] 房间：创建、6 位邀请码、JOIN 幂等（requestId）、座位分配、准备、开始条件、游戏中拒绝新成员、房间满拒绝
- [x] 会话：playerId + 高熵凭证 + sessionEpoch；身份只从会话绑定解析（from + epoch + 来源地址）
- [x] 重连：RESUME 校验凭证、重新绑定地址、签发新 epoch、旧 epoch 消息拒绝
- [x] 心跳：2s 心跳，6s 可疑，10s 断线；断线自动暂停，全员恢复后自动继续
- [x] 命令语义：`(matchId, playerId, commandId)` 结果缓存；同 ID 同 payload 返回同一结果，不同 payload 拒绝；旧 phaseId 拒绝；Host 串行处理
- [x] 快照：按玩家投影的完整 PlayerSnapshot，版本单调，Client 忽略旧快照、暂存先到的新对局快照
- [x] Host 切后台：冻结计时，回前台需房主手动「继续游戏」
- [x] 房主关闭房间 → ROOM_CLOSED，客户端清除恢复凭证
- [x] 重开：返回房间，新 matchId，清空身份与命令缓存

### 规则契约与运行时（§10）

- [x] GamePlugin 契约：validateConfig / parseCommand / isPublicControl / createInitialState / validate / reduce / project / getResult / timer / timeoutCommand / announce
- [x] 公共控制（结束讨论）仅房主可发起，以 `system` 身份执行；`PHASE_TIMEOUT` 只由 Host 定时器产生
- [x] 静态注册：入口传入 `games: [werewolfGame]`，规则与表现插件分离

### 狼人杀（§11）

- [x] 固定六人板子 `werewolf-6-v1`：2 狼 / 预言家 / 女巫 / 2 平民
- [x] Fisher–Yates + 拒绝采样均匀洗牌，Host 私有种子
- [x] 狼人合议（意见一致才生效）、预言家查验、女巫解药/毒药（仅首夜自救、同夜一种）、夜间同时结算
- [x] 白天讨论（房主结束）、投票（禁止自投、可弃权、平票无人放逐）、胜负判定
- [x] 超时：未提交视为弃权/放弃；死亡角色阶段按固定时长运行，不提前跳过
- [x] 投影白名单：身份、狼队友与狼票、查验记录、狼刀目标（仅解药可用时）各自可见；终局公开身份
- [x] 公共播报只用公开信息
- [x] Bot：只读取本玩家视图，经正常命令链路提交（测试与模拟器用）

### 游戏界面（§12）

- [x] 首页 / 加入 / 大厅 / 查看身份 / 夜间 / 白天讨论 / 投票 / 暂停 / 结果 / 房间关闭
- [x] 身份卡可随时收起；切后台立即隐藏
- [x] 操作「提交中」、失败重试（保持同一 commandId）
- [x] 断线提示条：重新连接 / 离开

### PC Web 模拟器（§13）

- [x] 单页面动态创建 6 个独立实例（独立 Canvas、Runtime、Client、会话、Storage、endpoint），不用 iframe / Tab / WebSocket
- [x] `createGameInstance` 可重入工厂，Web 与微信共用
- [x] VirtualNetwork + Memory Transport：延迟 / 丢包 / 重复 / 乱序、节点断网、单方向链路故障、endpoint generation、队列上限、networkId 隔离
- [x] 一键开房+加入、全员准备、开始、Bot 一步 / 自动 Bot，全部走正常 Client API
- [x] Tile 工具条：断网/恢复、切后台、重启（保留凭证）、静音、放大（不重建 Runtime）
- [x] Inspector：Room/Phase、Host 完整状态（测试专用）、单实例视图与命令、网络面板
- [x] Packet Inspector：按实例 / 类型 / 结果筛选，隐藏 ACK，暂停，清空
- [x] Debug Port：下一局按座位固定角色（仅 debug）
- [x] 视口切换、列数切换、固定随机、快速计时

### 测试（§14.2）

- [x] 规则单元测试（发牌分布、各角色、结算、胜负、终局）
- [x] 投影安全测试（平民视图无他人身份 / 私密信息）
- [x] 可靠传输测试（分片、5% 与 20% 丢包、重发耗尽、ACK 丢失、非法分片、旧 generation）
- [x] 房间与命令语义集成测试（重复 JOIN、错误邀请码、满房、游戏中加入、幂等、伪造会话、非房主结束讨论、关闭房间）
- [x] 重连测试（断线暂停、恢复、重启后凭证恢复、新 epoch）
- [x] 完整对局：理想网络与 5% 丢包/重复/乱序（手动时钟 + 固定 seed）
- [x] 六实例 UI E2E：通过点击 Canvas 按钮开房、加入、准备、开始、翻牌；Storage 隔离；Host 切后台暂停；销毁后无残留定时器
- [x] Chrome 中人工/脚本验证模拟器完整流程，无控制台错误

### Gate 0 PoC 代码（§14.1）

- [x] 独立 UDP ping/pong PoC：互填地址、100 次 ping、成功率、RTT P50/P95、错误记录、1200 字节模式、设备信息

---

## 二、待办

### Gate 0：微信真机验证（阻断项）

- [ ] 微信开发者工具导入 `dist/wechat-poc` 与 `dist/wechat`，确认编译运行
- [ ] G01 Android ↔ Android，同一 Wi-Fi
- [ ] G02 iOS ↔ iOS，同一 Wi-Fi
- [ ] G03 iOS ↔ Android，互换 Host
- [ ] G04 IP 获取与手工输入
- [ ] G05 6 台设备各 100 次 ping/pong，记录成功率与 RTT P50/P95
- [ ] G06 断外网但 Wi-Fi 保持
- [ ] G07 手机热点
- [ ] G08 公共 Wi-Fi / AP 隔离 / 拒绝权限时的提示
- [ ] G09 Host / Client 切后台、锁屏、恢复时 socket 状态
- [ ] G10 1200 字节数据报、超长包与分片
- [ ] G11 扫码、广播、安全随机数
- [ ] 根据结果给出 Go / No-go，并修订可靠层参数（重发间隔、心跳阈值、分片预算）

### 微信端适配（M5）

- [ ] 真机验证 `wx.showKeyboard` 文本输入（昵称、地址、邀请码）
- [ ] 真机字体、DPR、安全区、不同屏幕尺寸下的布局
- [ ] 回到前台后 socket 失效时重新打开并恢复会话（目前只发心跳与同步请求）
- [ ] Host IP 变化时提示使用新连接信息
- [ ] 公共播报音频：录制并配置 `audioClips`（当前只有屏幕文字）
- [ ] 六台真机完成至少三局，包含一次普通客户端断线重连（DoD）

### 设计中尚未覆盖的 P0 细节

- [ ] 第二款游戏的接口验证：写一个小型测试插件（成功标准第 5 项），确认无需修改通信 / 房间 / 微信层
- [ ] 随机命令序列测试，验证不变量（角色总量固定、死亡不可逆、药品只消费一次、版本单调、终局不可操作）
- [ ] AssetManifest 与资源预加载重试
- [ ] 按 peer 限制包频率（目前只限制了重组缓存）
- [~] 对局结束清理凭证：关闭房间 / 离开时已清除，对局结束（返回大厅）时尚未清除
- [ ] 模拟器页面级 `visibilitychange` / `pagehide` 处理
- [ ] 可滚动列表（当前布局不支持超出屏幕的内容滚动）
- [ ] Inspector 中 Host 自身 loopback 会话的「最后活跃」显示会持续增长（仅显示问题）

### P1

- [ ] 局域网二维码加入（`lan-game:v1:<base64url JSON>` + `wx.scanCode`），保留手工输入
- [ ] 安全强化：成熟密码库、每 Client 独立会话密钥、认证加密、重放防护（需独立评审）
- [ ] 批量 Bot 脚本场景、导出与回放日志
- [ ] 模拟器中多房间并排、不同 viewport / DPR 组合
- [ ] 模拟器玩家数可配置与其他 Game Plugin 场景

### P2

- [ ] 网络自动发现、UDP 广播
- [ ] Host 持久化恢复与迁移

### 规则与产品待确认

- [ ] 六人板子规则细节、计时参数（夜间 30s / 讨论 120s / 投票 30s）由产品确认
- [ ] 正式发布前：平台类目、资质、隐私与安全评审
