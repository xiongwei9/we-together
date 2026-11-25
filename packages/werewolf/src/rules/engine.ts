import type { Validation } from '@we/multiplayer';
import type { DeathCause, Phase, Role, Team, WerewolfAction, WerewolfEvent, WerewolfState, Winner } from './types';

/**
 * 规则状态机（规则文档 §5–§11）。reduce 先深拷贝再在副本上修改，输入状态保持不可变。
 */

type Events = WerewolfEvent[];

/** 连续无死亡的完整昼夜数达到该值时无结果结束（§13） */
const QUIET_LIMIT = 3;

export const SPEECH_PHASES: readonly Phase[] = ['sheriff-speech', 'sheriff-pk-speech', 'day-speech', 'pk-speech', 'last-words'];
export const VOTE_PHASES: readonly Phase[] = ['sheriff-vote', 'sheriff-pk-vote', 'day-vote', 'pk-vote'];
export const EXPLODE_PHASES: readonly Phase[] = ['sheriff-speech', 'sheriff-pk-speech', 'day-speech', 'pk-speech'];

const ok: Validation = { ok: true };
const no = (code: string): Validation => ({ ok: false, code });

// ---- 查询 ---------------------------------------------------------------

const teamOf = (role: Role): Team => (role === 'wolf' ? 'wolf' : 'good');
export const order = (s: WerewolfState): string[] => Object.keys(s.seats).sort((a, b) => s.seats[a]! - s.seats[b]!);
export const alive = (s: WerewolfState): string[] => order(s).filter((id) => s.players[id]!.alive);
const isAlive = (s: WerewolfState, id: string | null | undefined): id is string => !!id && !!s.players[id]?.alive;
const aliveRole = (s: WerewolfState, role: Role): string[] => alive(s).filter((id) => s.players[id]!.role === role);
const bySeat = (s: WerewolfState, ids: readonly string[]): string[] => [...ids].sort((a, b) => s.seats[a]! - s.seats[b]!);

export const currentSpeaker = (s: WerewolfState): string | null =>
  SPEECH_PHASES.includes(s.phase) && s.speech ? (s.speech.order[s.speech.index] ?? null) : null;

/** 屠边判定（§11.1） */
function winnerOf(s: WerewolfState): Winner | null {
  let wolves = 0;
  let villagers = 0;
  let gods = 0;
  for (const id of alive(s)) {
    const r = s.players[id]!.role;
    if (r === 'wolf') wolves++;
    else if (r === 'villager') villagers++;
    else gods++;
  }
  if (wolves === 0) return villagers > 0 && gods > 0 ? 'good' : 'draw';
  return villagers === 0 || gods === 0 ? 'wolf' : null;
}

/** 唯一最高票（至少 1 票）；警长在放逐投票中计 1.5 票 */
function leadersOf(votes: Record<string, string | null>, sheriff: string | null): string[] {
  const tally = new Map<string, number>();
  for (const [from, to] of Object.entries(votes)) if (to) tally.set(to, (tally.get(to) ?? 0) + (from === sheriff ? 1.5 : 1));
  let max = 0;
  let leaders: string[] = [];
  for (const [id, n] of tally) {
    if (n > max) {
      max = n;
      leaders = [id];
    } else if (n === max) leaders.push(id);
  }
  return leaders;
}

/** 从 seat 出发按方向找下一位存活玩家（dir=1 为座位号递增，即顺时针）；按实际座位环计算，不假设座位号连续 */
function nextAlive(s: WerewolfState, seat: number, dir: 1 | -1): string {
  const ring = order(s);
  const n = ring.length;
  const from = ring.findIndex((id) => s.seats[id] === seat);
  for (let step = 1; step <= n; step++) {
    const id = ring[(((from < 0 ? 0 : from) + dir * step) % n + n) % n]!;
    if (s.players[id]!.alive) return id;
  }
  return alive(s)[0]!;
}

/** 从 start 开始按方向排列全部存活玩家 */
function rotation(s: WerewolfState, start: string, dir: 1 | -1): string[] {
  const ids = alive(s);
  const out = [start];
  let cur = start;
  while (out.length < ids.length) {
    cur = nextAlive(s, s.seats[cur]!, dir);
    out.push(cur);
  }
  return out;
}

