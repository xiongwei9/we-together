import { describe, expect, it } from 'vitest';
import { createRelayHub, type HubOptions, type PeerSocket } from '../src/hub.js';

interface FakeSocket extends PeerSocket {
  texts: string[];
  frames: Uint8Array[];
  closed: { code: number; reason: string } | null;
}

function fakeSocket(): FakeSocket {
  const s: FakeSocket = {
    texts: [],
    frames: [],
    closed: null,
    sendText: (t) => void s.texts.push(t),
    sendBinary: (b) => void s.frames.push(b),
    close: (code, reason) => void (s.closed = { code, reason }),
  };
  return s;
}

const frame = (peer: string, ...payload: number[]): Uint8Array => Uint8Array.from([peer.length, ...[...peer].map((c) => c.charCodeAt(0)), ...payload]);

function setup(overrides: Partial<HubOptions> = {}) {
  let now = 1_000;
  let next = 100_000;
  const hub = createRelayHub({
    now: () => now,
    reserveMs: 60_000,
    maxPeers: 10,
    ratePerSecond: 100,
    rateBurst: 100,
    newId: () => String(next++),
    ...overrides,
  });
  return { hub, advance: (ms: number) => void (now += ms) };
}

describe('中继 hub', () => {
  it('分配 6 位编号并发送 welcome；转发时把目标编号改写为来源编号', () => {
    const { hub } = setup();
    const a = fakeSocket();
    const b = fakeSocket();
    const ia = hub.connect(a)!;
    const ib = hub.connect(b)!;
    expect(ia.id).toMatch(/^\d{6}$/);
    expect(JSON.parse(a.texts[0]!)).toEqual({ type: 'welcome', id: ia.id, token: ia.token });
    hub.receive(ia.id, frame(ib.id, 1, 2, 3));
    expect(b.frames).toEqual([frame(ia.id, 1, 2, 3)]);
    expect(a.frames).toEqual([]);
    expect(hub.stats()).toMatchObject({ online: 2, forwarded: 1, dropped: 0 });
  });

  it('目标不存在、离线或帧格式非法时静默丢弃', () => {
    const { hub } = setup();
    const a = fakeSocket();
    const b = fakeSocket();
    const ia = hub.connect(a)!;
    const ib = hub.connect(b)!;
    hub.receive(ia.id, frame('999999', 1));
    hub.receive(ia.id, frame('12', 1));
    hub.receive(ia.id, Uint8Array.from([6, 49, 50]));
    hub.receive(ia.id, frame(ib.id));
    hub.disconnect(ib.id, b);
    hub.receive(ia.id, frame(ib.id, 1));
    expect(b.frames).toEqual([]);
    expect(hub.stats()).toMatchObject({ forwarded: 0, dropped: 5, online: 1, reserved: 1 });
  });

  it('断线后在保留期内凭令牌找回原编号（房间号不变），过期或令牌错误则分配新编号', () => {
    const { hub, advance } = setup();
    const host = fakeSocket();
    const ih = hub.connect(host)!;
    hub.disconnect(ih.id, host);
    advance(30_000);
    expect(hub.connect(fakeSocket(), { id: ih.id, token: 'wrong' })!.id).not.toBe(ih.id);
    const again = fakeSocket();
    expect(hub.connect(again, { id: ih.id, token: ih.token })).toEqual(ih);
    const peer = fakeSocket();
    const ip = hub.connect(peer)!;
    hub.receive(ip.id, frame(ih.id, 7));
    expect(again.frames).toEqual([frame(ip.id, 7)]);
    // 保留期过后不能再找回
    hub.disconnect(ih.id, again);
    advance(60_001);
    hub.sweep();
    expect(hub.connect(fakeSocket(), { id: ih.id, token: ih.token })!.id).not.toBe(ih.id);
  });

  it('重连时替换仍挂着的旧连接', () => {
    const { hub } = setup();
    const old = fakeSocket();
    const id = hub.connect(old)!;
    const fresh = fakeSocket();
    hub.connect(fresh, id);
    expect(old.closed?.code).toBe(4000);
    // 旧连接随后的 close 事件不影响新连接
    hub.disconnect(id.id, old);
    expect(hub.stats().online).toBe(1);
  });

  it('超过速率上限的帧被丢弃，令牌随时间恢复', () => {
    const { hub, advance } = setup({ ratePerSecond: 2, rateBurst: 2 });
    const a = fakeSocket();
    const b = fakeSocket();
    const ia = hub.connect(a)!;
    const ib = hub.connect(b)!;
    for (let i = 0; i < 4; i++) hub.receive(ia.id, frame(ib.id, i));
    expect(b.frames).toHaveLength(2);
    advance(500);
    hub.receive(ia.id, frame(ib.id, 9));
    expect(b.frames).toHaveLength(3);
  });

  it('在线人数达到上限时拒绝新连接', () => {
    const { hub } = setup({ maxPeers: 1 });
    expect(hub.connect(fakeSocket())).not.toBeNull();
    expect(hub.connect(fakeSocket())).toBeNull();
  });
});
