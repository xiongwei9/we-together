import { button, card, column, row, spacer, text, theme, type UINode } from '@we/framework';
import type { GamePresentation, GameSceneContext } from '@we/game-app';
import type { Phase, Role, WerewolfAction, WerewolfPlayerView } from '../rules/types';

const ROLE_NAME: Record<Role, string> = { wolf: '狼人', seer: '预言家', witch: '女巫', villager: '平民' };
const ROLE_DESC: Record<Role, string> = {
  wolf: '夜间与队友合议击杀一名玩家。两狼意见一致才会生效。',
  seer: '每晚查验一名其他存活玩家的阵营，结果仅你可见。',
  witch: '一瓶解药、一瓶毒药，各限一次；同一夜最多用一种。仅首夜可自救。',
  villager: '没有夜间技能。白天通过讨论和投票找出狼人。',
};
const PHASE_NAME: Record<Phase, string> = {
  reveal: '查看身份',
  'night-wolf': '黑夜 · 狼人行动',
  'night-seer': '黑夜 · 预言家行动',
  'night-witch': '黑夜 · 女巫行动',
  'night-resolve': '黑夜结算',
  'day-discuss': '白天 · 讨论',
  'day-vote': '白天 · 投票',
  'day-resolve': '白天结算',
  finished: '游戏结束',
};

type Ctx = GameSceneContext & { view: WerewolfPlayerView };

const roleColor = (r: Role): string => (r === 'wolf' ? theme.wolf : theme.good);
const isNight = (p: Phase): boolean => p.startsWith('night');

function topBar(ctx: Ctx): UINode {
  const v = ctx.view;
  const secs = ctx.remainingMs === null ? null : Math.ceil(ctx.remainingMs / 1000);
  return row({ gap: 10, height: 44 }, [
    column({ flex: 1, gap: 2 }, [
      text(v.round > 0 ? `第 ${v.round} 轮` : '准备阶段', { size: 13, color: theme.muted }),
      text(PHASE_NAME[v.phase], { size: 19, weight: 'bold' }),
    ]),
    secs !== null
      ? column({ bg: secs <= 5 ? theme.danger : theme.surfaceAlt, radius: 22, width: 64, height: 44, align: 'center', justify: 'center' }, [
          text(ctx.paused ? '暂停' : `${secs}s`, { size: 18, weight: 'bold', align: 'center' }),
        ])
      : null,
    button(ctx.local.showRole ? '收起身份' : '我的身份', {
      onPress: () => ctx.setLocal({ showRole: !ctx.local.showRole }),
      variant: 'secondary',
      height: 40,
      size: 14,
    }),
  ]);
}

function roleCard(ctx: Ctx): UINode | null {
  const v = ctx.view;
  if (!v.me || !ctx.local.showRole) return null;
  const role = v.me.role;
  return card(
    [
      row({ justify: 'space-between' }, [
        text(`${ctx.nameOf(v.me.playerId)}`, { color: theme.muted, size: 14 }),
        text(v.me.alive ? '存活' : '已出局', { size: 14, color: v.me.alive ? theme.success : theme.danger }),
      ]),
      text(ROLE_NAME[role], { size: 30, weight: 'bold', color: roleColor(role) }),
      text(ROLE_DESC[role], { size: 14, color: theme.muted }),
      v.wolf ? text(`狼队友：${v.wolf.teammates.map(ctx.nameOf).join('、') || '无'}`, { size: 15, color: theme.wolf }) : null,
      v.seer && Object.keys(v.seer.checks).length
        ? text(
            `查验记录：${Object.entries(v.seer.checks)
              .map(([id, t]) => `${ctx.nameOf(id)}=${t === 'wolf' ? '狼人' : '好人'}`)
              .join('；')}`,
            { size: 14 },
          )
        : null,
      v.witch ? text(`解药：${v.witch.antidote ? '可用' : '已用'}　毒药：${v.witch.poison ? '可用' : '已用'}`, { size: 14 }) : null,
    ],
    { borderColor: roleColor(role) },
  );
}

