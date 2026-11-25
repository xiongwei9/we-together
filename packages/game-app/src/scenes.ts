import { button, card, column, list, modal, pressable, row, spacer, stack, text, theme, type UINode } from '@we/framework';
import { ERROR_TEXT, type ClientState, type RoomPlayer, type RoomView, type SavedSession } from '@we/multiplayer';

/** 公共场景：GameSelect / Join / Lobby / Paused / Closed（设计 §12） */

export interface AppModel {
  gameTitle: string;
  rulesVersion: string;
  nickname: string;
  route: 'home' | 'join';
  form: { address: string; invite: string };
  busy: string | null;
  bootError: string | null;
  saved: SavedSession | null;
  client: ClientState;
  hostInfo: { address: string | null; invite: string } | null;
}

export interface AppActions {
  editNickname(): void;
  createRoom(): void;
  openJoin(): void;
  cancelJoin(): void;
  editAddress(): void;
  editInvite(): void;
  submitJoin(): void;
  resumeSaved(): void;
  discardSaved(): void;
  setReady(ready: boolean): void;
  startMatch(): void;
  leaveRoom(): void;
  reconnect(): void;
  backHome(): void;
  backToLobby(): void;
  resumeGame(): void;
  endMatch(): void;
}

export const errorText = (code: string | null | undefined): string => (code ? (ERROR_TEXT[code] ?? code) : '');

export const playerName = (p: RoomPlayer): string => `${p.seat}号 ${p.nickname}`;

function screen(safeTop: number, safeBottom: number, children: (UINode | null | false)[]): UINode {
  return column({ flex: 1, padding: [safeTop + 16, 20, safeBottom + 20, 20], gap: 14 }, children);
}

function header(title: string, subtitle?: string): UINode {
  return column({ gap: 4 }, [
    text(title, { size: 26, weight: 'bold', color: theme.primary }),
    subtitle ? text(subtitle, { size: 13, color: theme.muted }) : null,
  ]);
}

function field(label: string, value: string, placeholder: string, onPress: () => void): UINode {
  // 标签与输入框整体可点击
  return pressable(
    column({ gap: 6, radius: 10 }, [
      text(label, { size: 13, color: theme.muted }),
      row({ height: 50, bg: theme.surfaceAlt, radius: 10, padding: [0, 14, 0, 14], borderColor: theme.border, borderWidth: 1 }, [
        text(value || placeholder, { size: 17, color: value ? theme.text : theme.muted, flex: 1, maxLines: 1 }),
        text('修改', { size: 14, color: theme.primary }),
      ]),
    ]),
    onPress,
  );
}

export function renderHome(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const busy = m.busy !== null;
  return screen(safe.top, safe.bottom, [
    spacer(0.4),
    text('🐺', { size: 56, align: 'center' }),
    text(m.gameTitle, { size: 30, weight: 'bold', align: 'center', color: theme.primary }),
    text(`规则 ${m.rulesVersion} · 局域网联机 · 无需服务器`, { size: 13, align: 'center', color: theme.muted }),
    spacer(0.4),
    field('我的昵称', m.nickname, '点击设置昵称', a.editNickname),
    m.saved
      ? card(
          [
            text(`发现未结束的房间（${m.saved.hostAddress}）`, { size: 14, color: theme.muted }),
            row({ gap: 10 }, [
              button('恢复连接', { onPress: busy ? undefined : a.resumeSaved, flex: 1 }),
              button('放弃', { onPress: a.discardSaved, variant: 'secondary', width: 90 }),
            ]),
          ],
          { borderColor: theme.primary },
        )
      : null,
    button('创建房间', { onPress: busy || m.bootError ? undefined : a.createRoom, height: 56 }),
    button('加入房间', { onPress: busy || m.bootError ? undefined : a.openJoin, variant: 'secondary', height: 56 }),
    m.busy ? text(m.busy, { align: 'center', color: theme.muted }) : null,
    m.bootError ? text(`网络不可用：${m.bootError}`, { align: 'center', color: theme.danger, size: 14 }) : null,
    m.client.error && m.client.phase !== 'in-room' ? text(errorText(m.client.error), { align: 'center', color: theme.danger }) : null,
    spacer(1),
    text('所有玩家需连接同一局域网（Wi-Fi）。房主设备保持亮屏。', { size: 12, color: theme.muted, align: 'center' }),
  ]);
}

