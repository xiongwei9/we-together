import type { CommandContext, GameContext, GamePlugin, Transition, Validation } from '@we/multiplayer';
import type {
  PendingAction,
  Phase,
  PublicDayResult,
  Role,
  Team,
  WerewolfAction,
  WerewolfConfig,
  WerewolfEvent,
  WerewolfPlayerView,
  WerewolfState,
  Winner,
} from './types';

/** 固定六人板子（设计 §11）：2 狼、1 预言家、1 女巫、2 平民 */
const RULES_VERSION = 'werewolf-6-v1';
export const ROLE_DECK: readonly Role[] = ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'];

const DEFAULT_CONFIG: WerewolfConfig = {
  deadRoleDelayMs: { min: 3_000, max: 8_000 },
  seerRevealMs: 3_000,
};

const ok: Validation = { ok: true };
const no = (code: string): Validation => ({ ok: false, code });

const teamOf = (role: Role): Team => (role === 'wolf' ? 'wolf' : 'good');

// ---- 确定性随机（Fisher–Yates + 拒绝采样保证均匀） -------------------------

function createSeededPrng(seed: Uint8Array): () => number {
  // sfc32，种子取 16 字节
  const w = (i: number): number =>
    ((seed[i % seed.length]! << 24) | (seed[(i + 1) % seed.length]! << 16) | (seed[(i + 2) % seed.length]! << 8) | seed[(i + 3) % seed.length]!) >>> 0;
  let a = w(0);
  let b = w(4);
  let c = w(8);
  let d = w(12) | 1;
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

function uniformIndex(next: () => number, n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const r = next();
    if (r < limit) return r % n;
  }
}

