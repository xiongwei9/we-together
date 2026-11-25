import { button, card, column, row, spacer, text, theme, type UINode } from '@we/framework';
import type { GamePresentation, GameSceneContext } from '@we/game-app';
import { canAppend, scoreColumn } from '../rules/cards';
import { COLORS, type Card, type Color, type LostCitiesAction, type LostCitiesPlayerView, type PlayerPublicView, type VisibleMove } from '../rules/types';

type Ctx = GameSceneContext & { view: LostCitiesPlayerView };

const COLOR_NAME: Record<Color, string> = { red: '红', yellow: '黄', blue: '蓝', green: '绿', white: '白' };
const COLOR_BG: Record<Color, string> = { red: '#c8504a', yellow: '#d9b23c', blue: '#4a86d6', green: '#3f9a6c', white: '#e8e4f0' };
const COLOR_FG: Record<Color, string> = { red: '#ffffff', yellow: '#1a1408', blue: '#ffffff', green: '#ffffff', white: '#1a1408' };

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
const cardLabel = (c: Card): string => (c.value === null ? '握' : String(c.value));
const cardName = (c: Card): string => `${COLOR_NAME[c.color]}${c.value === null ? '握手' : c.value}`;
const submit = (ctx: Ctx, action: LostCitiesAction): void => void ctx.send(action);

/** 手牌排序：按颜色，同色握手牌在前、数字递增 */
const sortHand = (hand: readonly Card[]): Card[] =>
  [...hand].sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || (a.value ?? 0) - (b.value ?? 0));

function meAndOpponent(v: LostCitiesPlayerView): { me: PlayerPublicView; opp: PlayerPublicView } {
  const myId = v.me?.playerId ?? v.players[0]!.playerId;
  return { me: v.players.find((p) => p.playerId === myId)!, opp: v.players.find((p) => p.playerId !== myId)! };
}

/** 弃牌暗置：他人弃出的牌只显示颜色 */
const moveCard = (m: VisibleMove): string => (m.card ? cardName(m.card) : `一张${COLOR_NAME[m.color]}牌`);

function moveText(ctx: Ctx, m: VisibleMove): string {
  const who = m.playerId === ctx.view.me?.playerId ? '我' : ctx.nameOf(m.playerId);
  const place = `${m.kind === 'play' ? '打出' : '弃掉'} ${moveCard(m)}`;
  const draw = m.draw === null ? '' : m.draw === 'deck' ? '，抽牌堆' : `，拿${COLOR_NAME[m.draw]}弃牌`;
  return `${who}：${place}${draw}${m.auto ? '（超时代操作）' : ''}`;
}

// ---- 卡牌与区域 -------------------------------------------------------------

function cardTile(c: Card, opts: { height: number; selected?: boolean; onPress?: () => void; size?: number }): ReturnType<typeof column> {
  return {
    ...column(
      {
        flex: 1,
        height: opts.height,
        radius: 8,
        bg: COLOR_BG[c.color],
        align: 'center',
        justify: 'center',
        borderColor: opts.selected ? theme.primary : 'rgba(0,0,0,0.35)',
        borderWidth: opts.selected ? 3 : 1,
      },
      [text(cardLabel(c), { size: opts.size ?? 20, weight: 'bold', color: COLOR_FG[c.color], align: 'center' })],
    ),
    onPress: opts.onPress,
    disabled: !opts.onPress,
    pressedBg: COLOR_BG[c.color],
  };
}

