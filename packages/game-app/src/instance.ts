import { createUiApp, type Scene, type UiApp } from '@we/framework';
import type { Platform, Unsubscribe } from '@we/platform';
import {
  createDeviceNet,
  createHostAuthority,
  createIdFactory,
  createPlayerClient,
  createReliableNode,
  createRoomBrowser,
  defaultAddressCodec,
  MAX_PASSWORD,
  type AddressCodec,
  type ClientState,
  type DeviceNet,
  type DiscoveredRoom,
  type Endpoint,
  type HostAuthority,
  type IdFactory,
  type PlayerClient,
  type ReliableNode,
  type RoomAction,
  type RoomBrowser,
  type Transport,
} from '@we/multiplayer';
import type { GamePluginDefinition, GameSceneContext } from './contract';
import {
  errorText,
  playerName,
  renderClosed,
  renderHome,
  renderJoin,
  renderLobby,
  renderManualJoin,
  wrapGame,
  type AppActions,
  type AppModel,
} from './scenes';

/**
 * 可重入的游戏实例工厂（设计 §13.3）：微信入口创建一次，Web 模拟器创建 N 次。
 * 不访问 document / wx；所有依赖显式注入，没有模块级可变单例。
 */

interface GameInstanceOptions {
  instanceId: string;
  platform: Platform;
  transport: Transport;
  games: readonly GamePluginDefinition[];
  address?: AddressCodec;
  /** 覆盖游戏配置（例如模拟器缩短计时） */
  gameConfig?: unknown;
  /** 仅模拟器：开启 Host Inspector / Debug Port */
  debug?: boolean;
  defaultNickname?: string;
}

export interface InstanceStatus {
  started: boolean;
  bootError: string | null;
  endpoint: Endpoint | null;
  isHost: boolean;
  hostInfo: { address: string | null; password: string | null } | null;
  /** 局域网发现的房间（仅在「加入房间」页搜索时更新） */
  rooms: readonly DiscoveredRoom[];
  client: ClientState;
  visible: boolean;
  muted: boolean;
}

/** 与 UI 按钮相同的玩家操作 API；模拟器批量操作也只能通过这里 */
interface GameActions {
  /** password 为 undefined 时弹出可选密码输入；传空串表示不设密码 */
  createRoom(options?: { nickname?: string; password?: string }): Promise<boolean>;
  searchRooms(): void;
  stopSearch(): void;
  /** 加入局域网发现的房间；需要密码且未提供时弹出输入 */
  joinDiscovered(roomKey: string, options?: { password?: string; nickname?: string }): Promise<boolean>;
  /** 兜底：按地址手动加入 */
  joinRoom(address: string, password?: string, nickname?: string): Promise<boolean>;
  resumeSaved(): Promise<boolean>;
  setReady(ready: boolean): void;
  startMatch(): void;
  sendGameAction(action: unknown): string | null;
  leaveRoom(): void;
  roomCommand(action: RoomAction): void;
}

export interface GameInstance {
  readonly instanceId: string;
  readonly actions: GameActions;
  start(): Promise<void>;
  setVisible(visible: boolean): void;
  setMuted(muted: boolean): void;
  getStatus(): InstanceStatus;
  subscribe(fn: () => void): Unsubscribe;
  /** 仅 debug：Host 完整状态的只读副本入口、指定夹具、UI 可点击区域 */
  readonly debug: {
    host(): HostAuthority | null;
    ui(): UiApp | null;
    game(): GamePluginDefinition;
  } | null;
  dispose(): Promise<void>;
}

const NICK_KEY = 'nickname';