function playerGrid(ctx: Ctx, options: { selectable?: (id: string) => boolean; selected?: string | null; onSelect?: (id: string) => void; badge?: (id: string) => string | null }): UINode {
  const v = ctx.view;
  const rows: UINode[] = [];
  for (let i = 0; i < v.players.length; i += 2) {
    rows.push(
      row(
        { gap: 8 },
        v.players.slice(i, i + 2).map((p) => {
          const canSelect = !!options.selectable?.(p.playerId);
          const selected = options.selected === p.playerId;
          const badge = options.badge?.(p.playerId);
          const isMe = p.playerId === v.me?.playerId;
          return {
            ...row(
              {
                flex: 1,
                height: 52,
                radius: 10,
                padding: [0, 12, 0, 12],
                gap: 6,
                bg: selected ? '#5a4a20' : p.alive ? theme.surface : '#18161f',
                borderColor: selected ? theme.primary : isMe ? theme.muted : theme.border,
                borderWidth: selected ? 2 : 1,
                opacity: p.alive ? 1 : 0.55,
              },
              [
                text(ctx.nameOf(p.playerId), { size: 15, flex: 1, maxLines: 1, color: p.alive ? theme.text : theme.muted }),
                badge ? text(badge, { size: 12, color: theme.primary }) : null,
                !p.alive ? text('出局', { size: 12, color: theme.danger }) : null,
              ],
            ),
            onPress: canSelect && options.onSelect ? () => options.onSelect!(p.playerId) : undefined,
            disabled: !canSelect,
            pressedBg: '#3a3554',
          };
        }),
      ),
    );
  }
  return column({ gap: 8 }, rows);
}

/** 当前阶段最近一次提交的状态：提交中 / 失败重试 */
function commandBar(ctx: Ctx): UINode | null {
  const last = [...ctx.commands].reverse().find((c) => c.kind === 'game');
  if (!last) return null;
  if (last.status === 'pending') return text('提交中…', { align: 'center', color: theme.muted });
  if (last.status === 'failed') return button('网络失败，点击重试', { onPress: () => ctx.retry(last.commandId), variant: 'danger', height: 40, size: 15 });
  return null;
}

function submit(ctx: Ctx, action: WerewolfAction): void {
  ctx.send(action);
}

function waitingNight(ctx: Ctx): UINode {
  return column({ flex: 1, bg: theme.night, radius: 16, align: 'center', justify: 'center', gap: 10, padding: 20 }, [
    text('🌙', { size: 48, align: 'center' }),
    text('天黑请闭眼', { size: 24, weight: 'bold', align: 'center' }),
    text(ctx.view.me?.alive === false ? '你已出局，可以旁观公开信息' : '请等待其他角色行动', { size: 14, color: theme.muted, align: 'center' }),
  ]);
}

function revealPanel(ctx: Ctx): UINode {
  const v = ctx.view;
  const done = v.submitted;
  return column({ flex: 1, gap: 14 }, [
    ctx.local.showRole
      ? null
      : {
          ...column({ height: 220, bg: theme.surfaceAlt, radius: 16, align: 'center', justify: 'center', gap: 8, borderColor: theme.primary, borderWidth: 1 }, [
            text('🂠', { size: 56, align: 'center', color: theme.primary }),
            text('点击翻看身份（注意遮挡）', { size: 16, align: 'center' }),
          ]),
          onPress: () => ctx.setLocal({ showRole: true }),
          pressedBg: '#3a3554',
        },
    spacer(1),
    text(`已确认 ${v.confirmedCount}/${v.players.length}`, { align: 'center', color: theme.muted }),
    button(done ? '已确认，等待其他玩家' : '我已记住身份', { onPress: done ? undefined : () => submit(ctx, { type: 'CONFIRM_ROLE' }), height: 56 }),
  ]);
}

function wolfPanel(ctx: Ctx): UINode {
  const v = ctx.view;
  const mates = new Set(v.wolf?.teammates ?? []);
  const target = (ctx.local.target as string | null | undefined) ?? null;
  const votes = v.wolf?.votes ?? {};
  return column({ flex: 1, gap: 12 }, [
    text('选择今晚的目标（两狼一致才生效）', { size: 15, color: theme.muted }),
    playerGrid(ctx, {
      selectable: (id) => !v.submitted && !mates.has(id) && id !== v.me?.playerId && !!v.players.find((p) => p.playerId === id)?.alive,
      selected: target,
      onSelect: (id) => ctx.setLocal({ target: id }),
      badge: (id) => {
        if (mates.has(id)) return id in votes ? `队友→${votes[id] ? ctx.nameOf(votes[id]!).split(' ')[0] : '弃权'}` : '队友';
        return null;
      },
    }),
    spacer(1),
    commandBar(ctx),
    v.submitted
      ? text(`你已选择：${votes[v.me!.playerId] ? ctx.nameOf(votes[v.me!.playerId]!) : '弃权'}，等待队友`, { align: 'center', color: theme.muted })
      : row({ gap: 10 }, [
          button('确认击杀', { onPress: target ? () => submit(ctx, { type: 'WOLF_VOTE', targetId: target }) : undefined, flex: 1, variant: 'danger' }),
          button('弃权', { onPress: () => submit(ctx, { type: 'WOLF_VOTE', targetId: null }), variant: 'secondary', width: 90 }),
        ]),
  ]);
}