// ---- 状态迁移（均在副本上修改） ---------------------------------------------

function enter(s: WerewolfState, phase: Phase, ev: Events): void {
  s.phaseSeq++;
  s.phase = phase;
  s.phaseId = `r${s.round}-${phase}-${s.phaseSeq}`;
  ev.push({ type: 'phase', phase });
}

function finish(s: WerewolfState, winner: Winner, ev: Events): void {
  s.result = { winner };
  s.speech = null;
  ev.push({ type: 'finished', winner });
  enter(s, 'finished', ev);
}

function kill(s: WerewolfState, id: string, cause: DeathCause, at: 'night' | 'day'): void {
  const p = s.players[id]!;
  if (p.alive) {
    p.alive = false;
    s.cycleHadDeath = true;
    s.deaths[id] = { round: s.round, at, causes: [cause] };
  } else if (s.deaths[id] && !s.deaths[id]!.causes.includes(cause)) s.deaths[id]!.causes.push(cause);
}

function startNight(s: WerewolfState, ev: Events): void {
  s.round++;
  s.wolfVotes = {};
  s.wolfIntents = {};
  s.wolfRevote = null;
  s.wolfTarget = null;
  s.witchAction = null;
  s.seerLastCheck = null;
  s.seerActed = false;
  s.nightDeaths = null;
  s.candidates = [];
  s.speech = null;
  s.votes = {};
  s.voters = [];
  s.voteTargets = [];
  s.batch = null;
  s.skipDayTalk = false;
  s.cycleHadDeath = false;
  enter(s, 'night-wolf', ev);
}

/** 白天结束：防御性胜负检查 + 连续无死亡计数，然后入夜 */
function endDay(s: WerewolfState, ev: Events): void {
  const w = winnerOf(s);
  if (w) return finish(s, w, ev);
  s.quietCycles = s.cycleHadDeath ? 0 : s.quietCycles + 1;
  if (s.quietCycles >= QUIET_LIMIT) return finish(s, 'none', ev);
  startNight(s, ev);
}

// ---- 夜间 ---------------------------------------------------------------

function resolveWolves(s: WerewolfState, ev: Events): void {
  const wolves = aliveRole(s, 'wolf');
  let target: string | null = null;
  if (s.config.wolfKill === 'unanimous') {
    const vs = wolves.map((w) => (w in s.wolfVotes ? s.wolfVotes[w]! : undefined));
    if (vs.length && vs.every((v) => typeof v === 'string' && v === vs[0])) target = vs[0]!;
  } else {
    // 空刀也是一个选项；未提交视为弃权
    const tally = new Map<string | null, number>();
    for (const w of wolves) if (w in s.wolfVotes) tally.set(s.wolfVotes[w]!, (tally.get(s.wolfVotes[w]!) ?? 0) + 1);
    const max = Math.max(0, ...tally.values());
    const leaders = [...tally].filter(([, n]) => n === max && max > 0).map(([k]) => k);
    if (leaders.length === 1) target = leaders[0]!;
    else if (leaders.length > 1 && !s.wolfRevote) {
      // 仅在并列选项中重投一次；仍停留在狼人阶段（计时步骤变化）
      const skip = leaders.includes(null);
      s.wolfRevote = [...(skip ? [null] : []), ...bySeat(s, leaders.filter((x): x is string => x !== null))];
      s.wolfVotes = {};
      s.wolfIntents = {};
      return;
    }
  }
  s.wolfTarget = isAlive(s, target) ? target : null;
  s.wolfRevote = null;
  enter(s, 'night-witch', ev);
}