/** 一名玩家的五列探险：列头为本列预估分，下方为握手牌数量与数字 */
function expeditionRow(p: PlayerPublicView, opts: { highlight?: Color | null; onPress?: (c: Color) => void } = {}): UINode {
  return row(
    { gap: 4, align: 'stretch' },
    COLORS.map((color) => {
      const col = p.expeditions[color];
      const wagers = col.filter((c) => c.value === null).length;
      const nums = col.filter((c) => c.value !== null).map((c) => c.value);
      const score = col.length ? scoreColumn(col).score : null;
      const lit = opts.highlight === color;
      return {
        ...column({ flex: 1, minHeight: 66, radius: 8, bg: theme.surface, borderColor: lit ? theme.primary : theme.border, borderWidth: lit ? 2 : 1, padding: [0, 2, 4, 2], gap: 2 }, [
          column({ height: 5, bg: COLOR_BG[color], radius: 2 }, []),
          text(score === null ? COLOR_NAME[color] : signed(score), { size: 13, weight: 'bold', align: 'center', color: score === null ? theme.muted : score >= 0 ? theme.success : theme.danger }),
          wagers ? text(`握×${wagers}`, { size: 11, align: 'center', color: COLOR_BG[color] === '#e8e4f0' ? theme.text : COLOR_BG[color] }) : null,
          nums.length ? text(nums.join(' '), { size: 12, align: 'center', maxLines: 3 }) : null,
          col.length >= 8 ? text('+20', { size: 10, align: 'center', color: theme.primary }) : null,
        ]),
        onPress: opts.onPress ? () => opts.onPress!(color) : undefined,
        disabled: !opts.onPress,
        pressedBg: theme.surfaceAlt,
      };
    }),
  );
}

/** 抽牌堆 + 五个弃牌堆（暗置，只显示张数）；抽牌阶段可点击 */
function pilesRow(ctx: Ctx, opts: { discardTarget?: Color | null; onDiscard?: () => void }): UINode {
  const v = ctx.view;
  const drawing = v.pendingAction === 'draw';
  const canTake = (c: Color): boolean => drawing && v.discardCounts[c] > 0 && v.blockedDiscard !== c;
  const deck = {
    ...column({ flex: 1.2, height: 60, radius: 8, bg: theme.surfaceAlt, align: 'center', justify: 'center', borderColor: drawing ? theme.primary : theme.border, borderWidth: drawing ? 2 : 1 }, [
      text('牌堆', { size: 12, color: theme.muted, align: 'center' }),
      text(String(v.deckCount), { size: 20, weight: 'bold', align: 'center', color: v.deckCount <= 5 ? theme.danger : theme.text }),
    ]),
    onPress: drawing ? () => submit(ctx, { type: 'DRAW', source: 'deck' }) : undefined,
    disabled: !drawing,
    pressedBg: '#3a3554',
  };
  const piles = COLORS.map((color) => {
    const count = v.discardCounts[color];
    const take = canTake(color);
    const target = opts.discardTarget === color;
    const press = take ? () => submit(ctx, { type: 'DRAW', source: color }) : target ? opts.onDiscard : undefined;
    const lit = take || target;
    // 牌背：本色底 + 张数，不显示牌面
    const box = column(
      {
        flex: 1,
        height: 60,
        radius: 8,
        align: 'center',
        justify: 'center',
        gap: 2,
        bg: count ? COLOR_BG[color] : undefined,
        borderColor: lit ? theme.primary : count ? 'rgba(0,0,0,0.35)' : COLOR_BG[color],
        borderWidth: lit ? 3 : 1,
      },
      [
        text('弃', { size: 12, color: count ? COLOR_FG[color] : theme.muted, align: 'center' }),
        count ? text(`${count} 张`, { size: 13, weight: 'bold', color: COLOR_FG[color], align: 'center' }) : null,
      ],
    );
    // 只对正在抽牌的玩家置灰刚弃的牌
    return { ...box, style: { ...box.style, opacity: drawing && v.blockedDiscard === color ? 0.35 : 1 }, onPress: press, disabled: !press, pressedBg: theme.surfaceAlt };
  });
  return row({ gap: 4 }, [deck, ...piles]);
}

function playerLine(ctx: Ctx, p: PlayerPublicView, label: string): UINode {
  const v = ctx.view;
  const active = v.current === p.playerId && (v.phase === 'play' || v.phase === 'draw');
  return row({ gap: 8, height: 22 }, [
    active ? text('▶', { size: 12, color: theme.primary }) : null,
    text(label, { size: 14, weight: 'bold', flex: 1, maxLines: 1, color: active ? theme.primary : theme.text }),
    text(`手牌 ${p.handCount} · 本轮 ${signed(p.roundScore)} · 累计 ${p.total}`, { size: 12, color: theme.muted }),
  ]);
}

