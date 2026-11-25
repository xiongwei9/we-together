import { button, card, column, createUiApp, row, spacer, text, theme, type Scene } from '@we/framework';
import { createWechatPlatform } from '@we/platform/wechat';
import { defaultAddressCodec, utf8Decode, utf8Encode, type Endpoint } from '@we/multiplayer';
import { createWechatUdpTransport } from '../udp-transport';

/**
 * Gate 0（设计 §14.1）：微信真机 UDP 最小 PoC。
 * 不含规则引擎与可靠层：两端互填地址，发送带序号/时间的 ping，对端立即回 pong，
 * 统计成功率、RTT P50/P95 与错误。G10 可切换 1200 字节数据报。
 */

interface Sample {
  seq: number;
  sentAt: number;
  rtt: number | null;
}

const platform = createWechatPlatform();
const transport = createWechatUdpTransport();
const ui = createUiApp(platform);

const state = {
  local: null as Endpoint | null,
  peer: null as Endpoint | null,
  peerText: '',
  samples: [] as Sample[],
  running: false,
  bigPayload: false,
  errors: [] as string[],
  received: 0,
  lastFrom: '',
  info: '',
};

const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

const logError = (msg: string): void => {
  state.errors = [`${new Date().toLocaleTimeString()} ${msg}`, ...state.errors].slice(0, 6);
  ui.invalidate();
};

const encode = (obj: unknown, pad: boolean): Uint8Array => {
  const base = JSON.stringify(obj);
  // 1200 字节预算：填充到恰好 1200 字节（UTF-8）
  const body = pad ? JSON.stringify({ ...(obj as object), pad: 'x'.repeat(Math.max(0, 1200 - base.length - 10)) }) : base;
  return utf8Encode(body);
};

transport.onPacket((p) => {
  let msg: { t?: string; seq?: number; at?: number };
  try {
    msg = JSON.parse(utf8Decode(p.payload)) as typeof msg;
  } catch {
    logError(`无法解析 ${p.payload.length} 字节`);
    return;
  }
  state.received++;
  state.lastFrom = defaultAddressCodec.format(p.from);
  if (msg.t === 'ping') {
    // 回复给 remoteInfo 中的实际来源端点
    transport.send(p.from, encode({ t: 'pong', seq: msg.seq, at: msg.at, size: p.payload.length }, p.payload.length >= 1000)).catch((e: unknown) => logError(String(e)));
  } else if (msg.t === 'pong') {
    const s = state.samples.find((x) => x.seq === msg.seq);
    if (s && s.rtt === null) s.rtt = platform.clock.now() - s.sentAt;
  }
  ui.invalidate();
});
transport.onError((e) => logError(e.message));

async function runPings(): Promise<void> {
  if (!state.peer || state.running) return;
  state.running = true;
  state.samples = [];
  for (let seq = 1; seq <= 100 && state.running; seq++) {
    const sample: Sample = { seq, sentAt: platform.clock.now(), rtt: null };
    state.samples.push(sample);
    transport.send(state.peer, encode({ t: 'ping', seq, at: sample.sentAt }, state.bigPayload)).catch((e: unknown) => logError(String(e)));
    ui.invalidate();
    await new Promise<void>((r) => platform.clock.setTimeout(r, 100));
  }
  await new Promise<void>((r) => platform.clock.setTimeout(r, 2000));
  state.running = false;
  ui.invalidate();
}

const scene: Scene = {
  id: 'poc',
  render() {
    const rtts = state.samples.map((s) => s.rtt).filter((x): x is number => x !== null);
    const sent = state.samples.length;
    const ok = rtts.length;
    const safe = platform.viewport().safeArea;
    return column({ flex: 1, padding: [safe.top + 16, 20, safe.bottom + 20, 20], gap: 12 }, [
      text('Gate 0 · UDP PoC', { size: 24, weight: 'bold', color: theme.primary }),
      card([
        text(`本机：${state.local ? defaultAddressCodec.format(state.local) : '启动中…'}`, { size: 17, weight: 'bold' }),
        text(`对端：${state.peer ? defaultAddressCodec.format(state.peer) : '未设置'}`, { size: 15 }),
        text(state.info, { size: 12, color: theme.muted }),
      ]),
      button('设置对端地址（IP:端口）', {
        variant: 'secondary',
        onPress: () =>
          void platform.promptText({ title: '对端地址', initial: state.peerText, maxLength: 32 }).then((v) => {
            if (v === null) return;
            state.peerText = v.trim();
            state.peer = defaultAddressCodec.parse(state.peerText);
            if (!state.peer) logError('地址格式应为 192.168.x.x:端口');
            ui.invalidate();
          }),
      }),
      row({ gap: 10 }, [
        button(state.running ? '发送中…' : '发送 100 次 ping', { onPress: state.peer && !state.running ? () => void runPings() : undefined, flex: 1 }),
        button(state.bigPayload ? '1200B' : '小包', { onPress: () => ((state.bigPayload = !state.bigPayload), ui.invalidate()), variant: 'secondary', width: 90 }),
      ]),
      card([
        text(`发送 ${sent} · 收到 pong ${ok} · 成功率 ${sent ? ((ok / sent) * 100).toFixed(1) : '-'}%`, { size: 16 }),
        text(`RTT P50 ${percentile(rtts, 50).toFixed(1)} ms · P95 ${percentile(rtts, 95).toFixed(1)} ms`, { size: 16 }),
        text(`累计收到数据报 ${state.received} · 最近来源 ${state.lastFrom || '-'}`, { size: 13, color: theme.muted }),
      ]),
      text('错误', { size: 13, color: theme.muted }),
      column({ gap: 4 }, state.errors.length ? state.errors.map((e) => text(e, { size: 12, color: theme.danger })) : [text('无', { size: 12, color: theme.muted })]),
      spacer(1),
      text('记录：机型 / OS / 微信版本 / 基础库 / 路由器模式 / 网络环境 / 时间 / 样本数', { size: 11, color: theme.muted }),
    ]);
  },
};

ui.setScene(scene);
const sys = wx.getSystemInfoSync();
state.info = `${sys.platform} · ${sys.system} · 微信 ${sys.version} · 基础库 ${sys.SDKVersion}`;
transport
  .start()
  .then((ep) => {
    state.local = ep;
    ui.invalidate();
  })
  .catch((e: unknown) => logError(`启动失败：${e instanceof Error ? e.message : String(e)}`));
