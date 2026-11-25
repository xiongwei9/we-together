import type { UINode } from '@we/framework';
import type { AnyGamePlugin, CommandStatus, PauseInfo, RoomPlayer, RoomView } from '@we/multiplayer';

/** Client 侧的游戏表现插件：只读取本玩家的授权视图 */
export interface GameSceneContext<View = unknown> {
  view: View;
  room: RoomView;
  me: RoomPlayer;
  isHost: boolean;
  phaseId: string;
  /** 当前剩余时间（显示用，权威计时在 Host） */
  remainingMs: number | null;
  paused: PauseInfo | null;
  commands: readonly CommandStatus[];
  send(action: unknown): string;
  retry(commandId: string): void;
  /** 实例内 UI 局部状态；阶段变化或切后台时清空 */
  local: Readonly<Record<string, unknown>>;
  setLocal(patch: Record<string, unknown>): void;
  nameOf(playerId: string): string;
  safeArea: { top: number; bottom: number };
  /** 本地单调时钟（仅用于显示，例如本地倒计时） */
  now: number;
  /** 本次渲染需要周期性重绘（本地倒计时、动画）；每次渲染需重新声明 */
  keepTicking(): void;
}

export interface GamePresentation {
  render(ctx: GameSceneContext): UINode;
}

export interface GamePluginDefinition {
  rules: AnyGamePlugin;
  presentation: GamePresentation;
  /** 测试工具：根据本玩家视图给出一个自动行动（仅模拟器使用） */
  bot?: (view: unknown, rng: () => number) => unknown | null;
}