export function shuffle<T>(items: readonly T[], seed: Uint8Array): T[] {
  const next = createSeededPrng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = uniformIndex(next, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---- 工具 ---------------------------------------------------------------

const alive = (s: WerewolfState): string[] => order(s).filter((id) => s.players[id]!.alive);
const order = (s: WerewolfState): string[] => Object.keys(s.seats).sort((a, b) => s.seats[a]! - s.seats[b]!);
const aliveWith = (s: WerewolfState, role: Role): string[] => alive(s).filter((id) => s.players[id]!.role === role);
const isAlive = (s: WerewolfState, id: string | null | undefined): id is string => !!id && !!s.players[id]?.alive;

function checkWinner(s: WerewolfState): Winner | null {
  const wolves = alive(s).filter((id) => s.players[id]!.role === 'wolf').length;
  const good = alive(s).length - wolves;
  if (wolves === 0 && good === 0) return 'draw';
  if (wolves === 0) return 'good';
  if (wolves >= good) return 'wolf';
  return null;
}

function enterPhase(s: WerewolfState, phase: Phase, events: WerewolfEvent[]): WerewolfState {
  const phaseSeq = s.phaseSeq + 1;
  events.push({ type: 'phase', phase });
  return { ...s, phase, phaseSeq, phaseId: `r${s.round}-${phase}-${phaseSeq}` };
}

function startNight(s: WerewolfState, round: number, events: WerewolfEvent[]): WerewolfState {
  return enterPhase(
    { ...s, round, wolfVotes: {}, wolfIntents: {}, wolfTarget: null, seerActed: false, seerLastCheck: null, witchAction: null, dayVotes: {} },
    'night-wolf',
    events,
  );
}

function finishIfOver(s: WerewolfState, events: WerewolfEvent[]): WerewolfState | null {
  const winner = checkWinner(s);
  if (!winner) return null;
  events.push({ type: 'finished', winner });
  return enterPhase({ ...s, result: { winner } }, 'finished', events);
}

function resolveWolves(s: WerewolfState, events: WerewolfEvent[]): WerewolfState {
  const wolves = aliveWith(s, 'wolf');
  const votes = wolves.map((w) => s.wolfVotes[w] ?? null);
  let target: string | null = null;
  if (votes.length === 1) target = votes[0]!;
  else if (votes.length > 1 && votes[0] !== null && votes.every((v) => v === votes[0])) target = votes[0]!;
  // 狼人可以刀任意存活玩家，包括自己和队友（自刀）
  if (target !== null && !isAlive(s, target)) target = null;
  return enterPhase({ ...s, wolfTarget: target }, 'night-seer', events);
}

function resolveNight(s: WerewolfState, events: WerewolfEvent[]): WerewolfState {
  const deaths = new Set<string>();
  const saved = s.witchAction?.kind === 'save';
  if (s.wolfTarget && !saved) deaths.add(s.wolfTarget);
  if (s.witchAction?.kind === 'poison' && s.witchAction.target) deaths.add(s.witchAction.target);
  const players = { ...s.players };
  for (const id of deaths) players[id] = { ...players[id]!, alive: false };
  const sorted = [...deaths].sort((a, b) => s.seats[a]! - s.seats[b]!);
  const entry: PublicDayResult = { round: s.round, kind: 'night', deaths: sorted };
  events.push({ type: 'night-deaths', deaths: sorted });
  const next: WerewolfState = { ...s, players, publicHistory: [...s.publicHistory, entry], phase: 'night-resolve' };
  return finishIfOver(next, events) ?? enterPhase(next, 'day-discuss', events);
}

function resolveDay(s: WerewolfState, events: WerewolfEvent[]): WerewolfState {
  const voters = alive(s);
  const votes: Record<string, string | null> = {};
  for (const v of voters) votes[v] = s.dayVotes[v] ?? null;
  const tally = new Map<string, number>();
  for (const t of Object.values(votes)) if (t) tally.set(t, (tally.get(t) ?? 0) + 1);
  let max = 0;
  let leaders: string[] = [];
  for (const [id, n] of tally) {
    if (n > max) {
      max = n;
      leaders = [id];
    } else if (n === max) leaders.push(id);
  }
  const exiled = max >= 1 && leaders.length === 1 ? leaders[0]! : null;
  const players = { ...s.players };
  if (exiled) players[exiled] = { ...players[exiled]!, alive: false };
  events.push({ type: 'exile', playerId: exiled });
  const entry: PublicDayResult = { round: s.round, kind: 'day', deaths: exiled ? [exiled] : [], votes, exiled };
  const next: WerewolfState = { ...s, players, publicHistory: [...s.publicHistory, entry], phase: 'day-resolve' };
  return finishIfOver(next, events) ?? startNight(next, s.round + 1, events);
}

// ---- 解析 ---------------------------------------------------------------

const isTarget = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

function parseAction(raw: unknown): WerewolfAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case 'CONFIRM_ROLE':
    case 'END_DISCUSSION':
    case 'SEER_PASS':
      return { type: a.type };
    case 'WOLF_SELECT':
    case 'WOLF_VOTE':
    case 'DAY_VOTE':
      return a.targetId === null || isTarget(a.targetId) ? { type: a.type, targetId: a.targetId } : null;
    case 'SEER_CHECK':
      return isTarget(a.targetId) ? { type: 'SEER_CHECK', targetId: a.targetId } : null;
    case 'WITCH_ACTION':
      if (a.action === 'pass' || a.action === 'save') return { type: 'WITCH_ACTION', action: a.action };
      if (a.action === 'poison' && isTarget(a.targetId)) return { type: 'WITCH_ACTION', action: 'poison', targetId: a.targetId };
      return null;
    // PHASE_TIMEOUT 仅由 Host 内部定时器产生，不接受网络输入
    default:
      return null;
  }
}

function isValidConfig(c: unknown): c is WerewolfConfig {
  if (typeof c !== 'object' || c === null) return false;
  const d = (c as { deadRoleDelayMs?: { min?: unknown; max?: unknown } }).deadRoleDelayMs;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 600_000;
  const reveal = (c as { seerRevealMs?: unknown }).seerRevealMs;
  return !!d && valid(d.min) && valid(d.max) && d.min <= d.max && valid(reveal);
}