export function renderJoin(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const joining = m.client.phase === 'joining';
  return screen(safe.top, safe.bottom, [
    header('加入房间', '向房主索取房间地址与邀请码'),
    field('我的昵称', m.nickname, '点击设置昵称', a.editNickname),
    field('房间地址', m.form.address, '例如 192.168.1.10:20000', a.editAddress),
    field('邀请码', m.form.invite, '6 位数字', a.editInvite),
    m.client.error ? text(errorText(m.client.error), { color: theme.danger }) : null,
    spacer(1),
    button(joining ? '连接中…' : '连接', {
      onPress: joining || !m.form.address || !m.form.invite || !m.nickname ? undefined : a.submitJoin,
      height: 56,
    }),
    button('返回', { onPress: a.cancelJoin, variant: 'ghost' }),
  ]);
}

function linkBanner(c: ClientState, a: AppActions): UINode | null {
  if (c.link === 'ok') return null;
  if (c.link === 'suspect')
    return row({ bg: '#4a3a12', radius: 10, padding: 10 }, [text('网络不稳定，正在等待房主响应…', { size: 14, color: theme.primary })]);
  return column({ bg: '#4a1d1b', radius: 10, padding: 12, gap: 8 }, [
    text(c.error ? `与房主失去连接（${errorText(c.error)}）` : '与房主失去连接', { size: 15, color: '#ffb4ae' }),
    row({ gap: 10 }, [
      button('重新连接', { onPress: a.reconnect, flex: 1, height: 40, size: 15 }),
      button('离开', { onPress: a.leaveRoom, variant: 'secondary', width: 80, height: 40, size: 15 }),
    ]),
  ]);
}

export function renderLobby(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const c = m.client;
  const room = c.room!;
  const me = room.players.find((p) => p.playerId === c.playerId);
  const isHost = room.hostId === c.playerId;
  const seats: (RoomPlayer | null)[] = Array.from({ length: room.capacity.max }, (_, i) => room.players.find((p) => p.seat === i + 1) ?? null);
  const allReady = room.players.length >= room.capacity.min && room.players.every((p) => p.ready && p.connected);
  const pendingStart = c.commands.some((cmd) => cmd.label === 'start' && cmd.status === 'pending');
  return screen(safe.top, safe.bottom, [
    header(room.gameTitle, `房间 ${room.roomId.slice(-6)} · ${room.players.length}/${room.capacity.max} 人`),
    linkBanner(c, a),
    m.hostInfo
      ? card([
          text('让其他玩家输入：', { size: 13, color: theme.muted }),
          row({ justify: 'space-between' }, [text('地址', { color: theme.muted }), text(m.hostInfo.address ?? '未知（请检查网络）', { size: 18, weight: 'bold' })]),
          row({ justify: 'space-between' }, [text('邀请码', { color: theme.muted }), text(m.hostInfo.invite, { size: 26, weight: 'bold', color: theme.primary })]),
        ])
      : null,
    list(
      seats,
      (p, i) =>
        row(
          {
            height: 50,
            bg: p?.playerId === c.playerId ? theme.surfaceAlt : theme.surface,
            radius: 10,
            padding: [0, 14, 0, 14],
            gap: 10,
            borderColor: p?.playerId === c.playerId ? theme.primary : theme.border,
            borderWidth: 1,
          },
          [
            text(`${i + 1}号`, { size: 15, color: theme.muted, width: 36 }),
            text(p ? p.nickname : '空位', { size: 17, color: p ? theme.text : theme.muted, flex: 1, maxLines: 1 }),
            p?.isHost ? text('房主', { size: 13, color: theme.primary }) : null,
            p && !p.connected ? text('离线', { size: 13, color: theme.danger }) : null,
            p ? text(p.ready ? '已准备' : '未准备', { size: 14, color: p.ready ? theme.success : theme.muted }) : null,
          ],
        ),
      { flex: 1 },
    ),
    isHost
      ? button(pendingStart ? '开始中…' : allReady ? '开始游戏' : `等待全员准备（需 ${room.capacity.min} 人）`, {
          onPress: allReady && !pendingStart ? a.startMatch : undefined,
          height: 56,
        })
      : button(me?.ready ? '取消准备' : '准备', { onPress: () => a.setReady(!me?.ready), height: 56, variant: me?.ready ? 'secondary' : 'primary' }),
    button(isHost ? '解散房间' : '退出房间', { onPress: a.leaveRoom, variant: 'ghost' }),
  ]);
}

