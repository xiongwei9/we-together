import { button, card, column, list, modal, pressable, row, spacer, stack, text, theme, type UINode } from '@we/framework';
import { ERROR_TEXT, type ClientState, type DiscoveredRoom, type RoomPlayer, type RoomView, type SavedSession } from '@we/multiplayer';

/** 公共场景：GameSelect / Join / Lobby / Paused / Closed（设计 §12） */

export interface AppModel {
  gameTitle: string;
  rulesVersion: string;
  nickname: string;
  /** join：局域网房间列表；manual：广播不可用时手动输入地址 */
  route: 'home' | 'join' | 'manual';
  form: { address: string; password: string };
  rooms: readonly DiscoveredRoom[];
  searching: boolean;
  busy: string | null;
  bootError: string | null;
  saved: SavedSession | null;
  client: ClientState;
  hostInfo: { address: string | null; password: string | null } | null;
}

export interface AppActions {
  editNickname(): void;
  createRoom(): void;
  openJoin(): void;
  cancelJoin(): void;
  joinDiscovered(room: DiscoveredRoom): void;
  openManual(): void;
  editAddress(): void;
  editPassword(): void;
  submitManualJoin(): void;
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

function roomCard(r: DiscoveredRoom, a: AppActions, disabled: boolean): UINode {
  const full = r.players >= r.capacity;
  const joinable = r.status === 'lobby' && !full;
  const state = r.status !== 'lobby' ? '游戏中' : full ? '已满' : '等待加入';
  return pressable(
    column({ bg: theme.surface, radius: 12, padding: [12, 14, 12, 14], gap: 4, borderColor: joinable ? theme.border : '#2a2738', borderWidth: 1, opacity: joinable ? 1 : 0.5 }, [
      row({ gap: 8 }, [
        text(`${r.hostName} 的房间`, { size: 17, weight: 'bold', flex: 1, maxLines: 1 }),
        r.hasPassword ? text('🔒 需密码', { size: 13, color: theme.primary }) : null,
      ]),
      text(`${r.gameTitle} · ${r.players}/${r.capacity} 人 · ${state}`, { size: 13, color: theme.muted }),
    ]),
    joinable && !disabled ? () => a.joinDiscovered(r) : undefined,
  );
}

export function renderJoin(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const joining = m.client.phase === 'joining';
  return screen(safe.top, safe.bottom, [
    header('加入房间', m.searching ? '正在搜索同一 Wi-Fi 下的房间…' : '已停止搜索'),
    field('我的昵称', m.nickname, '点击设置昵称', a.editNickname),
    m.rooms.length
      ? list(m.rooms, (r) => roomCard(r, a, joining || !m.nickname))
      : card([
          text('暂未发现房间', { size: 16, align: 'center' }),
          text('请确认与房主连接同一 Wi-Fi；公共 Wi-Fi 可能隔离设备，可改用手机热点或手动输入地址。', { size: 13, color: theme.muted, align: 'center' }),
        ]),
    joining ? text('连接中…', { align: 'center', color: theme.muted }) : null,
    m.client.error ? text(errorText(m.client.error), { color: theme.danger, align: 'center' }) : null,
    spacer(1),
    button('手动输入地址', { onPress: a.openManual, variant: 'secondary' }),
    button('返回', { onPress: a.cancelJoin, variant: 'ghost' }),
  ]);
}

export function renderManualJoin(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const joining = m.client.phase === 'joining';
  return screen(safe.top, safe.bottom, [
    header('手动加入', '局域网搜索不到时，向房主索取地址'),
    field('我的昵称', m.nickname, '点击设置昵称', a.editNickname),
    field('房间地址', m.form.address, '例如 192.168.1.10:20000', a.editAddress),
    field('房间密码（可选）', m.form.password ? '•'.repeat(m.form.password.length) : '', '无密码可不填', a.editPassword),
    m.client.error ? text(errorText(m.client.error), { color: theme.danger }) : null,
    spacer(1),
    button(joining ? '连接中…' : '连接', { onPress: joining || !m.form.address || !m.nickname ? undefined : a.submitManualJoin, height: 56 }),
    button('返回', { onPress: a.openJoin, variant: 'ghost' }),
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
          text('同一 Wi-Fi 下的玩家在「加入房间」中即可看到本房间', { size: 13, color: theme.muted }),
          row({ justify: 'space-between' }, [
            text('房间密码', { color: theme.muted }),
            m.hostInfo.password
              ? text(m.hostInfo.password, { size: 24, weight: 'bold', color: theme.primary })
              : text('未设置', { size: 16, color: theme.muted }),
          ]),
          m.hostInfo.address ? text(`搜索不到时可手动输入：${m.hostInfo.address}`, { size: 12, color: theme.muted }) : null,
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
