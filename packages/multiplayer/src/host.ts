import type { Clock, RandomSource, Unsubscribe } from '@we/platform';
import { cloneJson } from './codec';
import type { AnyGamePlugin } from './contract';
import { LOOPBACK_KEY, type DeviceNet, type Link } from './device-net';
import type { IdFactory } from './ids';
import {
  MAX_PASSWORD,
  PROTOCOL_VERSION,
  parseClientEnvelope,
  sanitizeNickname,
  type ClientEnvelope,
  type Envelope,
  type HostMessage,
  type PauseInfo,
  type PlayerSnapshot,
  type RoomAction,
  type RoomPlayer,
  type RoomStatus,
  type RoomView,
} from './protocol';

/**
 * Host Authority（设计 §7 / §9 / §10.2）：房间、会话、权威游戏状态。
 * 所有入站消息与定时器事件串行处理；完整 State 只存在于此闭包内。
 */

interface HeartbeatConfig {
  checkMs: number;
  suspectMs: number;
  lostMs: number;
}

const DEFAULT_HEARTBEAT: HeartbeatConfig = { checkMs: 1000, suspectMs: 6000, lostMs: 10000 };
const ROOM_CMD_CACHE_MAX = 500;
const DISCOVER_MIN_INTERVAL_MS = 300;

export interface HostInspection {
  room: RoomView;
  password: string | null;
  paused: PauseInfo | null;
  sessions: { playerId: string; link: string; epoch: string; lastSeenAgoMs: number; health: 'ok' | 'suspect' | 'lost' }[];
  match: { matchId: string; version: number; phaseId: string; timerRemainingMs: number | null; state: unknown } | null;
}

export interface HostAuthority {
  readonly roomId: string;
  /** 可选房间密码（展示给房主告知朋友）；null 表示无密码 */
  readonly password: string | null;
  /** 手动加入的兜底地址（局域网广播不可用时） */
  readonly address: string | null;
  /** Host 设备切后台：暂停规则时间，恢复后需房主手动继续 */
  setHostVisible(visible: boolean): void;
  close(reason: string): void;
  onClosed(fn: () => void): Unsubscribe;
  /** 测试专用：完整状态的不可变副本。生产入口不开启 debug 时抛错 */
  inspect(): HostInspection;
  /** 测试专用 Debug Port：下一局的夹具（例如指定角色） */
  setFixture(fixture: unknown): void;
  dispose(): void;
}

interface HostOptions {
  net: DeviceNet;
  clock: Clock;
  random: RandomSource;
  ids: IdFactory;
  plugin: AnyGamePlugin;
  config?: unknown;
  address: string | null;
  /** 可选房间密码；空串视为无密码 */
  password?: string;
  debug?: boolean;
  heartbeat?: Partial<HeartbeatConfig>;
  onAnnounce?: (text: string) => void;
}

interface Session {
  playerId: string;
  credential: string;
  epoch: string;
  link: Link;
  lastSeen: number;
  health: 'ok' | 'suspect' | 'lost';
  joinRequestId: string;
  resumeRequestId: string | null;
}

interface Match {
  matchId: string;
  state: unknown;
  version: number;
  timer: { key: string; phaseId: string; totalMs: number; hidden: boolean; deadline: number; remaining: number | null; cancel: Unsubscribe | null } | null;
  commandCache: Map<string, { hash: string; ok: boolean; code?: string }>;
}

type CommandResult = { ok: true } | { ok: false; code: string };