function resolveNight(s: WerewolfState, ev: Events): void {
  const causes = new Map<string, DeathCause[]>();
  const add = (id: string, c: DeathCause): void => void causes.set(id, [...(causes.get(id) ?? []), c]);
  const w = s.witchAction;
  if (s.wolfTarget && w?.kind !== 'save') add(s.wolfTarget, 'wolf');
  if (w?.kind === 'poison' && w.target) add(w.target, 'poison');
  s.nightDeaths = bySeat(s, [...causes.keys()]).map((id) => ({ id, causes: causes.get(id)! }));
  s.nightLog.push({
    round: s.round,
    wolfTarget: s.wolfTarget,
    witch: w?.kind === 'save' && s.wolfTarget ? { kind: 'save', target: s.wolfTarget } : w?.kind === 'poison' && w.target ? { kind: 'poison', target: w.target } : null,
    seer: s.seerLastCheck ? { target: s.seerLastCheck, team: s.seerChecks[s.seerLastCheck]! } : null,
  });
  s.seerLastCheck = null;
  if (s.config.sheriff && !s.sheriffElectionDone) {
    s.signups = {};
    return enter(s, 'sheriff-signup', ev);
  }
  dawn(s, ev);
}

/** 天亮：公布夜间死讯并进入死亡处理 */
function dawn(s: WerewolfState, ev: Events): void {
  const nd = s.nightDeaths ?? [];
  s.nightDeaths = null;
  for (const d of nd) for (const c of d.causes) kill(s, d.id, c, 'night');
  const ids = nd.map((d) => d.id);
  s.publicHistory.push({ kind: 'night', round: s.round, deaths: ids });
  ev.push({ type: 'night-deaths', deaths: ids });
  const hunter = nd.find((d) => s.players[d.id]!.role === 'hunter' && !d.causes.includes('poison'))?.id ?? null;
  s.batch = {
    kind: 'night',
    deaths: ids,
    hunter,
    hunterDone: false,
    badgeDone: false,
    // 仅首夜死亡有遗言；自爆者没有遗言
    lastWords: s.round === 1 ? ids.filter((id) => !s.deaths[id]!.causes.includes('explode')) : [],
  };
  continueBatch(s, ev);
}

// ---- 死亡批次：死亡技能 → 警徽 → 胜负 → 遗言 → 后续流程 ----------------------

function continueBatch(s: WerewolfState, ev: Events): void {
  const b = s.batch!;
  if (!b.hunterDone) {
    b.hunterDone = true;
    // 9 人局：有人死亡（自爆除外）时总是进入技能阶段，避免暴露猎人是否在本批次中
    if (s.config.board === 9 && b.kind !== 'explode' && b.deaths.length > 0) return enter(s, 'hunter', ev);
  }
  if (!b.badgeDone) {
    b.badgeDone = true;
    if (s.sheriff && !isAlive(s, s.sheriff)) return enter(s, 'badge', ev);
  }
  const w = winnerOf(s);
  if (w) return finish(s, w, ev);
  if (b.lastWords.length) {
    const speakers = b.lastWords;
    b.lastWords = [];
    return beginSpeech(s, 'last-words', speakers, ev);
  }
  if (b.kind === 'night' && !s.skipDayTalk) return startDayTalk(s, ev);
  endDay(s, ev);
}

function startDayTalk(s: WerewolfState, ev: Events): void {
  if (isAlive(s, s.sheriff)) return enter(s, 'sheriff-order', ev);
  // §8.1：以编号最小的夜间死者为锚点；平安夜从上一轮起点的下一位开始
  const night = [...s.publicHistory].reverse().find((e) => e.kind === 'night' && e.round === s.round);
  const deaths = night?.kind === 'night' ? night.deaths : [];
  const ids = alive(s);
  let start: string;
  if (deaths.length) start = nextAlive(s, Math.min(...deaths.map((d) => s.seats[d]!)), 1);
  else if (s.lastSpeechStart) start = nextAlive(s, s.seats[s.lastSpeechStart]!, 1);
  else start = ids[0]!;
  s.lastSpeechStart = start;
  beginSpeech(s, 'day-speech', rotation(s, start, 1), ev);
}

// ---- 发言 ---------------------------------------------------------------

function beginSpeech(s: WerewolfState, phase: Phase, speakers: readonly string[], ev: Events): void {
  s.speech = { order: [...speakers], index: 0 };
  if (!speakers.length) return speechDone(s, phase, ev);
  enter(s, phase, ev);
}

function canStillSpeak(s: WerewolfState, phase: Phase, id: string): boolean {
  if (phase === 'last-words') return true;
  if (phase === 'sheriff-speech' || phase === 'sheriff-pk-speech') return isAlive(s, id) && s.candidates.includes(id);
  return isAlive(s, id);
}

