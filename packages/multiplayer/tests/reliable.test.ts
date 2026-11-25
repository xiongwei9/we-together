import { describe, expect, it } from 'vitest';
import { createReliableNode, describeDatagram, utf8Decode, utf8Encode, type ReliableNode, type Transport } from '../src';
import { createManualClock, createVirtualNetwork, NETWORK_PRESETS, type NetworkFaultConfig } from '@we/testing';

async function pair(faults: NetworkFaultConfig, seed = 1) {
  const clock = createManualClock();
  const network = createVirtualNetwork({ networkId: 'n', clock, seed, faults });
  let seq = 0;
  const mk = async (id: string): Promise<{ t: Transport; node: ReliableNode; got: string[] }> => {
    const t = network.createTransport(id);
    await t.start();
    const node = createReliableNode({ transport: t, clock, nextMessageId: () => `${id}m${++seq}` });
    const got: string[] = [];
    node.onMessage((bytes) => got.push(utf8Decode(bytes)));
    return { t, node, got };
  };
  return { clock, network, a: await mk('a'), b: await mk('b') };
}

const B = { kind: 'memory', networkId: 'n', nodeId: 'b' } as const;

describe('codec', () => {
  it('UTF-8 往返（含中文与 emoji）', () => {
    const s = '狼人杀 🐺 werewolf ✓';
    expect(utf8Decode(utf8Encode(s))).toBe(s);
    expect(utf8Encode('中').length).toBe(3);
  });
});

describe('可靠消息与分片', () => {
  it('超过 1200 字节的消息分片发送、重组后交付一次', async () => {
    const { a, b, clock, network } = await pair(NETWORK_PRESETS.ideal!);
    const sizes: number[] = [];
    network.subscribePackets((e) => e.status === 'queued' && sizes.push(e.size));
    const big = '人'.repeat(3000); // 9000 字节
    a.node.send(B, utf8Encode(big), { reliable: true });
    clock.advance(1000);
    expect(b.got).toEqual([big]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1200);
    expect(a.node.stats().pendingParts).toBe(0);
  });

  it('5% 丢包 + 重复 + 乱序：全部送达且不重复交付', async () => {
    const { a, b, clock } = await pair(NETWORK_PRESETS.poor!, 3);
    const msgs = Array.from({ length: 60 }, (_, i) => `msg-${i}-${'x'.repeat(i * 40)}`);
    msgs.forEach((m) => a.node.send(B, utf8Encode(m), { reliable: true }));
    clock.advance(30_000);
    expect([...b.got].sort()).toEqual([...msgs].sort());
    expect(new Set(b.got).size).toBe(b.got.length);
    expect(a.node.stats().retransmits).toBeGreaterThan(0);
    expect(b.node.stats().duplicatesDropped).toBeGreaterThan(0);
  });

  it('20% 丢包：未送达的消息必然触发失败回调，送达的不重复', async () => {
    const { a, b, clock } = await pair(NETWORK_PRESETS.terrible!, 3);
    const msgs = Array.from({ length: 60 }, (_, i) => `msg-${i}-${'x'.repeat(i * 40)}`);
    const failed = new Set<string>();
    msgs.forEach((m) => a.node.send(B, utf8Encode(m), { reliable: true, onFailed: () => failed.add(m) }));
    clock.advance(30_000);
    expect(new Set(b.got).size).toBe(b.got.length);
    for (const m of msgs) expect(b.got.includes(m) || failed.has(m)).toBe(true);
  });

  it('对端不可达：重发耗尽后回调失败（初始 300ms，退避至 2s，最多 5 次）', async () => {
    const { a, clock, network } = await pair(NETWORK_PRESETS.ideal!);
    network.setNodeOnline('b', false);
    let failed = false;
    let attempts = 0;
    network.subscribePackets((e) => e.from === 'a' && e.reason === 'offline' && attempts++);
    a.node.send(B, utf8Encode('hello'), { reliable: true, onFailed: () => (failed = true) });
    clock.advance(300 + 600 + 1200 + 2000 - 1);
    expect(failed).toBe(false);
    clock.advance(2001);
    expect(failed).toBe(true);
    expect(attempts).toBe(5);
  });

  it('非法 / 越界分片与超长数据报被丢弃', async () => {
    const { a, b, clock } = await pair(NETWORK_PRESETS.ideal!);
    const bad = new Uint8Array([1, 2, 65, 66, 0, 5, 0, 2, 0, 0, 0, 3, 1, 2, 3]); // partIndex 5 >= partCount 2
    await a.t.send(B, bad);
    await a.t.send(B, new Uint8Array([9, 9, 9]));
    clock.advance(100);
    expect(b.got).toEqual([]);
    expect(b.node.stats().invalidDropped).toBe(2);
    expect(describeDatagram(bad).kind).toBe('data');
  });

  it('ACK 丢失：发送方重发，接收方回 ACK 但不重复交付', async () => {
    const { a, b, clock, network } = await pair(NETWORK_PRESETS.ideal!);
    network.setLinkFaults('b', 'a', { latencyMs: { min: 1, max: 1 }, packetLoss: 1, duplicateRate: 0, reorderRate: 0 });
    a.node.send(B, utf8Encode('once'), { reliable: true });
    clock.advance(1500);
    expect(b.got).toEqual(['once']);
    expect(a.node.stats().retransmits).toBeGreaterThan(1);
    network.setLinkFaults('b', 'a', null);
    clock.advance(5000);
    expect(b.got).toEqual(['once']);
  });

  it('实例重建后旧包不投递给新实例（endpoint generation）', async () => {
    const { a, b, clock, network } = await pair({ latencyMs: { min: 500, max: 500 }, packetLoss: 0, duplicateRate: 0, reorderRate: 0 });
    a.node.send(B, utf8Encode('stale'), { reliable: false });
    b.node.dispose();
    await b.t.stop();
    const t2 = network.createTransport('b');
    await t2.start();
    const got: Uint8Array[] = [];
    t2.onPacket((p) => got.push(p.payload));
    clock.advance(600);
    expect(got).toHaveLength(0);
  });
});
