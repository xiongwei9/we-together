import { createGameInstance, type GameInstance, type GamePluginDefinition, type InstanceStatus } from '@we/game-app';
import { createMemoryStorage, type StoragePort, type Unsubscribe } from '@we/platform';
import { connectBrowserWebSocket, createFrameScheduler, createRealClock, createWebPlatform, createWebRandom, type FrameScheduler } from '@we/platform/web';
import { createRelayTransport, defaultAddressCodec, ROOM_CODE, type AddressCodec, type HostInspection } from '@we/multiplayer';
import {
  NETWORK_PRESETS,
  createSeededRng,
  createVirtualNetwork,
  type NetworkFaultConfig,
  type PacketTraceEvent,
  type VirtualNetwork,
} from '@we/testing';

/**
 * PC Web 模拟器实例管理器（设计 §13.5）。
 * 只做挂载、网络与调试控制；批量操作全部走实例的正常玩家 API 与协议链路。
 */

export interface SimulationConfig {
  /** 挂载的 app 实例数（玩家设备数） */
  playerCount: number;
  /**
   * 模拟的联机方式：
   * - online：与 Web 版相同，经中继服务器（需 `pnpm dev:server`），凭房间号加入
   * - lan：与微信版相同，实例之间经 VirtualNetwork 局域网通信，可注入网络故障
   */
  network: 'lan' | 'online';
  preset: keyof typeof NETWORK_PRESETS;
}

/** 联网模式的中继服务器（apps/server，`pnpm dev:server`）；可用 VITE_RELAY_URL 覆盖 */
export const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? `ws://${location.hostname}:8787/relay`;

/** 模拟手机的逻辑屏幕尺寸 */
export const SIM_VIEWPORT = { width: 390, height: 844 } as const;

interface InstanceDescriptor {
  instanceId: string;
  seatHint: number;
  isHost: boolean;
}

export interface InstanceView extends InstanceDescriptor {
  attached: boolean;
  online: boolean;
  status: InstanceStatus | null;
  generation: number;
}

interface Record_ {
  descriptor: InstanceDescriptor;
  storage: StoragePort;
  instance: GameInstance | null;
  dispose: (() => void) | null;
  canvas: HTMLCanvasElement | null;
  overlay: HTMLElement | null;
  generation: number;
  visible: boolean;
  muted: boolean;
}

const LOG_LIMIT = 600;

