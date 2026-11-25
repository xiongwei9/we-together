import type { WerewolfAction, WerewolfPlayerView } from './types';

/**
 * 测试 / 模拟器用的简单 Bot：只读取本玩家的授权视图，经正常 Client 命令链路提交。
 * 返回 null 表示当前无需行动。
 */
export function chooseBotAction(view: WerewolfPlayerView, rng: () => number): WerewolfAction | null {
  if (!view.me || view.submitted || !view.pendingAction) return null;
  const me = view.me.playerId;
  const pick = <T>(xs: readonly T[]): T | null => (xs.length ? xs[Math.floor(rng() * xs.length)]! : null);
  const aliveOthers = view.players.filter((p) => p.alive && p.playerId !== me).map((p) => p.playerId);
  switch (view.pendingAction) {
    case 'confirm':
      return { type: 'CONFIRM_ROLE' };
    case 'wolf-vote': {
      const mates = new Set(view.wolf?.teammates ?? []);
      // 优先跟随队友已投目标，避免空刀
      const mateVote = Object.entries(view.wolf?.votes ?? {}).find(([id, t]) => mates.has(id) && t)?.[1] ?? null;
      // 两只 Bot 狼同时行动时各自看不到对方：按轮次从相同候选中确定性选择，保证意见一致
      const candidates = view.players.filter((p) => p.alive && p.playerId !== me && !mates.has(p.playerId)).map((p) => p.playerId);
      return { type: 'WOLF_VOTE', targetId: mateVote ?? candidates[view.round % Math.max(1, candidates.length)] ?? null };
    }
    case 'seer-check': {
      const unchecked = aliveOthers.filter((id) => !(id in (view.seer?.checks ?? {})));
      const target = pick(unchecked);
      return target ? { type: 'SEER_CHECK', targetId: target } : { type: 'SEER_PASS' };
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
    case 'day-vote': {
      if (rng() < 0.1) return { type: 'DAY_VOTE', targetId: null };
      const checks = view.seer?.checks ?? {};
      const knownWolf = aliveOthers.find((id) => checks[id] === 'wolf');
      const mates = new Set(view.wolf?.teammates ?? []);
      const candidates = aliveOthers.filter((id) => !mates.has(id));
      return { type: 'DAY_VOTE', targetId: knownWolf ?? pick(candidates) };
    }
  }
}
