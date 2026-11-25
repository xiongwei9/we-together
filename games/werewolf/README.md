# @we/werewolf · 狼人杀

6 人预女局 / 9 人预女猎局的狼人杀，包括纯规则插件、客户端表现插件和模拟器 Bot。**规则以 [werewolf-6-9-rules.md](werewolf-6-9-rules.md) 为准。**

依赖：`@we/framework`、`@we/multiplayer`、`@we/game-app`（规则层 `src/rules/` 只依赖 `@we/multiplayer`）。

## 入口

| 入口 | 内容 |
| --- | --- |
| `@we/werewolf` | `werewolfGame: GamePluginDefinition`，由 `apps/web` 和 `apps/wechat` 静态注册 |
| `@we/werewolf/rules` | 纯规则，不依赖 UI、网络或平台：`werewolfRules`、`projectView`、`chooseBotAction`、`ROLE_DECKS`，以及 `Role` / `WerewolfAction` / `WerewolfConfig` / `WerewolfPlayerView` / `WerewolfState` 类型 |

## 结构

```text
werewolf-6-9-rules.md      规则文档（权威）
src/index.ts               werewolfGame：rules + presentation + bot
src/rules/types.ts         State / Action / Event / PlayerView 类型
src/rules/config.ts        板子、默认配置、开房可调规则（ruleOptions / setRuleOption）
src/rules/engine.ts        规则状态机：validate / reduce
src/rules/plugin.ts        GamePlugin 实现：parseCommand、计时器、播报、发身份
src/rules/view.ts          projectView：按白名单生成玩家视图
src/rules/bot.ts           简单 Bot，只读取本玩家视图
src/scenes/presentation.ts Canvas 表现插件
tests/rules.test.ts        规则单元测试
```

## 规则概要

- 屠边、暗牌。夜间按狼人 → 女巫 → 预言家的顺序行动，最后统一结算；狼刀最高票并列时重投一次。
- 白天按座位轮流发言 → 放逐投票 → 平票时 PK 一次；首夜死者和被放逐者有遗言；猎人被狼刀或放逐时可以开枪，被毒杀时不能。
- 可选警长模式：首日竞选，放逐投票时警长计 1.5 票。
- 开房可调规则：板子、警长、女巫自救、狼刀决策、狼人自爆、发言时长。开局后锁定。
- 角色已出局时，其夜间阶段照常播报，并按 Host 私有种子随机停留一段时间，避免玩家通过界面或时长推断神职是否存活。

## 修改规则时

1. 先更新 `werewolf-6-9-rules.md`。
2. 修改 `src/rules/`，保持 `reduce` 是纯函数、`projectView` 是显式白名单。
3. 同步补充 `tests/rules.test.ts`；涉及联机流程时补充根目录 `tests/match.e2e.test.ts`。