function topBar(ctx: Ctx): UINode {
  const v = ctx.view;
  const secs = ctx.remainingMs !== null ? Math.ceil(ctx.remainingMs / 1000) : null;
  return row({ gap: 8, height: 40 }, [
    column({ flex: 1, gap: 1 }, [
      text(`第 ${v.round}/${v.rules.rounds} 轮`, { size: 12, color: theme.muted }),
      text(v.phase === 'round-end' ? '本轮结算' : v.current === v.me?.playerId ? (v.phase === 'play' ? '我的回合 · 出牌' : '我的回合 · 抽牌') : '对手回合', {
        size: 17,
        weight: 'bold',
        maxLines: 1,
      }),
    ]),
    secs !== null ? text(`${secs}s`, { size: 20, weight: 'bold', color: secs <= 5 ? theme.danger : theme.primary }) : null,
    button('认输', { onPress: () => ctx.setLocal({ confirmResign: true }), variant: 'ghost', height: 34, size: 13 }),
  ]);
}

function commandBar(ctx: Ctx): UINode | null {
  const last = [...ctx.commands].reverse().find((c) => c.kind === 'game');
  if (!last) return null;
  if (last.status === 'pending') return text('提交中…', { align: 'center', color: theme.muted, size: 13 });
  if (last.status === 'failed') return button('网络失败，点击重试', { onPress: () => ctx.retry(last.commandId), variant: 'danger', height: 40, size: 15 });
  return null;
}

// ---- 对局 -----------------------------------------------------------------

function selectedCard(ctx: Ctx): Card | null {
  const id = ctx.local.sel as string | undefined;
  return ctx.view.me?.hand.find((c) => c.id === id) ?? null;
}

function playHint(me: PlayerPublicView, c: Card): string | null {
  const col = me.expeditions[c.color];
  if (canAppend(col, c)) return null;
  const last = col[col.length - 1]!;
  if (c.value === null) return '握手牌只能放在数字牌之前';
  return `${COLOR_NAME[c.color]}探险已到 ${last.value}，只能打更大的数字`;
}

function actionArea(ctx: Ctx, me: PlayerPublicView): UINode {
  const v = ctx.view;
  if (ctx.local.confirmResign) {
    return column({ gap: 8 }, [
      text('认输后本场比赛直接判负', { size: 13, color: theme.danger, align: 'center' }),
      row({ gap: 10 }, [
        button('确认认输', { onPress: () => submit(ctx, { type: 'RESIGN' }), variant: 'danger', flex: 1, height: 44 }),
        button('取消', { onPress: () => ctx.setLocal({ confirmResign: false }), variant: 'secondary', width: 90, height: 44 }),
      ]),
    ]);
  }
  if (v.pendingAction === 'draw') {
    return column({ gap: 6 }, [
      text(
        v.blockedDiscard ? `点击牌堆，或盲抽某色弃牌堆顶（本回合不能拿回刚弃的${COLOR_NAME[v.blockedDiscard]}牌）` : '点击牌堆，或盲抽某色弃牌堆顶',
        { size: 13, color: theme.muted, align: 'center' },
      ),
      button('抽牌堆', { onPress: () => submit(ctx, { type: 'DRAW', source: 'deck' }), height: 44 }),
    ]);
  }
  if (v.pendingAction !== 'play') {
    const m = v.pendingMove;
    return column({ gap: 6, height: 70, justify: 'center' }, [
      text(m ? `对手已${m.kind === 'play' ? '打出' : '弃掉'} ${moveCard(m)}，正在抽牌` : '等待对手出牌…', { size: 14, color: theme.muted, align: 'center' }),
    ]);
  }
  const sel = selectedCard(ctx);
  if (!sel) return column({ gap: 6, height: 70, justify: 'center' }, [text('选择一张手牌：打入自己的探险列，或弃到同色弃牌堆', { size: 13, color: theme.muted, align: 'center' })]);
  const hint = playHint(me, sel);
  const send = (action: LostCitiesAction): void => {
    ctx.setLocal({ sel: null });
    submit(ctx, action);
  };
  return column({ gap: 6 }, [
    text(hint ?? `已选 ${cardName(sel)}`, { size: 13, color: hint ? theme.danger : theme.muted, align: 'center' }),
    row({ gap: 10 }, [
      button('打入探险', { onPress: hint ? undefined : () => send({ type: 'PLAY', cardId: sel.id }), flex: 1, height: 44 }),
      button(`弃到${COLOR_NAME[sel.color]}弃牌堆`, { onPress: () => send({ type: 'DISCARD', cardId: sel.id }), variant: 'secondary', flex: 1, height: 44, size: 15 }),
    ]),
  ]);
}

