import { button, card, column, row, spacer, text, theme, type UINode } from '@we/framework';
import type { GamePresentation, GameSceneContext } from '@we/game-app';
import type { DeathCause, Phase, PublicEntry, Role, WerewolfAction, WerewolfPlayerView, Winner } from '../rules/types';

const ROLE_NAME: Record<Role, string> = { wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', villager: '平民' };
const PHASE_NAME: Record<Phase, string> = {
  reveal: '查看身份',
  'night-wolf': '黑夜 · 狼人行动',
  'night-witch': '黑夜 · 女巫行动',
  'night-seer': '黑夜 · 预言家行动',
  'sheriff-signup': '警长竞选 · 上警',
  'sheriff-speech': '警长竞选 · 发言',
  'sheriff-vote': '警长竞选 · 投票',
  'sheriff-pk-speech': '警长竞选 · PK 发言',
  'sheriff-pk-vote': '警长竞选 · PK 投票',
  hunter: '技能结算',
  badge: '移交警徽',
  'last-words': '遗言',
  'sheriff-order': '警长选择发言顺序',
  'day-speech': '白天 · 发言',
  'day-vote': '白天 · 放逐投票',
  'pk-speech': '白天 · PK 发言',
  'pk-vote': '白天 · PK 投票',
  finished: '游戏结束',
};
const CAUSE_NAME: Record<DeathCause, string> = { wolf: '狼刀', poison: '毒杀', exile: '放逐', shot: '枪杀', explode: '自爆' };
const WINNER_NAME: Record<Winner, string> = { wolf: '狼人阵营胜利', good: '好人阵营胜利', draw: '平局', none: '无结果结束' };

type Ctx = GameSceneContext & { view: WerewolfPlayerView };

const roleColor = (r: Role): string => (r === 'wolf' ? theme.wolf : theme.good);
const isNight = (p: Phase): boolean => p.startsWith('night');
const seatOf = (ctx: Ctx, id: string): string => `${ctx.view.players.find((p) => p.playerId === id)?.seat ?? '?'}号`;
const isAliveId = (ctx: Ctx, id: string): boolean => !!ctx.view.players.find((p) => p.playerId === id)?.alive;

function roleDesc(v: WerewolfPlayerView, role: Role): string {
  const selfSave = { never: '全程不可自救', 'first-night': '仅首夜可自救', always: '可以自救' }[v.rules.witchSelfSave];
  switch (role) {
    case 'wolf':
      return `夜间与队友共同决定袭击一名玩家（${v.rules.wolfKill === 'majority' ? '最高票生效，平票重投一次' : '全体一致才生效'}），可空刀或自刀。${v.rules.selfExplode ? '白天发言阶段可在本卡片中自爆。' : ''}`;
    case 'seer':
      return '每晚查验一名其他存活玩家是好人还是狼人，结果仅你可见。';
    case 'witch':
      return `解药、毒药各一瓶，同一夜最多用一种；${selfSave}。解药用完后不再得知刀口。`;
    case 'hunter':
      return '被狼刀或被放逐出局时可以开枪带走一名玩家；被毒杀时不能开枪。';
    case 'villager':
      return '没有夜间技能。白天通过发言和投票找出狼人。';
  }
}

/** 公开倒计时（白天阶段）；隐藏计时阶段只给行动者显示本地倒计时 */
function countdown(ctx: Ctx): string | null {
  if (ctx.remainingMs !== null) return `${Math.ceil(ctx.remainingMs / 1000)}s`;
  const limit = ctx.view.actionLimitMs;
  if (limit === null) return null;
  const startedAt = ctx.local.actionAt as number | undefined;
  if (startedAt === undefined) ctx.setLocal({ actionAt: ctx.now });
  const secs = Math.max(0, Math.ceil((limit - (startedAt === undefined ? 0 : ctx.now - startedAt)) / 1000));
  if (secs > 0) ctx.keepTicking();
  return `${secs}s`;
}

function topBar(ctx: Ctx): UINode {
  const v = ctx.view;
  const left = countdown(ctx);
  return row({ gap: 10, height: 44 }, [
    column({ flex: 1, gap: 2 }, [
      text(v.round > 0 ? `第 ${v.round} 轮${v.sheriff ? ` · 警长 ${seatOf(ctx, v.sheriff)}` : ''}` : `准备阶段 · ${v.rules.board} 人局`, { size: 13, color: theme.muted }),
      text(PHASE_NAME[v.phase], { size: 19, weight: 'bold', maxLines: 1 }),
    ]),
    left ? text(left, { size: 20, weight: 'bold', color: theme.primary }) : null,
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
      text(roleDesc(v, role), { size: 14, color: theme.muted }),
      v.wolf ? text(`狼队友：${v.wolf.teammates.map(ctx.nameOf).join('、') || '无'}`, { size: 15, color: theme.wolf }) : null,
      v.seer && Object.keys(v.seer.checks).length
        ? text(
            `查验记录：${Object.entries(v.seer.checks)
              .map(([id, t]) => `${seatOf(ctx, id)}=${t === 'wolf' ? '狼人' : '好人'}`)
              .join('；')}`,
            { size: 14 },
          )
        : null,
      v.witch ? text(`解药：${v.witch.antidote ? '可用' : '已用'}　毒药：${v.witch.poison ? '可用' : '已用'}`, { size: 14 }) : null,
      explodeControl(ctx),
    ],
    { borderColor: roleColor(role) },
  );
}

/** 狼人自爆：只放在身份卡里（需先点「我的身份」），避免主界面出现仅狼人可见的按钮；两步确认 */
function explodeControl(ctx: Ctx): UINode | null {
  if (!ctx.view.canExplode) return null;
  if (!ctx.local.confirmExplode) return button('自爆', { onPress: () => ctx.setLocal({ confirmExplode: true }), variant: 'danger', height: 40, size: 15 });
  return row({ gap: 10 }, [
    button('确认自爆（公开狼人身份）', { onPress: () => submit(ctx, { type: 'EXPLODE' }), variant: 'danger', flex: 1, height: 40, size: 15 }),
    button('取消', { onPress: () => ctx.setLocal({ confirmExplode: false }), variant: 'secondary', width: 70, height: 40, size: 15 }),
  ]);
}

/** 玩家网格。提供 selectable 时处于「选择目标」模式：不可选的存活玩家置灰 */
function playerGrid(
  ctx: Ctx,
  options: { selectable?: (id: string) => boolean; selected?: string | null; onSelect?: (id: string) => void; badge?: (id: string) => string | null },
): UINode {
  const v = ctx.view;
  const selecting = !!options.selectable;
  const tall = v.players.length <= 6 ? 52 : 44;
  const rows: UINode[] = [];
  for (let i = 0; i < v.players.length; i += 2) {
    rows.push(
      row(
        { gap: 8 },
        v.players.slice(i, i + 2).map((p) => {
          const canSelect = !!options.selectable?.(p.playerId);
          const selected = options.selected === p.playerId;
          const badge = [v.sheriff === p.playerId ? '警长' : null, v.speech?.current === p.playerId ? '发言中' : null, options.badge?.(p.playerId) ?? null]
            .filter(Boolean)
            .join(' ');
          const isMe = p.playerId === v.me?.playerId;
          const greyed = selecting && p.alive && !canSelect && !selected;
          return {
            ...row(
              {
                flex: 1,
                height: tall,
                radius: 10,
                padding: [0, 12, 0, 12],
                gap: 6,
                bg: selected ? '#5a4a20' : greyed ? '#1a1822' : p.alive ? theme.surface : '#18161f',
                borderColor: selected || v.speech?.current === p.playerId ? theme.primary : isMe ? theme.muted : theme.border,
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

const submit = (ctx: Ctx, action: WerewolfAction): void => void ctx.send(action);
const selectedTarget = (ctx: Ctx): string | null => (ctx.local.target as string | undefined) ?? null;

/** 选目标 + 确认 / 放弃 的通用面板 */
function targetPanel(
  ctx: Ctx,
  opts: { hint: string; can: (id: string) => boolean; confirm: string; onConfirm: (id: string) => WerewolfAction; skip?: { label: string; action: WerewolfAction }; danger?: boolean; extra?: UINode | null },
): UINode {
  const target = selectedTarget(ctx);
  return column({ flex: 1, gap: 12 }, [
    text(opts.hint, { size: 15, color: theme.muted }),
    opts.extra ?? null,
    playerGrid(ctx, { selectable: opts.can, selected: target, onSelect: (id) => ctx.setLocal({ target: id }) }),
    spacer(1),
    commandBar(ctx),
    row({ gap: 10 }, [
      button(opts.confirm, { onPress: target && opts.can(target) ? () => submit(ctx, opts.onConfirm(target)) : undefined, flex: 1, variant: opts.danger ? 'danger' : 'primary' }),
      opts.skip ? button(opts.skip.label, { onPress: () => submit(ctx, opts.skip!.action), variant: 'secondary', width: 110 }) : null,
    ]),
  ]);
}

function waiting(ctx: Ctx, title: string, hint: string, icon = '🌙'): UINode {
  return column({ flex: 1, bg: isNight(ctx.view.phase) ? theme.night : theme.surface, radius: 16, align: 'center', justify: 'center', gap: 10, padding: 20 }, [
    text(icon, { size: 48, align: 'center' }),
    text(title, { size: 24, weight: 'bold', align: 'center' }),
    text(hint, { size: 14, color: theme.muted, align: 'center' }),
  ]);
}

const waitingNight = (ctx: Ctx): UINode => waiting(ctx, '天黑请闭眼', '请等待其他角色行动');

/** 不计时模式下房主可跳过当前发言（公共控制，出局的房主同样可用） */
function skipSpeechButton(ctx: Ctx): UINode | null {
  const v = ctx.view;
  if (!ctx.isHost || v.rules.speechSec !== 0 || !v.speech || v.speech.current === v.me?.playerId || v.result) return null;
  return button('跳过当前发言（房主）', { onPress: () => submit(ctx, { type: 'SKIP_SPEECH' }), variant: 'secondary', height: 40, size: 15, flex: 1 });
}

// ---- 身份与夜间 -----------------------------------------------------------

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
  const w = v.wolf!;
  const votes = w.votes ?? {};
  const intents = w.intents ?? {};
  const aliveMates = w.teammates.filter((id) => isAliveId(ctx, id));
  const revote = w.revote;
  const allowed = (id: string | null): boolean => (revote ? revote.includes(id) : id === null || isAliveId(ctx, id));
  // 我的选择：已确认以狼票为准，否则以本地点选或已同步的意向为准
  const target = v.submitted ? (votes[me] ?? null) : ((ctx.local.target as string | undefined) ?? intents[me] ?? null);
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
        const desc = !c ? '还在选择' : c.id === null ? (c.confirmed ? '已确认空刀' : '倾向空刀') : `${c.confirmed ? '已确认' : '想刀'} ${ctx.nameOf(c.id)}`;
        return text(`队友 ${ctx.nameOf(m)}：${desc}`, { size: 15, color: c?.confirmed ? theme.wolf : theme.text });
      })
    : [text('你是唯一存活的狼人，你的选择直接生效', { size: 15 })];
  const hint = revote
    ? `平票重投：只能在 ${revote.map((t) => (t ? seatOf(ctx, t) : '空刀')).join('、')} 中选择，再次平票则空刀`
    : v.rules.wolfKill === 'majority'
      ? '选择今晚的目标：最高票生效，平票重投一次（可自刀、可空刀）'
      : '选择今晚的目标：全体狼人一致才生效（可自刀、可空刀）';
  return column({ flex: 1, gap: 12 }, [
    text(hint, { size: 14, color: theme.muted }),
    card(mateLines, { gap: 6, padding: 12, borderColor: theme.wolf }),
    playerGrid(ctx, {
      selectable: (id) => !v.submitted && allowed(id),
      selected: target,
      onSelect: select,
      badge: (id) => {
        const marks = aliveMates.filter((m) => mateChoice(m)?.id === id).map((m) => `${seatOf(ctx, m)}${mateChoice(m)!.confirmed ? '已确认' : '想刀'}`);
        return [w.teammates.includes(id) ? '队友' : null, ...marks].filter(Boolean).join(' ') || null;
      },
    }),
    spacer(1),
    commandBar(ctx),
    v.submitted
      ? text(`你已确认：${votes[me] ? ctx.nameOf(votes[me]!) : '空刀'}，等待队友`, { align: 'center', color: theme.muted })
      : row({ gap: 10 }, [
          button('确认袭击', { onPress: target && allowed(target) ? () => submit(ctx, { type: 'WOLF_VOTE', targetId: target }) : undefined, flex: 1, variant: 'danger' }),
          button('空刀', { onPress: allowed(null) ? () => submit(ctx, { type: 'WOLF_VOTE', targetId: null }) : undefined, variant: 'secondary', width: 90 }),
        ]),
  ]);
}

function witchPanel(ctx: Ctx): UINode {
  const v = ctx.view;
  const w = v.witch!;
  if (ctx.local.mode === 'poison') {
    return targetPanel(ctx, {
      hint: '选择要使用毒药的玩家（不能毒自己）',
      can: (id) => id !== v.me?.playerId && isAliveId(ctx, id),
      confirm: '确认用毒',
      danger: true,
      onConfirm: (id) => ({ type: 'WITCH_ACTION', action: 'poison', targetId: id }),
      extra: button('返回', { onPress: () => ctx.setLocal({ mode: null, target: null }), variant: 'ghost', height: 36, size: 14 }),
    });
  }
  const selfTarget = w.wolfTarget === v.me?.playerId;
  return column({ flex: 1, gap: 12 }, [
    card([
      text('今晚的情况', { size: 14, color: theme.muted }),
      text(w.antidote ? (w.wolfTarget ? `${ctx.nameOf(w.wolfTarget)} 被狼人袭击` : '今晚是空刀') : '解药已用完，无法得知今晚刀口', { size: 18, weight: 'bold' }),
      selfTarget && !w.canSave ? text('本局规则不允许自救', { size: 13, color: theme.danger }) : null,
      text('同一夜最多使用一种药', { size: 13, color: theme.muted }),
    ]),
    spacer(1),
    commandBar(ctx),
    button(w.canSave ? '使用解药' : '解药不可用', { onPress: w.canSave ? () => submit(ctx, { type: 'WITCH_ACTION', action: 'save' }) : undefined, height: 52 }),
    button(w.poison ? '使用毒药…' : '毒药已用', { onPress: w.poison ? () => ctx.setLocal({ mode: 'poison' }) : undefined, height: 52, variant: 'danger' }),
    button('今晚不用药', { onPress: () => submit(ctx, { type: 'WITCH_ACTION', action: 'pass' }), height: 52, variant: 'secondary' }),
  ]);
}

function seerPanel(ctx: Ctx): UINode {
  const v = ctx.view;
  const checks = v.seer?.checks ?? {};
  return targetPanel(ctx, {
    hint: '选择一名其他存活玩家查验阵营（可重复查验）',
    can: (id) => id !== v.me?.playerId && isAliveId(ctx, id),
    confirm: '查验',
    onConfirm: (id) => ({ type: 'SEER_CHECK', targetId: id }),
    skip: { label: '今晚不查验', action: { type: 'SEER_PASS' } },
    extra: Object.keys(checks).length
      ? text(`已查验：${Object.entries(checks).map(([id, t]) => `${seatOf(ctx, id)}${t === 'wolf' ? '狼' : '好'}`).join(' ')}`, { size: 13, color: theme.muted })
      : null,
  });
}

/** 查验完成后：展示结果，提醒在倒计时结束前闭眼 */
function seerRevealPanel(ctx: Ctx): UINode {
  const check = ctx.view.seer!.lastCheck!;
  const isWolf = check.team === 'wolf';
  return column({ flex: 1, gap: 16, align: 'center', justify: 'center' }, [
    text('查验结果', { size: 16, color: theme.muted, align: 'center' }),
    text(ctx.nameOf(check.targetId), { size: 22, weight: 'bold', align: 'center' }),
    text(isWolf ? '狼人' : '好人', { size: 44, weight: 'bold', align: 'center', color: isWolf ? theme.wolf : theme.good }),
    text('请记住结果，稍后自动闭眼', { size: 17, align: 'center' }),
  ]);
}

// ---- 死亡处理 -------------------------------------------------------------

function hunterPanel(ctx: Ctx): UINode {
  const v = ctx.view;
  if (!v.hunter?.canShoot) return waiting(ctx, '你被毒杀出局', '被毒杀时不能开枪', '☠️');
  return targetPanel(ctx, {
    hint: '你已出局，可以开枪带走一名存活玩家（公开），也可以放弃',
    can: (id) => id !== v.me?.playerId && isAliveId(ctx, id),
    confirm: '开枪',
    danger: true,
    onConfirm: (id) => ({ type: 'HUNTER_SHOOT', targetId: id }),
    skip: { label: '放弃开枪', action: { type: 'HUNTER_SHOOT', targetId: null } },
  });
}

function badgePanel(ctx: Ctx): UINode {
  return targetPanel(ctx, {
    hint: '你已出局，请把警徽移交给一名存活玩家，或撕毁警徽',
    can: (id) => isAliveId(ctx, id),
    confirm: '移交警徽',
    onConfirm: (id) => ({ type: 'BADGE_PASS', targetId: id }),
    skip: { label: '撕毁警徽', action: { type: 'BADGE_PASS', targetId: null } },
  });
}

// ---- 白天 ---------------------------------------------------------------

function speechPanel(ctx: Ctx): UINode {
  const v = ctx.view;
  const sp = v.speech;
  const mine = v.pendingAction === 'speak';
  const label = v.phase === 'last-words' ? '遗言' : '发言';
  return column({ flex: 1, gap: 12 }, [
    sp
      ? card([
          text(`${v.phase === 'last-words' ? '正在发表遗言' : '当前发言'}：${ctx.nameOf(sp.current)}`, { size: 18, weight: 'bold', color: mine ? theme.primary : theme.text }),
          text(`顺序：${sp.order.map((id) => seatOf(ctx, id)).join(' → ')}`, { size: 13, color: theme.muted }),
          v.candidates?.length ? text(`候选：${v.candidates.map((id) => seatOf(ctx, id)).join('、')}`, { size: 13, color: theme.muted }) : null,
        ])
      : null,
    playerGrid(ctx, { badge: (id) => (v.candidates?.includes(id) ? '候选' : null) }),
    spacer(1),
    commandBar(ctx),
    // 结束发言 / 房主跳过 / 提示与退水同一行，避免 9 人局展开身份卡时超出屏幕
    row({ gap: 10 }, [
      mine
        ? button(`结束${label}`, { onPress: () => submit(ctx, { type: 'END_SPEECH' }), height: 52, flex: 1 })
        : (skipSpeechButton(ctx) ?? text(`请安静聆听${label}，不要插话`, { align: 'center', color: theme.muted, size: 13, flex: 1 })),
      v.canWithdraw ? button('退水', { onPress: () => submit(ctx, { type: 'SHERIFF_WITHDRAW' }), variant: 'secondary', width: 90, height: mine ? 52 : 40 }) : null,
    ]),
  ]);
}

function votePanel(ctx: Ctx): UINode {
  const v = ctx.view;
  const progress = v.progress ? text(`已投票 ${v.progress.done}/${v.progress.total}，全部投完或时间到后公布票型`, { align: 'center', color: theme.muted, size: 13 }) : null;
  const sheriffVote = v.phase === 'sheriff-vote' || v.phase === 'sheriff-pk-vote';
  const hint = sheriffVote ? '投票选出警长（可弃票）' : `投票放逐一名玩家（不可投自己，可弃票${v.sheriff ? '；警长计 1.5 票' : ''}）`;
  if (!v.vote) {
    return column({ flex: 1, gap: 12 }, [
      text(v.candidates ? `候选：${v.candidates.map((id) => seatOf(ctx, id)).join('、')}` : hint, { size: 15, color: theme.muted }),
      playerGrid(ctx, { badge: (id) => (v.candidates?.includes(id) ? '候选' : null) }),
      spacer(1),
      progress,
      text('你本轮没有投票权', { align: 'center', color: theme.muted }),
    ]);
  }
  const targets = v.vote.targets;
  const target = v.submitted ? (v.vote.myVote ?? null) : selectedTarget(ctx);
  return column({ flex: 1, gap: 12 }, [
    text(hint, { size: 15, color: theme.muted }),
    playerGrid(ctx, {
      selectable: (id) => !v.submitted && targets.includes(id),
      selected: target,
      onSelect: (id) => ctx.setLocal({ target: id }),
      badge: (id) => (v.candidates?.includes(id) ? '候选' : null),
    }),
    spacer(1),
    progress,
    commandBar(ctx),
    v.submitted
      ? text(`已投票：${v.vote.myVote ? ctx.nameOf(v.vote.myVote) : '弃票'}`, { align: 'center', color: theme.muted })
      : row({ gap: 10 }, [
          button('确认投票', { onPress: target ? () => submit(ctx, { type: 'VOTE', targetId: target }) : undefined, flex: 1 }),
          button('弃票', { onPress: () => submit(ctx, { type: 'VOTE', targetId: null }), variant: 'secondary', width: 90 }),
        ]),
  ]);
}

function signupPanel(ctx: Ctx): UINode {
  const v = ctx.view;
  return column({ flex: 1, gap: 12 }, [
    card([
      text('警长竞选', { size: 20, weight: 'bold' }),
      text('上警的玩家依次竞选发言，警下玩家投票选出警长。警长放逐投票计 1.5 票，并决定每天的发言顺序。', { size: 14, color: theme.muted }),
    ]),
    playerGrid(ctx, {}),
    spacer(1),
    v.progress ? text(`已选择 ${v.progress.done}/${v.progress.total}`, { align: 'center', color: theme.muted, size: 13 }) : null,
    commandBar(ctx),
    v.pendingAction !== 'sheriff-signup'
      ? null
      : v.submitted
        ? text('已提交，等待其他玩家', { align: 'center', color: theme.muted })
        : row({ gap: 10 }, [
            button('上警', { onPress: () => submit(ctx, { type: 'SHERIFF_SIGNUP', join: true }), flex: 1 }),
            button('不上警', { onPress: () => submit(ctx, { type: 'SHERIFF_SIGNUP', join: false }), variant: 'secondary', flex: 1 }),
          ]),
  ]);
}

function orderPanel(ctx: Ctx): UINode {
  if (ctx.view.pendingAction !== 'sheriff-order') return waiting(ctx, '等待警长', '警长正在选择今天的发言顺序', '🎖️');
  return column({ flex: 1, gap: 12 }, [
    text('选择今天的发言顺序：从你相邻的玩家开始，你最后发言（归票）', { size: 15, color: theme.muted }),
    playerGrid(ctx, {}),
    spacer(1),
    commandBar(ctx),
    button('顺时针（座位号递增）', { onPress: () => submit(ctx, { type: 'SHERIFF_ORDER', dir: 'cw' }), height: 52 }),
    button('逆时针（座位号递减）', { onPress: () => submit(ctx, { type: 'SHERIFF_ORDER', dir: 'ccw' }), height: 52, variant: 'secondary' }),
  ]);
}

// ---- 公开历史与结果 ---------------------------------------------------------

function voteLine(ctx: Ctx, votes: Record<string, string | null>): string {
  return Object.entries(votes)
    .map(([from, to]) => `${seatOf(ctx, from)}→${to ? seatOf(ctx, to) : '弃'}`)
    .join(' ');
}

function historyLines(ctx: Ctx, entries: readonly PublicEntry[]): { title: string; detail?: string }[] {
  const seats = (ids: readonly string[]): string => ids.map((id) => seatOf(ctx, id)).join('、');
  return entries.map((e) => {
    switch (e.kind) {
      case 'night':
        return { title: `第${e.round}夜：${e.deaths.length ? `${seats(e.deaths)} 死亡` : '平安夜'}` };
      case 'sheriff':
        return {
          title: e.tied.length ? `警长竞选：${seats(e.tied)} 平票进入 PK` : e.elected ? `${seatOf(ctx, e.elected)} 当选警长` : '警徽流失，没有警长',
          detail: e.votes ? voteLine(ctx, e.votes) : e.candidates.length ? `上警：${seats(e.candidates)}` : undefined,
        };
      case 'vote':
        return {
          title: `第${e.round}天${e.pk ? ' PK' : ''}：${e.tied.length ? `${seats(e.tied)} 平票进入 PK` : e.exiled ? `${seatOf(ctx, e.exiled)} 被放逐` : '无人放逐'}`,
          detail: voteLine(ctx, e.votes) || undefined,
        };
      case 'shot':
        return { title: `猎人 ${seatOf(ctx, e.shooter)} 开枪带走 ${seatOf(ctx, e.target)}` };
      case 'explode':
        return { title: `${seatOf(ctx, e.playerId)} 自爆（狼人）` };
      case 'badge':
        return { title: e.to ? `警徽由 ${seatOf(ctx, e.from)} 移交给 ${seatOf(ctx, e.to)}` : `${seatOf(ctx, e.from)} 的警徽被撕毁` };
    }
  });
}

function historyCard(ctx: Ctx, limit: number): UINode | null {
  const lines = historyLines(ctx, ctx.view.history).slice(-limit);
  if (!lines.length) return null;
  return card(
    lines.map((l) => column({ gap: 2 }, [text(l.title, { size: 14 }), l.detail ? text(l.detail, { size: 12, color: theme.muted }) : null])),
    { gap: 6, padding: 12 },
  );
}

function resultPanel(ctx: Ctx): UINode {
  const r = ctx.view.result!;
  const v = ctx.view;
  const mine = v.me && (r.winner === 'wolf' || r.winner === 'good') ? (v.me.role === 'wolf') === (r.winner === 'wolf') : null;
  const nightLine = (n: (typeof r.nights)[number]): string => {
    const parts = [`刀 ${n.wolfTarget ? seatOf(ctx, n.wolfTarget) : '空'}`];
    if (n.witch) parts.push(`${n.witch.kind === 'save' ? '救' : '毒'} ${seatOf(ctx, n.witch.target)}`);
    if (n.seer) parts.push(`验 ${seatOf(ctx, n.seer.target)}${n.seer.team === 'wolf' ? '狼' : '好'}`);
    return `第${n.round}夜：${parts.join('，')}`;
  };
  return column({ flex: 1, gap: 10 }, [
    text(WINNER_NAME[r.winner], { size: 28, weight: 'bold', align: 'center', color: r.winner === 'wolf' ? theme.wolf : r.winner === 'good' ? theme.good : theme.text }),
    mine === null ? null : text(mine ? '你赢了！' : '你输了', { align: 'center', size: 17 }),
    card(
      v.players.map((p) => {
        const d = r.deaths[p.playerId];
        return row({ justify: 'space-between', gap: 8 }, [
          text(ctx.nameOf(p.playerId), { size: 14, flex: 1, maxLines: 1 }),
          text(d ? `第${d.round}${d.at === 'night' ? '夜' : '天'} ${d.causes.map((c) => CAUSE_NAME[c]).join('+')}` : '存活', { size: 12, color: theme.muted }),
          text(ROLE_NAME[r.roles[p.playerId]!], { size: 14, weight: 'bold', color: roleColor(r.roles[p.playerId]!) }),
        ]);
      }),
      { gap: 6, padding: 12 },
    ),
    r.nights.length ? card(r.nights.slice(-4).map((n) => text(nightLine(n), { size: 13 })), { gap: 4, padding: 12 }) : null,
    spacer(1),
    text(ctx.isHost ? '房主可返回房间开始新一局' : '等待房主开始新一局', { align: 'center', color: theme.muted, size: 13 }),
    spacer(0.6),
  ]);
}

function phasePanel(ctx: Ctx): UINode {
  const v = ctx.view;
  if (v.result) return resultPanel(ctx);
  switch (v.phase) {
    case 'reveal':
      return revealPanel(ctx);
    case 'night-wolf':
      return v.pendingAction === 'wolf-vote' && v.wolf ? wolfPanel(ctx) : waitingNight(ctx);
    case 'night-witch':
      return v.pendingAction === 'witch' && !v.submitted ? witchPanel(ctx) : waitingNight(ctx);
    case 'night-seer':
      if (v.seer?.lastCheck) return seerRevealPanel(ctx);
      return v.pendingAction === 'seer-check' && !v.submitted ? seerPanel(ctx) : waitingNight(ctx);
    case 'hunter':
      // 无论本批次是否有猎人，其他玩家看到的界面一致
      return v.pendingAction === 'hunter' || v.hunter ? hunterPanel(ctx) : waiting(ctx, '技能结算中', '请等待', '⏳');
    case 'badge':
      return v.pendingAction === 'badge' ? badgePanel(ctx) : waiting(ctx, '移交警徽', '出局的警长正在移交警徽', '🎖️');
    case 'sheriff-signup':
      return signupPanel(ctx);
    case 'sheriff-order':
      return orderPanel(ctx);
    case 'finished':
      return waiting(ctx, '游戏结束', '');
    default:
      if (v.speech) return speechPanel(ctx);
      return votePanel(ctx);
  }
}

/** 出局玩家：只展示公开战况；仍有待处理的死亡技能 / 警徽 / 遗言时显示对应操作 */
function eliminatedScreen(ctx: Ctx): UINode {
  const v = ctx.view;
  const aliveCount = v.players.filter((p) => p.alive).length;
  const skip = skipSpeechButton(ctx);
  const d = v.history.find((e) => (e.kind === 'night' && e.deaths.includes(v.me!.playerId)) || (e.kind === 'vote' && e.exiled === v.me!.playerId));
  const how = !d ? '你已出局' : d.kind === 'night' ? `你在第 ${d.round} 夜出局` : `你在第 ${d.round} 天被放逐`;
  return column({ flex: 1, padding: [ctx.safeArea.top + 12, 16, ctx.safeArea.bottom + 16, 16], gap: 12, bg: theme.bg }, [
    column({ gap: 2 }, [text(`第 ${v.round} 轮 · ${PHASE_NAME[v.phase]}`, { size: 13, color: theme.muted }), text('公开战况', { size: 19, weight: 'bold' })]),
    card(
      [
        text('你已出局', { size: 22, weight: 'bold', color: theme.danger }),
        text(how, { size: 15 }),
        text('不能再发言、投票或使用技能，请安静旁观，不要透露身份', { size: 13, color: theme.muted }),
      ],
      { borderColor: theme.danger },
    ),
    text(`存活 ${aliveCount} 人 · 出局 ${v.players.length - aliveCount} 人`, { size: 14, color: theme.muted }),
    playerGrid(ctx, {}),
    v.progress ? text(`进行中：${v.progress.done}/${v.progress.total}`, { size: 14, color: theme.muted }) : null,
    historyCard(ctx, skip ? 3 : 5),
    spacer(1),
    skip ? row({}, [skip]) : null,
  ]);
}

export const werewolfPresentation: GamePresentation = {
  render(raw) {
    const ctx = raw as Ctx;
    const v = ctx.view;
    if (v.me && !v.me.alive && !v.result && !v.pendingAction && !v.hunter) return eliminatedScreen(ctx);
    const night = isNight(v.phase);
    const day = !night && v.phase !== 'reveal' && !v.result;
    return column({ flex: 1, padding: [ctx.safeArea.top + 12, 16, ctx.safeArea.bottom + 16, 16], gap: 12, bg: night ? theme.night : theme.bg }, [
      topBar(ctx),
      roleCard(ctx),
      phasePanel(ctx),
      day && !ctx.local.showRole && v.phase !== 'sheriff-signup' && v.speech === null && !v.vote ? historyCard(ctx, 2) : null,
    ]);
  },
};