function advanceSpeech(s: WerewolfState, ev: Events): void {
  const phase = s.phase;
  const sp = s.speech!;
  let i = sp.index + 1;
  while (i < sp.order.length && !canStillSpeak(s, phase, sp.order[i]!)) i++;
  if (i < sp.order.length) {
    sp.index = i;
    return enter(s, phase, ev); // 每位发言者一个独立 phaseId，过期的结束发言请求自然失效
  }
  speechDone(s, phase, ev);
}

function speechDone(s: WerewolfState, phase: Phase, ev: Events): void {
  s.speech = null;
  const others = (exclude: readonly string[]): string[] => alive(s).filter((id) => !exclude.includes(id));
  switch (phase) {
    case 'sheriff-speech': {
      if (s.candidates.length <= 1) return electSheriff(s, s.candidates[0] ?? null, null, false, ev);
      const voters = others(s.campaigners);
      if (!voters.length) return electSheriff(s, null, null, false, ev);
      return beginVote(s, 'sheriff-vote', voters, s.candidates, ev);
    }
    case 'sheriff-pk-speech': {
      const voters = others(s.candidates);
      if (!voters.length) return electSheriff(s, null, null, true, ev);
      return beginVote(s, 'sheriff-pk-vote', voters, s.candidates, ev);
    }
    case 'day-speech':
      return beginVote(s, 'day-vote', alive(s), alive(s), ev);
    case 'pk-speech': {
      const voters = others(s.candidates);
      if (voters.length) return beginVote(s, 'pk-vote', voters, s.candidates, ev);
      // 没有合法投票人：本轮无人出局
      s.publicHistory.push({ kind: 'vote', round: s.round, pk: true, sheriff: s.sheriff, votes: {}, exiled: null, tied: [] });
      ev.push({ type: 'exile', playerId: null });
      return endDay(s, ev);
    }
    case 'last-words':
      return continueBatch(s, ev);
  }
}

// ---- 投票 ---------------------------------------------------------------

function beginVote(s: WerewolfState, phase: Phase, voters: readonly string[], targets: readonly string[], ev: Events): void {
  s.votes = {};
  s.voters = [...voters];
  s.voteTargets = [...targets];
  enter(s, phase, ev);
}

function resolveVote(s: WerewolfState, ev: Events): void {
  const votes: Record<string, string | null> = {};
  for (const v of s.voters) votes[v] = s.votes[v] ?? null;
  const pk = s.phase === 'sheriff-pk-vote' || s.phase === 'pk-vote';
  if (s.phase === 'sheriff-vote' || s.phase === 'sheriff-pk-vote') {
    const leaders = leadersOf(votes, null);
    if (leaders.length === 1) return electSheriff(s, leaders[0]!, votes, pk, ev);
    if (leaders.length > 1 && !pk) {
      const tied = bySeat(s, leaders);
      s.publicHistory.push({ kind: 'sheriff', round: s.round, candidates: [...s.candidates], votes, pk, elected: null, tied });
      s.candidates = tied;
      ev.push({ type: 'pk', candidates: tied, sheriff: true });
      return beginSpeech(s, 'sheriff-pk-speech', tied, ev);
    }
    return electSheriff(s, null, votes, pk, ev);
  }
  const leaders = leadersOf(votes, s.sheriff);
  const exiled = leaders.length === 1 ? leaders[0]! : null;
  const tied = !pk && leaders.length > 1 ? bySeat(s, leaders) : [];
  s.publicHistory.push({ kind: 'vote', round: s.round, pk, sheriff: s.sheriff, votes, exiled, tied });
  if (tied.length) {
    s.candidates = tied;
    ev.push({ type: 'pk', candidates: tied, sheriff: false });
    return beginSpeech(s, 'pk-speech', tied, ev);
  }
  ev.push({ type: 'exile', playerId: exiled });
  if (!exiled) return endDay(s, ev);
  kill(s, exiled, 'exile', 'day');
  s.batch = {
    kind: 'exile',
    deaths: [exiled],
    hunter: s.players[exiled]!.role === 'hunter' ? exiled : null,
    hunterDone: false,
    badgeDone: false,
    lastWords: [exiled],
  };
  continueBatch(s, ev);
}

