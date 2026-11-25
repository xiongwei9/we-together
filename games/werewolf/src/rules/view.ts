import { EXPLODE_PHASES, SPEECH_PHASES, VOTE_PHASES, currentSpeaker, order } from './engine';
import type { PendingAction, WerewolfPlayerView, WerewolfState } from './types';

/** 当前玩家需要执行的操作 */
function pendingFor(s: WerewolfState, id: string): { action: PendingAction; submitted: boolean } {
  const me = s.players[id];
  const none = { action: null, submitted: false };
  if (!me || s.result) return none;
  switch (s.phase) {
    case 'reveal':
      return { action: 'confirm', submitted: s.confirmed.includes(id) };
    case 'night-wolf':
      return me.alive && me.role === 'wolf' ? { action: 'wolf-vote', submitted: id in s.wolfVotes } : none;
    case 'night-witch':
      return me.alive && me.role === 'witch' ? { action: 'witch', submitted: s.witchAction !== null } : none;
    case 'night-seer':
      return me.alive && me.role === 'seer' ? { action: 'seer-check', submitted: s.seerActed } : none;
    case 'hunter':
      return s.batch?.hunter === id ? { action: 'hunter', submitted: false } : none;
    case 'badge':
      return s.sheriff === id ? { action: 'badge', submitted: false } : none;
    case 'sheriff-signup':
      return me.alive ? { action: 'sheriff-signup', submitted: id in s.signups } : none;
    case 'sheriff-order':
      return s.sheriff === id ? { action: 'sheriff-order', submitted: false } : none;
    default:
      if (SPEECH_PHASES.includes(s.phase)) return currentSpeaker(s) === id ? { action: 'speak', submitted: false } : none;
      if (VOTE_PHASES.includes(s.phase)) return s.voters.includes(id) ? { action: 'vote', submitted: id in s.votes } : none;
      return none;
  }
}

/** 隐藏计时阶段中本人操作的时限（其他人看不到任何计时） */
function actionLimit(s: WerewolfState, action: PendingAction): number | null {
  const t = s.config.timers;
  switch (action) {
    case 'wolf-vote':
      return s.wolfRevote ? t.wolfRevoteMs : t.wolfMs;
    case 'witch':
      return t.witchMs;
    case 'seer-check':
      return t.seerMs;
    case 'hunter':
      return t.hunterMs;
    default:
      return null;
  }
}

/** 显式白名单投影：不 spread 完整 State */
export function projectView(s: WerewolfState, playerId: string): WerewolfPlayerView {
  const me = s.players[playerId];
  const pending = pendingFor(s, playerId);
  const c = s.config;
  const night = s.phase.startsWith('night');

  // 出局玩家只接收公开信息（猎人开枪资格除外）
  let wolf: WerewolfPlayerView['wolf'] = null;
  if (me?.alive && me.role === 'wolf') {
    wolf = {
      teammates: order(s).filter((id) => id !== playerId && s.players[id]!.role === 'wolf'),
      votes: s.phase === 'night-wolf' ? { ...s.wolfVotes } : null,
      intents: s.phase === 'night-wolf' ? { ...s.wolfIntents } : null,
      revote: s.phase === 'night-wolf' && s.wolfRevote ? [...s.wolfRevote] : null,
      target: night && s.phase !== 'night-wolf' ? s.wolfTarget : null,
    };
  }

  let seer: WerewolfPlayerView['seer'] = null;
  if (me?.alive && me.role === 'seer') {
    const last = s.phase === 'night-seer' ? s.seerLastCheck : null;
    seer = { checks: { ...s.seerChecks }, lastCheck: last ? { targetId: last, team: s.seerChecks[last]! } : null };
  }

  let witch: WerewolfPlayerView['witch'] = null;
  if (me?.alive && me.role === 'witch') {
    // 只有解药未用时才能看到刀口
    const wolfTarget = s.phase === 'night-witch' && s.witchInventory.antidote ? s.wolfTarget : null;
    const rule = c.witchSelfSave;
    const selfOk = rule === 'always' || (rule === 'first-night' && s.round === 1);
    witch = {
      antidote: s.witchInventory.antidote,
      poison: s.witchInventory.poison,
      wolfTarget,
      canSave: !!wolfTarget && (wolfTarget !== playerId || selfOk),
    };
  }

  const hunter = s.phase === 'hunter' && me?.role === 'hunter' && s.batch?.deaths.includes(playerId) ? { canShoot: s.batch.hunter === playerId } : null;

  const speaker = currentSpeaker(s);
  const inVote = VOTE_PHASES.includes(s.phase);
  const showCandidates = s.phase.startsWith('sheriff-') ? s.phase !== 'sheriff-signup' && s.phase !== 'sheriff-order' : s.phase.startsWith('pk-');

  return {
    rulesVersion: s.rulesVersion,
    rules: { board: c.board, sheriff: c.sheriff, witchSelfSave: c.witchSelfSave, wolfKill: c.wolfKill, selfExplode: c.selfExplode, speechSec: c.speechSec },
    round: s.round,
    phase: s.phase,
    players: order(s).map((id) => ({ playerId: id, seat: s.seats[id]!, alive: s.players[id]!.alive })),
    sheriff: s.sheriff,
    me: me ? { playerId, seat: s.seats[playerId]!, role: me.role, alive: me.alive } : null,
    confirmedCount: s.confirmed.length,
    speech: speaker && s.speech ? { order: [...s.speech.order], current: speaker } : null,
    candidates: showCandidates ? [...s.candidates] : null,
    progress:
      s.phase === 'sheriff-signup'
        ? { done: Object.keys(s.signups).length, total: order(s).filter((id) => s.players[id]!.alive).length }
        : inVote
          ? { done: Object.keys(s.votes).length, total: s.voters.length }
          : null,
    vote: inVote && s.voters.includes(playerId) ? { targets: s.voteTargets.filter((t) => t !== playerId), myVote: playerId in s.votes ? s.votes[playerId] : undefined } : null,
    wolf,
    seer,
    witch,
    hunter,
    pendingAction: pending.action,
    submitted: pending.submitted,
    actionLimitMs: pending.submitted ? null : actionLimit(s, pending.action),
    canExplode: c.selfExplode && EXPLODE_PHASES.includes(s.phase) && !!me?.alive && me.role === 'wolf' && !s.result,
    canWithdraw: s.phase === 'sheriff-speech' && s.candidates.includes(playerId),
    history: JSON.parse(JSON.stringify(s.publicHistory)) as WerewolfPlayerView['history'],
    result: s.result
      ? {
          winner: s.result.winner,
          roles: Object.fromEntries(order(s).map((id) => [id, s.players[id]!.role])),
          deaths: JSON.parse(JSON.stringify(s.deaths)) as WerewolfState['deaths'],
          nights: JSON.parse(JSON.stringify(s.nightLog)) as WerewolfState['nightLog'],
        }
      : null,
  };
}
