import type { Clock, StoragePort, Unsubscribe } from '@we/platform';
import type { DeviceNet, Link } from './device-net';
import type { IdFactory } from './ids';
import {
  PROTOCOL_VERSION,
  parseHostEnvelope,
  type ClientMessage,
  type Envelope,
  type HostEnvelope,
  type PlayerSnapshot,
  type RoomAction,
  type RoomView,
} from './protocol';
import type { Endpoint } from './transport';

/** Client / Player Session（设计 §7.3 / §9.1）。只持有本玩家的授权投影。 */

type LinkHealth = 'ok' | 'suspect' | 'lost';

export interface CommandStatus {
  commandId: string;
  kind: 'room' | 'game';
  /** room: action.kind；game: action.type */
  label: string;
  status: 'pending' | 'ok' | 'rejected' | 'failed';
  code?: string;
}

export interface ClientState {
  phase: 'idle' | 'joining' | 'resuming' | 'in-room' | 'closed';
  error: string | null;
  hostAddress: string | null;
  isLocalHost: boolean;
  playerId: string | null;
  room: RoomView | null;
  snapshot: PlayerSnapshot | null;
  /** 收到快照时的本地时钟，用于显示倒计时 */
  snapshotAt: number;
  link: LinkHealth;
  commands: readonly CommandStatus[];
}

export interface SavedSession {
  hostAddress: string;
  endpoint: Endpoint;
  roomId: string;
  playerId: string;
  credential: string;
  nickname: string;
}