export async function createHostAuthority(options: HostOptions): Promise<HostAuthority> {
  const { net, clock, random, ids, plugin } = options;
  const hb = { ...DEFAULT_HEARTBEAT, ...options.heartbeat };
  let config: unknown = options.config ?? plugin.defaultConfig;
  const configCheck = plugin.validateConfig(config);
  if (!configCheck.ok) throw new Error(`invalid game config: ${configCheck.code}`);

  const roomId = ids.next('r');
  const password = options.password?.trim().slice(0, MAX_PASSWORD) || null;
  const discoverSeen = new Map<string, number>();

  const room: {
    hostId: string;
    roomVersion: number;
    status: RoomStatus;
    matchId: string | null;
    players: RoomPlayer[];
  } = { hostId: '', roomVersion: 1, status: 'lobby', matchId: null, players: [] };

  const sessions = new Map<string, Session>();
  const joinRequests = new Map<string, string>(); // requestId -> playerId
  const roomCmdCache = new Map<string, { hash: string; result: CommandResult }>();
  const pauseReasons = new Set<'disconnect' | 'host-hidden'>();
  const closedHandlers = new Set<() => void>();
  let match: Match | null = null;
  let fixture: unknown = undefined;
  let hostVisible = true;
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();
  let heartbeatCancel: Unsubscribe | null = null;

  /** 串行执行入站消息与定时器事件 */
  const enqueue = (task: () => void | Promise<void>): void => {
    queue = queue.then(task).catch(() => {
      /* 单条消息异常不影响后续处理 */
    });
  };

  // ---- 视图与发送 ---------------------------------------------------------

  const roomView = (): RoomView => ({
    roomId,
    hostId: room.hostId,
    gameId: plugin.id,
    gameTitle: plugin.title,
    rulesVersion: plugin.rulesVersion,
    roomVersion: room.roomVersion,
    matchId: room.matchId,
    status: room.status,
    capacity: plugin.playerCount(config),
    rules: plugin.ruleOptions(config),
    players: room.players.map((p) => ({ ...p })).sort((a, b) => a.seat - b.seat),
  });

  const envelope = (to: string, epoch: string, msg: HostMessage): Envelope => ({
    v: 1,
    roomId,
    matchId: room.matchId,
    from: 'host',
    to,
    sessionEpoch: epoch,
    messageId: ids.next('h'),
    type: msg.type,
    payload: msg.payload,
  });

  const sendTo = (link: Link, to: string, epoch: string, msg: HostMessage, reliable = true): void => {
    link.send(envelope(to, epoch, msg), { reliable });
  };

  const sendToPlayer = (playerId: string, msg: HostMessage, reliable = true): void => {
    const s = sessions.get(playerId);
    if (s) sendTo(s.link, playerId, s.epoch, msg, reliable);
  };

  const isConnected = (playerId: string): boolean =>
    room.players.find((p) => p.playerId === playerId)?.connected ?? false;

  const broadcastRoom = (): void => {
    room.roomVersion++;
    const view = roomView();
    for (const s of sessions.values()) if (isConnected(s.playerId)) sendToPlayer(s.playerId, { type: 'ROOM_SNAPSHOT', payload: { room: view } });
  };

  const pauseInfo = (): PauseInfo | null =>
    pauseReasons.size === 0
      ? null
      : { reasons: [...pauseReasons], disconnected: room.players.filter((p) => !p.connected).map((p) => p.playerId) };

  const timerInfo = (m: Match): PlayerSnapshot['timer'] => {
    if (!m.timer) return null;
    const remaining = m.timer.remaining ?? Math.max(0, m.timer.deadline - clock.now());
    return { remainingMs: remaining, totalMs: m.timer.totalMs };
  };

  /** 下发给玩家的计时：隐藏计时不出现在快照中 */
  const visibleTimer = (m: Match): PlayerSnapshot['timer'] => (m.timer?.hidden ? null : timerInfo(m));

  const snapshotFor = (m: Match, playerId: string): PlayerSnapshot => ({
    matchId: m.matchId,
    version: m.version,
    phaseId: plugin.phaseId(m.state),
    view: plugin.project(m.state, playerId),
    timer: visibleTimer(m),
    paused: pauseInfo(),
  });

  const sendSnapshot = (playerId: string): void => {
    if (!match || !room.players.some((p) => p.playerId === playerId)) return;
    sendToPlayer(playerId, { type: 'PLAYER_SNAPSHOT', payload: snapshotFor(match, playerId) });
  };

  const broadcastSnapshots = (): void => {
    if (!match) return;
    for (const p of room.players) if (p.connected) sendSnapshot(p.playerId);
  };

  // ---- 计时与暂停 ---------------------------------------------------------

  const clearTimer = (m: Match): void => {
    m.timer?.cancel?.();
    m.timer = null;
  };

  const timerKey = (t: { phaseId: string; step?: string } | null): string | null => (t ? `${t.phaseId}|${t.step ?? ''}` : null);

  const armTimer = (m: Match, key: string, phaseId: string, ms: number, totalMs: number, hidden: boolean): void => {
    const timer = { key, phaseId, totalMs, hidden, deadline: clock.now() + ms, remaining: null as number | null, cancel: null as Unsubscribe | null };
    m.timer = timer;
    if (pauseReasons.size > 0) {
      timer.remaining = ms;
      return;
    }
    timer.cancel = clock.setTimeout(() => enqueue(() => onTimer(m, key)), ms);
  };

  const scheduleTimer = (m: Match): void => {
    clearTimer(m);
    if (room.status !== 'playing') return;
    const t = plugin.timer(m.state);
    if (t) armTimer(m, timerKey(t)!, t.phaseId, t.ms, t.ms, t.hidden ?? false);
  };

  const onTimer = (m: Match, key: string): void => {
    if (match !== m || pauseReasons.size > 0 || room.status !== 'playing') return;
    if (!m.timer || m.timer.key !== key || timerKey(plugin.timer(m.state)) !== key) return;
    m.timer = null;
    applyCommand(m, 'system', plugin.timeoutCommand(m.state));
  };

  const setPaused = (reason: 'disconnect' | 'host-hidden', on: boolean): void => {
    const before = pauseReasons.size > 0;
    if (on) pauseReasons.add(reason);
    else pauseReasons.delete(reason);
    const after = pauseReasons.size > 0;
    if (!match || room.status !== 'playing') return;
    const m = match;
    if (!before && after && m.timer) {
      // 冻结剩余时间，不在后台补执行阶段
      m.timer.remaining = Math.max(0, m.timer.deadline - clock.now());
      m.timer.cancel?.();
      m.timer.cancel = null;
    } else if (before && !after && m.timer && m.timer.remaining !== null) {
      armTimer(m, m.timer.key, m.timer.phaseId, m.timer.remaining, m.timer.totalMs, m.timer.hidden);
    }
    m.version++;
    broadcastSnapshots();
  };

  const refreshDisconnectPause = (): void => {
    const anyLost = room.players.some((p) => !p.connected);
    if (room.status === 'playing') setPaused('disconnect', anyLost);
    else pauseReasons.delete('disconnect');
  };

  // ---- 游戏命令 -----------------------------------------------------------

  const applyCommand = (m: Match, actorId: string, command: unknown): CommandResult => {
    const phaseBefore = plugin.phaseId(m.state);
    const ctx = { actorId, now: clock.now(), phaseId: phaseBefore };
    const v = plugin.validate(m.state, command, ctx);
    if (!v.ok) return v;
    const prev = m.state;
    const t = plugin.reduce(m.state, command, ctx);
    m.state = t.state;
    m.version++;
    if (plugin.getResult(m.state) !== null && room.status === 'playing') {
      room.status = 'finished';
      pauseReasons.clear();
      clearTimer(m);
      broadcastRoom();
    } else if (plugin.phaseId(m.state) !== phaseBefore || (m.timer?.key ?? null) !== timerKey(plugin.timer(m.state))) {
      // 阶段变化，或同一阶段内计时步骤变化（例如预言家查验后的结果展示）
      scheduleTimer(m);
    }
    broadcastSnapshots();
    for (const text of plugin.announce(prev, m.state, t.events)) options.onAnnounce?.(text);
    return { ok: true };
  };

  const startMatch = async (): Promise<void> => {
    const matchId = ids.next('m');
    const seed = await random.bytes(32);
    const players = [...room.players].sort((a, b) => a.seat - b.seat).map((p) => ({ playerId: p.playerId, seat: p.seat }));
    const state = plugin.createInitialState({ matchId, players, config, seed, fixture: options.debug ? fixture : undefined });
    const m: Match = { matchId, state, version: 1, timer: null, commandCache: new Map() };
    match = m;
    room.status = 'playing';
    room.matchId = matchId;
    pauseReasons.clear();
    broadcastRoom();
    scheduleTimer(m);
    broadcastSnapshots();
    for (const text of plugin.announce(null, m.state, [])) options.onAnnounce?.(text);
  };

  const handleGameCommand = (s: Session, env: ClientEnvelope & { type: 'GAME_COMMAND' }): void => {
    const reply = (r: CommandResult): void =>
      sendToPlayer(s.playerId, { type: 'COMMAND_RESULT', payload: { commandId: env.payload.commandId, ...r } });
    const m = match;
    if (!m || env.matchId !== m.matchId) return reply({ ok: false, code: 'WRONG_STATUS' });
    const key = `${s.playerId}:${env.payload.commandId}`;
    const hash = JSON.stringify([env.payload.phaseId, env.payload.action]);
    const cached = m.commandCache.get(key);
    if (cached) {
      // 幂等：同 ID 同 payload 返回同一结果；业务结果丢失时也会重新下发最新投影
      reply(cached.hash === hash ? (cached.ok ? { ok: true } : { ok: false, code: cached.code ?? 'REJECTED' }) : { ok: false, code: 'COMMAND_ID_REUSED' });
      sendSnapshot(s.playerId);
      return;
    }
    const result = ((): CommandResult => {
      if (room.status !== 'playing') return { ok: false, code: 'WRONG_STATUS' };
      if (pauseReasons.size > 0) return { ok: false, code: 'PAUSED' };
      if (env.payload.phaseId !== plugin.phaseId(m.state)) return { ok: false, code: 'STALE_PHASE' };
      const command = plugin.parseCommand(env.payload.action);
      if (command === null) return { ok: false, code: 'BAD_ACTION' };
      let actor = s.playerId;
      if (plugin.isPublicControl(command)) {
        if (s.playerId !== room.hostId) return { ok: false, code: 'NOT_HOST' };
        actor = 'system';
      }
      return applyCommand(m, actor, command);
    })();
    m.commandCache.set(key, { hash, ok: result.ok, code: result.ok ? undefined : result.code });
    reply(result);
    if (!result.ok) sendSnapshot(s.playerId);
  };

  // ---- 房间命令 -----------------------------------------------------------

  /** 期望座位空闲且不超过容量时使用，否则分配最小空位 */
  const freeSeat = (preferred?: number): number => {
    const taken = new Set(room.players.map((p) => p.seat));
    if (preferred && preferred <= plugin.playerCount(config).max && !taken.has(preferred)) return preferred;
    let seat = 1;
    while (taken.has(seat)) seat++;
    return seat;
  };

  const removePlayer = (playerId: string): void => {
    room.players = room.players.filter((p) => p.playerId !== playerId);
    sessions.delete(playerId);
  };

  const runRoomAction = async (s: Session, action: RoomAction): Promise<CommandResult> => {
    const isHost = s.playerId === room.hostId;
    const me = room.players.find((p) => p.playerId === s.playerId);
    if (!me) return { ok: false, code: 'UNKNOWN_SESSION' };
    switch (action.kind) {
      case 'ready':
        if (room.status !== 'lobby') return { ok: false, code: 'WRONG_STATUS' };
        me.ready = action.ready;
        broadcastRoom();
        return { ok: true };
      case 'start': {
        if (!isHost) return { ok: false, code: 'NOT_HOST' };
        if (room.status !== 'lobby') return { ok: false, code: 'WRONG_STATUS' };
        const n = room.players.length;
        const count = plugin.playerCount(config);
        if (n < count.min || n > count.max) return { ok: false, code: 'BAD_PLAYER_COUNT' };
        if (!room.players.every((p) => p.ready && p.connected)) return { ok: false, code: 'NOT_READY' };
        await startMatch();
        return { ok: true };
      }
      case 'set-rule': {
        if (!isHost) return { ok: false, code: 'NOT_HOST' };
        if (room.status !== 'lobby') return { ok: false, code: 'WRONG_STATUS' };
        const next = plugin.setRuleOption(config, action.key, action.value);
        if (next === null || !plugin.validateConfig(next).ok) return { ok: false, code: 'BAD_RULE' };
        if (room.players.length > plugin.playerCount(next).max) return { ok: false, code: 'TOO_MANY_PLAYERS' };
        config = next;
        // 人数上限变小：超出上限的座位移到空位，保证开局时座位号连续
        for (const p of [...room.players].sort((a, b) => a.seat - b.seat)) {
          if (p.seat > plugin.playerCount(config).max) p.seat = freeSeat();
        }
        // 规则变化后其他玩家需要重新确认准备
        room.players.forEach((p) => (p.ready = p.isHost));
        broadcastRoom();
        return { ok: true };
      }
      case 'leave':
        if (isHost) {
          close('host-left');
          return { ok: true };
        }
        if (room.status === 'lobby') {
          removePlayer(s.playerId);
          broadcastRoom();
        } else {
          // 游戏中离开视为断线，等待重连或 Host 结束对局
          me.connected = false;
          s.health = 'lost';
          broadcastRoom();
          refreshDisconnectPause();
        }
        return { ok: true };
      case 'back-to-lobby':
      case 'end-match':
        if (!isHost) return { ok: false, code: 'NOT_HOST' };
        if (action.kind === 'back-to-lobby' ? room.status !== 'finished' : room.status !== 'playing')
          return { ok: false, code: 'WRONG_STATUS' };
        if (match) clearTimer(match);
        match = null;
        pauseReasons.clear();
        room.status = 'lobby';
        room.matchId = null;
        // 新一局：清空身份与命令；离线玩家移出座位
        for (const p of room.players.filter((x) => !x.connected)) removePlayer(p.playerId);
        room.players.forEach((p) => (p.ready = p.isHost));
        broadcastRoom();
        return { ok: true };
      case 'resume-game':
        if (!isHost) return { ok: false, code: 'NOT_HOST' };
        setPaused('host-hidden', false);
        return { ok: true };
      case 'close-room':
        if (!isHost) return { ok: false, code: 'NOT_HOST' };
        close('host-closed');
        return { ok: true };
    }
  };

  const handleRoomCommand = async (s: Session, env: ClientEnvelope & { type: 'ROOM_COMMAND' }): Promise<void> => {
    const key = `${s.playerId}:${env.payload.commandId}`;
    const hash = JSON.stringify(env.payload.action);
    const cached = roomCmdCache.get(key);
    let result: CommandResult;
    if (cached) result = cached.hash === hash ? cached.result : { ok: false, code: 'COMMAND_ID_REUSED' };
    else {
      result = await runRoomAction(s, env.payload.action);
      roomCmdCache.set(key, { hash, result });
      if (roomCmdCache.size > ROOM_CMD_CACHE_MAX) roomCmdCache.delete(roomCmdCache.keys().next().value!);
    }
    sendTo(s.link, s.playerId, s.epoch, { type: 'COMMAND_RESULT', payload: { commandId: env.payload.commandId, ...result } });
  };

  // ---- 加入 / 恢复 ---------------------------------------------------------

  const handleJoin = async (env: ClientEnvelope & { type: 'JOIN_REQUEST' }, reply: Link): Promise<void> => {
    const { requestId } = env.payload;
    const reject = (code: string): void => sendTo(reply, '', '', { type: 'JOIN_REJECT', payload: { requestId, code } });
    const existing = joinRequests.get(requestId);
    if (existing) {
      const s = sessions.get(existing);
      if (s && s.link.key === reply.key)
        sendTo(reply, s.playerId, s.epoch, {
          type: 'JOIN_ACCEPT',
          payload: { requestId, playerId: s.playerId, credential: s.credential, sessionEpoch: s.epoch, room: roomView() },
        });
      return;
    }
    if (env.payload.protocol !== PROTOCOL_VERSION) return reject('PROTOCOL');
    if (env.payload.gameId !== plugin.id) return reject('WRONG_GAME');
    if (room.status === 'closed') return reject('ROOM_CLOSED');
    if (password !== null && env.payload.password !== password) return reject('BAD_PASSWORD');
    if (room.status !== 'lobby') return reject('GAME_IN_PROGRESS');
    const nickname = sanitizeNickname(env.payload.nickname);
    if (!nickname) return reject('BAD_NICKNAME');
    const isLoopback = reply.key === LOOPBACK_KEY;
    if (!room.hostId && !isLoopback) return reject('HOST_NOT_READY');
    // 同一设备重复加入（例如重启后未走恢复）：替换旧座位
    for (const s of [...sessions.values()]) if (s.link.key === reply.key && s.playerId !== room.hostId) removePlayer(s.playerId);
    if (room.players.length >= plugin.playerCount(config).max) return reject('ROOM_FULL');

    const playerId = ids.next('p');
    const credential = await ids.secret(18);
    const epoch = ids.next('e');
    const seat = freeSeat(env.payload.seat);
    const isHost = !room.hostId && isLoopback;
    if (isHost) room.hostId = playerId;
    room.players.push({ playerId, nickname, seat, ready: isHost, connected: true, isHost });
    sessions.set(playerId, {
      playerId,
      credential,
      epoch,
      link: reply,
      lastSeen: clock.now(),
      health: 'ok',
      joinRequestId: requestId,
      resumeRequestId: null,
    });
    joinRequests.set(requestId, playerId);
    room.roomVersion++;
    sendTo(reply, playerId, epoch, {
      type: 'JOIN_ACCEPT',
      payload: { requestId, playerId, credential, sessionEpoch: epoch, room: roomView() },
    });
    broadcastRoom();
  };

  const handleResume = (env: ClientEnvelope & { type: 'RESUME_REQUEST' }, reply: Link): void => {
    const { requestId, playerId, credential } = env.payload;
    const s = sessions.get(playerId);
    if (!s || s.credential !== credential || room.status === 'closed') {
      sendTo(reply, '', '', { type: 'RESUME_REJECT', payload: { requestId, code: 'BAD_CREDENTIAL' } });
      return;
    }
    if (s.resumeRequestId !== requestId || s.link.key !== reply.key) {
      // 重新绑定当前地址并签发新 sessionEpoch；旧 epoch 消息被拒绝
      s.resumeRequestId = requestId;
      s.link = reply;
      s.epoch = ids.next('e');
    }
    s.lastSeen = clock.now();
    s.health = 'ok';
    const me = room.players.find((p) => p.playerId === playerId);
    if (me) me.connected = true;
    sendTo(reply, playerId, s.epoch, { type: 'RESUME_ACCEPT', payload: { requestId, playerId, sessionEpoch: s.epoch, room: roomView() } });
    broadcastRoom();
    refreshDisconnectPause();
    sendSnapshot(playerId);
  };

  // ---- 入站分发 -----------------------------------------------------------

  const markAlive = (s: Session): void => {
    s.lastSeen = clock.now();
    s.health = 'ok';
    const p = room.players.find((x) => x.playerId === s.playerId);
    if (p && !p.connected) {
      p.connected = true;
      broadcastRoom();
      refreshDisconnectPause();
      sendSnapshot(s.playerId);
    }
  };

  /** 房间发现：对广播 DISCOVER 单播回复公开房间信息；按来源限频 */
  const handleDiscover = (env: ClientEnvelope & { type: 'DISCOVER' }, reply: Link): void => {
    const hostPlayer = room.players.find((p) => p.isHost);
    if (!hostPlayer || env.payload.protocol !== PROTOCOL_VERSION) return;
    if (env.payload.gameId && env.payload.gameId !== plugin.id) return;
    const now = clock.now();
    if (now - (discoverSeen.get(reply.key) ?? -Infinity) < DISCOVER_MIN_INTERVAL_MS) return;
    if (discoverSeen.size > 256) discoverSeen.clear();
    discoverSeen.set(reply.key, now);
    sendTo(
      reply,
      '',
      '',
      {
        type: 'ROOM_INFO',
        payload: {
          nonce: env.payload.nonce,
          protocol: PROTOCOL_VERSION,
          roomId,
          gameId: plugin.id,
          gameTitle: plugin.title,
          hostName: hostPlayer.nickname,
          players: room.players.length,
          capacity: plugin.playerCount(config).max,
          status: room.status,
          hasPassword: password !== null,
        },
      },
      false,
    );
  };

  const handleInbound = async (raw: unknown, reply: Link): Promise<void> => {
    if (disposed || room.status === 'closed') return;
    const env = parseClientEnvelope(raw);
    if (!env) return;
    if (env.type === 'DISCOVER') return handleDiscover(env, reply);
    if (env.type === 'JOIN_REQUEST') return handleJoin(env, reply);
    if (env.roomId !== roomId) return;
    if (env.type === 'RESUME_REQUEST') return handleResume(env, reply);
    // 身份只从会话绑定解析：from + epoch + 来源地址全部匹配
    const s = sessions.get(env.from);
    if (!s || s.epoch !== env.sessionEpoch || s.link.key !== reply.key) {
      sendTo(reply, env.from, env.sessionEpoch, { type: 'SESSION_REJECT', payload: { code: 'UNKNOWN_SESSION', epoch: env.sessionEpoch } }, false);
      return;
    }
    markAlive(s);
    switch (env.type) {
      case 'HEARTBEAT':
        sendTo(reply, s.playerId, s.epoch, { type: 'PONG', payload: { t: env.payload.t } }, false);
        return;
      case 'SYNC_REQUEST':
        sendToPlayer(s.playerId, { type: 'ROOM_SNAPSHOT', payload: { room: roomView() } });
        sendSnapshot(s.playerId);
        return;
      case 'ROOM_COMMAND':
        return handleRoomCommand(s, env);
      case 'GAME_COMMAND':
        return handleGameCommand(s, env);
    }
  };

  const offInbound = net.onHostInbound((raw, reply) => enqueue(() => handleInbound(raw, reply)));

  // ---- 心跳检查 -----------------------------------------------------------

  const checkHeartbeats = (): void => {
    heartbeatCancel = null;
    if (disposed || room.status === 'closed') return;
    if (hostVisible) {
      const now = clock.now();
      let changed = false;
      for (const s of sessions.values()) {
        if (s.link.key === LOOPBACK_KEY) continue;
        const p = room.players.find((x) => x.playerId === s.playerId);
        const idle = now - s.lastSeen;
        if (idle > hb.lostMs) {
          s.health = 'lost';
          if (p?.connected) {
            p.connected = false;
            changed = true;
          }
        } else if (idle > hb.suspectMs) s.health = 'suspect';
      }
      if (changed) {
        broadcastRoom();
        refreshDisconnectPause();
      }
    }
    heartbeatCancel = clock.setTimeout(() => enqueue(checkHeartbeats), hb.checkMs);
  };
  heartbeatCancel = clock.setTimeout(() => enqueue(checkHeartbeats), hb.checkMs);

  // ---- 关闭 ---------------------------------------------------------------

  function close(reason: string): void {
    if (room.status === 'closed') return;
    for (const s of sessions.values()) sendTo(s.link, s.playerId, s.epoch, { type: 'ROOM_CLOSED', payload: { reason } });
    room.status = 'closed';
    if (match) clearTimer(match);
    heartbeatCancel?.();
    heartbeatCancel = null;
    closedHandlers.forEach((fn) => fn());
  }

  return {
    roomId,
    password,
    address: options.address,
    setHostVisible(visible) {
      enqueue(() => {
        hostVisible = visible;
        if (!visible) {
          if (room.status === 'playing') setPaused('host-hidden', true);
        } else {
          // 恢复后给所有客户端一个宽限期，避免把 Host 自己挂起的时间算成客户端断线
          const now = clock.now();
          sessions.forEach((s) => (s.lastSeen = now));
        }
      });
    },
    close: (reason) => enqueue(() => close(reason)),
    onClosed(fn) {
      closedHandlers.add(fn);
      return () => closedHandlers.delete(fn);
    },
    inspect() {
      if (!options.debug) throw new Error('inspect() is only available in debug builds');
      const now = clock.now();
      return cloneJson<HostInspection>({
        room: roomView(),
        password,
        paused: pauseInfo(),
        sessions: [...sessions.values()].map((s) => ({
          playerId: s.playerId,
          link: s.link.key,
          epoch: s.epoch,
          lastSeenAgoMs: now - s.lastSeen,
          health: s.health,
        })),
        match: match
          ? {
              matchId: match.matchId,
              version: match.version,
              phaseId: plugin.phaseId(match.state),
              timerRemainingMs: timerInfo(match)?.remainingMs ?? null,
              state: match.state,
            }
          : null,
      });
    },
    setFixture(f) {
      if (!options.debug) throw new Error('fixtures are only available in debug builds');
      fixture = f;
    },
    dispose() {
      if (disposed) return;
      if (room.status !== 'closed') close('host-disposed');
      disposed = true;
      offInbound();
      if (match) clearTimer(match);
      heartbeatCancel?.();
      closedHandlers.clear();
    },
  };
}
