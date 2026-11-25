/** 规则文档 lost-cities-game-rules.md 的状态、动作与视图类型 */

export const COLORS = ['red', 'yellow', 'blue', 'green', 'white'] as const;
export type Color = (typeof COLORS)[number];

/** value 为 null 表示握手牌 */
export interface Card {
  id: string;
  color: Color;
  value: number | null;
}

export type Expeditions = Record<Color, Card[]>;

export interface LostCitiesConfig {
  /** 比赛轮数：标准 3 轮，快速模式 1 轮（§9.1） */
  rounds: 1 | 3;
  /** 回合时间（秒），打牌与抽牌共享倒计时；0 表示不计时 */
  turnSec: 0 | 30 | 60;
  /** 两轮之间的结算展示时间（毫秒）；不计时模式下等待双方确认 */
  roundEndMs: number;
}

/**
 * play：第一步打出或弃掉；draw：第二步抽牌（同一回合共享 phaseId 与倒计时）；
 * round-end：本轮已结算，等待进入下一轮；finished：比赛结束
 */
type Phase = 'play' | 'draw' | 'round-end' | 'finished';

export type DrawSource = 'deck' | Color;

export type LostCitiesAction =
  | { type: 'PLAY'; cardId: string }
  | { type: 'DISCARD'; cardId: string }
  | { type: 'DRAW'; source: DrawSource }
  /** 结算页确认进入下一轮 */
  | { type: 'NEXT_ROUND' }
  /** 主动认输：当前比赛直接判负（§9.1） */
  | { type: 'RESIGN' }
  /** 仅 Host 内部定时器产生 */
  | { type: 'TIMEOUT' };

/** 一次行动的完整记录（Host 状态内；投影时按 §9.3 隐藏弃牌牌面） */
export interface PublicMove {
  playerId: string;
  kind: 'play' | 'discard';
  card: Card;
  /** 抽牌来源；本轮在此回合结束时为 null */
  draw: DrawSource | null;
  /** 超时由系统代为完成 */
  auto: boolean;
}

export interface PlayerRoundState {
  hand: Card[];
  expeditions: Expeditions;
}

export interface ColumnScore {
  sum: number;
  wagers: number;
  count: number;
  bonus: boolean;
  score: number;
}

export interface RoundRecord {
  round: number;
  starter: string;
  scores: Record<string, number>;
  /** 每名玩家五列的计分明细 */
  columns: Record<string, Record<Color, ColumnScore>>;
}

export interface LostCitiesResult {
  /** null 表示平局 */
  winner: string | null;
  totals: Record<string, number>;
  resigned: string | null;
}

export interface LostCitiesState {
  rulesVersion: string;
  config: LostCitiesConfig;
  /** Host 私有种子（每轮派生洗牌种子），不进入任何视图 */
  seed: number[];
  /** 座位顺序的两名玩家 */
  order: [string, string];
  seats: Record<string, number>;
  round: number;
  /** 全局回合计数，用于 phaseId 与超时随机弃牌 */
  turn: number;
  phase: Phase;
  phaseId: string;
  starter: string;
  current: string;
  deck: Card[];
  /** 每色弃牌堆，数组末尾为堆顶 */
  discards: Record<Color, Card[]>;
  players: Record<string, PlayerRoundState>;
  /** 当前回合第一步弃掉的牌所在颜色；本回合不能从该堆抽牌 */
  justDiscarded: Color | null;
  /** 当前回合第一步（待抽牌时展示） */
  pendingMove: PublicMove | null;
  /** 最近的公开行动，最新在末尾 */
  moves: PublicMove[];
  /** 已结束轮次的记录 */
  history: RoundRecord[];
  /** round-end 阶段已确认进入下一轮的玩家 */
  nextReady: string[];
  result: LostCitiesResult | null;
}

export type LostCitiesEvent =
  | { type: 'round-start'; round: number; starter: string }
  | { type: 'round-end'; round: number; scores: Record<string, number> }
  | { type: 'finished'; result: LostCitiesResult };

export type PendingAction = 'play' | 'draw' | 'next-round' | null;

/** 玩家视图中的行动记录：弃牌暗置，只有弃牌者本人能看到弃掉的牌面 */
export interface VisibleMove {
  playerId: string;
  kind: 'play' | 'discard';
  color: Color;
  /** 打出的牌、或本人弃出的牌；他人弃牌为 null */
  card: Card | null;
  draw: DrawSource | null;
  auto: boolean;
}

export interface PlayerPublicView {
  playerId: string;
  seat: number;
  handCount: number;
  expeditions: Expeditions;
  /** 当前预估分（本轮） */
  roundScore: number;
  /** 已结束轮次的累计分 */
  total: number;
}

export interface LostCitiesPlayerView {
  rulesVersion: string;
  rules: { rounds: number; turnSec: number };
  round: number;
  phase: Phase;
  /** 座位顺序 */
  players: PlayerPublicView[];
  me: { playerId: string; hand: Card[] } | null;
  current: string;
  starter: string;
  deckCount: number;
  /** 弃牌暗置（§9.3）：只公开各色弃牌堆张数 */
  discardCounts: Record<Color, number>;
  /** 当前回合不能抽取的弃牌堆（刚弃的牌所在颜色） */
  blockedDiscard: Color | null;
  pendingAction: PendingAction;
  /** next-round 已确认 */
  submitted: boolean;
  nextReadyCount: number;
  /** 当前回合第一步（对手可见，用于提示） */
  pendingMove: VisibleMove | null;
  moves: VisibleMove[];
  history: RoundRecord[];
  result: LostCitiesResult | null;
}