/**
 * 神职出局后的假阶段停留时长：[min, max] 内随机。
 * 由 Host 私有种子派生的盐 + phaseId 计算，客户端无法预测；同一局可重放。
 */
function deadRoleDelay(s: WerewolfState): number {
  const { min, max } = s.config.deadRoleDelayMs;
  let h = (2166136261 ^ s.delaySalt) >>> 0;
  for (let i = 0; i < s.phaseId.length; i++) h = Math.imul(h ^ s.phaseId.charCodeAt(i), 16777619) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 2246822507) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return min + (h % (max - min + 1));
}

/** 只有已死亡的预言家 / 女巫的夜间阶段需要计时，其余阶段无超时 */
/** 预言家可查验的目标：其他存活且未查验过的玩家 */
function uncheckedTargets(s: WerewolfState, seer: string): string[] {
  return alive(s).filter((id) => id !== seer && !(id in s.seerChecks));
}

/** 存活预言家完成查验后的结果展示期（仍处于 night-seer 阶段） */
function seerRevealing(s: WerewolfState): boolean {
  return s.phase === 'night-seer' && s.seerActed && aliveWith(s, 'seer').length > 0;
}

function deadRolePhase(s: WerewolfState): boolean {
  return (s.phase === 'night-seer' && aliveWith(s, 'seer').length === 0) || (s.phase === 'night-witch' && aliveWith(s, 'witch').length === 0);
}

// ---- 投影 ---------------------------------------------------------------

function pendingFor(s: WerewolfState, id: string): { action: PendingAction; submitted: boolean } {
  const me = s.players[id];
  if (!me || s.result) return { action: null, submitted: false };
  switch (s.phase) {
    case 'reveal':
      return { action: 'confirm', submitted: s.confirmed.includes(id) };
    case 'night-wolf':
      return me.alive && me.role === 'wolf' ? { action: 'wolf-vote', submitted: id in s.wolfVotes } : { action: null, submitted: false };
    case 'night-seer':
      return me.alive && me.role === 'seer' ? { action: 'seer-check', submitted: s.seerActed } : { action: null, submitted: false };
    case 'night-witch':
      return me.alive && me.role === 'witch' ? { action: 'witch', submitted: s.witchAction !== null } : { action: null, submitted: false };
    case 'day-vote':
      return me.alive ? { action: 'day-vote', submitted: id in s.dayVotes } : { action: null, submitted: false };
    default:
      return { action: null, submitted: false };
  }
}