function seerPanel(ctx: Ctx): UINode {
  const v = ctx.view;
  const target = (ctx.local.target as string | undefined) ?? null;
  const checks = v.seer?.checks ?? {};
  return column({ flex: 1, gap: 12 }, [
    text('选择一名玩家查验阵营', { size: 15, color: theme.muted }),
    playerGrid(ctx, {
      selectable: (id) => !v.submitted && id !== v.me?.playerId && !!v.players.find((p) => p.playerId === id)?.alive,
      selected: target,
      onSelect: (id) => ctx.setLocal({ target: id }),
      badge: (id) => (checks[id] ? (checks[id] === 'wolf' ? '狼人' : '好人') : null),
    }),
    spacer(1),
    commandBar(ctx),
    button('查验', { onPress: target && !v.submitted ? () => submit(ctx, { type: 'SEER_CHECK', targetId: target }) : undefined, height: 52 }),
  ]);
}

function witchPanel(ctx: Ctx): UINode {
  const v = ctx.view;
  const w = v.witch!;
  const mode = (ctx.local.mode as 'poison' | undefined) ?? null;
  const target = (ctx.local.target as string | undefined) ?? null;
  if (mode === 'poison') {
    return column({ flex: 1, gap: 12 }, [
      text('选择要使用毒药的玩家', { size: 15, color: theme.muted }),
      playerGrid(ctx, {
        selectable: (id) => id !== v.me?.playerId && !!v.players.find((p) => p.playerId === id)?.alive,
        selected: target,
        onSelect: (id) => ctx.setLocal({ target: id }),
      }),
      spacer(1),
      commandBar(ctx),
      row({ gap: 10 }, [
        button('确认用毒', { onPress: target ? () => submit(ctx, { type: 'WITCH_ACTION', action: 'poison', targetId: target }) : undefined, flex: 1, variant: 'danger' }),
        button('返回', { onPress: () => ctx.setLocal({ mode: null, target: null }), variant: 'secondary', width: 90 }),
      ]),
    ]);
  }
  return column({ flex: 1, gap: 12 }, [
    card([
      text('今晚的情况', { size: 14, color: theme.muted }),
      text(
        w.antidote ? (w.wolfTarget ? `${ctx.nameOf(w.wolfTarget)} 被狼人选中` : '今晚无人被狼人选中') : '解药已用完，无法得知今晚情况',
        { size: 18, weight: 'bold' },
      ),
    ]),
    spacer(1),
    commandBar(ctx),
    button(w.canSave ? '使用解药' : '解药不可用', { onPress: w.canSave ? () => submit(ctx, { type: 'WITCH_ACTION', action: 'save' }) : undefined, height: 52, variant: 'primary' }),
    button(w.poison ? '使用毒药…' : '毒药已用', { onPress: w.poison ? () => ctx.setLocal({ mode: 'poison' }) : undefined, height: 52, variant: 'danger' }),
    button('今晚不用药', { onPress: () => submit(ctx, { type: 'WITCH_ACTION', action: 'pass' }), height: 52, variant: 'secondary' }),
  ]);
}

function lastResults(ctx: Ctx): UINode | null {
  const h = ctx.view.history;
  if (!h.length) return null;
  const items = h.slice(-2).map((r) => {
    if (r.kind === 'night') return `第${r.round}夜：${r.deaths.length ? `${r.deaths.map(ctx.nameOf).join('、')} 死亡` : '平安夜'}`;
    const votes = Object.entries(r.votes ?? {})
      .map(([from, to]) => `${ctx.nameOf(from).split(' ')[0]}→${to ? ctx.nameOf(to).split(' ')[0] : '弃'}`)
      .join(' ');
    return `第${r.round}天：${r.exiled ? `${ctx.nameOf(r.exiled)} 被放逐` : '无人放逐'}\n${votes}`;
  });
  return card(items.map((s) => text(s, { size: 14 })), { gap: 6 });
}

