import { seededShuffle, type GameContext, type GamePlugin, type Validation } from '@we/multiplayer';
import { DEFAULT_CONFIG, ROLE_DECKS, isValidConfig, ruleOptions, setRuleOption } from './config';
import { SPEECH_PHASES, VOTE_PHASES, alive, reduce, validate } from './engine';
import type { Phase, Role, WerewolfAction, WerewolfConfig, WerewolfEvent, WerewolfPlayerView, WerewolfState, Winner } from './types';
import { projectView } from './view';

/** 规则文档 werewolf-6-9-rules.md v1.0 */
const RULES_VERSION = 'werewolf-6-9-v1';

// ---- 解析 ---------------------------------------------------------------

const isTarget = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const isTargetOrNull = (v: unknown): v is string | null => v === null || isTarget(v);

function parseAction(raw: unknown): WerewolfAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case 'CONFIRM_ROLE':
    case 'SEER_PASS':
    case 'SHERIFF_WITHDRAW':
    case 'END_SPEECH':
    case 'SKIP_SPEECH':
    case 'EXPLODE':
      return { type: a.type };
    case 'WOLF_SELECT':
    case 'WOLF_VOTE':
    case 'HUNTER_SHOOT':
    case 'BADGE_PASS':
    case 'VOTE':
      return isTargetOrNull(a.targetId) ? { type: a.type, targetId: a.targetId } : null;
    case 'SEER_CHECK':
      return isTarget(a.targetId) ? { type: 'SEER_CHECK', targetId: a.targetId } : null;
    case 'WITCH_ACTION':
      if (a.action === 'pass' || a.action === 'save') return { type: 'WITCH_ACTION', action: a.action };
      if (a.action === 'poison' && isTarget(a.targetId)) return { type: 'WITCH_ACTION', action: 'poison', targetId: a.targetId };
      return null;
    case 'SHERIFF_SIGNUP':
      return typeof a.join === 'boolean' ? { type: 'SHERIFF_SIGNUP', join: a.join } : null;
    case 'SHERIFF_ORDER':
      return a.dir === 'cw' || a.dir === 'ccw' ? { type: 'SHERIFF_ORDER', dir: a.dir } : null;
    // PHASE_TIMEOUT 仅由 Host 内部定时器产生，不接受网络输入
    default:
      return null;
  }
}

// ---- 计时 ---------------------------------------------------------------

/**
 * 假阶段的停留时长：[min, max] 内随机。
 * 由 Host 私有种子派生的盐 + phaseId 计算，客户端无法预测；同一局可重放。
 */
function fakeDelay(s: WerewolfState): number {
  const { min, max } = s.config.timers.deadRoleDelayMs;
  let h = (2166136261 ^ s.delaySalt) >>> 0;
  for (let i = 0; i < s.phaseId.length; i++) h = Math.imul(h ^ s.phaseId.charCodeAt(i), 16777619) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 2246822507) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return min + (h % (max - min + 1));
}

interface TimerSpec {
  ms: number;
  hidden: boolean;
  step: string;
}

/**
 * 夜间与死亡技能阶段使用隐藏计时（不下发客户端）：角色已出局时照常播报并随机停留，
 * 避免通过界面或时长推断神职存活；白天阶段公开倒计时。
 */
function timerSpec(s: WerewolfState): TimerSpec | null {
  const t = s.config.timers;
  const hasAlive = (role: Role): boolean => alive(s).some((id) => s.players[id]!.role === role);
  const hidden = (ms: number, step: string): TimerSpec => ({ ms, hidden: true, step });
  const shown = (ms: number): TimerSpec => ({ ms, hidden: false, step: '' });
  // 不计时：所有发言阶段都不限时
  if (s.config.speechSec === 0 && SPEECH_PHASES.includes(s.phase)) return null;
  switch (s.phase) {
    case 'night-wolf':
      return s.wolfRevote ? hidden(t.wolfRevoteMs, 'revote') : hidden(t.wolfMs, 'vote');
    case 'night-witch':
      return hasAlive('witch') ? hidden(t.witchMs, 'act') : hidden(fakeDelay(s), 'fake');
    case 'night-seer':
      if (!hasAlive('seer')) return hidden(fakeDelay(s), 'fake');
      return s.seerLastCheck ? hidden(t.seerRevealMs, 'reveal') : hidden(t.seerMs, 'act');
    case 'hunter':
      return s.batch?.hunter ? hidden(t.hunterMs, 'act') : hidden(fakeDelay(s), 'fake');
    case 'badge':
      return shown(t.badgeMs);
    case 'sheriff-signup':
      return shown(t.sheriffSignupMs);
    case 'sheriff-order':
      return shown(t.sheriffOrderMs);
    case 'sheriff-speech':
    case 'day-speech':
      return shown(s.config.speechSec * 1000);
    case 'sheriff-pk-speech':
    case 'pk-speech':
      return shown(t.pkSpeechMs);
    case 'last-words':
      return shown(t.lastWordsMs);
    default:
      return VOTE_PHASES.includes(s.phase) ? shown(t.voteMs) : null;
  }
}

