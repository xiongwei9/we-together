import { createGameInstance } from '@we/game-app';
import { createWechatPlatform } from '@we/platform/wechat';
import { lostCitiesGame } from '@we/lost-cities';
import { werewolfGame } from '@we/werewolf';
import { createWechatUdpTransport } from './udp-transport';

/** 微信小游戏入口：创建一次实例。不包含 Inspector / Debug Port。 */
const instance = createGameInstance({
  instanceId: 'wechat',
  platform: createWechatPlatform(),
  // 微信支持局域网 UDP：仅局域网联机
  network: 'lan',
  transport: createWechatUdpTransport(),
  games: [werewolfGame, lostCitiesGame],
});

instance.start().catch((e: unknown) => {
  wx.showModal({ title: '启动失败', content: e instanceof Error ? e.message : String(e), showCancel: false });
});