function discussPanel(ctx: Ctx): UINode {
  return column({ flex: 1, gap: 12 }, [
    lastResults(ctx),
    playerGrid(ctx, {}),
    spacer(1),
    text('线下自由讨论。由房主控制结束讨论。', { size: 14, color: theme.muted, align: 'center' }),
    ctx.isHost ? button('结束讨论，开始投票', { onPress: () => submit(ctx, { type: 'END_DISCUSSION' }), height: 52 }) : null,
    commandBar(ctx),
  ]);
}

function votePanel(ctx: Ctx): UINode {
  const v = ctx.view;
  const target = (ctx.local.target as string | undefined) ?? null;
  if (v.pendingAction !== 'day-vote')
    return column({ flex: 1, gap: 12 }, [playerGrid(ctx, {}), spacer(1), text('你已出局，等待投票结果', { align: 'center', color: theme.muted })]);
  return column({ flex: 1, gap: 12 }, [
    text('投票放逐一名玩家（不可投自己，可弃权）', { size: 15, color: theme.muted }),
    playerGrid(ctx, {
      selectable: (id) => !v.submitted && id !== v.me?.playerId && !!v.players.find((p) => p.playerId === id)?.alive,
      selected: v.submitted ? (v.myDayVote ?? null) : target,
      onSelect: (id) => ctx.setLocal({ target: id }),
    }),
    spacer(1),
    commandBar(ctx),
    v.submitted
      ? text(`已投票：${v.myDayVote ? ctx.nameOf(v.myDayVote) : '弃权'}`, { align: 'center', color: theme.muted })
      : row({ gap: 10 }, [
          button('确认投票', { onPress: target ? () => submit(ctx, { type: 'DAY_VOTE', targetId: target }) : undefined, flex: 1 }),
          button('弃权', { onPress: () => submit(ctx, { type: 'DAY_VOTE', targetId: null }), variant: 'secondary', width: 90 }),
        ]),
  ]);
}

function resultPanel(ctx: Ctx): UINode {
  const r = ctx.view.result!;
  const title = r.winner === 'draw' ? '平局' : r.winner === 'wolf' ? '狼人阵营胜利' : '好人阵营胜利';
  const mine = ctx.view.me ? (r.winner === 'draw' ? null : (ctx.view.me.role === 'wolf') === (r.winner === 'wolf')) : null;
  return column({ flex: 1, gap: 12 }, [
    text(title, { size: 30, weight: 'bold', align: 'center', color: r.winner === 'wolf' ? theme.wolf : theme.good }),
    mine === null ? null : text(mine ? '你赢了！' : '你输了', { align: 'center', size: 18 }),
    card(
      ctx.view.players.map((p) =>
        row({ justify: 'space-between' }, [
          text(`${ctx.nameOf(p.playerId)}${p.alive ? '' : '（出局）'}`, { size: 15, flex: 1 }),
          text(ROLE_NAME[r.roles[p.playerId]!], { size: 15, weight: 'bold', color: roleColor(r.roles[p.playerId]!) }),
        ]),
      ),
    ),
    lastResults(ctx),
    spacer(1),
    ctx.isHost ? text('房主可返回房间开始新一局', { align: 'center', color: theme.muted, size: 13 }) : text('等待房主开始新一局', { align: 'center', color: theme.muted, size: 13 }),
  ]);
}

function phasePanel(ctx: Ctx): UINode {
  const v = ctx.view;
  if (v.result) return resultPanel(ctx);
  switch (v.phase) {
    case 'reveal':
      return revealPanel(ctx);
    case 'night-wolf':
      return v.pendingAction === 'wolf-vote' ? wolfPanel(ctx) : waitingNight(ctx);
    case 'night-seer':
      return v.pendingAction === 'seer-check' && !v.submitted ? seerPanel(ctx) : waitingNight(ctx);
    case 'night-witch':
      return v.pendingAction === 'witch' && !v.submitted ? witchPanel(ctx) : waitingNight(ctx);
    case 'day-discuss':
      return discussPanel(ctx);
    case 'day-vote':
      return votePanel(ctx);
    default:
      return waitingNight(ctx);
  }
}

export const werewolfPresentation: GamePresentation = {
  render(raw) {
    const ctx = raw as Ctx;
    const night = isNight(ctx.view.phase);
    return column({ flex: 1, padding: [ctx.safeArea.top + 12, 16, ctx.safeArea.bottom + 16, 16], gap: 12, bg: night ? theme.night : theme.bg }, [
      topBar(ctx),
      roleCard(ctx),
      phasePanel(ctx),
    ]);
  },
};
