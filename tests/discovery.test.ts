import { describe, expect, it } from 'vitest';
import { createRoomBrowser, type RoomBrowser } from '@we/multiplayer';
import { createHeadlessWorld, type HeadlessDevice, type HeadlessWorld } from '@we/testing';
import { werewolfRules } from '@we/werewolf/rules';

function browserOf(world: HeadlessWorld, d: HeadlessDevice): RoomBrowser {
  return createRoomBrowser({ net: d.net, clock: world.clock, ids: d.ids, gameId: werewolfRules.id });
}

async function join(world: HeadlessWorld, d: HeadlessDevice, host: HeadlessDevice, password: string): Promise<boolean> {
  const p = d.client.join({ link: d.net.remote(host.endpoint), hostAddress: '', password, nickname: d.nodeId });
  await world.run(1000);
  return p;
}

describe('局域网房间发现', () => {
  it('无需地址：广播搜索即可发现房间，信息随房间人数更新；房主离开后从列表消失', async () => {
    const world = createHeadlessWorld({ seed: 31 });
    const h = await world.createDevice('h1');
    await world.createHost(h, werewolfRules, { nickname: '阿明' });
    const p2 = await world.createDevice('p2');
    const p3 = await world.createDevice('p3');
    const browser = browserOf(world, p3);
    browser.start();
    await world.run(500);
    expect(browser.rooms()).toHaveLength(1);
    const room = browser.rooms()[0]!;
    expect(room).toMatchObject({ hostName: '阿明', players: 1, capacity: 6, status: 'lobby', hasPassword: false });
    expect(room.endpoint).toEqual(h.endpoint);

    // 用发现到的 endpoint 加入（地址来自数据报来源，而非用户输入）
    expect(await join(world, p2, h, '')).toBe(true);
    await world.run(1500);
    expect(browser.rooms()[0]!.players).toBe(2);

    await h.dispose();
    await world.run(5000);
    expect(browser.rooms()).toHaveLength(0);
    browser.dispose();
  });

  it('多个房间并存；广播不跨 networkId', async () => {
    const world = createHeadlessWorld({ seed: 32, networkId: 'lan-a' });
    const h1 = await world.createDevice('h1');
    const h2 = await world.createDevice('h2');
    await world.createHost(h1, werewolfRules, { nickname: '甲' });
    await world.createHost(h2, werewolfRules, { nickname: '乙', password: '123' });
    const other = createHeadlessWorld({ seed: 33, networkId: 'lan-b' });
    const h3 = await other.createDevice('h3');
    await other.createHost(h3, werewolfRules, { nickname: '丙' });

    const p = await world.createDevice('p');
    const browser = browserOf(world, p);
    browser.start();
    await world.run(1500);
    const found = Object.fromEntries(browser.rooms().map((r) => [r.hostName, r.hasPassword]));
    expect(found).toEqual({ 甲: false, 乙: true });
    browser.stop();
    expect(browser.searching).toBe(false);
  });

  it('只接受对本机 DISCOVER 的回复；停止搜索后不再广播', async () => {
    const world = createHeadlessWorld({ seed: 34 });
    const h = await world.createDevice('h1');
    await world.createHost(h, werewolfRules);
    const p = await world.createDevice('p');
    const spy = await world.createDevice('spy');
    const browser = browserOf(world, p);
    // spy 自己搜索得到的 ROOM_INFO 不会进入 p 的列表
    const spyBrowser = browserOf(world, spy);
    spyBrowser.start();
    await world.run(1500);
    expect(spyBrowser.rooms()).toHaveLength(1);
    expect(browser.rooms()).toHaveLength(0);

    let discovers = 0;
    world.network.subscribePackets((e) => e.status === 'queued' && e.type === 'DISCOVER' && e.from === 'spy' && discovers++);
    spyBrowser.stop();
    await world.run(3000);
    expect(discovers).toBe(0);
  });
});

describe('可选房间密码', () => {
  it('设了密码：错误密码被拒绝，正确密码可加入', async () => {
    const world = createHeadlessWorld({ seed: 35 });
    const h = await world.createDevice('h1');
    const host = await world.createHost(h, werewolfRules, { password: ' 8866 ' });
    expect(host.password).toBe('8866');
    const p = await world.createDevice('p');
    expect(await join(world, p, h, '')).toBe(false);
    expect(p.client.getState().error).toBe('BAD_PASSWORD');
    expect(await join(world, p, h, '1234')).toBe(false);
    expect(p.client.getState().error).toBe('BAD_PASSWORD');
    expect(await join(world, p, h, '8866')).toBe(true);
    expect(host.inspect().room.players).toHaveLength(2);
  });

  it('未设密码：任何同网玩家都可加入（客户端误填密码也不影响）', async () => {
    const world = createHeadlessWorld({ seed: 36 });
    const h = await world.createDevice('h1');
    const host = await world.createHost(h, werewolfRules, { password: '' });
    expect(host.password).toBeNull();
    const p = await world.createDevice('p');
    expect(await join(world, p, h, 'whatever')).toBe(true);
  });
});