// ---- 警长 ---------------------------------------------------------------

function resolveSignup(s: WerewolfState, ev: Events): void {
  const ids = alive(s);
  const cands = ids.filter((id) => s.signups[id]);
  s.campaigners = cands;
  s.candidates = cands;
  // 无人上警或全员上警（没有警下投票人）：警徽流失
  if (cands.length === 0 || cands.length === ids.length) return electSheriff(s, null, null, false, ev);
  if (cands.length === 1) return electSheriff(s, cands[0]!, null, false, ev);
  beginSpeech(s, 'sheriff-speech', cands, ev);
}

function electSheriff(s: WerewolfState, id: string | null, votes: Record<string, string | null> | null, pk: boolean, ev: Events): void {
  s.publicHistory.push({ kind: 'sheriff', round: s.round, candidates: [...s.campaigners], votes, pk, elected: id, tied: [] });
  s.sheriff = id;
  s.sheriffElectionDone = true;
  s.candidates = [];
  s.speech = null;
  ev.push({ type: 'sheriff', elected: id });
  dawn(s, ev);
}

// ---- 校验 ---------------------------------------------------------------

export function validate(s: WerewolfState, a: WerewolfAction, actor: string, hasTimer: boolean): Validation {
  if (s.result) return no('GAME_OVER');
  if (a.type === 'PHASE_TIMEOUT') return actor !== 'system' ? no('FORBIDDEN') : hasTimer ? ok : no('WRONG_PHASE');
  if (a.type === 'SKIP_SPEECH') {
    // 公共控制：Host 校验房主身份后以 system 执行
    if (actor !== 'system') return no('FORBIDDEN');
    if (s.config.speechSec !== 0) return no('DISABLED');
    return currentSpeaker(s) ? ok : no('WRONG_PHASE');
  }
  const me = actor === 'system' ? undefined : s.players[actor];
  if (!me) return no('NOT_A_PLAYER');
  const phaseIs = (...ps: Phase[]): boolean => ps.includes(s.phase);
  const role = (r: Role): Validation | null => (!me.alive ? no('DEAD') : me.role !== r ? no('FORBIDDEN') : null);
  switch (a.type) {
    case 'CONFIRM_ROLE':
      if (!phaseIs('reveal')) return no('WRONG_PHASE');
      return s.confirmed.includes(actor) ? no('ALREADY_SUBMITTED') : ok;
    case 'WOLF_SELECT':
    case 'WOLF_VOTE': {
      if (!phaseIs('night-wolf')) return no('WRONG_PHASE');
      const bad = role('wolf');
      if (bad) return bad;
      if (actor in s.wolfVotes) return no('ALREADY_SUBMITTED');
      if (a.targetId !== null && !isAlive(s, a.targetId)) return no('BAD_TARGET');
      if (s.wolfRevote && !s.wolfRevote.includes(a.targetId)) return no('BAD_TARGET');
      return ok;
    }
    case 'WITCH_ACTION': {
      if (!phaseIs('night-witch')) return no('WRONG_PHASE');
      const bad = role('witch');
      if (bad) return bad;
      if (s.witchAction) return no('ALREADY_SUBMITTED');
      if (a.action === 'save') {
        if (!s.witchInventory.antidote) return no('NO_ANTIDOTE');
        if (!s.wolfTarget) return no('BAD_TARGET');
        const rule = s.config.witchSelfSave;
        if (s.wolfTarget === actor && (rule === 'never' || (rule === 'first-night' && s.round !== 1))) return no('NO_SELF_SAVE');
      }
      if (a.action === 'poison') {
        if (!s.witchInventory.poison) return no('NO_POISON');
        if (!a.targetId || a.targetId === actor || !isAlive(s, a.targetId)) return no('BAD_TARGET');
      }
      return ok;
    }
    case 'SEER_CHECK':
    case 'SEER_PASS': {
      if (!phaseIs('night-seer')) return no('WRONG_PHASE');
      const bad = role('seer');
      if (bad) return bad;
      if (s.seerActed) return no('ALREADY_SUBMITTED');
      if (a.type === 'SEER_CHECK' && (a.targetId === actor || !isAlive(s, a.targetId))) return no('BAD_TARGET');
      return ok;
    }
    case 'HUNTER_SHOOT':
      if (!phaseIs('hunter')) return no('WRONG_PHASE');
      if (s.batch?.hunter !== actor) return no('FORBIDDEN');
      if (a.targetId !== null && (a.targetId === actor || !isAlive(s, a.targetId))) return no('BAD_TARGET');
      return ok;
    case 'BADGE_PASS':
      if (!phaseIs('badge')) return no('WRONG_PHASE');
      if (s.sheriff !== actor) return no('FORBIDDEN');
      if (a.targetId !== null && !isAlive(s, a.targetId)) return no('BAD_TARGET');
      return ok;
    case 'SHERIFF_SIGNUP':
      if (!phaseIs('sheriff-signup')) return no('WRONG_PHASE');
      if (!me.alive) return no('DEAD');
      return actor in s.signups ? no('ALREADY_SUBMITTED') : ok;
    case 'SHERIFF_WITHDRAW':
      if (!phaseIs('sheriff-speech')) return no('WRONG_PHASE');
      return s.candidates.includes(actor) ? ok : no('FORBIDDEN');
    case 'SHERIFF_ORDER':
      if (!phaseIs('sheriff-order')) return no('WRONG_PHASE');
      return s.sheriff === actor ? ok : no('FORBIDDEN');
    case 'END_SPEECH':
      if (!SPEECH_PHASES.includes(s.phase)) return no('WRONG_PHASE');
      return currentSpeaker(s) === actor ? ok : no('NOT_YOUR_TURN');
    case 'VOTE':
      if (!VOTE_PHASES.includes(s.phase)) return no('WRONG_PHASE');
      if (!me.alive) return no('DEAD');
      if (!s.voters.includes(actor)) return no('FORBIDDEN');
      if (actor in s.votes) return no('ALREADY_SUBMITTED');
      if (a.targetId !== null && (a.targetId === actor || !s.voteTargets.includes(a.targetId) || !isAlive(s, a.targetId))) return no('BAD_TARGET');
      return ok;
    case 'EXPLODE': {
      if (!s.config.selfExplode) return no('DISABLED');
      if (!EXPLODE_PHASES.includes(s.phase)) return no('WRONG_PHASE');
      return role('wolf') ?? ok;
    }
  }
}