export function projectView(s: WerewolfState, playerId: string): WerewolfPlayerView {
  const me = s.players[playerId];
  const players = order(s).map((id) => ({ playerId: id, seat: s.seats[id]!, alive: s.players[id]!.alive }));
  const pending = pendingFor(s, playerId);
  const finished = s.result !== null;

  let wolf: WerewolfPlayerView['wolf'] = null;
  // 出局玩家只接收公开信息，不再下发任何角色私密数据
  if (me?.alive && me.role === 'wolf') {
    const teammates = order(s).filter((id) => id !== playerId && s.players[id]!.role === 'wolf');
    // 死狼人不接收新的私密行动信息
    const showNight = me.alive && s.phase.startsWith('night');
    wolf = {
      teammates,
      votes: showNight ? { ...s.wolfVotes } : null,
      intents: showNight && s.phase === 'night-wolf' ? { ...s.wolfIntents } : null,
      target: showNight && s.phase !== 'night-wolf' ? s.wolfTarget : null,
    };
  }

  let seer: WerewolfPlayerView['seer'] = null;
  if (me?.alive && me.role === 'seer') {
    const revealing = me.alive && seerRevealing(s) && s.seerLastCheck !== null;
    seer = {
      checks: { ...s.seerChecks },
      actedTonight: s.seerActed,
      lastCheck: revealing ? { targetId: s.seerLastCheck!, team: s.seerChecks[s.seerLastCheck!]! } : null,
      revealMs: s.config.seerRevealMs,
    };
  }

  let witch: WerewolfPlayerView['witch'] = null;
  if (me?.alive && me.role === 'witch') {
    const inWitchPhase = me.alive && s.phase === 'night-witch';
    // 本原型仅在解药可用时提供狼刀目标
    const wolfTarget = inWitchPhase && s.witchInventory.antidote ? s.wolfTarget : null;
    witch = {
      antidote: s.witchInventory.antidote,
      poison: s.witchInventory.poison,
      wolfTarget,
      canSave: !!wolfTarget && (wolfTarget !== playerId || s.round === 1),
      acted: s.witchAction !== null,
    };
  }

  return {
    rulesVersion: s.rulesVersion,
    round: s.round,
    phase: s.phase,
    players,
    me: me ? { playerId, seat: s.seats[playerId]!, role: me.role, alive: me.alive } : null,
    confirmedCount: s.confirmed.length,
    votedCount: s.phase === 'day-vote' ? Object.keys(s.dayVotes).length : 0,
    wolf,
    seer,
    witch,
    pendingAction: pending.action,
    submitted: pending.submitted,
    myDayVote: s.phase === 'day-vote' && playerId in s.dayVotes ? s.dayVotes[playerId] : undefined,
    history: s.publicHistory.map((h) => ({ ...h, deaths: [...h.deaths], votes: h.votes ? { ...h.votes } : undefined })),
    result: finished
      ? { winner: s.result!.winner, roles: Object.fromEntries(order(s).map((id) => [id, s.players[id]!.role])) }
      : null,
  };
}

// ---- 播报（只使用公开信息） -------------------------------------------------

function seatText(s: WerewolfState, ids: readonly string[]): string {
  return ids.map((id) => `${s.seats[id]}号`).join('、');
}

function announce(prev: WerewolfState | null, next: WerewolfState, events: readonly WerewolfEvent[]): string[] {
  const out: string[] = [];
  if (!prev) out.push('游戏开始，请各自查看身份，确认后天黑。');
  for (const e of events) {
    if (e.type === 'night-deaths') out.push(e.deaths.length ? `天亮了。昨晚 ${seatText(next, e.deaths)} 死亡。` : '天亮了。昨晚是平安夜。');
    if (e.type === 'exile') out.push(e.playerId ? `${seatText(next, [e.playerId])} 被放逐。` : '平票或全部弃权，无人被放逐。');
    if (e.type === 'phase') {
      const text: Partial<Record<Phase, string>> = {
        'night-wolf': '天黑请闭眼。狼人请睁眼，选择今晚的目标。',
        'night-seer': '狼人请闭眼。预言家请睁眼，选择要查验的玩家。',
        'night-witch': '预言家请闭眼。女巫请睁眼。',
        'day-discuss': '请开始讨论。',
        'day-vote': '讨论结束，请投票。',
      };
      const t = text[e.phase];
      if (t) out.push(t);
    }
    if (e.type === 'finished') out.push(e.winner === 'draw' ? '游戏结束，平局。' : `游戏结束，${e.winner === 'wolf' ? '狼人' : '好人'}阵营胜利。`);
  }
  return out;
}

// ---- 插件 ---------------------------------------------------------------

interface WerewolfFixture {
  /** 测试 Debug Port：按座位号指定角色（必须与板子角色数量一致） */
  rolesBySeat?: Record<number, Role>;
}