function boardScreen(ctx: Ctx): UINode {
  const v = ctx.view;
  const { me, opp } = meAndOpponent(v);
  const playing = v.pendingAction === 'play' && !ctx.local.confirmResign;
  const sel = playing ? selectedCard(ctx) : null;
  const canPlaySel = !!sel && canAppend(me.expeditions[sel.color], sel);
  const send = (action: LostCitiesAction): void => {
    ctx.setLocal({ sel: null });
    submit(ctx, action);
  };
  const last = v.pendingMove ?? v.moves[v.moves.length - 1] ?? null;
  const hand = sortHand(v.me?.hand ?? []);
  return column({ flex: 1, padding: [ctx.safeArea.top + 10, 12, ctx.safeArea.bottom + 12, 12], gap: 8, bg: theme.bg }, [
    topBar(ctx),
    playerLine(ctx, opp, ctx.nameOf(opp.playerId)),
    expeditionRow(opp),
    spacer(0.3),
    pilesRow(ctx, { discardTarget: sel?.color ?? null, onDiscard: sel ? () => send({ type: 'DISCARD', cardId: sel.id }) : undefined }),
    text(last ? `上一步 ${moveText(ctx, last)}` : `${ctx.nameOf(v.starter)} 先手`, { size: 12, color: theme.muted, maxLines: 1 }),
    spacer(0.3),
    expeditionRow(me, { highlight: canPlaySel ? sel!.color : null, onPress: canPlaySel ? (c) => c === sel!.color && send({ type: 'PLAY', cardId: sel!.id }) : undefined }),
    playerLine(ctx, me, `我（${ctx.nameOf(me.playerId)}）`),
    row(
      { gap: 3 },
      hand.map((c) => cardTile(c, { height: 62, selected: sel?.id === c.id, onPress: playing ? () => ctx.setLocal({ sel: sel?.id === c.id ? null : c.id }) : undefined })),
    ),
    spacer(1),
    commandBar(ctx),
    actionArea(ctx, me),
  ]);
}

// ---- 结算 -----------------------------------------------------------------

function roundTable(ctx: Ctx, round: LostCitiesPlayerView['history'][number]): UINode {
  const v = ctx.view;
  return column(
    { gap: 6 },
    v.players.map((p) => {
      const cols = round.columns[p.playerId]!;
      return card(
        [
          row({}, [
            text(p.playerId === v.me?.playerId ? `我（${ctx.nameOf(p.playerId)}）` : ctx.nameOf(p.playerId), { size: 14, weight: 'bold', flex: 1, maxLines: 1 }),
            text(`${signed(round.scores[p.playerId]!)} 分`, { size: 16, weight: 'bold', color: theme.primary }),
          ]),
          row(
            { gap: 4 },
            COLORS.map((c) =>
              column({ flex: 1, gap: 2, radius: 6, padding: [4, 2, 4, 2], bg: theme.surfaceAlt }, [
                column({ height: 4, bg: COLOR_BG[c], radius: 2 }, []),
                text(cols[c].count ? signed(cols[c].score) : '—', { size: 13, weight: 'bold', align: 'center', color: cols[c].score < 0 ? theme.danger : theme.text }),
                cols[c].count ? text(`${cols[c].count}张${cols[c].wagers ? ` ×${cols[c].wagers + 1}` : ''}`, { size: 10, align: 'center', color: theme.muted }) : null,
              ]),
            ),
          ),
        ],
        { gap: 6, padding: 10 },
      );
    }),
  );
}

