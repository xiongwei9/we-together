import { button, card, column, list, modal, pressable, row, spacer, stack, text, theme, type UINode } from '@we/framework';
import { ERROR_TEXT, ROOM_CODE, type ClientState, type DiscoveredRoom, type RoomPlayer, type RoomView, type RuleOption, type SavedSession } from '@we/multiplayer';

/** 公共场景：AppHome（主题 + 游戏选择）/ GameHome / Join / Lobby / Paused / Closed（设计 §12） */

export interface AppModel {
  /** app 首页展示的主题 */
  app: { title: string; tagline: string };
  /** 已注册的游戏 */
  games: readonly { id: string; title: string; icon: string; summary: string; rulesVersion: string }[];
  /** 当前游戏（游戏首页、加入页使用） */
  selectedGame: string;
  nickname: string;
  /** apps：app 首页（多游戏）；home：游戏首页；join：局域网房间列表；manual：广播不可用时手动输入地址 */
  route: 'apps' | 'home' | 'join' | 'manual';
  /** 入口决定的联机方式：局域网（同一 Wi-Fi，微信）或联网（服务器中继、房间号加入，Web） */
  network: 'lan' | 'online';
  form: { address: string; password: string };
  /** 大厅中显示房间规则页（房主开房后默认打开） */
  showRules: boolean;
  rooms: readonly DiscoveredRoom[];
  searching: boolean;
  busy: string | null;
  bootError: string | null;
  saved: SavedSession | null;
  client: ClientState;
  hostInfo: { address: string | null; password: string | null } | null;
}