// ---- 播报（只使用公开信息） -------------------------------------------------

const PHASE_TEXT: Partial<Record<Phase, string>> = {
  'night-wolf': '天黑请闭眼。狼人请睁眼，请选择今晚要袭击的玩家。',
  'night-witch': '狼人请闭眼。女巫请睁眼。',
  'night-seer': '女巫请闭眼。预言家请睁眼，请选择要查验的玩家。',
  'sheriff-signup': '天亮了。现在开始警长竞选，想竞选警长的玩家请上警。',
  hunter: '请确认是否发动技能。',
  badge: '警长出局，请移交或撕毁警徽。',
  'sheriff-order': '请警长选择发言顺序。',
  'sheriff-vote': '请警下玩家投票选举警长。',
  'sheriff-pk-vote': '请投票，在 PK 玩家中选出警长。',
  'day-vote': '发言结束，请投票放逐。',
  'pk-vote': '请投票，在 PK 玩家中放逐一人。',
};

const SPEECH_TEXT: Partial<Record<Phase, string>> = {
  'sheriff-speech': '竞选发言',
  'sheriff-pk-speech': '警长 PK 发言',
  'day-speech': '发言',
  'pk-speech': 'PK 发言',
  'last-words': '发表遗言',
};

const WINNER_TEXT: Record<Winner, string> = {
  wolf: '游戏结束，狼人阵营胜利。',
  good: '游戏结束，好人阵营胜利。',
  draw: '游戏结束，平局。',
  none: '连续三个昼夜无人死亡，本局无结果结束。',
};

function announce(prev: WerewolfState | null, next: WerewolfState, events: readonly WerewolfEvent[]): string[] {
  const seat = (ids: readonly string[]): string => ids.map((id) => `${next.seats[id]}号`).join('、');
  const out: string[] = [];
  if (!prev) out.push('游戏开始，请各自查看身份，确认后天黑。');
  for (const e of events) {
    switch (e.type) {
      case 'phase': {
        const speak = SPEECH_TEXT[e.phase];
        const speaker = next.speech ? next.speech.order[next.speech.index] : undefined;
        if (speak && e.phase === next.phase && speaker) out.push(`请 ${seat([speaker])} ${speak}。`);
        else if (PHASE_TEXT[e.phase]) out.push(PHASE_TEXT[e.phase]!);
        break;
      }
      case 'night-deaths': {
        // 警长模式首日在竞选开始时已播报「天亮了」
        const prefix = next.config.sheriff && next.round === 1 ? '' : '天亮了。';
        out.push(e.deaths.length ? `${prefix}昨晚 ${seat(e.deaths)} 死亡。` : `${prefix}昨晚是平安夜。`);
        break;
      }
      case 'sheriff':
        out.push(e.elected ? `${seat([e.elected])} 当选警长。` : '警徽流失，本局没有警长。');
        break;
      case 'pk':
        out.push(`${seat(e.candidates)} 平票，进入 PK。`);
        break;
      case 'exile':
        out.push(e.playerId ? `${seat([e.playerId])} 被放逐。` : '无人被放逐。');
        break;
      case 'shot':
        out.push(`猎人开枪，${seat([e.target])} 被带走。`);
        break;
      case 'explode':
        out.push(`${seat([e.playerId])} 自爆，身份是狼人。`);
        break;
      case 'badge':
        out.push(e.to ? `警徽移交给 ${seat([e.to])}。` : '警徽被撕毁。');
        break;
      case 'finished':
        out.push(WINNER_TEXT[e.winner]);
        break;
    }
  }
  return out;
}

