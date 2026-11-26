import { createGameInstance } from '@we/game-app';
import { lostCitiesGame } from '@we/lost-cities';
import { createRelayTransport } from '@we/multiplayer';
import { connectBrowserWebSocket, createFrameScheduler, createLocalStorage, createRealClock, createWebPlatform, createWebRandom } from '@we/platform/web';
import { werewolfGame } from '@we/werewolf';
import './style.css';

/**
 * Web 客户端入口（真实玩家使用）：创建一次实例。
 * 浏览器无法使用局域网 UDP，只支持联网模式（经 apps/server 中继，凭房间号加入）。不包含 Inspector / Debug Port。
 */

/** 中继服务器地址：默认与页面同源的 /relay（开发时由 Vite 代理，生产由反向代理转发）；可用 VITE_RELAY_URL 覆盖 */
const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;

/** 读取刘海屏 / 底部手势条的安全区（CSS env），并保留最小边距 */
function readSafeArea(): { top: number; right: number; bottom: number; left: number } {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const px = (v: string): number => Number.parseFloat(v) || 0;
  const inset = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  probe.remove();
  return { top: Math.max(inset.top, 16), right: inset.right, bottom: Math.max(inset.bottom, 12), left: inset.left };
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const clock = createRealClock();

const instance = createGameInstance({
  instanceId: 'web',
  platform: createWebPlatform({
    canvas,
    overlayHost: overlay,
    page: true,
    safeArea: readSafeArea(),
    storage: createLocalStorage('we-together:'),
    clock,
    random: createWebRandom(),
    frames: createFrameScheduler(),
  }),
  network: 'online',
  transport: createRelayTransport({ url: RELAY_URL, connect: connectBrowserWebSocket, clock }),
  games: [werewolfGame, lostCitiesGame],
});

instance.start().catch((e: unknown) => {
  window.alert(`启动失败：${e instanceof Error ? e.message : String(e)}`);
});