// ---- 结算 ---------------------------------------------------------------

export function reduce(prev: WerewolfState, a: WerewolfAction, actor: string): { state: WerewolfState; events: Events } {
  const s: WerewolfState = JSON.parse(JSON.stringify(prev)) as WerewolfState;
  const ev: Events = [];
  switch (a.type) {
    case 'CONFIRM_ROLE':
      s.confirmed.push(actor);
      if (s.confirmed.length === Object.keys(s.players).length) startNight(s, ev);
      break;
    case 'WOLF_SELECT':
      s.wolfIntents[actor] = a.targetId;
      break;
    case 'WOLF_VOTE':
      s.wolfVotes[actor] = a.targetId;
      s.wolfIntents[actor] = a.targetId;
      if (aliveRole(s, 'wolf').every((w) => w in s.wolfVotes)) resolveWolves(s, ev);
      break;
    case 'WITCH_ACTION':
      if (a.action === 'save') s.witchInventory.antidote = false;
      if (a.action === 'poison') s.witchInventory.poison = false;
      s.witchAction = a.action === 'poison' ? { kind: 'poison', target: a.targetId } : { kind: a.action };
      enter(s, 'night-seer', ev);
      break;
    case 'SEER_CHECK':
      // 先展示结果（计时步骤变化，phaseId 不变），到时再结算夜晚
      s.seerActed = true;
      s.seerLastCheck = a.targetId;
      s.seerChecks[a.targetId] = teamOf(s.players[a.targetId]!.role);
      break;
    case 'SEER_PASS':
      s.seerActed = true;
      resolveNight(s, ev);
      break;
    case 'HUNTER_SHOOT':
      if (a.targetId) {
        kill(s, a.targetId, 'shot', 'day');
        s.batch!.deaths.push(a.targetId);
        s.publicHistory.push({ kind: 'shot', round: s.round, shooter: actor, target: a.targetId });
        ev.push({ type: 'shot', target: a.targetId });
      }
      continueBatch(s, ev);
      break;
    case 'BADGE_PASS':
      passBadge(s, a.targetId, ev);
      break;
    case 'SHERIFF_SIGNUP':
      s.signups[actor] = a.join;
      if (alive(s).every((id) => id in s.signups)) resolveSignup(s, ev);
      break;
    case 'SHERIFF_WITHDRAW': {
      const speaking = currentSpeaker(s) === actor;
      s.candidates = s.candidates.filter((id) => id !== actor);
      if (s.candidates.length <= 1) electSheriff(s, s.candidates[0] ?? null, null, false, ev);
      else if (speaking) advanceSpeech(s, ev);
      break;
    }
    case 'SHERIFF_ORDER':
      sheriffOrder(s, a.dir, ev);
      break;
    case 'END_SPEECH':
    case 'SKIP_SPEECH':
      advanceSpeech(s, ev);
      break;
    case 'VOTE':
      s.votes[actor] = a.targetId;
      if (s.voters.every((id) => id in s.votes)) resolveVote(s, ev);
      break;
    case 'EXPLODE':
      explode(s, actor, ev);
      break;
    case 'PHASE_TIMEOUT':
      timeout(s, ev);
      break;
  }
  return { state: s, events: ev };
}