export function renderClosed(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const reason: Record<string, string> = {
    'host-left': '房主已离开',
    'host-closed': '房主解散了房间',
    'host-disposed': '房主设备已退出',
  };
  return screen(safe.top, safe.bottom, [
    spacer(1),
    text('房间已关闭', { size: 26, weight: 'bold', align: 'center' }),
    text(reason[m.client.error ?? ''] ?? errorText(m.client.error), { align: 'center', color: theme.muted }),
    spacer(1),
    button('返回首页', { onPress: a.backHome, height: 56 }),
  ]);
}

/** 游戏场景外壳：连接提示 + 暂停弹窗 */
export function wrapGame(game: UINode, m: AppModel, a: AppActions, room: RoomView): UINode {
  const c = m.client;
  const paused = c.snapshot?.paused ?? null;
  const isHost = room.hostId === c.playerId;
  const banner = linkBanner(c, a);
  let pauseModal: UINode | null = null;
  if (paused && room.status === 'playing') {
    const names = paused.disconnected
      .map((id) => room.players.find((p) => p.playerId === id))
      .filter((p): p is RoomPlayer => !!p)
      .map((p) => `${p.seat}号 ${p.nickname}`);
    pauseModal = modal(
      card([
        text('游戏暂停', { size: 22, weight: 'bold', align: 'center' }),
        names.length ? text(`等待 ${names.join('、')} 重新连接`, { align: 'center', color: theme.muted }) : null,
        paused.reasons.includes('host-hidden') ? text('房主设备曾切到后台，需房主手动继续', { align: 'center', color: theme.muted }) : null,
        isHost && paused.reasons.includes('host-hidden') && !names.length ? button('继续游戏', { onPress: a.resumeGame }) : null,
        isHost ? button('结束本局', { onPress: a.endMatch, variant: 'danger' }) : null,
        !isHost ? text('计时已暂停，请稍候', { align: 'center', size: 13, color: theme.muted }) : null,
      ]),
    );
  }
  const finishedBar =
    room.status === 'finished'
      ? {
          kind: 'box' as const,
          dir: 'column' as const,
          absolute: true,
          style: { justify: 'end' as const, padding: [0, 16, 16, 16] as [number, number, number, number] },
          children: [
            isHost
              ? row({ gap: 10 }, [
                  button('返回房间，再来一局', { onPress: a.backToLobby, flex: 1, height: 52 }),
                  button('解散', { onPress: a.leaveRoom, variant: 'secondary', width: 80, height: 52 }),
                ])
              : button('离开房间', { onPress: a.leaveRoom, variant: 'secondary', height: 48 }),
          ],
        }
      : null;
  return stack(
    [
      game,
      finishedBar,
      banner ? { kind: 'box', dir: 'column', absolute: true, style: { padding: [8, 12, 0, 12] }, children: [banner] } : null,
      pauseModal,
    ],
    { flex: 1 },
  );
}
