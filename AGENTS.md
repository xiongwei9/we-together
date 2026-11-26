# AGENTS.md

## 工作方式

- 默认只修改文件并执行必要检查。暂存（`git add`）、提交（含 `--amend`）以及创建或更新 diff，均须用户对本次改动明确授权。此前的授权不延续到后续改动。
- 每个里程碑先完成能运行的最小垂直切片。需要提交时遵循上面的授权规则。
- 引入服务器、数据库、抖音支持、外部账号体系、远程代码加载或重型渲染引擎前，单独确认项目范围。

## 改动前查阅

- 架构与开发约束见 [项目设计 §17.1](docs/local-multiplayer-game-design-v0.2.md#171-coding-agent-开发约束)。
- 狼人杀玩法以 [6／9 人规则](games/werewolf/werewolf-6-9-rules.md) 为准，失落的城市以 [经典双人规则](games/lost-cities/lost-cities-game-rules.md) 为准。当前实现与设计的差异见 [README](README.md#与设计的对应与偏差)。

## 架构与模拟器

- 默认使用纯 TypeScript，优先函数式工厂、显式依赖注入和纯 reducer，避免不必要的面向对象框架。只导出其他文件实际使用的符号。
- Core 与 Game Rules 不得依赖 `wx`、DOM、React 或 Node.js API。平台相关逻辑仅放在 `packages/platform/src/web`、`packages/platform/src/wechat` 和 `apps/*`。共享核心由仅配置 `ES2022` 库的 `tsconfig.core.json` 检查。
- Runtime、Client、Store、Input、Storage 和 Transport 必须支持显式创建多个实例，禁止依赖模块级可变单例、全局 Canvas 或固定玩家 ID。
- Web Simulator 在同一页面挂载多个实例。所有实例和批量操作都走正常的 Client 命令与状态同步链路，禁止使用 iframe、多 Tab 或直接共享 Host Store 来替代该链路。
- 联网模式的 `apps/server` 只做中继转发，不运行游戏规则、不解析或记录数据内容；权威状态仍由房主设备的 Host 持有。服务器不引用 `@we/*` 运行时包。
- 原型与安全模式分离。`debug`、Inspector、`setFixture` 等测试专用入口不得进入微信构建。

## 协议与状态边界

- 所有网络 payload 均视为不可信。使用 `packages/multiplayer/src/protocol.ts` 或插件的 `parseCommand` 做 schema 校验，并检查会话身份（`from`、`sessionEpoch`、来源地址）与规则权限。
- 普通 Client 只能收到 `PlayerView`。`project()` 按白名单显式映射字段，禁止展开完整 `State`。Host 的完整 `State` 不得进入公共 Store、网络广播或生产日志。
- 重试同一命令时保留原 `commandId`。只有 Host 的 `COMMAND_RESULT` 或权威快照可以确认业务成功。

## 验证

- 新增规则、协议或 Transport 行为时同步补充测试。新增微信平台 API 前，核对微信小游戏官方文档和 `minigame-api-typings`。
- `pnpm test` 运行测试，`pnpm typecheck` 检查共享核心、测试、Web 和微信入口。
- `pnpm dev:simulator` 启动 Web Simulator，`pnpm dev:web` 启动 Web 客户端（仅联网，需同时运行 `pnpm dev:server` 中继服务器）。`pnpm build:web`、`pnpm build:simulator`、`pnpm build:wechat` 和 `pnpm build:server` 分别构建 Web 客户端、模拟器、微信版本和服务器。
