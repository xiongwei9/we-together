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

/** 回合内不显示倒计时：阶段由玩家操作或房主推进 */
function topBar(ctx: Ctx): UINode {
  const v = ctx.view;
  return row({ gap: 10, height: 44 }, [
    column({ flex: 1, gap: 2 }, [
      text(v.round > 0 ? `第 ${v.round} 轮` : '准备阶段', { size: 13, color: theme.muted }),
      text(PHASE_NAME[v.phase], { size: 19, weight: 'bold' }),
    ]),
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

/**
 * 玩家网格。提供 selectable 时处于「选择目标」模式：不可选的存活玩家（本人、狼队友等）置灰。
 */
function playerGrid(ctx: Ctx, options: { selectable?: (id: string) => boolean; selected?: string | null; onSelect?: (id: string) => void; badge?: (id: string) => string | null }): UINode {
  const v = ctx.view;
  const selecting = !!options.selectable;
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
          const greyed = selecting && p.alive && !canSelect && !selected;
          return {
            ...row(
              {
                flex: 1,
                height: 52,
                radius: 10,
                padding: [0, 12, 0, 12],
                gap: 6,
                bg: selected ? '#5a4a20' : greyed ? '#1a1822' : p.alive ? theme.surface : '#18161f',
                borderColor: selected ? theme.primary : isMe ? theme.muted : theme.border,
                borderWidth: selected ? 2 : 1,
                opacity: !p.alive ? 0.55 : greyed ? 0.45 : 1,
              },
              [
                text(ctx.nameOf(p.playerId), { size: 15, flex: 1, maxLines: 1, color: p.alive && !greyed ? theme.text : theme.muted }),
                isMe ? text('我', { size: 12, color: theme.muted }) : null,
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
  // 狼人意向选择是即时同步，不显示「提交中」
  const last = [...ctx.commands].reverse().find((c) => c.kind === 'game' && c.label !== 'WOLF_SELECT');
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
    text('请等待其他角色行动', { size: 14, color: theme.muted, align: 'center' }),
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
  const me = v.me!.playerId;
  const mates = v.wolf?.teammates ?? [];
  const votes = v.wolf?.votes ?? {};
  const intents = v.wolf?.intents ?? {};
  const isAliveId = (id: string): boolean => !!v.players.find((p) => p.playerId === id)?.alive;
  const aliveMates = mates.filter(isAliveId);
  const seat = (id: string): string => ctx.nameOf(id).split(' ')[0]!;
  // 我的选择：已确认以狼票为准，否则以本地点选或已同步的意向为准
  const target = v.submitted ? (votes[me] ?? null) : ((ctx.local.target as string | undefined) ?? intents[me] ?? null);
  /** 队友的选择：已确认的狼票优先，其次是意向；undefined 表示还没选 */
  const mateChoice = (m: string): { id: string | null; confirmed: boolean } | undefined =>
    m in votes ? { id: votes[m]!, confirmed: true } : m in intents ? { id: intents[m]!, confirmed: false } : undefined;

  const select = (id: string): void => {
    ctx.setLocal({ target: id });
    // 意向即时同步给存活队友，不参与结算
    ctx.send({ type: 'WOLF_SELECT', targetId: id });
  };

  const mateLines = aliveMates.length
    ? aliveMates.map((m) => {
        const c = mateChoice(m);
        const desc = !c ? '还在选择' : c.id === null ? (c.confirmed ? '已确认弃权' : '暂未选择') : `${c.confirmed ? '已确认' : '想刀'} ${ctx.nameOf(c.id)}`;
        return text(`队友 ${ctx.nameOf(m)}：${desc}`, { size: 15, color: c?.confirmed ? theme.wolf : theme.text });
      })
    : [text('你的队友已出局，你的选择直接生效', { size: 15 })];

  let agreement: UINode | null = null;
  if (aliveMates.length && target) {
    const choices = aliveMates.map(mateChoice);
    if (choices.every((c) => c?.id === target)) agreement = text('与队友意见一致', { size: 13, color: theme.success });
    else if (choices.some((c) => c && c.id !== null && c.id !== target)) agreement = text('与队友不一致：两狼都确认后若仍不一致将空刀', { size: 13, color: theme.danger });
  }

  return column({ flex: 1, gap: 12 }, [
    text('选择今晚的目标（两狼一致才生效，可自刀）', { size: 15, color: theme.muted }),
    card(mateLines, { gap: 6, padding: 12, borderColor: theme.wolf }),
    playerGrid(ctx, {
      // 狼人可以刀任意存活玩家，包括自己和队友
      selectable: (id) => !v.submitted && isAliveId(id),
      selected: target,
      onSelect: select,
      badge: (id) => {
        const marks = aliveMates
          .filter((m) => mateChoice(m)?.id === id)
          .map((m) => `${seat(m)}${mateChoice(m)!.confirmed ? '已确认' : '想刀'}`);
        return [mates.includes(id) ? '队友' : null, ...marks].filter(Boolean).join(' ') || null;
      },
    }),
    agreement,
    spacer(1),
    commandBar(ctx),
    v.submitted
      ? text(`你已确认：${votes[me] ? ctx.nameOf(votes[me]!) : '弃权'}，等待队友`, { align: 'center', color: theme.muted })
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
  // 本人与已查验过的玩家置灰不可选
  const canCheck = (id: string): boolean => id !== v.me?.playerId && !(id in checks) && !!v.players.find((p) => p.playerId === id)?.alive;
  const anyTarget = v.players.some((p) => canCheck(p.playerId));
  return column({ flex: 1, gap: 12 }, [
    text(anyTarget ? '选择一名玩家查验阵营（已查验过的不可再选）' : '其他存活玩家都已查验过', { size: 15, color: theme.muted }),
    playerGrid(ctx, {
      selectable: (id) => !v.submitted && canCheck(id),
      selected: target,
      onSelect: (id) => ctx.setLocal({ target: id }),
      badge: (id) => (checks[id] ? (checks[id] === 'wolf' ? '狼人' : '好人') : null),
    }),
    spacer(1),
    commandBar(ctx),
    anyTarget
      ? button('查验', { onPress: target && !v.submitted ? () => submit(ctx, { type: 'SEER_CHECK', targetId: target }) : undefined, height: 52 })
      : button('今晚不查验', { onPress: v.submitted ? undefined : () => submit(ctx, { type: 'SEER_PASS' }), height: 52, variant: 'secondary' }),
  ]);
}

/** 查验完成后：展示结果并本地倒计时，提醒在倒计时结束前闭眼 */
function seerRevealPanel(ctx: Ctx): UINode {
  const seer = ctx.view.seer!;
  const check = seer.lastCheck!;
  const startedAt = ctx.local.revealAt as number | undefined;
  if (startedAt === undefined) ctx.setLocal({ revealAt: ctx.now });
  const elapsed = startedAt === undefined ? 0 : ctx.now - startedAt;
  const secs = Math.max(0, Math.ceil((seer.revealMs - elapsed) / 1000));
  if (secs > 0) ctx.keepTicking();
  const isWolf = check.team === 'wolf';
  return column({ flex: 1, gap: 16, align: 'center', justify: 'center' }, [
    text('查验结果', { size: 16, color: theme.muted, align: 'center' }),
    text(ctx.nameOf(check.targetId), { size: 22, weight: 'bold', align: 'center' }),
    text(isWolf ? '狼人' : '好人', { size: 44, weight: 'bold', align: 'center', color: isWolf ? theme.wolf : theme.good }),
    column({ width: 96, height: 96, radius: 48, bg: theme.surfaceAlt, borderColor: theme.primary, borderWidth: 2, align: 'center', justify: 'center' }, [
      text(secs > 0 ? String(secs) : '0', { size: 40, weight: 'bold', align: 'center', color: theme.primary }),
    ]),
    text(secs > 0 ? '请记住结果，倒计时结束前请闭眼' : '请闭眼', { size: 17, align: 'center', color: secs > 0 ? theme.text : theme.primary }),
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
  const voters = v.players.filter((p) => p.alive).length;
  const progress = text(`已投票 ${v.votedCount}/${voters}，全部投完后公布结果`, { align: 'center', color: theme.muted, size: 13 });
  return column({ flex: 1, gap: 12 }, [
    text('投票放逐一名玩家（不可投自己，可弃权）', { size: 15, color: theme.muted }),
    playerGrid(ctx, {
      selectable: (id) => !v.submitted && id !== v.me?.playerId && !!v.players.find((p) => p.playerId === id)?.alive,
      selected: v.submitted ? (v.myDayVote ?? null) : target,
      onSelect: (id) => ctx.setLocal({ target: id }),
    }),
    spacer(1),
    progress,
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
      if (v.pendingAction === 'seer-check' && !v.submitted) return seerPanel(ctx);
      return v.seer?.lastCheck ? seerRevealPanel(ctx) : waitingNight(ctx);
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

/** 公开战况：全部公开历史（夜间死亡、白天放逐与票型） */
function publicHistory(ctx: Ctx): UINode {
  const all = ctx.view.history;
  if (!all.length) return text('暂无公开结果', { size: 14, color: theme.muted });
  // 屏幕高度有限：只显示最近 6 条
  const h = all.slice(-6);
  const items = h.map((r) => {
    if (r.kind === 'night') return text(`第${r.round}夜：${r.deaths.length ? `${r.deaths.map(ctx.nameOf).join('、')} 死亡` : '平安夜'}`, { size: 14 });
    const votes = Object.entries(r.votes ?? {})
      .map(([from, to]) => `${ctx.nameOf(from).split(' ')[0]}→${to ? ctx.nameOf(to).split(' ')[0] : '弃'}`)
      .join(' ');
    return column({ gap: 2 }, [
      text(`第${r.round}天：${r.exiled ? `${ctx.nameOf(r.exiled)} 被放逐` : '无人放逐'}`, { size: 14 }),
      votes ? text(votes, { size: 12, color: theme.muted }) : null,
    ]);
  });
  return column({ gap: 8 }, items);
}

/** 出局方式：只用公开信息（第几夜死亡 / 第几天被放逐） */
function eliminationText(ctx: Ctx): string {
  const me = ctx.view.me!.playerId;
  const entry = ctx.view.history.find((r) => r.deaths.includes(me));
  if (!entry) return '你已出局';
  return entry.kind === 'night' ? `你在第 ${entry.round} 夜出局` : `你在第 ${entry.round} 天被投票放逐`;
}

/** 出局玩家：不可再操作，只展示出局信息与当前公开战况 */
function eliminatedScreen(ctx: Ctx): UINode {
  const v = ctx.view;
  const alive = v.players.filter((p) => p.alive).length;
  return column({ flex: 1, padding: [ctx.safeArea.top + 12, 16, ctx.safeArea.bottom + 16, 16], gap: 12, bg: theme.bg }, [
    column({ gap: 2 }, [
      text(`第 ${v.round} 轮 · ${PHASE_NAME[v.phase]}`, { size: 13, color: theme.muted }),
      text('公开战况', { size: 19, weight: 'bold' }),
    ]),
    card(
      [
        text('你已出局', { size: 22, weight: 'bold', color: theme.danger }),
        text(eliminationText(ctx), { size: 15 }),
        text('不能再投票或使用技能，请安静旁观，不要透露身份', { size: 13, color: theme.muted }),
      ],
      { borderColor: theme.danger },
    ),
    text(`存活 ${alive} 人 · 出局 ${v.players.length - alive} 人`, { size: 14, color: theme.muted }),
    playerGrid(ctx, {}),
    v.phase === 'day-vote' ? text(`投票进行中：已投票 ${v.votedCount}/${alive}`, { size: 14, color: theme.muted }) : null,
    card([publicHistory(ctx)], { gap: 8 }),
    spacer(1),
    // 房主出局后仍负责主持：保留结束讨论的公共控制
    ctx.isHost && v.phase === 'day-discuss' ? button('结束讨论，开始投票（房主）', { onPress: () => submit(ctx, { type: 'END_DISCUSSION' }), height: 52 }) : null,
  ]);
}

export const werewolfPresentation: GamePresentation = {
  render(raw) {
    const ctx = raw as Ctx;
    if (ctx.view.me && !ctx.view.me.alive && !ctx.view.result) return eliminatedScreen(ctx);
    const night = isNight(ctx.view.phase);
    return column({ flex: 1, padding: [ctx.safeArea.top + 12, 16, ctx.safeArea.bottom + 16, 16], gap: 12, bg: night ? theme.night : theme.bg }, [
      topBar(ctx),
      roleCard(ctx),
      phasePanel(ctx),
    ]);
  },
};
