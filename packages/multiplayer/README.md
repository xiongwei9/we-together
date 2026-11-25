# @we/multiplayer · 协议、可靠传输与权威房间

本地多人联机的核心：消息协议与 schema 校验、可靠消息与分片、设备级链路复用、局域网房间发现、Host Authority、Player Client，以及游戏规则契约 `GamePlugin`。

依赖：`@we/platform`（只用端口类型）。不依赖 UI，不 import `wx`、DOM 或 Node API。

## 分层

```text
Transport              平台提供的字节数据报（微信 UDP / 测试用 Memory Transport）
  └─ ReliableNode      可靠 DATA + ACK、应用层分片、去重；心跳走不可靠通道
      └─ DeviceNet     每台设备一个：区分 Host / Client 角色的入站消息，本机 Host↔Client 走 loopback（仍经过编解码）
          ├─ HostAuthority   房间、会话、权威游戏状态；串行处理消息与定时器
          ├─ PlayerClient    只持有本玩家的 PlayerSnapshot；命令状态与重试
          └─ RoomBrowser     广播 DISCOVER，收集 Host 回复的 ROOM_INFO
```

## 主要导出

| 模块 | 导出 |
| --- | --- |
| `transport.ts` | `Transport`、`Endpoint`、`Packet`、`AddressCodec`、`defaultAddressCodec`（`192.168.1.10:20000` 或 `mem:<networkId>/<nodeId>`） |
| `reliable.ts` | `createReliableNode`、`describeDatagram`（Inspector 用，只解析头部） |
| `device-net.ts` | `createDeviceNet` |
| `discovery.ts` | `createRoomBrowser`、`DiscoveredRoom` |
| `host.ts` | `createHostAuthority`、`HostAuthority`、`HostInspection` |
| `client.ts` | `createPlayerClient`、`ClientState`、`CommandStatus`、`SavedSession` |
| `protocol.ts` | 消息类型、`RoomView`、`PlayerSnapshot`、`RoomAction`、`PauseInfo`、`ERROR_TEXT`、`MAX_PASSWORD` |
| `contract.ts` | `GamePlugin`、`GameContext`、`CommandContext`、`Transition`、`Validation`、`RuleOption`、`AnyGamePlugin` |
| `codec.ts` / `ids.ts` | `utf8Encode` / `utf8Decode`（不依赖 `TextEncoder`）、`createIdFactory` |

## 编写规则插件

实现 `GamePlugin<State, Command, View, Config, Event, Result>`：

- `parseCommand(raw)`：对网络 action 做 schema 校验，不合法返回 `null`。
- `validate` / `reduce`：纯函数，`reduce` 不修改输入状态。
- `project(state, playerId)`：按白名单显式映射字段，生成玩家视图，不 spread 完整 State。
- `timer(state)` / `timeoutCommand(state)`：由 Host 计时，`hidden: true` 的计时器不下发给客户端。
- `playerCount` / `ruleOptions` / `setRuleOption`：板子人数与开房时可调的规则。
- `announce`：只返回可以公开播报的文本。

完整示例见 [@we/werewolf](../../games/werewolf)。

## 安全约定

- 所有来自网络的 payload 都视为不可信：`parseClientEnvelope` / `parseHostEnvelope` 做 schema 校验，之后再做会话认证（`from` + `sessionEpoch` + 来源地址）和规则权限检查。
- 普通 Client 只收到 `PlayerSnapshot`。Host 的完整 State 不进入公共 Store、网络广播或生产日志；`inspect()` 和 `setFixture()` 只在 `debug` 模式下可用。
- 命令重试必须保持同一个 `commandId`。业务成功只能由 Host 的 `COMMAND_RESULT` 或权威快照确认。
- 房间密码只做入房访问控制，不是加密密钥。目前是明文 UDP，只适合可信的隔离 Wi-Fi。

## 测试

`tests/reliable.test.ts` 覆盖可靠层与分片；跨包的房间、命令语义和完整对局测试在仓库根目录的 `tests/` 下。
