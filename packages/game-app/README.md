# @we/game-app · 可重入游戏实例与公共场景

把平台、Transport、联机核心和游戏插件组装成一个完整的游戏实例（设计 §13.3），并提供首页、加入、大厅、规则、暂停、关闭等公共场景。微信入口创建一个实例，Web 模拟器在同一页面创建 N 个。

依赖：`@we/platform`、`@we/framework`、`@we/multiplayer`。不依赖具体游戏，游戏由入口静态注册。

## 用法

```ts
import { createGameInstance } from '@we/game-app';

const instance = createGameInstance({
  instanceId: 'wechat',
  platform,                 // @we/platform 的 Platform 实现
  transport,                // @we/multiplayer 的 Transport 实现
  games: [werewolfGame],    // GamePluginDefinition 列表
  // 可选：address、gameConfig、debug（仅模拟器）、defaultNickname、seatHint
});
await instance.start();
```

`GameInstance` 提供：

- `actions`：和 UI 按钮相同的玩家操作，包括 `createRoom`、`searchRooms`、`joinDiscovered`、`joinRoom`（手动地址兜底）、`resumeSaved`、`setReady`、`setRule`、`startMatch`、`sendGameAction`、`leaveRoom`、`roomCommand`。模拟器的批量操作也只能通过这里。
- `getStatus()` / `subscribe()`：实例状态（endpoint、是否房主、发现的房间、Client 状态等）。
- `setVisible()` / `setMuted()` / `dispose()`。
- `debug`：只有传入 `debug: true` 时才有值，否则为 `null`。

## 游戏插件契约

游戏模块导出 `GamePluginDefinition`：

```ts
interface GamePluginDefinition {
  rules: AnyGamePlugin;            // Host 侧规则（见 @we/multiplayer 的 GamePlugin）
  presentation: GamePresentation;  // Client 侧表现：render(ctx: GameSceneContext) => UINode
  bot?: (view, rng) => action | null;  // 仅模拟器使用
}
```

`GameSceneContext` 只包含本玩家的授权视图（`view`）、房间信息、命令状态、剩余时间，以及 `send` / `retry` / `setLocal` / `keepTicking` 等回调。

## 文件

```text
src/contract.ts    GamePluginDefinition / GamePresentation / GameSceneContext
src/instance.ts    createGameInstance
src/scenes.ts      公共场景（首页 / 加入 / 手动加入 / 大厅 / 规则 / 关闭 / 游戏外壳与暂停弹窗）
src/nicknames.ts   随机昵称池
```

实例级 UI 测试在仓库根目录的 `tests/instance.e2e.test.ts`。
