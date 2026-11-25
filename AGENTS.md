# AGENTS.md

本项目的设计文档：`local-multiplayer-game-design-v0.2.md`。以下约束来自设计 §17.1，修改代码前请遵守。

- 默认纯 TypeScript，优先函数式工厂、显式依赖注入和纯 reducer，不引入不必要的面向对象框架。
- Core 与 Game Rules 不能 import `wx`、DOM、React、Node.js API；平台相关逻辑仅在 `packages/platform/src/{web,wechat}` 与 `apps/*`。`tsconfig.core.json`（lib 仅 ES2022）负责检查这一点。
- 所有来自网络的 payload 视为不可信，必须 schema 校验（`protocol.ts` / 插件 `parseCommand`）、会话认证（from + sessionEpoch + 来源地址）和规则权限检查。
- 普通 Client 永远只收到 PlayerView；`project()` 必须显式白名单映射字段，不 spread 完整 State。Host 的完整 State 不进入公共 Store、网络广播或生产日志。
- 任何命令重试必须保持 commandId；业务成功只能由 Host 的 COMMAND_RESULT 或权威快照确认。
- 每次增加规则、协议、Transport 行为时同步增加测试；新增平台 API 前核对真实小游戏文档与 `minigame-api-typings`。
- 不自行引入服务器、数据库、抖音支持、外部账号体系、远程代码加载或重型渲染引擎；新增范围需要单独决策。
- 原型与安全模式分离，测试-only 指令（`debug`、Inspector、`setFixture`）不能进入微信构建。
- Runtime、Client、Store、Input、Storage、Transport 必须支持显式创建多个实例，不能依赖模块级可变单例、全局 Canvas 或固定玩家 ID。
- Web Simulator 是单页面多实例容器，不允许用 iframe、多 Tab 或直接共享 Host Store 代替真实命令与状态同步链路；批量操作调用正常 Client 命令。
- 只 export 确实被其他文件使用的符号。
- 每个里程碑先提交能运行的最小垂直切片。

常用命令：`pnpm test`、`pnpm typecheck`、`pnpm dev:web`、`pnpm build:wechat`。
