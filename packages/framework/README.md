# @we/framework · 轻量 Canvas UI 框架

基于 Canvas 2D 的节点树、flex 布局、渲染和命中测试（设计 §6.2）。不实现 JSX、reconciler 或 Hooks，Web 和微信共用同一套 UI。

依赖：`@we/platform`（只用端口类型）。

## API

```ts
import { createUiApp, column, row, text, button, card, list, modal, pressable, spacer, stack, theme } from '@we/framework';

const ui = createUiApp(platform);
```

- `createUiApp(platform)`：创建 UI 应用，负责 Scene 切换、按需重绘、指针事件分发和 Toast。
- `Scene`：生命周期 `enter` / `render` / `exit`，退出时释放全部监听。
- 节点工厂：`row` / `column` / `stack` / `spacer` / `text` / `button` / `card` / `list` / `pressable` / `modal`，返回 `UINode`（`BoxNode | TextNode`）。
- `theme`：共享的颜色和字号。

## 实现要点

- 布局（`src/layout.ts`）：padding、gap、固定尺寸、flex、对齐、分布、叠放、安全区；文本测量带缓存，支持自动换行和 `maxLines` 省略。
- 渲染：使用逻辑坐标，按 DPR 缩放；只在需要时重绘，有倒计时或动画时才周期调度（场景里调用 `keepTicking()`）。
- 命中测试：按可见层级逆序查找，`modal` 的遮罩会拦截底层点击；按钮有按下态反馈。

## 文件

```text
src/ui.ts       节点类型、工厂函数、theme
src/layout.ts   测量与 flex 布局
src/app.ts      createUiApp：Scene、渲染循环、命中测试、Toast
```
