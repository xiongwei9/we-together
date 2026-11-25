# @we/lost-cities · 失落的城市

经典双人五色 60 张版的失落的城市，包括纯规则插件、客户端表现插件和模拟器 Bot。**规则以 [lost-cities-game-rules.md](lost-cities-game-rules.md) 为准。**

依赖：`@we/framework`、`@we/multiplayer`、`@we/game-app`（规则层 `src/rules/` 只依赖 `@we/multiplayer`）。

## 入口

| 入口 | 内容 |
| --- | --- |
| `@we/lost-cities` | `lostCitiesGame: GamePluginDefinition`，由 `apps/web` 和 `apps/wechat` 静态注册 |
| `@we/lost-cities/rules` | 纯规则，不依赖 UI、网络或平台：`lostCitiesRules`、`projectView`、`chooseBotAction`、`createDeck`、`scoreColumn`，以及 `Card` / `Color` / `LostCitiesAction` / `LostCitiesConfig` / `LostCitiesPlayerView` / `LostCitiesState` 类型 |

## 结构

```text
lost-cities-game-rules.md  规则文档（权威）
src/index.ts               lostCitiesGame：rules + presentation + bot
src/rules/types.ts         State / Action / Event / PlayerView 类型
src/rules/cards.ts         60 张牌、出牌合法性（canAppend）、单列计分（scoreColumn）
src/rules/config.ts        默认配置、开房可调规则（比赛轮数、回合时间）
src/rules/engine.ts        规则状态机：发牌、validate / reduce、轮次结算与先手
src/rules/plugin.ts        GamePlugin 实现：parseCommand、计时器、播报
src/rules/view.ts          projectView：按白名单生成玩家视图
src/rules/bot.ts           简单 Bot，只读取本玩家视图
src/scenes/presentation.ts Canvas 表现插件：对局、本轮结算、比赛结果
tests/rules.test.ts        规则单元测试（覆盖规则文档 §11 的 T01–T27）
```

联机与 Canvas UI 的端到端测试在仓库根目录的 `tests/lost-cities.e2e.test.ts`。

## 规则概要

- 2 人，每轮洗 60 张牌，各发 8 张，其余 44 张为抽牌堆。每回合先打出或弃掉一张，再从抽牌堆或任一弃牌堆顶抽一张；不能抽回本回合刚弃的牌。
- **弃牌暗置**（本产品约定，规则文档 §9.3）：弃牌堆只显示各色张数，不显示牌面；对手弃牌只知道颜色，从弃牌堆抽牌是按颜色盲抽堆顶。
- 探险列同色、数字严格递增；握手牌只能放在数字牌之前。单列得分 `(S − 20) × (W + 1)`，8 张及以上再加 20。
- 有人抽走抽牌堆最后一张时本轮立即结算，对手没有补偿回合。比赛按累计分决胜，同分为平局。
- 开房可调规则：比赛轮数（标准 3 轮 / 快速 1 轮）、回合时间（30 / 60 秒 / 不计时），开局后锁定。

## 线上约定的实现（规则文档 §9）

- 首轮先手由 Host 私有种子随机确定；后续轮由累计分较高者先手，相同则与上一轮交换。每轮的洗牌种子由 Host 私有种子派生，不进入任何玩家视图。
- 打牌与抽牌同属一个 `phaseId`，共享回合倒计时。超时时：尚未出牌则随机弃一张（由 Host 种子与回合号决定）再抽牌堆；已出牌则只抽牌堆。超时操作在公开记录中标记为「超时代操作」。
- 玩家视图只包含本人手牌、双方探险列、各色弃牌堆张数、抽牌堆数量与公开记录；不含对手手牌、抽牌堆牌面与顺序、任何弃牌牌面。公开记录中他人弃出的牌只有颜色，也不包含从任一牌堆抽到的牌。
- 主动认输：任一玩家可随时认输，对手直接获胜（界面上需两步确认）。
- 没有语音播报（`announce` 返回空），对局信息只在各自屏幕上显示。
- 规则文档未规定两轮之间的过渡：本实现在每轮结算后进入「本轮结算」页，双方都点「开始下一轮」或 20 秒后自动开始；不计时模式下等待双方确认。最后一轮结算后直接显示比赛结果。

## 与规则文档的偏差

- 弃牌暗置是对原版（堆顶公开）的产品改动，已写入规则文档 §9.1 / §9.3。

- **掉线时倒计时暂停**，不是规则文档 §9.1 的「倒计时继续」：这是框架的统一行为（任一玩家断线即暂停对局，全部重连后恢复）。
- 未实现 §9.2 中可选的比赛时长上限（文档默认不启用）。

## 修改规则时

1. 先更新 `lost-cities-game-rules.md`。
2. 修改 `src/rules/`，保持 `reduce` 是纯函数、`projectView` 是显式白名单。
3. 同步补充 `tests/rules.test.ts`；涉及联机流程时补充根目录 `tests/lost-cities.e2e.test.ts`。
