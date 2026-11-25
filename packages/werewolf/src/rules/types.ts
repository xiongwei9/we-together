export type Role = 'wolf' | 'villager' | 'seer' | 'witch' | 'hunter';
export type Team = 'wolf' | 'good';
export type Board = 6 | 9;

export type Phase =
  | 'reveal'
  | 'night-wolf'
  | 'night-witch'
  | 'night-seer'
  | 'sheriff-signup'
  | 'sheriff-speech'
  | 'sheriff-vote'
  | 'sheriff-pk-speech'
  | 'sheriff-pk-vote'
  | 'hunter'
  | 'badge'
  | 'last-words'
  | 'sheriff-order'
  | 'day-speech'
  | 'day-vote'
  | 'pk-speech'
  | 'pk-vote'
  | 'finished';

/** 各操作时限（规则文档 §13），单位毫秒 */
export interface WerewolfTimers {
  wolfMs: number;
  wolfRevoteMs: number;
  witchMs: number;
  seerMs: number;
  /** 预言家查验后展示结果的时长 */
  seerRevealMs: number;
  hunterMs: number;
  badgeMs: number;
  sheriffSignupMs: number;
  sheriffOrderMs: number;
  pkSpeechMs: number;
  voteMs: number;
  lastWordsMs: number;
  /**
   * 角色已出局（或本批次无人可开枪）时，其阶段照常播报，并在 [min, max] 内随机停留后推进，
   * 避免通过等待时长推断神职是否存活；停留时长不下发给客户端。
   */
  deadRoleDelayMs: { min: number; max: number };
}

type WitchSelfSave = 'never' | 'first-night' | 'always';
type WolfKillMode = 'majority' | 'unanimous';

/** 房主开房时可自定义的规则（开局后锁定） */
export interface WerewolfConfig {
  board: Board;
  /** 警长模式：首个白天竞选警长，警长归票 1.5 票并决定发言顺序 */
  sheriff: boolean;
  witchSelfSave: WitchSelfSave;
  wolfKill: WolfKillMode;
  selfExplode: boolean;
  /** 发言时长（秒）；0 表示不计时：竞选发言、发言、PK 发言与遗言都不限时，由发言者结束或房主跳过 */
  speechSec: number;
  timers: WerewolfTimers;
}

export type DeathCause = 'wolf' | 'poison' | 'exile' | 'shot' | 'explode';

interface DeathRecord {
  round: number;
  at: 'night' | 'day';
  causes: DeathCause[];
}

/** 复盘用的夜间行动记录（仅游戏结束后公开） */
interface NightRecord {
  round: number;
  wolfTarget: string | null;
  witch: { kind: 'save' | 'poison'; target: string } | null;
  seer: { target: string; team: Team } | null;
}

/** 公开事件：所有玩家都能看到 */
export type PublicEntry =
  | { kind: 'night'; round: number; deaths: string[] }
  /** 警长竞选结果；tied 非空表示平票进入 PK */
  | { kind: 'sheriff'; round: number; candidates: string[]; votes: Record<string, string | null> | null; pk: boolean; elected: string | null; tied: string[] }
  | { kind: 'vote'; round: number; pk: boolean; sheriff: string | null; votes: Record<string, string | null>; exiled: string | null; tied: string[] }
  | { kind: 'shot'; round: number; shooter: string; target: string }
  | { kind: 'explode'; round: number; playerId: string }
  | { kind: 'badge'; round: number; from: string; to: string | null };

/** 胜负：none 表示连续无死亡导致的无结果结束 */
export type Winner = 'wolf' | 'good' | 'draw' | 'none';

/** 当前批次死亡的后续处理：死亡技能 → 警徽 → 胜负 → 遗言 */
interface DeathBatch {
  kind: 'night' | 'exile' | 'explode';
  deaths: string[];
  /** 本批次具备开枪资格的猎人 */
  hunter: string | null;
  hunterDone: boolean;
  badgeDone: boolean;
  lastWords: string[];
}

export interface WerewolfState {
  rulesVersion: string;
  config: WerewolfConfig;
  /** 由 Host 私有种子派生的盐，用于假阶段的随机停留时长（不下发客户端） */
  delaySalt: number;
  round: number;
  phase: Phase;
  phaseSeq: number;
  phaseId: string;
  seats: Record<string, number>;
  players: Record<string, { role: Role; alive: boolean }>;
  confirmed: string[];

  // ---- 夜间
  wolfVotes: Record<string, string | null>;
  /** 狼人确认前的意向选择（仅存活狼人可见，不参与结算） */
  wolfIntents: Record<string, string | null>;
  /** 最高票并列时的重投选项（null 为空刀）；null 表示不在重投中 */
  wolfRevote: (string | null)[] | null;
  wolfTarget: string | null;
  witchInventory: { antidote: boolean; poison: boolean };
  witchAction: { kind: 'pass' | 'save' | 'poison'; target?: string } | null;
  /** 每名被查验玩家的结果（预言家可见） */
  seerChecks: Record<string, Team>;
  /** 本夜查验目标；非 null 时处于结果展示期 */
  seerLastCheck: string | null;
  seerActed: boolean;
  /** 夜间结算后、天亮公布前的死亡名单（警长竞选期间保留） */
  nightDeaths: { id: string; causes: DeathCause[] }[] | null;

