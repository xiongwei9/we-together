/** 游戏规则契约（设计 §10.1）。规则插件不依赖 UI、网络或平台。 */

export interface GameContext<Config> {
  matchId: string;
  players: readonly { playerId: string; seat: number }[];
  config: Config;
  /** Host 私有种子；确定性 PRNG 用于可重放 */
  seed: Uint8Array;
  /** 仅测试 Debug Port 注入的夹具（例如指定角色）；生产入口不会传入 */
  fixture?: unknown;
}

export interface CommandContext {
  /** 由 Host 认证后注入；'system' 仅来自 Host 内部定时器或经权限控制的公共控制 */
  actorId: string | 'system';
  now: number;
  phaseId: string;
}

export type Validation = { ok: true } | { ok: false; code: string };

export interface Transition<State, Event> {
  state: State;
  /** 内部事件，不能直接广播 */
  events: readonly Event[];
}

interface PhaseTimer {
  /** 当前阶段 id；阶段变化后旧定时器作废 */
  phaseId: string;
  ms: number;
}

/**
 * 方法语法声明（双变），便于以 GamePlugin<unknown, ...> 统一注册。
 */
export interface GamePlugin<State, Command, View, Config, Event, Result> {
  readonly id: string;
  readonly rulesVersion: string;
  readonly title: string;
  readonly playerCount: { min: number; max: number };
  readonly defaultConfig: Config;
  validateConfig(config: unknown): Validation;
  /** 网络 action 的 schema 校验：不合法返回 null */
  parseCommand(raw: unknown): Command | null;
  /** 公共控制操作（如结束讨论）：仅 Host 玩家可发起，以 system 身份执行 */
  isPublicControl(command: Command): boolean;
  createInitialState(ctx: GameContext<Config>): State;
  phaseId(state: State): string;
  validate(state: State, command: Command, ctx: CommandContext): Validation;
  reduce(state: State, command: Command, ctx: CommandContext): Transition<State, Event>;
  project(state: State, playerId: string): View;
  getResult(state: State): Result | null;
  /** 当前阶段需要的 Host 计时器；超时发出 timeoutCommand */
  timer(state: State): PhaseTimer | null;
  timeoutCommand(state: State): Command;
  /** 当前状态下可以公开播报的文本（Host 播放，绝不包含私密信息） */
  announce(prev: State | null, next: State, events: readonly Event[]): readonly string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGamePlugin = GamePlugin<any, any, any, any, any, any>;