export interface SimulationController {
  readonly config: SimulationConfig | null;
  readonly simulationId: string | null;
  create(config: SimulationConfig): Promise<readonly InstanceDescriptor[]>;
  attach(instanceId: string, canvas: HTMLCanvasElement, overlay: HTMLElement): Promise<void>;
  detach(instanceId: string): Promise<void>;
  disconnect(instanceId: string): void;
  reconnect(instanceId: string): void;
  restart(instanceId: string): Promise<void>;
  setVisible(instanceId: string, visible: boolean): void;
  setMuted(instanceId: string, muted: boolean): void;
  setPreset(preset: keyof typeof NETWORK_PRESETS): void;
  setLinkFaults(from: string, to: string, faults: NetworkFaultConfig | null): void;
  /**
   * 一键：实例 1 用它当前所在的游戏与联机方式开房（不设密码），其余实例像玩家一样进入同一游戏，
   * 局域网经广播发现、联网凭房间号加入（不超过房间人数上限）。返回无法执行的原因
   */
  hostAndJoinAll(): Promise<string | null>;
  readyAll(): void;
  start(): void;
  /** 每个实例按自己的授权视图执行一次 Bot 行动（经正常 Client 命令） */
  botStep(): number;
  /** Debug Port：下一局按座位指定角色 */
  setFixture(fixture: unknown): void;
  instances(): InstanceView[];
  hostInspection(): HostInspection | null;
  packets(): readonly PacketTraceEvent[];
  clearPackets(): void;
  subscribe(fn: () => void): Unsubscribe;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export function createSimulationController(games: readonly GamePluginDefinition[]): SimulationController {
  const frames: FrameScheduler = createFrameScheduler();
  const clock = createRealClock();
  const listeners = new Set<() => void>();
  const records = new Map<string, Record_>();
  let network: VirtualNetwork | null = null;
  let config: SimulationConfig | null = null;
  let simulationId: string | null = null;
  let simCounter = 0;
  let log: PacketTraceEvent[] = [];
  let offPackets: Unsubscribe | null = null;
  let botRng = createSeededRng(1);
  let notifyScheduled = false;

  const notify = (): void => {
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      listeners.forEach((fn) => fn());
    });
  };

  /** 模拟器地址：`mem:<networkId>/<nodeId>`，也接受简写 `p1` */
  const simCodec = (): AddressCodec => ({
    format: defaultAddressCodec.format,
    parse(text) {
      const t = text.trim();
      // 6 位数字为联网房间号，其余简写为内存网络节点
      if (!ROOM_CODE.test(t) && /^[\w-]+$/.test(t) && network) return { kind: 'memory', networkId: network.networkId, nodeId: t };
      return defaultAddressCodec.parse(t);
    },
  });

  const gameById = (id: string | null | undefined): GamePluginDefinition | undefined => games.find((g) => g.rules.id === id);

  const mount = async (r: Record_): Promise<void> => {
    if (!config || !r.canvas || !r.overlay) return;
    if (config.network === 'lan' && !network) return;
    r.generation++;
    const index = Number(r.descriptor.instanceId.slice(1));
    // 与真机相同：每台模拟手机使用真随机源
    const random = createWebRandom();
    const platform = createWebPlatform({
      canvas: r.canvas,
      overlayHost: r.overlay,
      logicalSize: SIM_VIEWPORT,
      storage: r.storage,
      clock,
      random,
      frames,
      muted: r.muted,
    });
    // 联网：每个实例各自通过真实 WebSocket 连接中继服务器（第一次开房 / 加入时才连接）
    const transport =
      config.network === 'online'
        ? createRelayTransport({ url: RELAY_URL, connect: connectBrowserWebSocket, clock })
        : network!.createTransport(r.descriptor.instanceId);
    const instance = createGameInstance({
      instanceId: r.descriptor.instanceId,
      platform,
      network: config.network,
      transport,
      // 与微信入口相同：注册全部游戏，由玩家在 app 首页选择
      games,
      address: simCodec(),
      debug: true,
      // 实例 pN 坐 N 号；昵称从昵称池随机分配
      seatHint: index,
    });
    const off = instance.subscribe(notify);
    r.instance = instance;
    r.dispose = () => {
      off();
      platform.dispose();
    };
    await instance.start();
    if (!r.visible) instance.setVisible(false);
    notify();
  };

  const unmount = async (r: Record_): Promise<void> => {
    const inst = r.instance;
    const dispose = r.dispose;
    r.instance = null;
    r.dispose = null;
    if (inst) await inst.dispose();
    dispose?.();
    notify();
  };

  const host = (): GameInstance | null => records.get('p1')?.instance ?? null;

  const teardown = async (): Promise<void> => {
    for (const r of records.values()) await unmount(r);
    records.clear();
    offPackets?.();
    offPackets = null;
    network?.dispose();
    network = null;
    log = [];
  };

  const controller: SimulationController = {
    get config() {
      return config;
    },
    get simulationId() {
      return simulationId;
    },
    async create(cfg) {
      await teardown();
      config = cfg;
      simulationId = `sim-${++simCounter}`;
      // 网络故障与 Bot 的随机序列每次创建时随机取种子
      const seed = Math.floor(Math.random() * 0x7fffffff);
      botRng = createSeededRng(seed);
      if (cfg.network === 'lan') {
        const vn = createVirtualNetwork({ networkId: simulationId, clock, seed, faults: NETWORK_PRESETS[cfg.preset] });
        network = vn;
        offPackets = vn.subscribePackets((e) => {
          log.push(e);
          if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
          notify();
        });
      }
      for (let i = 1; i <= cfg.playerCount; i++) {
        const descriptor = { instanceId: `p${i}`, seatHint: i, isHost: i === 1 };
        records.set(descriptor.instanceId, {
          descriptor,
          storage: createMemoryStorage(),
          instance: null,
          dispose: null,
          canvas: null,
          overlay: null,
          generation: 0,
          visible: true,
          muted: i !== 1, // 默认仅 Host 播放公共裁判音频
        });
      }
      notify();
      return [...records.values()].map((r) => r.descriptor);
    },
    async attach(instanceId, canvas, overlay) {
      const r = records.get(instanceId);
      if (!r) return;
      if (r.instance && r.canvas === canvas) return; // 幂等：React 重渲染不重建实例
      if (r.instance) await unmount(r);
      r.canvas = canvas;
      r.overlay = overlay;
      await mount(r);
    },
    async detach(instanceId) {
      const r = records.get(instanceId);
      if (!r) return;
      // 先同步清空，避免与随后挂载的新 Tile 竞争
      r.canvas = null;
      r.overlay = null;
      await unmount(r);
    },
    disconnect(instanceId) {
      network?.setNodeOnline(instanceId, false);
      notify();
    },
    reconnect(instanceId) {
      network?.setNodeOnline(instanceId, true);
      notify();
    },
    async restart(instanceId) {
      const r = records.get(instanceId);
      if (!r) return;
      // 保留该席位的 Storage（含恢复凭证），重新建立 endpoint generation
      await unmount(r);
      await mount(r);
    },
    setVisible(instanceId, visible) {
      const r = records.get(instanceId);
      if (!r) return;
      r.visible = visible;
      r.instance?.setVisible(visible);
      notify();
    },
    setMuted(instanceId, muted) {
      const r = records.get(instanceId);
      if (!r) return;
      r.muted = muted;
      r.instance?.setMuted(muted);
      notify();
    },
    setPreset(preset) {
      if (config) config = { ...config, preset };
      network?.setGlobalFaults(NETWORK_PRESETS[preset]!);
      notify();
    },
    setLinkFaults(from, to, faults) {
      network?.setLinkFaults(from, to, faults);
    },
    async hostAndJoinAll() {
      const h = host();
      if (!h) return '实例 1 尚未启动';
      const gameId = h.getStatus().gameId;
      const g = gameById(gameId);
      if (!gameId || !g) return '请先在实例 1 的 app 首页选择游戏';
      // 板子与模拟人数一致（例如 6 人 / 9 人局）
      const rules = g.rules;
      const board = String(config?.playerCount ?? '');
      const hasBoard = rules.ruleOptions(rules.defaultConfig).some((r) => r.key === 'board' && r.choices.some((c) => c.value === board));
      if (!h.getStatus().hostInfo) await h.actions.createRoom({ password: '', rules: hasBoard ? { board } : undefined });
      const roomId = h.debug?.host()?.roomId;
      const room = h.getStatus().client.room;
      if (!roomId || !room) return '实例 1 创建房间失败';
      const pass = h.getStatus().hostInfo?.password ?? '';
      const roomCode = config?.network === 'online' ? h.getStatus().hostInfo?.address : null;
      const joinOne = async (inst: GameInstance): Promise<void> => {
        inst.actions.selectGame(gameId);
        // 联网：与玩家相同，输入房间号加入
        if (roomCode) {
          await inst.actions.joinRoom(roomCode, pass);
          return;
        }
        // 局域网：与玩家相同，点「加入房间」广播搜索，等房间出现在列表后加入
        inst.actions.searchRooms();
        for (let i = 0; i < 50; i++) {
          const room = inst.getStatus().rooms.find((r) => r.roomId === roomId);
          if (room) {
            await inst.actions.joinDiscovered(room.key, { password: pass });
            return;
          }
          await new Promise<void>((resolve) => clock.setTimeout(resolve, 100));
        }
        inst.actions.stopSearch();
      };
      const free = room.capacity.max - room.players.length;
      await Promise.all(
        [...records.values()]
          .filter((r) => r.descriptor.instanceId !== 'p1' && r.instance)
          .filter((r) => r.instance!.getStatus().client.phase !== 'in-room')
          .slice(0, Math.max(0, free))
          .map((r) => joinOne(r.instance!)),
      );
      return null;
    },
    readyAll() {
      for (const r of records.values()) {
        const s = r.instance?.getStatus();
        const me = s?.client.room?.players.find((p) => p.playerId === s.client.playerId);
        if (me && !me.ready && !me.isHost) r.instance!.actions.setReady(true);
      }
    },
    start() {
      host()?.actions.startMatch();
    },
    botStep() {
      let n = 0;
      for (const r of records.values()) {
        const s = r.instance?.getStatus();
        const snap = s?.client.snapshot;
        const bot = gameById(s?.client.room?.gameId)?.bot;
        if (!s || !snap || !bot || snap.paused || !s.visible) continue;
        if (s.client.commands.some((c) => c.status === 'pending')) continue;
        const action = bot(snap.view, botRng);
        if (action) {
          r.instance!.actions.sendGameAction(action);
          n++;
        }
      }
      return n;
    },
    setFixture(fixture) {
      host()?.debug?.host()?.setFixture(fixture);
    },
    instances() {
      return [...records.values()].map((r) => ({
        ...r.descriptor,
        attached: !!r.instance,
        // 联网模式没有虚拟局域网可断开
        online: network ? network.isNodeOnline(r.descriptor.instanceId) : true,
        status: r.instance?.getStatus() ?? null,
        generation: r.generation,
      }));
    },
    hostInspection() {
      try {
        return host()?.debug?.host()?.inspect() ?? null;
      } catch {
        return null;
      }
    },
    packets: () => log,
    clearPackets() {
      log = [];
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async reset() {
      if (config) await controller.create(config);
    },
    async dispose() {
      await teardown();
      frames.dispose();
      listeners.clear();
    },
  };
  return controller;
}
