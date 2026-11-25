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

export interface WerewolfConfig {
  nightPhaseMs: number;
  discussMs: number;
  voteMs: number;
  /** 已死亡角色的夜间阶段仍按固定节奏运行，不提前跳过以免泄露存活信息 */
  deadRolePhaseMs: number;
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
  round: number;
  phase: Phase;
  phaseSeq: number;
  phaseId: string;
  seats: Record<string, number>;
  players: Record<string, { role: Role; alive: boolean }>;
  confirmed: string[];
  wolfVotes: Record<string, string | null>;
  wolfTarget: string | null;
  seerChecks: Record<string, Team>;
  seerActed: boolean;
  witchInventory: { antidote: boolean; poison: boolean };
  witchAction: { kind: 'pass' | 'save' | 'poison'; target?: string } | null;
  dayVotes: Record<string, string | null>;
  publicHistory: PublicDayResult[];
  result: { winner: Winner } | null;
}

export type WerewolfAction =
  | { type: 'CONFIRM_ROLE' }
  | { type: 'WOLF_VOTE'; targetId: string | null }
  | { type: 'SEER_CHECK'; targetId: string }
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
  wolf: { teammates: string[]; votes: Record<string, string | null> | null; target: string | null } | null;
  seer: { checks: Record<string, Team>; actedTonight: boolean } | null;
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
