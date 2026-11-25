import type { WerewolfAction, WerewolfPlayerView } from './types';

/**
 * 测试 / 模拟器用的简单 Bot：只读取本玩家的授权视图，经正常 Client 命令链路提交。
 * 返回 null 表示当前无需行动。
 */
export function chooseBotAction(view: WerewolfPlayerView, rng: () => number): WerewolfAction | null {
  if (!view.me || view.result) return null;
  const me = view.me.playerId;
  const pick = <T>(xs: readonly T[]): T | null => (xs.length ? xs[Math.floor(rng() * xs.length)]! : null);
  const aliveOthers = view.players.filter((p) => p.alive && p.playerId !== me).map((p) => p.playerId);
  const mates = new Set(view.wolf?.teammates ?? []);
  // 狼人偶尔在发言阶段自爆
  if (view.canExplode && rng() < 0.02) return { type: 'EXPLODE' };
  if (view.canWithdraw && rng() < 0.1) return { type: 'SHERIFF_WITHDRAW' };
  if (view.submitted || !view.pendingAction) return null;
  switch (view.pendingAction) {
    case 'confirm':
      return { type: 'CONFIRM_ROLE' };
    case 'wolf-vote': {
      const w = view.wolf;
      if (w?.revote) return { type: 'WOLF_VOTE', targetId: w.revote.find((t) => t !== null) ?? null };
      // 优先跟随队友已投目标；多只 Bot 狼同时行动时按轮次从相同候选中确定性选择，保证意见一致
      const mateVote = Object.entries(w?.votes ?? {}).find(([id, t]) => mates.has(id) && t)?.[1] ?? null;
      const candidates = aliveOthers.filter((id) => !mates.has(id));
      return { type: 'WOLF_VOTE', targetId: mateVote ?? candidates[view.round % Math.max(1, candidates.length)] ?? null };
    }
    case 'witch': {
      const w = view.witch;
      if (w?.canSave && rng() < 0.6) return { type: 'WITCH_ACTION', action: 'save' };
      if (w?.poison && rng() < 0.25) {
        const target = pick(aliveOthers);
        if (target) return { type: 'WITCH_ACTION', action: 'poison', targetId: target };
      }
      return { type: 'WITCH_ACTION', action: 'pass' };
    }
    case 'seer-check': {
      const unchecked = aliveOthers.filter((id) => !(id in (view.seer?.checks ?? {})));
      const target = pick(unchecked.length ? unchecked : aliveOthers);
      return target ? { type: 'SEER_CHECK', targetId: target } : { type: 'SEER_PASS' };
    }
    case 'hunter':
      return { type: 'HUNTER_SHOOT', targetId: view.hunter?.canShoot && rng() < 0.7 ? pick(aliveOthers) : null };
    case 'badge':
      return { type: 'BADGE_PASS', targetId: rng() < 0.8 ? pick(aliveOthers) : null };
    case 'sheriff-signup':
      return { type: 'SHERIFF_SIGNUP', join: rng() < 0.4 };
    case 'sheriff-order':
      return { type: 'SHERIFF_ORDER', dir: rng() < 0.5 ? 'cw' : 'ccw' };
    case 'speak':
      return { type: 'END_SPEECH' };
    case 'vote': {
      const targets = view.vote?.targets ?? [];
      if (rng() < 0.1) return { type: 'VOTE', targetId: null };
      const checks = view.seer?.checks ?? {};
      const knownWolf = targets.find((id) => checks[id] === 'wolf');
      return { type: 'VOTE', targetId: knownWolf ?? pick(targets.filter((id) => !mates.has(id))) ?? pick(targets) };
    }
  }
}