  // ---- 白天
  sheriff: string | null;
  sheriffElectionDone: boolean;
  /** 上警报名（未公布） */
  signups: Record<string, boolean>;
  /** 本次竞选全部上警玩家（含退水），没有警下投票权 */
  campaigners: string[];
  /** 当前仍在竞选 / PK 的候选人 */
  candidates: string[];
  speech: { order: string[]; index: number } | null;
  lastSpeechStart: string | null;
  votes: Record<string, string | null>;
  voters: string[];
  voteTargets: string[];
  batch: DeathBatch | null;
  /** 白天流程被自爆中断：死亡处理后直接入夜 */
  skipDayTalk: boolean;
  /** 连续无死亡的完整昼夜数 */
  quietCycles: number;
  cycleHadDeath: boolean;

  deaths: Record<string, DeathRecord>;
  nightLog: NightRecord[];
  publicHistory: PublicEntry[];
  result: { winner: Winner } | null;
}

export type WerewolfAction =
  | { type: 'CONFIRM_ROLE' }
  | { type: 'WOLF_SELECT'; targetId: string | null }
  /** targetId 为 null 表示明确投空刀 */
  | { type: 'WOLF_VOTE'; targetId: string | null }
  | { type: 'WITCH_ACTION'; action: 'pass' | 'save' | 'poison'; targetId?: string }
  | { type: 'SEER_CHECK'; targetId: string }
  | { type: 'SEER_PASS' }
  /** targetId 为 null 表示放弃开枪 */
  | { type: 'HUNTER_SHOOT'; targetId: string | null }
  /** targetId 为 null 表示撕毁警徽 */
  | { type: 'BADGE_PASS'; targetId: string | null }
  | { type: 'SHERIFF_SIGNUP'; join: boolean }
  | { type: 'SHERIFF_WITHDRAW' }
  | { type: 'SHERIFF_ORDER'; dir: 'cw' | 'ccw' }
  | { type: 'END_SPEECH' }
  /** 房主跳过当前发言（公共控制，仅「不计时」时可用） */
  | { type: 'SKIP_SPEECH' }
  /** 警长竞选、放逐及 PK 投票；targetId 为 null 表示弃票 */
  | { type: 'VOTE'; targetId: string | null }
  | { type: 'EXPLODE' }
  | { type: 'PHASE_TIMEOUT' };

export type WerewolfEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'night-deaths'; deaths: string[] }
  | { type: 'sheriff'; elected: string | null }
  | { type: 'pk'; candidates: string[]; sheriff: boolean }
  | { type: 'exile'; playerId: string | null }
  | { type: 'shot'; target: string }
  | { type: 'explode'; playerId: string }
  | { type: 'badge'; to: string | null }
  | { type: 'finished'; winner: Winner };

export type PendingAction =
  | 'confirm'
  | 'wolf-vote'
  | 'witch'
  | 'seer-check'
  | 'hunter'
  | 'badge'
  | 'sheriff-signup'
  | 'sheriff-order'
  | 'speak'
  | 'vote'
  | null;

/** Client 使用的独立视图 schema：显式白名单字段 */
export interface WerewolfPlayerView {
  rulesVersion: string;
  rules: { board: Board; sheriff: boolean; witchSelfSave: WitchSelfSave; wolfKill: WolfKillMode; selfExplode: boolean; speechSec: number };
  round: number;
  phase: Phase;
  players: { playerId: string; seat: number; alive: boolean }[];
  sheriff: string | null;
  me: { playerId: string; seat: number; role: Role; alive: boolean } | null;
  confirmedCount: number;
  /** 发言阶段：公开的发言顺序与当前发言者 */
  speech: { order: string[]; current: string } | null;
  /** 警长候选人 / PK 候选人（公开后） */
  candidates: string[] | null;
  /** 上警报名或投票的进度（只公开人数） */
  progress: { done: number; total: number } | null;
  /** 投票阶段：可投对象与本人已投（undefined 表示未投） */
  vote: { targets: string[]; myVote: string | null | undefined } | null;
  wolf: {
    teammates: string[];
    votes: Record<string, string | null> | null;
    intents: Record<string, string | null> | null;
    revote: (string | null)[] | null;
    target: string | null;
  } | null;
  seer: { checks: Record<string, Team>; lastCheck: { targetId: string; team: Team } | null } | null;
  witch: { antidote: boolean; poison: boolean; wolfTarget: string | null; canSave: boolean } | null;
  /** 猎人开枪资格：仅在本批次死亡处理时下发给猎人本人 */
  hunter: { canShoot: boolean } | null;
  pendingAction: PendingAction;
  submitted: boolean;
  /** 隐藏计时阶段中本人操作的时限（用于本地倒计时显示） */
  actionLimitMs: number | null;
  canExplode: boolean;
  canWithdraw: boolean;
  history: PublicEntry[];
  result: {
    winner: Winner;
    roles: Record<string, Role>;
    deaths: Record<string, DeathRecord>;
    nights: NightRecord[];
  } | null;
}
