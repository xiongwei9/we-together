import { createGameInstance, type GameInstance, type GamePluginDefinition, type InstanceStatus } from '@we/game-app';
import { createMemoryStorage, type StoragePort, type Unsubscribe } from '@we/platform';
import { createFrameScheduler, createRealClock, createWebPlatform, createWebRandom, type FrameScheduler } from '@we/platform/web';
import { defaultAddressCodec, type AddressCodec, type HostInspection } from '@we/multiplayer';
import {
  NETWORK_PRESETS,
  createSeededRandom,
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
  gameId: string;
  playerCount: number;
  seed: number;
  /** 固定 seed 时实例随机源也使用 seed（仅测试，可重复） */
  deterministic: boolean;
  fastTimers: boolean;
  viewport: { width: number; height: number };
  preset: keyof typeof NETWORK_PRESETS;
}

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

/** 快速节奏：仅缩短神职出局后假阶段的随机停留（默认 3–8s），其余时限按规则文档 */
function fastConfig(defaults: unknown): unknown {
  const d = defaults as { timers?: Record<string, unknown> };
  return d.timers ? { ...d, timers: { ...d.timers, deadRoleDelayMs: { min: 1_000, max: 2_000 } } } : defaults;
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
  /** 一键：实例 1 开房（可选密码），其余实例经局域网发现找到房间并正常 JOIN */
  hostAndJoinAll(password: string): Promise<void>;
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
      if (/^[\w-]+$/.test(t) && network) return { kind: 'memory', networkId: network.networkId, nodeId: t };
      return defaultAddressCodec.parse(t);
    },
  });

  const game = (): GamePluginDefinition => {
    const g = games.find((x) => x.rules.id === config?.gameId) ?? games[0];
    if (!g) throw new Error('no game registered');
    return g;
  };

  const mount = async (r: Record_): Promise<void> => {
    if (!network || !config || !r.canvas || !r.overlay) return;
    r.generation++;
    const index = Number(r.descriptor.instanceId.slice(1));
    const random = config.deterministic ? createSeededRandom(config.seed * 1000 + index * 17 + r.generation) : createWebRandom();
    const platform = createWebPlatform({
      canvas: r.canvas,
      overlayHost: r.overlay,
      logicalSize: config.viewport,
      storage: r.storage,
      clock,
      random,
      frames,
      muted: r.muted,
    });
    const transport = network.createTransport(r.descriptor.instanceId);
    const instance = createGameInstance({
      instanceId: r.descriptor.instanceId,
      platform,
      transport,
      games: [game()],
      address: simCodec(),
      gameConfig: config.fastTimers ? fastConfig(game().rules.defaultConfig) : undefined,
      debug: true,
      // 实例 pN 坐 N 号；昵称从昵称池随机分配（固定随机时可重现）
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
      botRng = createSeededRng(cfg.seed);
      network = createVirtualNetwork({ networkId: simulationId, clock, seed: cfg.seed, faults: NETWORK_PRESETS[cfg.preset] });
      offPackets = network.subscribePackets((e) => {
        log.push(e);
        if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
        notify();
      });
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
    async hostAndJoinAll(password) {
      const h = host();
      if (!h) return;
      // 板子与模拟人数一致（例如 6 人 / 9 人局）
      const rules = game().rules;
      const board = String(config?.playerCount ?? '');
      const hasBoard = rules.ruleOptions(rules.defaultConfig).some((r) => r.key === 'board' && r.choices.some((c) => c.value === board));
      if (!h.getStatus().hostInfo) await h.actions.createRoom({ password, rules: hasBoard ? { board } : undefined });
      const roomId = h.debug?.host()?.roomId;
      if (!roomId) return;
      const pass = h.getStatus().hostInfo?.password ?? '';
      const joinOne = async (inst: GameInstance): Promise<void> => {
        // 与玩家点「加入房间」相同：广播搜索，等房间出现在列表后加入
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
      await Promise.all(
        [...records.values()]
          .filter((r) => r.descriptor.instanceId !== 'p1' && r.instance)
          .filter((r) => r.instance!.getStatus().client.phase !== 'in-room')
          .map((r) => joinOne(r.instance!)),
      );
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
      const g = game();
      if (!g.bot) return 0;
      let n = 0;
      for (const r of records.values()) {
        const s = r.instance?.getStatus();
        const snap = s?.client.snapshot;
        if (!s || !snap || snap.paused || !s.visible) continue;
        if (s.client.commands.some((c) => c.status === 'pending')) continue;
        const action = g.bot(snap.view, botRng);
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
        online: network?.isNodeOnline(r.descriptor.instanceId) ?? false,
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
