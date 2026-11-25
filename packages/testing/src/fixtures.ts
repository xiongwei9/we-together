import { createMemoryStorage, type RandomSource } from '@we/platform';
import {
  createDeviceNet,
  createHostAuthority,
  createIdFactory,
  createPlayerClient,
  createReliableNode,
  defaultAddressCodec,
  type AnyGamePlugin,
  type DeviceNet,
  type Endpoint,
  type HostAuthority,
  type IdFactory,
  type PlayerClient,
  type ReliableNode,
  type Transport,
} from '@we/multiplayer';
import { createManualClock, createSeededRandom, type ManualClock } from './clock';
import { createVirtualNetwork, type NetworkFaultConfig, type VirtualNetwork } from './virtual-network';

/** 无 UI 的模拟设备：Transport + 可靠层 + DeviceNet + Client（可选 Host） */
export interface HeadlessDevice {
  nodeId: string;
  endpoint: Endpoint;
  transport: Transport;
  reliable: ReliableNode;
  net: DeviceNet;
  client: PlayerClient;
  storage: ReturnType<typeof createMemoryStorage>;
  host: HostAuthority | null;
  random: RandomSource;
  ids: IdFactory;
  dispose(): Promise<void>;
}

export interface HeadlessWorld {
  clock: ManualClock;
  network: VirtualNetwork;
  /** 推进虚拟时间并冲刷 Promise 微任务 */
  run(ms: number, step?: number): Promise<void>;
  flush(): Promise<void>;
  createDevice(nodeId: string, storage?: ReturnType<typeof createMemoryStorage>): Promise<HeadlessDevice>;
  createHost(device: HeadlessDevice, plugin: AnyGamePlugin, options?: { config?: unknown; nickname?: string; password?: string }): Promise<HostAuthority>;
}

export function createHeadlessWorld(options: { seed: number; faults?: NetworkFaultConfig; networkId?: string }): HeadlessWorld {
  const clock = createManualClock(1_000);
  const network = createVirtualNetwork({ networkId: options.networkId ?? 'test-net', clock, seed: options.seed, faults: options.faults });
  let deviceSeed = options.seed * 7919;

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) await Promise.resolve();
  };
  const run = async (ms: number, step = 10): Promise<void> => {
    for (let t = 0; t < ms; t += step) {
      clock.advance(step);
      await flush();
    }
  };

  return {
    clock,
    network,
    run,
    flush,
    async createDevice(nodeId, storage = createMemoryStorage()) {
      const random = createSeededRandom(++deviceSeed);
      const transport = network.createTransport(nodeId);
      const endpoint = await transport.start();
      const ids = await createIdFactory(random);
      const reliable = createReliableNode({ transport, clock, nextMessageId: () => ids.next('m') });
      const net = createDeviceNet({ reliable, clock });
      const client = createPlayerClient({ net, clock, ids, storage, gameId: 'werewolf' });
      const device: HeadlessDevice = {
        nodeId,
        endpoint,
        transport,
        reliable,
        net,
        client,
        storage,
        host: null,
        random,
        ids,
        async dispose() {
          device.host?.dispose();
          client.dispose();
          net.dispose();
          reliable.dispose();
          await transport.stop();
        },
      };
      return device;
    },
    async createHost(device, plugin, hostOptions = {}) {
      const host = await createHostAuthority({
        net: device.net,
        clock,
        random: device.random,
        ids: device.ids,
        plugin,
        config: hostOptions.config,
        password: hostOptions.password,
        address: defaultAddressCodec.format(device.endpoint),
        debug: true,
      });
      device.host = host;
      const joined = device.client.join({
        link: device.net.loopbackToHost,
        hostAddress: host.address ?? '',
        password: host.password ?? '',
        nickname: hostOptions.nickname ?? 'Host',
        gameId: plugin.id,
      });
      await run(50);
      if (!(await joined)) throw new Error('host client failed to join');
      return host;
    },
  };
}