export function createGameInstance(options: GameInstanceOptions): GameInstance {
  const { instanceId, platform, transport } = options;
  const codec = options.address ?? defaultAddressCodec;
  const game = options.games[0];
  if (!game) throw new Error('at least one game must be registered');

  let ui: UiApp | null = null;
  let reliable: ReliableNode | null = null;
  let net: DeviceNet | null = null;
  let ids: IdFactory | null = null;
  let client: PlayerClient | null = null;
  let browser: RoomBrowser | null = null;
  let host: HostAuthority | null = null;
  let endpoint: Endpoint | null = null;
  let started = false;
  let disposed = false;
  let visible = true;
  let muted = false;
  const offs: Unsubscribe[] = [];
  const listeners = new Set<() => void>();
  let local: Record<string, unknown> = {};
  let tickRequested = false;
  let localPhase = '';

  const emptyClient: ClientState = {
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

  const model: AppModel = {
    gameTitle: game.rules.title,
    rulesVersion: game.rules.rulesVersion,
    nickname: options.defaultNickname ?? '',
    route: 'home',
    form: { address: '', password: '' },
    rooms: [],
    searching: false,
    busy: null,
    bootError: null,
    saved: null,
    client: emptyClient,
    hostInfo: null,
  };

  const notify = (): void => {
    ui?.invalidate();
    listeners.forEach((fn) => fn());
  };

  const patch = (p: Partial<AppModel>): void => {
    Object.assign(model, p);
    notify();
  };

  // ---- 操作 ---------------------------------------------------------------

  const ensureNickname = async (): Promise<string | null> => {
    if (model.nickname) return model.nickname;
    await editNickname();
    return model.nickname || null;
  };

  const editNickname = async (): Promise<void> => {
    const value = await platform.promptText({ title: '设置昵称', initial: model.nickname, maxLength: 12, placeholder: '最多 12 个字' });
    if (value === null) return;
    const nick = value.trim().slice(0, 12);
    if (!nick) return;
    patch({ nickname: nick });
    platform.storage.set(NICK_KEY, nick).catch(() => undefined);
  };

  const disposeHost = (): void => {
    host?.dispose();
    host = null;
    model.hostInfo = null;
  };

  const createRoom = async (opts: { nickname?: string; password?: string } = {}): Promise<boolean> => {
    if (!client || !net || !ids || model.busy) return false;
    if (opts.nickname) patch({ nickname: opts.nickname });
    const nick = await ensureNickname();
    if (!nick) return false;
    let password = opts.password;
    if (password === undefined) {
      const input = await platform.promptText({ title: '房间密码（可选，留空则不设密码）', maxLength: MAX_PASSWORD, placeholder: '不填则任何同一 Wi-Fi 的玩家都可加入' });
      if (input === null) return false;
      password = input;
    }
    stopSearch();
    patch({ busy: '正在创建房间…' });
    try {
      disposeHost();
      const h = await createHostAuthority({
        net,
        clock: platform.clock,
        random: platform.random,
        ids,
        plugin: game.rules,
        config: options.gameConfig,
        address: endpoint ? codec.format(endpoint) : null,
        password,
        debug: options.debug,
        onAnnounce: (t) => platform.audio.announce(t),
      });
      host = h;
      h.onClosed(() => {
        if (host === h) platform.keepScreenOn(false);
      });
      platform.keepScreenOn(true);
      model.hostInfo = { address: h.address, password: h.password };
      const ok = await client.join({ link: net.loopbackToHost, hostAddress: h.address ?? '', password: h.password ?? '', nickname: nick });
      if (!ok) disposeHost();
      patch({ busy: null });
      return ok;
    } catch (e) {
      disposeHost();
      patch({ busy: null });
      ui?.toast(`创建失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  const joinEndpoint = async (ep: Endpoint, password: string, nickname?: string): Promise<boolean> => {
    if (!client || !net) return false;
    if (nickname) patch({ nickname });
    const nick = await ensureNickname();
    if (!nick) return false;
    disposeHost();
    const ok = await client.join({ link: net.remote(ep), hostAddress: codec.format(ep), password, nickname: nick });
    if (ok) {
      stopSearch();
      patch({ route: 'home' });
    }
    return ok;
  };

  const joinRoom = async (address: string, password = '', nickname?: string): Promise<boolean> => {
    const ep = codec.parse(address);
    if (!ep) {
      ui?.toast('房间地址格式不正确');
      return false;
    }
    patch({ form: { address, password } });
    return joinEndpoint(ep, password, nickname);
  };

  const joinDiscovered = async (roomKey: string, opts: { password?: string; nickname?: string } = {}): Promise<boolean> => {
    const room = model.rooms.find((r) => r.key === roomKey);
    if (!room) {
      ui?.toast('房间已不可见，请稍后重试');
      return false;
    }
    let password = opts.password ?? '';
    if (room.hasPassword && opts.password === undefined) {
      const input = await platform.promptText({ title: `输入「${room.hostName} 的房间」密码`, maxLength: MAX_PASSWORD });
      if (input === null) return false;
      password = input;
    }
    return joinEndpoint(room.endpoint, password, opts.nickname);
  };

  function searchRooms(): void {
    if (!browser) return;
    browser.start();
    patch({ searching: true });
  }

  function stopSearch(): void {
    if (!browser?.searching) return;
    browser.stop();
    patch({ searching: false });
  }

  const resumeSaved = async (): Promise<boolean> => {
    if (!client || !model.saved) return false;
    patch({ busy: '正在恢复连接…' });
    const ok = await client.resume(model.saved);
    patch({ busy: null, saved: ok ? null : await client.loadSavedSession() });
    if (!ok) ui?.toast(`恢复失败：${errorText(client.getState().error)}`);
    return ok;
  };

  const roomCommand = (action: RoomAction): void => {
    client?.roomCommand(action);
  };

  const leaveRoom = (): void => {
    if (!client) return;
    const wasHost = host !== null;
    if (wasHost) roomCommand({ kind: 'close-room' });
    else client.leave();
    if (wasHost) {
      // 留出时间发送 ROOM_CLOSED（可靠层会继续重发）
      const h = host;
      platform.clock.setTimeout(() => {
        if (host === h) disposeHost();
        client?.leave();
        notify();
      }, 300);
    }
    patch({ route: 'home' });
  };

  const actions: GameActions = {
    createRoom,
    searchRooms,
    stopSearch,
    joinDiscovered,
    joinRoom,
    resumeSaved,
    setReady: (ready) => roomCommand({ kind: 'ready', ready }),
    startMatch: () => roomCommand({ kind: 'start' }),
    sendGameAction: (action) => client?.gameCommand(action) ?? null,
    leaveRoom,
    roomCommand,
  };

  const prompt = async (title: string, initial: string, numeric: boolean, maxLength: number): Promise<string | null> =>
    platform.promptText({ title, initial, numeric, maxLength });

  const appActions: AppActions = {
    editNickname: () => void editNickname(),
    createRoom: () => void createRoom(),
    openJoin: () => {
      patch({ route: 'join' });
      searchRooms();
    },
    cancelJoin: () => {
      stopSearch();
      patch({ route: 'home' });
    },
    joinDiscovered: (room) => void joinDiscovered(room.key),
    openManual: () => {
      stopSearch();
      patch({ route: 'manual' });
    },
    editAddress: () =>
      void prompt('房间地址（IP:端口）', model.form.address, false, 64).then((v) => v !== null && patch({ form: { ...model.form, address: v.trim() } })),
    editPassword: () =>
      void prompt('房间密码（无密码可留空）', model.form.password, false, MAX_PASSWORD).then(
        (v) => v !== null && patch({ form: { ...model.form, password: v } }),
      ),
    submitManualJoin: () => void joinRoom(model.form.address, model.form.password),
    resumeSaved: () => void resumeSaved(),
    discardSaved: () => {
      platform.storage.remove('session').catch(() => undefined);
      patch({ saved: null });
    },
    setReady: actions.setReady,
    startMatch: actions.startMatch,
    leaveRoom,
    reconnect: () =>
      void client?.reconnect().then((ok) => {
        if (!ok) ui?.toast(`重连失败：${errorText(client?.getState().error)}`);
      }),
    backHome: () => {
      disposeHost();
      client?.leave();
      patch({ route: 'home' });
    },
    backToLobby: () => roomCommand({ kind: 'back-to-lobby' }),
    resumeGame: () => roomCommand({ kind: 'resume-game' }),
    endMatch: () => roomCommand({ kind: 'end-match' }),
  };

  // ---- 场景 ---------------------------------------------------------------

  const safe = (): { top: number; bottom: number } => {
    const vp = platform.viewport();
    return { top: vp.safeArea.top, bottom: vp.safeArea.bottom };
  };

  const gameContext = (): GameSceneContext | null => {
    const c = model.client;
    const snap = c.snapshot;
    const room = c.room;
    const me = room?.players.find((p) => p.playerId === c.playerId);
    if (!snap || !room || !me || !client) return null;
    if (snap.phaseId !== localPhase) {
      localPhase = snap.phaseId;
      local = {};
    }
    const remainingMs = snap.timer ? (snap.paused ? snap.timer.remainingMs : Math.max(0, snap.timer.remainingMs - (platform.clock.now() - c.snapshotAt))) : null;
    const cl = client;
    return {
      view: snap.view,
      room,
      me,
      isHost: room.hostId === c.playerId,
      phaseId: snap.phaseId,
      remainingMs,
      paused: snap.paused,
      commands: c.commands,
      send: (action) => cl.gameCommand(action),
      retry: (id) => cl.retry(id),
      local,
      setLocal: (p) => {
        local = { ...local, ...p };
        ui?.invalidate();
      },
      nameOf: (id) => {
        const p = room.players.find((x) => x.playerId === id);
        return p ? playerName(p) : '未知玩家';
      },
      safeArea: safe(),
      now: platform.clock.now(),
      keepTicking: () => {
        tickRequested = true;
      },
    };
  };

  const scene: Scene = {
    id: 'root',
    render() {
      const c = model.client;
      const s = safe();
      if (c.phase === 'closed') return renderClosed(model, appActions, s);
      if (c.phase === 'in-room' && c.room) {
        if (c.room.status === 'lobby') {
          ui?.setTicking(false);
          return renderLobby(model, appActions, s);
        }
        const ctx = gameContext();
        if (ctx) {
          tickRequested = false;
          const node = game.presentation.render(ctx);
          ui?.setTicking((ctx.remainingMs !== null && !ctx.paused) || tickRequested);
          return wrapGame(node, model, appActions, c.room);
        }
        return renderLobby(model, appActions, s);
      }
      ui?.setTicking(false);
      if (model.route === 'manual') return renderManualJoin(model, appActions, s);
      if (model.route === 'join' || c.phase === 'joining') return renderJoin(model, appActions, s);
      return renderHome(model, appActions, s);
    },
  };

  // ---- 生命周期 -----------------------------------------------------------

  const applyVisibility = (v: boolean): void => {
    if (v === visible) return;
    visible = v;
    // 离开页面立即隐藏身份卡等私密界面
    local = {};
    ui?.setVisible(v);
    client?.setVisible(v);
    host?.setHostVisible(v);
    if (!v) browser?.stop();
    else if (model.route === 'join' && model.client.phase !== 'in-room') browser?.start();
    notify();
  };

  return {
    instanceId,
    actions,
    async start() {
      if (started || disposed) return;
      started = true;
      ui = createUiApp(platform);
      ui.setScene(scene);
      const savedNick = await platform.storage.get(NICK_KEY).catch(() => null);
      if (savedNick && !model.nickname) model.nickname = savedNick;
      try {
        ids = await createIdFactory(platform.random);
        endpoint = await transport.start();
      } catch (e) {
        patch({ bootError: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (disposed) return;
      reliable = createReliableNode({ transport, clock: platform.clock, nextMessageId: () => ids!.next('m') });
      net = createDeviceNet({ reliable, clock: platform.clock });
      client = createPlayerClient({ net, clock: platform.clock, ids, storage: platform.storage, gameId: game.rules.id });
      const b = createRoomBrowser({ net, clock: platform.clock, ids, gameId: game.rules.id });
      browser = b;
      offs.push(
        b.subscribe(() => patch({ rooms: b.rooms(), searching: b.searching })),
        client.subscribe((s) => {
          const prev = model.client;
          model.client = s;
          if (prev.phase !== 'closed' && s.phase === 'closed') disposeHost();
          const last = s.commands[s.commands.length - 1];
          const prevLast = prev.commands.find((c) => c.commandId === last?.commandId);
          if (last && prevLast?.status === 'pending' && (last.status === 'rejected' || last.status === 'failed')) {
            ui?.toast(`操作失败：${errorText(last.code)}`);
          }
          notify();
        }),
        transport.onError((e) => ui?.toast(`网络错误：${e.message}`)),
        platform.onVisibility(applyVisibility),
      );
      patch({ saved: await client.loadSavedSession() });
    },
    setVisible: applyVisibility,
    setMuted(m) {
      muted = m;
      platform.audio.setMuted(m);
      notify();
    },
    getStatus: () => ({
      started,
      bootError: model.bootError,
      endpoint,
      isHost: host !== null,
      hostInfo: model.hostInfo,
      rooms: model.rooms,
      client: model.client,
      visible,
      muted,
    }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    debug: options.debug ? { host: () => host, ui: () => ui, game: () => game } : null,
    async dispose() {
      if (disposed) return;
      disposed = true;
      offs.forEach((off) => off());
      host?.dispose();
      host = null;
      browser?.dispose();
      client?.dispose();
      net?.dispose();
      reliable?.dispose();
      ui?.dispose();
      listeners.clear();
      platform.keepScreenOn(false);
      await transport.stop().catch(() => undefined);
    },
  };
}
