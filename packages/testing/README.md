# @we/testing · 测试与模拟工具

进程内虚拟网络、手动时钟、确定性随机源和无头设备夹具，供 Vitest 测试和 Web 模拟器使用。**不能进入微信构建。**

依赖：`@we/platform`、`@we/multiplayer`。

## API

| 导出 | 用途 |
| --- | --- |
| `createVirtualNetwork({ networkId, clock, seed, faults? })` | 进程内虚拟网络（设计 §13.4），只认识 endpoint、字节包、链路状态和投递时间，不认识游戏规则。支持延迟、丢包、重复、乱序，可以按节点断网或按单方向链路设置故障，并提供 Packet Trace |
| `NETWORK_PRESETS` | 网络预设：`ideal` / `wifi` / `poor` / `terrible` |
| `createManualClock(start?)` | 手动推进的虚拟时钟 |
| `createSeededRng(seed)` | mulberry32 伪随机数，返回 `() => number` |
| `createSeededRandom(seed)` | 确定性 `RandomSource`，只用于测试，不能用于生产凭证 |
| `createHeadlessWorld({ seed, faults?, networkId? })` | 无 UI 的多设备世界：`createDevice` / `createHost` / `run(ms)` / `flush()` |

## 示例

```ts
import { createHeadlessWorld } from '@we/testing';
import { werewolfRules } from '@we/werewolf/rules';

const world = createHeadlessWorld({ seed: 1 });
const hostDevice = await world.createDevice('p1');
const host = await world.createHost(hostDevice, werewolfRules);
const guest = await world.createDevice('p2');
// ……通过 guest.client 加入房间、发送命令
await world.run(1_000); // 推进虚拟时间并冲刷微任务
```

用法示例见仓库根目录 `tests/match.e2e.test.ts` 和 `tests/commands.test.ts`。

## 约定

- 相同的输入、时间推进和 seed 必须得到相同的结果，便于复现问题。
- 这里的工具只模拟网络和时间，不能用来绕过真实的命令与状态同步链路（例如直接读写 Host 状态）。
