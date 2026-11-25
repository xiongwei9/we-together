export type Role = 'wolf' | 'seer' | 'witch' | 'villager';
export type Team = 'wolf' | 'good';

export type Phase =
  | 'reveal'
  | 'night-wolf'
  | 'night-seer'
  | 'night-witch'
  | 'night-resolve'
  | 'day-discuss'
  | 'day-vote'
  | 'day-resolve'
  | 'finished';

/**
 * 回合内没有倒计时：阶段只在玩家完成操作（或房主结束讨论）后推进。
 * 唯一例外：神职（预言家 / 女巫）出局后，轮到其夜间阶段时仍照常播报，
 * 并在 [min, max] 区间内随机停留后自动推进，伪造该角色仍在场的假象；停留时长不下发给客户端。
 */
export interface WerewolfConfig {
  deadRoleDelayMs: { min: number; max: number };
  /** 预言家查验后展示结果的时长，结束后进入女巫阶段 */
  seerRevealMs: number;
}

/** 公开结果：仅轮次、公开死亡/放逐、公开投票 */
export interface PublicDayResult {
  round: number;
  kind: 'night' | 'day';
  deaths: string[];
  votes?: Record<string, string | null>;
  exiled?: string | null;
}

export type Winner = 'wolf' | 'good' | 'draw';

export interface WerewolfState {
  rulesVersion: string;
  config: WerewolfConfig;
  /** 由 Host 私有种子派生的盐，用于神职出局后假阶段的随机停留时长（不下发客户端） */
  delaySalt: number;
  round: number;
  phase: Phase;
  phaseSeq: number;
  phaseId: string;
  seats: Record<string, number>;
  players: Record<string, { role: Role; alive: boolean }>;
  confirmed: string[];
  wolfVotes: Record<string, string | null>;
  /** 狼人确认前的意向选择（仅存活狼人可见，不参与结算） */
  wolfIntents: Record<string, string | null>;
  wolfTarget: string | null;
  seerChecks: Record<string, Team>;
  seerActed: boolean;
  /** 本夜查验目标（结果展示期间使用） */
  seerLastCheck: string | null;
  witchInventory: { antidote: boolean; poison: boolean };
  witchAction: { kind: 'pass' | 'save' | 'poison'; target?: string } | null;
  dayVotes: Record<string, string | null>;
  publicHistory: PublicDayResult[];
  result: { winner: Winner } | null;
}

export type WerewolfAction =
  | { type: 'CONFIRM_ROLE' }
  | { type: 'WOLF_SELECT'; targetId: string | null }
  | { type: 'WOLF_VOTE'; targetId: string | null }
  | { type: 'SEER_CHECK'; targetId: string }
  /** 没有可查验的人（其他存活玩家都已查验过）时放弃本夜查验 */
  | { type: 'SEER_PASS' }
  | { type: 'WITCH_ACTION'; action: 'pass' | 'save' | 'poison'; targetId?: string }
  | { type: 'DAY_VOTE'; targetId: string | null }
  | { type: 'END_DISCUSSION' }
  | { type: 'PHASE_TIMEOUT' };

export type WerewolfEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'night-deaths'; deaths: string[] }
  | { type: 'exile'; playerId: string | null }
  | { type: 'finished'; winner: Winner };

export type PendingAction = 'confirm' | 'wolf-vote' | 'seer-check' | 'witch' | 'day-vote' | null;

/** Client 使用的独立视图 schema：显式白名单字段 */
export interface WerewolfPlayerView {
  rulesVersion: string;
  round: number;
  phase: Phase;
  players: { playerId: string; seat: number; alive: boolean }[];
  me: { playerId: string; seat: number; role: Role; alive: boolean } | null;
  confirmedCount: number;
  /** 白天投票阶段已投票人数（只公开人数，不公开投向） */
  votedCount: number;
  wolf: {
    teammates: string[];
    /** 已确认的狼票 */
    votes: Record<string, string | null> | null;
    /** 尚未确认的意向选择 */
    intents: Record<string, string | null> | null;
    target: string | null;
  } | null;
  seer: {
    checks: Record<string, Team>;
    actedTonight: boolean;
    /** 本夜查验结果：仅在查验后的展示期间下发 */
    lastCheck: { targetId: string; team: Team } | null;
    revealMs: number;
  } | null;
  witch: {
    antidote: boolean;
    poison: boolean;
    wolfTarget: string | null;
    canSave: boolean;
    acted: boolean;
  } | null;
  pendingAction: PendingAction;
  submitted: boolean;
  myDayVote: string | null | undefined;
  history: PublicDayResult[];
  result: { winner: Winner; roles: Record<string, Role> } | null;
}