export interface AppActions {
  selectGame(gameId: string): void;
  openAppHome(): void;
  editNickname(): void;
  randomizeNickname(): void;
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
  setRule(key: string, value: string): void;
  openRules(): void;
  closeRules(): void;
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

/** 昵称输入框 + 「换一个」随机昵称 */
function nicknameField(m: AppModel, a: AppActions): UINode {
  return row({ gap: 8, align: 'end' }, [
    column({ flex: 1 }, [field('我的昵称', m.nickname, '点击设置昵称', a.editNickname)]),
    button('🎲 换一个', { onPress: a.randomizeNickname, variant: 'secondary', height: 50, width: 116, size: 15 }),
  ]);
}

/** 未结束房间的恢复入口（app 首页与游戏首页共用） */
function savedCard(m: AppModel, a: AppActions, busy: boolean): UINode | null {
  if (!m.saved) return null;
  return card(
    [
      text(`发现未结束的房间（${m.saved.hostAddress}）`, { size: 14, color: theme.muted }),
      row({ gap: 10 }, [
        button('恢复连接', { onPress: busy ? undefined : a.resumeSaved, flex: 1 }),
        button('放弃', { onPress: a.discardSaved, variant: 'secondary', width: 90 }),
      ]),
    ],
    { borderColor: theme.primary },
  );
}

/** app 首页：展示 app 主题与可玩的游戏，点选后进入该游戏的首页 */
export function renderAppHome(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const busy = m.busy !== null;
  return screen(safe.top, safe.bottom, [
    spacer(0.5),
    text('🎲', { size: 56, align: 'center' }),
    text(m.app.title, { size: 32, weight: 'bold', align: 'center', color: theme.primary }),
    text(m.app.tagline, { size: 14, align: 'center', color: theme.muted }),
    spacer(0.5),
    savedCard(m, a, busy),
    text('选择游戏', { size: 14, color: theme.muted }),
    list(m.games, (g) =>
      pressable(
        row({ height: 76, bg: theme.surface, radius: 14, padding: [0, 16, 0, 16], gap: 14, borderColor: theme.border, borderWidth: 1 }, [
          text(g.icon, { size: 34 }),
          column({ flex: 1, gap: 4 }, [
            text(g.title, { size: 19, weight: 'bold', maxLines: 1 }),
            g.summary ? text(g.summary, { size: 13, color: theme.muted, maxLines: 1 }) : null,
          ]),
          text('›', { size: 24, color: theme.primary }),
        ]),
        busy ? undefined : () => a.selectGame(g.id),
        { pressedBg: theme.surfaceAlt },
      ),
    ),
    m.busy ? text(m.busy, { align: 'center', color: theme.muted }) : null,
    m.bootError ? text(`网络不可用：${m.bootError}`, { align: 'center', color: theme.danger, size: 14 }) : null,
    m.client.error && m.client.phase !== 'in-room' ? text(errorText(m.client.error), { align: 'center', color: theme.danger }) : null,
    spacer(1),
    text(m.network === 'online' ? '联网对局：输入房间号加入，不需要同一 Wi-Fi。' : '局域网联机，无需服务器。所有玩家需连接同一 Wi-Fi。', {
      size: 12,
      color: theme.muted,
      align: 'center',
    }),
  ]);
}

/** 游戏首页：昵称、创建房间、加入房间（联网时输入房间号） */
export function renderHome(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const busy = m.busy !== null;
  const game = m.games.find((g) => g.id === m.selectedGame) ?? m.games[0]!;
  const online = m.network === 'online';
  return screen(safe.top, safe.bottom, [
    m.games.length > 1 ? row({}, [button('‹ 全部游戏', { onPress: busy ? undefined : a.openAppHome, variant: 'ghost', height: 36, size: 15 }), spacer(1)]) : null,
    spacer(0.4),
    text(game.icon, { size: 56, align: 'center' }),
    text(game.title, { size: 30, weight: 'bold', align: 'center', color: theme.primary }),
    text(`规则 ${game.rulesVersion}`, { size: 13, align: 'center', color: theme.muted }),
    spacer(0.4),
    nicknameField(m, a),
    savedCard(m, a, busy),
    button('创建房间', { onPress: busy || m.bootError ? undefined : a.createRoom, height: 56 }),
    button(online ? '输入房间号加入' : '加入房间', { onPress: busy || m.bootError ? undefined : a.openJoin, variant: 'secondary', height: 56 }),
    m.busy ? text(m.busy, { align: 'center', color: theme.muted }) : null,
    m.bootError ? text(`网络不可用：${m.bootError}`, { align: 'center', color: theme.danger, size: 14 }) : null,
    m.client.error && m.client.phase !== 'in-room' ? text(errorText(m.client.error), { align: 'center', color: theme.danger }) : null,
    spacer(1),
    text(online ? '不需要同一 Wi-Fi。房主创建房间后，把 6 位房间号告诉其他玩家。' : '所有玩家需连接同一局域网（Wi-Fi）。房主设备保持亮屏。', {
      size: 12,
      color: theme.muted,
      align: 'center',
    }),
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
    header('加入房间', `${m.games.find((g) => g.id === m.selectedGame)?.title ?? ''} · ${m.searching ? '正在搜索同一 Wi-Fi 下的房间…' : '已停止搜索'}`),
    nicknameField(m, a),
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

/** 手动加入：局域网按地址（广播搜不到时）；联网按房间号 */
export function renderManualJoin(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const joining = m.client.phase === 'joining';
  const online = m.network === 'online';
  const busy = joining || m.busy !== null;
  return screen(safe.top, safe.bottom, [
    online ? header('输入房间号', '向房主索取 6 位房间号') : header('手动加入', '局域网搜索不到时，向房主索取地址'),
    nicknameField(m, a),
    online ? field('房间号', m.form.address, '6 位数字', a.editAddress) : field('房间地址', m.form.address, '例如 192.168.1.10:20000', a.editAddress),
    field('房间密码（可选）', m.form.password ? '•'.repeat(m.form.password.length) : '', '无密码可不填', a.editPassword),
    m.busy ? text(m.busy, { align: 'center', color: theme.muted }) : null,
    m.client.error ? text(errorText(m.client.error), { color: theme.danger }) : null,
    spacer(1),
    button(joining ? '连接中…' : online ? '加入' : '连接', { onPress: busy || !m.form.address || !m.nickname ? undefined : a.submitManualJoin, height: 56 }),
    button('返回', { onPress: online ? a.cancelJoin : a.openJoin, variant: 'ghost' }),
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

const choiceLabel = (r: RuleOption): string => r.choices.find((c) => c.value === r.value)?.label ?? r.value;

function seatTile(p: RoomPlayer | null, seat: number, mine: boolean): UINode {
  return column(
    {
      flex: 1,
      height: 56,
      bg: mine ? theme.surfaceAlt : theme.surface,
      radius: 10,
      padding: [6, 8, 6, 8],
      gap: 2,
      justify: 'center',
      borderColor: mine ? theme.primary : theme.border,
      borderWidth: 1,
    },
    [
      row({ gap: 4 }, [
        text(`${seat}号`, { size: 12, color: theme.muted }),
        p?.isHost ? text('房主', { size: 11, color: theme.primary }) : null,
        spacer(1),
        p ? text(!p.connected ? '离线' : p.ready ? '已准备' : '未准备', { size: 11, color: !p.connected ? theme.danger : p.ready ? theme.success : theme.muted }) : null,
      ]),
      text(p ? p.nickname : '空位', { size: 15, color: p ? theme.text : theme.muted, maxLines: 1 }),
    ],
  );
}

export function renderLobby(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const c = m.client;
  const room = c.room!;
  const me = room.players.find((p) => p.playerId === c.playerId);
  const isHost = room.hostId === c.playerId;
  const seats: (RoomPlayer | null)[] = Array.from({ length: room.capacity.max }, (_, i) => room.players.find((p) => p.seat === i + 1) ?? null);
  const allReady = room.players.length >= room.capacity.min && room.players.every((p) => p.ready && p.connected);
  const pendingStart = c.commands.some((cmd) => cmd.label === 'start' && cmd.status === 'pending');
  const grid: UINode[] = [];
  for (let i = 0; i < seats.length; i += 3) {
    grid.push(row({ gap: 8 }, [0, 1, 2].map((k) => (i + k < seats.length ? seatTile(seats[i + k]!, i + k + 1, seats[i + k]?.playerId === c.playerId) : spacer(1)))));
  }
  // 联网房间：房主的中继编号即房间号，所有人都显示以便转告
  const roomCode = c.hostAddress && ROOM_CODE.test(c.hostAddress) ? c.hostAddress : null;
  return screen(safe.top, safe.bottom, [
    header(room.gameTitle, `${roomCode ? `联网房间号 ${roomCode}` : `房间 ${room.roomId.slice(-6)}`} · ${room.players.length}/${room.capacity.max} 人`),
    linkBanner(c, a),
    m.hostInfo
      ? card(
          [
            m.network === 'online' && m.hostInfo.address
              ? row({ justify: 'space-between' }, [
                  text('房间号', { color: theme.muted }),
                  text(m.hostInfo.address, { size: 26, weight: 'bold', color: theme.primary }),
                ])
              : null,
            row({ justify: 'space-between' }, [
              text('房间密码', { color: theme.muted }),
              m.hostInfo.password
                ? text(m.hostInfo.password, { size: 22, weight: 'bold', color: theme.primary })
                : text('未设置', { size: 16, color: theme.muted }),
            ]),
            text(
              m.network === 'online'
                ? '其他玩家在游戏首页点「输入房间号加入」'
                : m.hostInfo.address
                  ? `同一 Wi-Fi 下在「加入房间」即可看到；搜索不到时手动输入 ${m.hostInfo.address}`
                  : '同一 Wi-Fi 下的玩家在「加入房间」中即可看到本房间',
              { size: 12, color: theme.muted },
            ),
          ],
          { gap: 6, padding: 12 },
        )
      : null,
    room.rules.length
      ? pressable(
          column({ bg: theme.surface, radius: 12, padding: 12, gap: 4, borderColor: theme.border, borderWidth: 1 }, [
            row({}, [text('房间规则', { size: 14, color: theme.muted, flex: 1 }), text(isHost ? '修改 ›' : '查看 ›', { size: 14, color: theme.primary })]),
            text(room.rules.map(choiceLabel).join(' · '), { size: 13, maxLines: 3 }),
          ]),
          a.openRules,
        )
      : null,
    column({ gap: 8 }, grid),
    spacer(1),
    isHost
      ? button(pendingStart ? '开始中…' : allReady ? '开始游戏' : `等待全员准备（需 ${room.capacity.min} 人）`, {
          onPress: allReady && !pendingStart ? a.startMatch : undefined,
          height: 56,
        })
      : button(me?.ready ? '取消准备' : '准备', { onPress: () => a.setReady(!me?.ready), height: 56, variant: me?.ready ? 'secondary' : 'primary' }),
    button(isHost ? '解散房间' : '退出房间', { onPress: a.leaveRoom, variant: 'ghost' }),
  ]);
}

/** 房间规则：房主可逐项点击切换取值，其他玩家只读；修改后其他玩家需重新准备 */
export function renderRules(m: AppModel, a: AppActions, safe: { top: number; bottom: number }): UINode {
  const room = m.client.room!;
  const isHost = room.hostId === m.client.playerId;
  const next = (r: RuleOption): string => {
    const i = r.choices.findIndex((c) => c.value === r.value);
    return r.choices[(i + 1) % r.choices.length]!.value;
  };
  return screen(safe.top, safe.bottom, [
    header('房间规则', isHost ? '点击任一项切换；开局后规则锁定' : '由房主设置，开局后锁定'),
    linkBanner(m.client, a),
    list(room.rules, (r) =>
      pressable(
        row({ height: 52, bg: theme.surface, radius: 10, padding: [0, 14, 0, 14], gap: 10, borderColor: theme.border, borderWidth: 1 }, [
          text(r.label, { size: 15, color: theme.muted, width: 80 }),
          text(choiceLabel(r), { size: 16, flex: 1, maxLines: 1 }),
          isHost ? text('切换', { size: 14, color: theme.primary }) : null,
        ]),
        isHost ? () => a.setRule(r.key, next(r)) : undefined,
      ),
    ),
    isHost ? text('修改规则后，其他玩家需要重新准备。', { size: 12, color: theme.muted }) : null,
    spacer(1),
    button('完成', { onPress: a.closeRules, height: 56 }),
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
