import type { GameContext, GamePlugin, Validation } from '@we/multiplayer';
import { emptyPiles } from './cards';
import { DEFAULT_CONFIG, isValidConfig, ruleOptions, setRuleOption } from './config';
import { reduce, startRound, validate } from './engine';
import { COLORS, type Color, type LostCitiesAction, type LostCitiesConfig, type LostCitiesEvent, type LostCitiesPlayerView, type LostCitiesState } from './types';
import { projectView } from './view';

/** 规则文档 lost-cities-game-rules.md（经典双人五色版） */
const RULES_VERSION = 'lost-cities-classic-v1';

const isCardId = (v: unknown): v is string => typeof v === 'string' && /^[a-z]+-w?\d{1,2}$/.test(v);
const isColor = (v: unknown): v is Color => COLORS.includes(v as Color);

function parseAction(raw: unknown): LostCitiesAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case 'PLAY':
    case 'DISCARD':
      return isCardId(a.cardId) ? { type: a.type, cardId: a.cardId } : null;
    case 'DRAW':
      return a.source === 'deck' || isColor(a.source) ? { type: 'DRAW', source: a.source } : null;
    case 'NEXT_ROUND':
    case 'RESIGN':
      return { type: a.type };
    // TIMEOUT 仅由 Host 内部定时器产生，不接受网络输入
    default:
      return null;
  }
}

function createInitialState(ctx: GameContext<LostCitiesConfig>): LostCitiesState {
  const seated = [...ctx.players].sort((a, b) => a.seat - b.seat);
  if (seated.length !== 2) throw new Error(`${RULES_VERSION} requires exactly 2 players`);
  const order: [string, string] = [seated[0]!.playerId, seated[1]!.playerId];
  const seed = Array.from(ctx.seed);
  const base: LostCitiesState = {
    rulesVersion: RULES_VERSION,
    config: ctx.config,
    seed,
    order,
    seats: Object.fromEntries(seated.map((p) => [p.playerId, p.seat])),
    round: 0,
    turn: 0,
    phase: 'play',
    phaseId: '',
    starter: order[0],
    current: order[0],
    deck: [],
    discards: emptyPiles(),
    players: {},
    justDiscarded: null,
    pendingMove: null,
    moves: [],
    history: [],
    nextReady: [],
    result: null,
  };
  // 首轮先手由 Host 私有种子随机确定（§9.1）
  return startRound(base, 1, order[(ctx.seed[31] ?? 0) & 1]!);
}

export const lostCitiesRules: GamePlugin<LostCitiesState, LostCitiesAction, LostCitiesPlayerView, LostCitiesConfig, LostCitiesEvent, LostCitiesState['result']> = {
  id: 'lost-cities',
  title: '失落的城市',
  rulesVersion: RULES_VERSION,
  defaultConfig: DEFAULT_CONFIG,

  validateConfig: (config): Validation => (isValidConfig(config) ? { ok: true } : { ok: false, code: 'BAD_CONFIG' }),
  playerCount: () => ({ min: 2, max: 2 }),
  ruleOptions,
  setRuleOption,
  parseCommand: parseAction,
  isPublicControl: () => false,
  createInitialState,
  phaseId: (s) => s.phaseId,
  validate: (s, a, ctx) => validate(s, a, ctx.actorId),
  reduce: (s, a, ctx) => reduce(s, a, ctx.actorId),
  project: projectView,
  getResult: (s) => s.result,
  timer(s) {
    // 打牌与抽牌同属一个 phaseId，共享倒计时（§9.1）
    if (s.result || s.config.turnSec === 0) return null;
    if (s.phase === 'play' || s.phase === 'draw') return { phaseId: s.phaseId, ms: s.config.turnSec * 1000 };
    if (s.phase === 'round-end') return { phaseId: s.phaseId, ms: s.config.roundEndMs };
    return null;
  },
  timeoutCommand: () => ({ type: 'TIMEOUT' }),
  // 双人卡牌对局不需要裁判语音播报
  announce: () => [],
};
