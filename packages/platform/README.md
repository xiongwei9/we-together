# @we/platform · 平台端口与适配

定义共享核心依赖的窄接口（设计 §6.1），并提供 Web 和微信两套实现。核心代码只依赖这里的接口，不引用 `HTMLCanvasElement`、`wx` 等平台类型。

## 入口

| 入口 | 内容 | 可在核心中使用 |
| --- | --- | --- |
| `@we/platform` | 端口类型：`Platform`、`Viewport`、`Clock`、`RandomSource`、`StoragePort`、`Canvas2D`、`CanvasPort`、`PointerInput`、`TextInputOptions`、`AudioPort`；以及 `createMemoryStorage()` | 是 |
| `@we/platform/web` | Web 适配：页面级共享 RAF 调度器 `createFrameScheduler`、`createRealClock`、`createWebRandom`（`crypto.getRandomValues`），以及按实例创建的 Web Platform（独立 Canvas、Pointer 坐标映射、DOM 文本输入 overlay、`speechSynthesis` 播报；`page: true` 时跟随页面可见性并用 Wake Lock 常亮，不传 `logicalSize` 时逻辑尺寸跟随 Canvas）、`createLocalStorage`、`connectBrowserWebSocket` | 否，只给 `apps/web` 与 `apps/simulator` |
| `@we/platform/wechat` | `createWechatPlatform({ audioClips? })`：`wx.createCanvas`、触摸、`onShow/onHide`、`showKeyboard`、`setKeepScreenOn`、Storage、`getUserCryptoManager` 随机数 | 否，只给 `apps/wechat` |

## 约定

- 每个 Platform 实例都是显式创建的，不依赖全局 Canvas 或模块级可变单例。Web 模拟器会在同一页面创建多个实例。
- 安全随机数不可用时直接报错，不回退到 `Math.random`。
- 微信没有内置 TTS，`announce` 按文本映射到 `audioClips` 中的预录音频，没有对应音频时只在屏幕上显示文字。
- `src/web/**` 和 `src/wechat/**` 不在核心 tsconfig（`tsconfig.core.json`）的范围内，分别由 `apps/web`、`apps/simulator` 和 `apps/wechat` 的 tsconfig 检查。
