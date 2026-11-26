# @we/game-app · 可重入游戏实例与公共场景

把平台、Transport、联机核心和游戏插件组装成一个完整的游戏实例（设计 §13.3），并提供首页、加入、大厅、规则、暂停、关闭等公共场景。微信入口创建一个实例，Web 模拟器在同一页面创建 N 个。

依赖：`@we/platform`、`@we/framework`、`@we/multiplayer`。不依赖具体游戏，游戏由入口静态注册。

## 用法

```ts
import { createGameInstance } from '@we/game-app';

const instance = createGameInstance({
  instanceId: 'wechat',
  platform,                 // @we/platform 的 Platform 实现
  network: 'lan',           // 联机方式：'lan'（默认）或 'online'，由入口决定
  transport,                // 与 network 对应的 Transport：局域网 UDP / 内存网络，或 createRelayTransport
  games: [werewolfGame, lostCitiesGame],  // GamePluginDefinition 列表
  // 可选：app（首页主题）、address、gameConfigs（按 gameId 覆盖配置）、debug（仅模拟器）、defaultNickname、seatHint
});
await instance.start();
```

联机方式由入口通过 `network` 决定，app 内不可切换：微信入口用 `'lan'`（广播发现房间、「加入房间」列表）；Web 无法使用局域网，用 `'online'`（`createRelayTransport`）。联网时启动不连接服务器，第一次「创建房间」或加入时才连接（连不上会提示，可重试）；房主的中继编号即 6 位房间号（大厅显示），其他玩家点「输入房间号加入」。

页面层级：注册多个游戏时，启动进入 **app 首页**（`app.title` / `app.tagline` 主题 + 游戏列表，以及未结束房间的恢复入口）；点选游戏进入该游戏的**游戏首页**（昵称、创建房间、加入房间，左上角「‹ 全部游戏」返回）。「创建房间」「加入房间」「手动输入地址」都针对当前游戏，加入页只列出当前游戏的房间。进入房间后按 `room.gameId` 选择表现插件。只注册一个游戏时没有 app 首页，直接进入游戏首页，房间发现也只搜索该游戏。

`GameInstance` 提供：

- `actions`：和 UI 按钮相同的玩家操作，包括 `selectGame` / `openAppHome`（app 首页与游戏首页之间切换）、`createRoom`、`searchRooms`、`joinDiscovered`、`joinRoom`（手动地址兜底）、`resumeSaved`、`setReady`、`setRule`、`startMatch`、`sendGameAction`、`leaveRoom`、`roomCommand`。模拟器的批量操作也只能通过这里。
- `getStatus()` / `subscribe()`：实例状态（endpoint、是否房主、当前游戏 `gameId`（在 app 首页时为 `null`）、发现的房间、Client 状态等）。
- `setVisible()` / `setMuted()` / `dispose()`。
- `debug`：只有传入 `debug: true` 时才有值，否则为 `null`。

## 游戏插件契约

游戏模块导出 `GamePluginDefinition`：

```ts
interface GamePluginDefinition {
  rules: AnyGamePlugin;            // Host 侧规则（见 @we/multiplayer 的 GamePlugin）
  presentation: GamePresentation;  // Client 侧表现：render(ctx: GameSceneContext) => UINode
  icon?: string;                   // app 首页游戏列表与游戏首页显示的 emoji
  summary?: string;                // app 首页游戏列表中的一句话介绍
  bot?: (view, rng) => action | null;  // 仅模拟器使用
}
```

`GameSceneContext` 只包含本玩家的授权视图（`view`）、房间信息、命令状态、剩余时间，以及 `send` / `retry` / `setLocal` / `keepTicking` 等回调。

## 文件

```text
src/contract.ts    GamePluginDefinition / GamePresentation / GameSceneContext
src/instance.ts    createGameInstance
src/scenes.ts      公共场景（app 首页 / 游戏首页 / 加入 / 手动加入 / 大厅 / 规则 / 关闭 / 游戏外壳与暂停弹窗）
src/nicknames.ts   随机昵称池
```

实例级 UI 测试在仓库根目录的 `tests/instance.e2e.test.ts`。