export const werewolfRules: GamePlugin<WerewolfState, WerewolfAction, WerewolfPlayerView, WerewolfConfig, WerewolfEvent, WerewolfState['result']> = {
  id: 'werewolf',
  title: '狼人杀 · 六人局',
  rulesVersion: RULES_VERSION,
  playerCount: { min: 6, max: 6 },
  defaultConfig: DEFAULT_CONFIG,

  validateConfig: (config) => (isValidConfig(config) ? ok : no('BAD_CONFIG')),
  parseCommand: parseAction,
  isPublicControl: (a) => a.type === 'END_DISCUSSION',

  createInitialState(ctx: GameContext<WerewolfConfig>): WerewolfState {
    const seated = [...ctx.players].sort((a, b) => a.seat - b.seat);
    if (seated.length !== ROLE_DECK.length) throw new Error('werewolf-6-v1 requires exactly 6 players');
    let roles = shuffle(ROLE_DECK, ctx.seed);
    const fixture = ctx.fixture as WerewolfFixture | undefined;
    if (fixture?.rolesBySeat) {
      const forced = seated.map((p) => fixture.rolesBySeat![p.seat]);
      const counts = (rs: readonly (Role | undefined)[]): string => [...rs].sort().join(',');
      if (forced.every((r): r is Role => !!r) && counts(forced) === counts(ROLE_DECK)) roles = forced;
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
      wolfTarget: null,
      seerChecks: {},
      seerActed: false,
      seerLastCheck: null,
      witchInventory: { antidote: true, poison: true },
      witchAction: null,
      dayVotes: {},
      publicHistory: [],
      result: null,
    };
  },

  phaseId: (s) => s.phaseId,

  validate(s, a, ctx: CommandContext): Validation {
    if (s.result) return no('GAME_OVER');
    const actor = ctx.actorId;
    if (a.type === 'PHASE_TIMEOUT') return actor !== 'system' ? no('FORBIDDEN') : deadRolePhase(s) || seerRevealing(s) ? ok : no('WRONG_PHASE');
    if (a.type === 'END_DISCUSSION') return actor !== 'system' ? no('FORBIDDEN') : s.phase === 'day-discuss' ? ok : no('WRONG_PHASE');
    const me = actor === 'system' ? undefined : s.players[actor];
    if (!me) return no('NOT_A_PLAYER');
    switch (a.type) {
      case 'CONFIRM_ROLE':
        if (s.phase !== 'reveal') return no('WRONG_PHASE');
        return s.confirmed.includes(actor) ? no('ALREADY_SUBMITTED') : ok;
      case 'WOLF_SELECT':
      case 'WOLF_VOTE':
        if (s.phase !== 'night-wolf') return no('WRONG_PHASE');
        if (!me.alive) return no('DEAD');
        if (me.role !== 'wolf') return no('FORBIDDEN');
        if (actor in s.wolfVotes) return no('ALREADY_SUBMITTED');
        if (a.targetId !== null && !isAlive(s, a.targetId)) return no('BAD_TARGET');
        return ok;
      case 'SEER_CHECK':
        if (s.phase !== 'night-seer') return no('WRONG_PHASE');
        if (!me.alive) return no('DEAD');
        if (me.role !== 'seer') return no('FORBIDDEN');
        if (s.seerActed) return no('ALREADY_SUBMITTED');
        if (a.targetId === actor || !isAlive(s, a.targetId)) return no('BAD_TARGET');
        if (a.targetId in s.seerChecks) return no('ALREADY_CHECKED');
        return ok;
      case 'SEER_PASS':
        if (s.phase !== 'night-seer') return no('WRONG_PHASE');
        if (!me.alive) return no('DEAD');
        if (me.role !== 'seer') return no('FORBIDDEN');
        if (s.seerActed) return no('ALREADY_SUBMITTED');
        if (uncheckedTargets(s, actor).length > 0) return no('HAS_TARGET');
        return ok;
      case 'WITCH_ACTION':
        if (s.phase !== 'night-witch') return no('WRONG_PHASE');
        if (!me.alive) return no('DEAD');
        if (me.role !== 'witch') return no('FORBIDDEN');
        if (s.witchAction) return no('ALREADY_SUBMITTED');
        if (a.action === 'save') {
          if (!s.witchInventory.antidote) return no('NO_ANTIDOTE');
          if (!s.wolfTarget) return no('BAD_TARGET');
          if (s.wolfTarget === actor && s.round !== 1) return no('NO_SELF_SAVE');
        }
        if (a.action === 'poison') {
          if (!s.witchInventory.poison) return no('NO_POISON');
          if (!a.targetId || a.targetId === actor || !isAlive(s, a.targetId)) return no('BAD_TARGET');
        }
        return ok;
      case 'DAY_VOTE':
        if (s.phase !== 'day-vote') return no('WRONG_PHASE');
        if (!me.alive) return no('DEAD');
        if (actor in s.dayVotes) return no('ALREADY_SUBMITTED');
        if (a.targetId !== null && (a.targetId === actor || !isAlive(s, a.targetId))) return no('BAD_TARGET');
        return ok;
    }
  },

  reduce(s, a, ctx): Transition<WerewolfState, WerewolfEvent> {
    const events: WerewolfEvent[] = [];
    const actor = ctx.actorId;
    let next = s;
    switch (a.type) {
      case 'CONFIRM_ROLE': {
        next = { ...s, confirmed: [...s.confirmed, actor] };
        if (next.confirmed.length === Object.keys(s.players).length) next = startNight(next, 1, events);
        break;
      }
      case 'WOLF_SELECT':
        next = { ...s, wolfIntents: { ...s.wolfIntents, [actor]: a.targetId } };
        break;
      case 'WOLF_VOTE': {
        next = { ...s, wolfVotes: { ...s.wolfVotes, [actor]: a.targetId }, wolfIntents: { ...s.wolfIntents, [actor]: a.targetId } };
        if (aliveWith(next, 'wolf').every((w) => w in next.wolfVotes)) next = resolveWolves(next, events);
        break;
      }
      case 'SEER_CHECK': {
        const team = teamOf(s.players[a.targetId]!.role);
        // 不立即进入女巫阶段：先给预言家展示结果，seerRevealMs 后由 Host 计时推进
        next = { ...s, seerActed: true, seerLastCheck: a.targetId, seerChecks: { ...s.seerChecks, [a.targetId]: team } };
        break;
      }
      case 'SEER_PASS':
        next = { ...s, seerActed: true, seerLastCheck: null };
        break;
      case 'WITCH_ACTION': {
        const inv = { ...s.witchInventory };
        if (a.action === 'save') inv.antidote = false;
        if (a.action === 'poison') inv.poison = false;
        const action = a.action === 'poison' ? { kind: a.action, target: a.targetId } : { kind: a.action };
        next = resolveNight({ ...s, witchInventory: inv, witchAction: action }, events);
        break;
      }
      case 'END_DISCUSSION':
        next = enterPhase(s, 'day-vote', events);
        break;
      case 'DAY_VOTE': {
        next = { ...s, dayVotes: { ...s.dayVotes, [actor]: a.targetId } };
        if (alive(next).every((id) => id in next.dayVotes)) next = resolveDay(next, events);
        break;
      }
      case 'PHASE_TIMEOUT':
        // 已死亡角色的夜间阶段：隐藏延时结束后推进
        if (s.phase === 'night-seer') next = enterPhase({ ...s, seerActed: true }, 'night-witch', events);
        else if (s.phase === 'night-witch') next = resolveNight({ ...s, witchAction: { kind: 'pass' } }, events);
        break;
    }
    return { state: next, events };
  },

  project: projectView,
  getResult: (s) => s.result,

  // 两种计时都隐藏：不下发客户端，避免暴露预言家是否存活、是否已查验
  timer: (s) =>
    deadRolePhase(s)
      ? { phaseId: s.phaseId, ms: deadRoleDelay(s), hidden: true }
      : seerRevealing(s)
        ? { phaseId: s.phaseId, ms: s.config.seerRevealMs, hidden: true }
        : null,
  timeoutCommand: () => ({ type: 'PHASE_TIMEOUT' }),
  announce,
};