export interface PlayerClient {
  getState(): ClientState;
  subscribe(fn: (state: ClientState) => void): Unsubscribe;
  join(options: { link: Link; hostAddress: string; invite: string; nickname: string }): Promise<boolean>;
  resume(saved: SavedSession): Promise<boolean>;
  /** 断线后在原链路上重新绑定会话 */
  reconnect(): Promise<boolean>;
  roomCommand(action: RoomAction): string;
  gameCommand(action: unknown): string;
  retry(commandId: string): void;
  sync(): void;
  leave(): void;
  loadSavedSession(): Promise<SavedSession | null>;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const SESSION_KEY = 'session';
const MAX_COMMANDS = 20;

export function createPlayerClient(options: {
  net: DeviceNet;
  clock: Clock;
  ids: IdFactory;
  storage: StoragePort;
  gameId: string;
  heartbeatMs?: number;
  suspectMs?: number;
  lostMs?: number;
  requestTimeoutMs?: number;
}): PlayerClient {
  const { net, clock, ids, storage, gameId } = options;
  const heartbeatMs = options.heartbeatMs ?? 2000;
  const suspectMs = options.suspectMs ?? 6000;
  const lostMs = options.lostMs ?? 10000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 8000;

  let state: ClientState = {
    phase: 'idle',
    error: null,
    hostAddress: null,
    isLocalHost: false,
    playerId: null,
    room: null,
    snapshot: null,
    snapshotAt: 0,
    link: 'ok',
    commands: [],
  };
  const listeners = new Set<(s: ClientState) => void>();
  let hostLink: Link | null = null;
  let epoch = '';
  let roomId = '';
  let credential = '';
  let nickname = '';
  let lastPong = 0;
  let heartbeatCancel: Unsubscribe | null = null;
  let visible = true;
  let disposed = false;
  let stashedSnapshot: PlayerSnapshot | null = null;
  const sentCommands = new Map<string, ClientMessage>();
  let pendingRequest: { requestId: string; finish: (ok: boolean, error: string | null) => void } | null = null;

  const set = (patch: Partial<ClientState>): void => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn(state));
  };

  const envelope = (msg: ClientMessage): Envelope => ({
    v: 1,
    roomId: state.room?.roomId ?? roomId,
    matchId: state.snapshot?.matchId ?? state.room?.matchId ?? null,
    from: state.playerId ?? '',
    to: 'host',
    sessionEpoch: epoch,
    messageId: ids.next('c'),
    type: msg.type,
    payload: msg.payload,
  });

  const send = (msg: ClientMessage, reliable: boolean, onFailed?: () => void): void => {
    hostLink?.send(envelope(msg), { reliable, onFailed });
  };

  const persist = async (): Promise<void> => {
    if (!hostLink?.endpoint || !state.playerId || !state.room || !state.hostAddress) return;
    const saved: SavedSession = {
      hostAddress: state.hostAddress,
      endpoint: hostLink.endpoint,
      roomId: state.room.roomId,
      playerId: state.playerId,
      credential,
      nickname,
    };
    await storage.set(SESSION_KEY, JSON.stringify(saved));
  };

  const clearSaved = (): void => {
    storage.remove(SESSION_KEY).catch(() => undefined);
  };

  // ---- 心跳 ---------------------------------------------------------------

  const stopHeartbeat = (): void => {
    heartbeatCancel?.();
    heartbeatCancel = null;
  };

  const heartbeatTick = (): void => {
    heartbeatCancel = null;
    if (disposed || !visible || state.phase !== 'in-room' || !hostLink || state.isLocalHost) return;
    send({ type: 'HEARTBEAT', payload: { t: clock.now() } }, false);
    const idle = clock.now() - lastPong;
    const health: LinkHealth = idle > lostMs ? 'lost' : idle > suspectMs ? 'suspect' : 'ok';
    if (health !== state.link) set({ link: health });
    heartbeatCancel = clock.setTimeout(heartbeatTick, heartbeatMs);
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    if (state.isLocalHost) return;
    lastPong = clock.now();
    heartbeatTick();
  };

  // ---- 请求（JOIN / RESUME） ----------------------------------------------

  /** 结果由入站 ACCEPT / REJECT、超时或投递失败之一结束 */
  const request = (msg: ClientMessage & { payload: { requestId: string } }): Promise<boolean> =>
    new Promise((resolve) => {
      pendingRequest?.finish(false, null);
      const requestId = msg.payload.requestId;
      let cancelTimeout: Unsubscribe = () => undefined;
      const finish = (ok: boolean, error: string | null): void => {
        if (pendingRequest?.requestId !== requestId) return;
        pendingRequest = null;
        cancelTimeout();
        if (!ok && error !== null) set({ phase: state.room ? 'in-room' : 'idle', error });
        resolve(ok);
      };
      pendingRequest = { requestId, finish };
      cancelTimeout = clock.setTimeout(() => finish(false, 'TIMEOUT'), requestTimeoutMs);
      send(msg, true, () => finish(false, 'DELIVERY_FAILED'));
    });

  const finishRequest = (requestId: string, ok: boolean, error: string | null): void => {
    if (pendingRequest?.requestId === requestId) pendingRequest.finish(ok, error);
  };

  // ---- 入站 ---------------------------------------------------------------

  const acceptSnapshot = (snap: PlayerSnapshot): void => {
    if (!state.room || snap.matchId !== state.room.matchId) {
      stashedSnapshot = snap;
      return;
    }
    const cur = state.snapshot;
    if (cur && cur.matchId === snap.matchId && snap.version <= cur.version) return; // 忽略旧快照
    set({ snapshot: snap, snapshotAt: clock.now() });
  };

  const acceptRoom = (room: RoomView): void => {
    if (state.room && state.room.roomId === room.roomId && room.roomVersion <= state.room.roomVersion) return;
    const matchChanged = state.room?.matchId !== room.matchId;
    const patch: Partial<ClientState> = { room };
    if (matchChanged || room.matchId === null) patch.snapshot = null;
    set(patch);
    if (stashedSnapshot && stashedSnapshot.matchId === room.matchId) {
      const s = stashedSnapshot;
      stashedSnapshot = null;
      acceptSnapshot(s);
    }
  };

  const handle = (env: HostEnvelope, from: Link): void => {
    if (!hostLink || from.key !== hostLink.key) return;
    switch (env.type) {
      case 'JOIN_ACCEPT':
      case 'RESUME_ACCEPT': {
        if (pendingRequest?.requestId !== env.payload.requestId) return;
        epoch = env.payload.sessionEpoch;
        if (env.type === 'JOIN_ACCEPT') credential = env.payload.credential;
        set({ phase: 'in-room', error: null, playerId: env.payload.playerId, link: 'ok' });
        acceptRoom(env.payload.room);
        void persist();
        startHeartbeat();
        finishRequest(env.payload.requestId, true, null);
        if (env.type === 'RESUME_ACCEPT') send({ type: 'SYNC_REQUEST', payload: {} }, true);
        return;
      }
      case 'JOIN_REJECT':
      case 'RESUME_REJECT':
        if (env.type === 'RESUME_REJECT') clearSaved();
        finishRequest(env.payload.requestId, false, env.payload.code);
        return;
      case 'SESSION_REJECT':
        if (env.payload.epoch !== epoch || state.phase !== 'in-room') return; // 旧 epoch 的迟到拒绝
        set({ link: 'lost', error: env.payload.code });
        return;
      case 'ROOM_SNAPSHOT':
        if (env.to !== state.playerId) return;
        acceptRoom(env.payload.room);
        return;
      case 'PLAYER_SNAPSHOT':
        if (env.to !== state.playerId) return;
        acceptSnapshot(env.payload);
        return;
      case 'COMMAND_RESULT': {
        const { commandId, ok, code } = env.payload;
        if (!state.commands.some((c) => c.commandId === commandId)) return;
        set({
          commands: state.commands.map((c) =>
            c.commandId === commandId ? { ...c, status: ok ? 'ok' : 'rejected', code } : c,
          ),
        });
        return;
      }
      case 'PONG':
        lastPong = clock.now();
        if (state.link !== 'ok') {
          set({ link: 'ok', error: null });
          send({ type: 'SYNC_REQUEST', payload: {} }, true);
        }
        return;
      case 'ROOM_CLOSED':
        if (env.to !== state.playerId) return;
        stopHeartbeat();
        clearSaved();
        set({ phase: 'closed', error: env.payload.reason, snapshot: null });
        return;
    }
  };

  const offInbound = net.onClientInbound((raw, from) => {
    if (disposed) return;
    const env = parseHostEnvelope(raw);
    if (env) handle(env, from);
  });

  // ---- 命令 ---------------------------------------------------------------

  const track = (commandId: string, kind: 'room' | 'game', label: string, msg: ClientMessage): void => {
    sentCommands.set(commandId, msg);
    const commands = [...state.commands, { commandId, kind, label, status: 'pending' as const }].slice(-MAX_COMMANDS);
    const keep = new Set(commands.map((c) => c.commandId));
    for (const id of sentCommands.keys()) if (!keep.has(id)) sentCommands.delete(id);
    set({ commands });
  };

  const markFailed = (commandId: string): void => {
    set({
      commands: state.commands.map((c) =>
        c.commandId === commandId && c.status === 'pending' ? { ...c, status: 'failed', code: 'DELIVERY_FAILED' } : c,
      ),
    });
  };

  const dispatch = (commandId: string): void => {
    const msg = sentCommands.get(commandId);
    if (msg) send(msg, true, () => markFailed(commandId));
  };

  const resetSession = (): void => {
    stopHeartbeat();
    hostLink = null;
    epoch = '';
    roomId = '';
    credential = '';
    stashedSnapshot = null;
    sentCommands.clear();
  };

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async join({ link, hostAddress, invite, nickname: name }) {
      resetSession();
      hostLink = link;
      nickname = name;
      set({
        phase: 'joining',
        error: null,
        hostAddress,
        isLocalHost: link.endpoint === null,
        playerId: null,
        room: null,
        snapshot: null,
        commands: [],
        link: 'ok',
      });
      const requestId = ids.next('rq');
      return request({
        type: 'JOIN_REQUEST',
        payload: { requestId, protocol: PROTOCOL_VERSION, gameId, invite: invite.trim(), nickname: name },
      });
    },
    async resume(saved) {
      resetSession();
      hostLink = net.remote(saved.endpoint);
      credential = saved.credential;
      roomId = saved.roomId;
      nickname = saved.nickname;
      set({
        phase: 'resuming',
        error: null,
        hostAddress: saved.hostAddress,
        isLocalHost: false,
        playerId: saved.playerId,
        room: null,
        snapshot: null,
        commands: [],
        link: 'ok',
      });
      const requestId = ids.next('rq');
      return request({ type: 'RESUME_REQUEST', payload: { requestId, playerId: saved.playerId, credential: saved.credential } });
    },
    async reconnect() {
      if (!hostLink || !state.playerId || !credential) return false;
      const requestId = ids.next('rq');
      set({ error: null });
      return request({ type: 'RESUME_REQUEST', payload: { requestId, playerId: state.playerId, credential } });
    },
    roomCommand(action) {
      const commandId = ids.next('cmd');
      track(commandId, 'room', action.kind, { type: 'ROOM_COMMAND', payload: { commandId, action } });
      dispatch(commandId);
      return commandId;
    },
    gameCommand(action) {
      const commandId = ids.next('cmd');
      const snap = state.snapshot;
      const label = typeof action === 'object' && action && 'type' in action ? String((action as { type: unknown }).type) : 'action';
      track(commandId, 'game', label, {
        type: 'GAME_COMMAND',
        payload: { commandId, phaseId: snap?.phaseId ?? '', expectedVersion: snap?.version ?? 0, action },
      });
      dispatch(commandId);
      return commandId;
    },
    retry(commandId) {
      // 重试保持同一 commandId；Host 幂等返回同一结果
      set({ commands: state.commands.map((c) => (c.commandId === commandId ? { ...c, status: 'pending', code: undefined } : c)) });
      dispatch(commandId);
    },
    sync() {
      send({ type: 'SYNC_REQUEST', payload: {} }, true);
    },
    leave() {
      if (state.phase === 'in-room') send({ type: 'ROOM_COMMAND', payload: { commandId: ids.next('cmd'), action: { kind: 'leave' } } }, true);
      resetSession();
      clearSaved();
      set({ phase: 'idle', error: null, room: null, snapshot: null, playerId: null, commands: [], link: 'ok', hostAddress: null });
    },
    async loadSavedSession() {
      const raw = await storage.get(SESSION_KEY);
      if (!raw) return null;
      try {
        const s = JSON.parse(raw) as SavedSession;
        return s && typeof s.playerId === 'string' && typeof s.credential === 'string' && s.endpoint ? s : null;
      } catch {
        return null;
      }
    },
    setVisible(v) {
      visible = v;
      if (!v) stopHeartbeat();
      else if (state.phase === 'in-room') {
        startHeartbeat();
        send({ type: 'SYNC_REQUEST', payload: {} }, true);
      }
    },
    dispose() {
      disposed = true;
      offInbound();
      stopHeartbeat();
      pendingRequest?.finish(false, null);
      listeners.clear();
    },
  };
}