// ---- 插件 ---------------------------------------------------------------

interface WerewolfFixture {
  /** 测试 Debug Port：按座位号指定角色（必须与板子角色数量一致） */
  rolesBySeat?: Record<number, Role>;
}

function createInitialState(ctx: GameContext<WerewolfConfig>): WerewolfState {
  const deck = ROLE_DECKS[ctx.config.board];
  const seated = [...ctx.players].sort((a, b) => a.seat - b.seat);
  if (seated.length !== deck.length) throw new Error(`${RULES_VERSION} board ${ctx.config.board} requires exactly ${deck.length} players`);
  let roles = seededShuffle(deck, ctx.seed);
  const fixture = ctx.fixture as WerewolfFixture | undefined;
  if (fixture?.rolesBySeat) {
    const forced = seated.map((p) => fixture.rolesBySeat![p.seat]);
    const counts = (rs: readonly (Role | undefined)[]): string => [...rs].sort().join(',');
    if (forced.every((r): r is Role => !!r) && counts(forced) === counts(deck)) roles = forced;
  }
  const seats: Record<string, number> = {};
  const players: WerewolfState['players'] = {};
  seated.forEach((p, i) => {
    seats[p.playerId] = p.seat;
    players[p.playerId] = { role: roles[i]!, alive: true };
  });
  // 种子前 16 字节用于洗牌，16–19 字节派生延时盐
  const b = (i: number): number => ctx.seed[i % ctx.seed.length] ?? 0;
  const delaySalt = ((b(16) << 24) | (b(17) << 16) | (b(18) << 8) | b(19)) >>> 0;
  return {
    rulesVersion: RULES_VERSION,
    config: ctx.config,
    delaySalt,
    round: 0,
    phase: 'reveal',
    phaseSeq: 0,
    phaseId: 'r0-reveal-0',
    seats,
    players,
    confirmed: [],
    wolfVotes: {},
    wolfIntents: {},
    wolfRevote: null,
    wolfTarget: null,
    witchInventory: { antidote: true, poison: true },
    witchAction: null,
    seerChecks: {},
    seerLastCheck: null,
    seerActed: false,
    nightDeaths: null,
    sheriff: null,
    sheriffElectionDone: false,
    signups: {},
    campaigners: [],
    candidates: [],
    speech: null,
    lastSpeechStart: null,
    votes: {},
    voters: [],
    voteTargets: [],
    batch: null,
    skipDayTalk: false,
    quietCycles: 0,
    cycleHadDeath: false,
    deaths: {},
    nightLog: [],
    publicHistory: [],
    result: null,
  };
}

export const werewolfRules: GamePlugin<WerewolfState, WerewolfAction, WerewolfPlayerView, WerewolfConfig, WerewolfEvent, WerewolfState['result']> = {
  id: 'werewolf',
  title: '狼人杀',
  rulesVersion: RULES_VERSION,
  defaultConfig: DEFAULT_CONFIG,

  validateConfig: (config): Validation => (isValidConfig(config) ? { ok: true } : { ok: false, code: 'BAD_CONFIG' }),
  playerCount: (config) => ({ min: config.board, max: config.board }),
  ruleOptions,
  setRuleOption,
  parseCommand: parseAction,
  isPublicControl: (a) => a.type === 'SKIP_SPEECH',
  createInitialState,
  phaseId: (s) => s.phaseId,
  validate: (s, a, ctx) => validate(s, a, ctx.actorId, timerSpec(s) !== null),
  reduce: (s, a, ctx) => reduce(s, a, ctx.actorId),
  project: projectView,
  getResult: (s) => s.result,
  timer(s) {
    const t = timerSpec(s);
    return t ? { phaseId: s.phaseId, step: t.step, ms: t.ms, hidden: t.hidden } : null;
  },
  timeoutCommand: () => ({ type: 'PHASE_TIMEOUT' }),
  announce,
};

