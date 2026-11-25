# @we/web · PC Web 模拟器

Vite + React 的单页面多实例工作台：在一个页面里同时运行 N 个独立的游戏实例，用于开发、调试和演示，不需要真机。

## 命令

```bash
pnpm dev:web      # 在仓库根目录运行，http://localhost:5173
pnpm build:web    # 输出到 dist/web
```

在本目录下也可以直接用 `pnpm dev` / `pnpm build` / `pnpm preview`。

## 结构

```text
index.html
vite.config.ts              Vite 配置（React 插件，输出 ../../dist/web）
src/main.tsx                挂载 React
src/simulator/App.tsx       工作台 UI：工具栏、实例 Tile、Inspector、Packet Inspector
src/simulator/controller.ts 实例管理器 createSimulationController
src/simulator/styles.css
```

## 工作方式

- 每个实例都通过 `createGameInstance`（[@we/game-app](../../packages/game-app)）创建，各自拥有独立的 Canvas、Runtime、Client、会话、Storage 和 Memory Transport endpoint。
- 实例之间用 [@we/testing](../../packages/testing) 的 `VirtualNetwork` 通信，可以切换网络预设、让节点断网、制造单方向链路故障。
- 一键开房、全员准备、Bot 一步 / 自动 Bot 这些批量操作，只调用实例的正常玩家 API（`instance.actions`），走完整的命令与状态同步链路。
- Inspector 里的 Host 完整状态和「下一局固定角色」只在模拟器里打开（`debug: true`）。微信入口不传这个选项。

## 约束

- 不能用 iframe、多 Tab 或直接共享 Host Store 来代替真实的命令与状态同步链路（见 [AGENTS.md](../../AGENTS.md)）。
- 平台相关代码（DOM、`requestAnimationFrame`、`speechSynthesis`）只能放在本应用和 `@we/platform/web` 里。