function scoreboard(ctx: Ctx): UINode {
  const v = ctx.view;
  return card(
    [
      row({}, [
        text('轮次', { size: 12, color: theme.muted, width: 56 }),
        ...v.players.map((p) => text(ctx.nameOf(p.playerId), { size: 12, color: theme.muted, flex: 1, align: 'right', maxLines: 1 })),
      ]),
      ...v.history.map((r) =>
        row({}, [
          text(`第 ${r.round} 轮`, { size: 13, width: 56 }),
          ...v.players.map((p) => text(signed(r.scores[p.playerId]!), { size: 13, flex: 1, align: 'right' })),
        ]),
      ),
      row({}, [
        text('累计', { size: 14, weight: 'bold', width: 56 }),
        ...v.players.map((p) => text(String(v.result?.totals[p.playerId] ?? p.total), { size: 15, weight: 'bold', flex: 1, align: 'right', color: theme.primary })),
      ]),
    ],
    { gap: 6, padding: 12 },
  );
}

function roundEndScreen(ctx: Ctx): UINode {
  const v = ctx.view;
  const round = v.history[v.history.length - 1]!;
  const secs = ctx.remainingMs !== null ? Math.ceil(ctx.remainingMs / 1000) : null;
  return column({ flex: 1, padding: [ctx.safeArea.top + 12, 16, ctx.safeArea.bottom + 16, 16], gap: 10, bg: theme.bg }, [
    text(`第 ${round.round} 轮结算`, { size: 22, weight: 'bold' }),
    text('抽牌堆已抽完，本轮结束。手牌不计分。', { size: 13, color: theme.muted }),
    roundTable(ctx, round),
    scoreboard(ctx),
    spacer(1),
    commandBar(ctx),
    text(`${secs !== null ? `${secs} 秒后自动开始下一轮 · ` : ''}已确认 ${v.nextReadyCount}/2`, { size: 13, color: theme.muted, align: 'center' }),
    button(v.submitted ? '等待对手确认' : `开始第 ${round.round + 1} 轮`, { onPress: v.submitted ? undefined : () => submit(ctx, { type: 'NEXT_ROUND' }), height: 52 }),
  ]);
}

function resultScreen(ctx: Ctx): UINode {
  const v = ctx.view;
  const r = v.result!;
  const myId = v.me?.playerId;
  const title = r.winner === null ? '平局' : r.winner === myId ? '你赢了！' : '你输了';
  const detail = r.resigned ? `${r.resigned === myId ? '你' : ctx.nameOf(r.resigned)}认输` : r.winner ? `${ctx.nameOf(r.winner)} 以累计分获胜` : '双方累计分相同';
  const lastRound = v.history[v.history.length - 1];
  return column({ flex: 1, padding: [ctx.safeArea.top + 12, 16, ctx.safeArea.bottom + 16, 16], gap: 10, bg: theme.bg }, [
    text(title, { size: 30, weight: 'bold', align: 'center', color: r.winner === null ? theme.text : r.winner === myId ? theme.primary : theme.danger }),
    text(detail, { size: 14, color: theme.muted, align: 'center' }),
    scoreboard(ctx),
    lastRound && !r.resigned ? roundTable(ctx, lastRound) : null,
    spacer(1),
    text(ctx.isHost ? '房主可返回房间开始新一场' : '等待房主开始新一场', { align: 'center', color: theme.muted, size: 13 }),
    spacer(0.6),
  ]);
}

export const lostCitiesPresentation: GamePresentation = {
  render(raw) {
    const ctx = raw as Ctx;
    const v = ctx.view;
    if (v.result) return resultScreen(ctx);
    if (v.phase === 'round-end') return roundEndScreen(ctx);
    return boardScreen(ctx);
  },
};