function passBadge(s: WerewolfState, to: string | null, ev: Events): void {
  s.publicHistory.push({ kind: 'badge', round: s.round, from: s.sheriff!, to });
  s.sheriff = to;
  ev.push({ type: 'badge', to });
  continueBatch(s, ev);
}

function sheriffOrder(s: WerewolfState, dir: 'cw' | 'ccw', ev: Events): void {
  const sheriff = s.sheriff!;
  const d = dir === 'cw' ? 1 : -1;
  const start = nextAlive(s, s.seats[sheriff]!, d);
  // 警长最后发言（归票）
  const speakers = rotation(s, start, d).filter((id) => id !== sheriff);
  s.lastSpeechStart = start;
  beginSpeech(s, 'day-speech', [...speakers, sheriff], ev);
}

function explode(s: WerewolfState, wolf: string, ev: Events): void {
  const inElection = s.phase === 'sheriff-speech' || s.phase === 'sheriff-pk-speech';
  kill(s, wolf, 'explode', 'day');
  s.publicHistory.push({ kind: 'explode', round: s.round, playerId: wolf });
  ev.push({ type: 'explode', playerId: wolf });
  s.speech = null;
  if (inElection) {
    // 竞选中自爆：警徽流失，公布死讯并处理死亡后直接入夜
    s.skipDayTalk = true;
    s.publicHistory.push({ kind: 'sheriff', round: s.round, candidates: [...s.campaigners], votes: null, pk: false, elected: null, tied: [] });
    s.sheriffElectionDone = true;
    s.sheriff = null;
    s.candidates = [];
    ev.push({ type: 'sheriff', elected: null });
    return dawn(s, ev);
  }
  if (s.sheriff === wolf) {
    s.publicHistory.push({ kind: 'badge', round: s.round, from: wolf, to: null });
    s.sheriff = null;
    ev.push({ type: 'badge', to: null });
  }
  s.batch = { kind: 'explode', deaths: [wolf], hunter: null, hunterDone: true, badgeDone: true, lastWords: [] };
  continueBatch(s, ev);
}

function timeout(s: WerewolfState, ev: Events): void {
  switch (s.phase) {
    case 'night-wolf':
      return resolveWolves(s, ev);
    case 'night-witch':
      s.witchAction = s.witchAction ?? { kind: 'pass' };
      return enter(s, 'night-seer', ev);
    case 'night-seer':
      return resolveNight(s, ev);
    case 'hunter':
      return continueBatch(s, ev);
    case 'badge':
      return passBadge(s, null, ev);
    case 'sheriff-signup':
      return resolveSignup(s, ev);
    case 'sheriff-order':
      return sheriffOrder(s, 'cw', ev);
    default:
      if (SPEECH_PHASES.includes(s.phase)) return advanceSpeech(s, ev);
      if (VOTE_PHASES.includes(s.phase)) return resolveVote(s, ev);
  }
}
