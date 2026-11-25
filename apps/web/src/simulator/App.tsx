import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ERROR_TEXT } from '@we/multiplayer';
import { NETWORK_PRESETS, type PacketTraceEvent } from '@we/testing';
import { werewolfGame } from '@we/werewolf';
import { createSimulationController, type InstanceView, type SimulationConfig, type SimulationController } from './controller';

const VIEWPORTS = {
  'iPhone 390×844': { width: 390, height: 844 },
  'Android 360×780': { width: 360, height: 780 },
  '小屏 320×640': { width: 320, height: 640 },
} as const;

type PresetKey = keyof typeof NETWORK_PRESETS;
const PRESET_LABEL: Record<string, string> = { ideal: '理想', wifi: '普通 Wi-Fi', poor: '差（5% 丢包/重复/乱序）', terrible: '极差（20% 丢包）' };

const ROLE_FIXTURE = { rolesBySeat: { 1: 'wolf', 2: 'wolf', 3: 'seer', 4: 'witch', 5: 'villager', 6: 'villager' } };

function useController(): SimulationController {
  const [controller] = useState(() => createSimulationController([werewolfGame]));
  useEffect(() => () => void controller.dispose(), [controller]);
  return controller;
}

function useTick(controller: SimulationController, intervalMs: number): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let raf = 0;
    const off = controller.subscribe(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(force);
    });
    const id = window.setInterval(force, intervalMs);
    return () => {
      off();
      cancelAnimationFrame(raf);
      window.clearInterval(id);
    };
  }, [controller, intervalMs]);
}

export function App() {
  const controller = useController();
  useTick(controller, 500);
  const [cfg, setCfg] = useState<SimulationConfig>({
    gameId: 'werewolf',
    playerCount: 6,
    seed: 42,
    deterministic: false,
    fastTimers: true,
    viewport: VIEWPORTS['iPhone 390×844'],
    preset: 'ideal',
  });
  const [descriptors, setDescriptors] = useState<readonly { instanceId: string }[]>([]);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('p1');
  const [columns, setColumns] = useState<number>(3);
  const [autoBot, setAutoBot] = useState(false);

  const create = async (): Promise<void> => {
    setZoomed(null);
    setDescriptors(await controller.create(cfg));
  };

  useEffect(() => {
    void create();
    // 首次进入自动创建一个场景
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoBot) return;
    const id = window.setInterval(() => controller.botStep(), 900);
    return () => window.clearInterval(id);
  }, [autoBot, controller]);

  const views = controller.instances();
  const simId = controller.simulationId;

  return (
    <div className="sim">
      <header className="toolbar">
        <strong className="brand">we-together Simulator</strong>
        <label>
          游戏
          <select value={cfg.gameId} onChange={(e) => setCfg({ ...cfg, gameId: e.target.value })}>
            <option value="werewolf">狼人杀 · 六人局</option>
          </select>
        </label>
        <label>
          玩家数 <input value={cfg.playerCount} disabled style={{ width: 32 }} />
        </label>
        <label>
          Seed
          <input type="number" value={cfg.seed} style={{ width: 70 }} onChange={(e) => setCfg({ ...cfg, seed: Number(e.target.value) || 0 })} />
        </label>
        <label title="实例随机源使用 seed（发牌可重复）">
          <input type="checkbox" checked={cfg.deterministic} onChange={(e) => setCfg({ ...cfg, deterministic: e.target.checked })} />
          固定随机
        </label>
        <label title="夜间 15s / 讨论 45s / 投票 20s">
          <input type="checkbox" checked={cfg.fastTimers} onChange={(e) => setCfg({ ...cfg, fastTimers: e.target.checked })} />
          快速计时
        </label>
        <label>
          视口
          <select
            value={Object.entries(VIEWPORTS).find(([, v]) => v.width === cfg.viewport.width)?.[0]}
            onChange={(e) => setCfg({ ...cfg, viewport: VIEWPORTS[e.target.value as keyof typeof VIEWPORTS] })}
          >
            {Object.keys(VIEWPORTS).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <button onClick={() => void create()}>创建 / 重置</button>
        <span className="sep" />
        <label>
          网络
          <select
            value={controller.config?.preset ?? cfg.preset}
            onChange={(e) => {
              const preset = e.target.value as PresetKey;
              setCfg({ ...cfg, preset });
              controller.setPreset(preset);
            }}
          >
            {Object.keys(NETWORK_PRESETS).map((k) => (
              <option key={k} value={k}>
                {PRESET_LABEL[k] ?? k}
              </option>
            ))}
          </select>
        </label>
        <span className="sep" />
        <button onClick={() => void controller.hostAndJoinAll()}>一键开房+加入</button>
        <button onClick={() => controller.readyAll()}>全员准备</button>
        <button onClick={() => controller.start()}>开始</button>
        <button onClick={() => controller.botStep()}>Bot 一步</button>
        <label>
          <input type="checkbox" checked={autoBot} onChange={(e) => setAutoBot(e.target.checked)} />
          自动 Bot
        </label>
        <span className="sep" />
        <label>
          列数
          <select value={columns} onChange={(e) => setColumns(Number(e.target.value))}>
            {[1, 2, 3, 4, 6].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </header>

      <main className="body">
        <section className={`grid ${zoomed ? 'zoomed' : ''}`} style={{ gridTemplateColumns: zoomed ? '1fr' : `repeat(${columns}, minmax(0, 1fr))` }}>
          {descriptors.map((d) => {
            const v = views.find((x) => x.instanceId === d.instanceId);
            return (
              <PlayerTile
                key={`${simId}-${d.instanceId}`}
                controller={controller}
                instanceId={d.instanceId}
                view={v}
                aspect={cfg.viewport}
                zoomed={zoomed === d.instanceId}
                hidden={!!zoomed && zoomed !== d.instanceId}
                selected={selected === d.instanceId}
                onSelect={() => setSelected(d.instanceId)}
                onZoom={() => setZoomed(zoomed === d.instanceId ? null : d.instanceId)}
              />
            );
          })}
        </section>
        <Inspector controller={controller} views={views} selected={selected} onSelect={setSelected} />
      </main>
      <EventLog controller={controller} views={views} />
    </div>
  );
}

function statusLabel(v: InstanceView | undefined): string {
  const c = v?.status?.client;
  if (!v?.attached) return '未挂载';
  if (v.status?.bootError) return `启动失败`;
  if (!c) return '启动中';
  if (c.phase === 'in-room') return c.link === 'ok' ? (c.room?.status === 'lobby' ? '大厅' : c.room?.status === 'playing' ? '游戏中' : '已结束') : c.link === 'suspect' ? '链路可疑' : '失联';
  return { idle: '首页', joining: '加入中', resuming: '恢复中', closed: '房间关闭' }[c.phase];
}

function PlayerTile(props: {
  controller: SimulationController;
  instanceId: string;
  view: InstanceView | undefined;
  aspect: { width: number; height: number };
  zoomed: boolean;
  hidden: boolean;
  selected: boolean;
  onSelect(): void;
  onZoom(): void;
}) {
  const { controller, instanceId, view } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    void controller.attach(instanceId, canvas, overlay);
    return () => void controller.detach(instanceId);
  }, [controller, instanceId]);

  const s = view?.status;
  const me = s?.client.room?.players.find((p) => p.playerId === s.client.playerId);
  const visible = s?.visible ?? true;
  return (
    <div className={`tile ${props.zoomed ? 'zoom' : ''} ${props.selected ? 'selected' : ''}`} style={{ display: props.hidden ? 'none' : undefined }} onMouseDown={props.onSelect}>
      <div className="tile-bar">
        <span className="tile-id">
          {instanceId.toUpperCase()}
          {s?.isHost ? ' · Host' : ''}
          {me ? ` · ${me.seat}号` : ''}
        </span>
        <span className={`dot ${view?.online ? (s?.client.link === 'ok' ? 'ok' : 'warn') : 'off'}`} title={view?.online ? '在线' : '断网'} />
        <span className="tile-status">{statusLabel(view)}</span>
        <span className="grow" />
        <button className={view?.online ? '' : 'on'} onClick={() => (view?.online ? controller.disconnect(instanceId) : controller.reconnect(instanceId))}>
          {view?.online ? '断网' : '恢复'}
        </button>
        <button className={visible ? '' : 'on'} onClick={() => controller.setVisible(instanceId, !visible)}>
          {visible ? '切后台' : '回前台'}
        </button>
        <button onClick={() => void controller.restart(instanceId)}>重启</button>
        <button onClick={() => controller.setMuted(instanceId, !s?.muted)}>{s?.muted ? '🔇' : '🔊'}</button>
        <button onClick={props.onZoom}>{props.zoomed ? '还原' : '放大'}</button>
      </div>
      <div className="screen" style={{ aspectRatio: `${props.aspect.width} / ${props.aspect.height}`, maxWidth: props.zoomed ? `${props.aspect.width * 1.1}px` : undefined }}>
        <canvas ref={canvasRef} />
        {!visible && <div className="hidden-mask">后台（模拟 onHide）</div>}
        <div ref={overlayRef} className="overlay-host" />
      </div>
    </div>
  );
}

function Inspector(props: { controller: SimulationController; views: InstanceView[]; selected: string; onSelect(id: string): void }) {
  const { controller } = props;
  const [tab, setTab] = useState<'room' | 'state' | 'client' | 'network'>('room');
  const inspection = controller.hostInspection();
  const selected = props.views.find((v) => v.instanceId === props.selected);
  return (
    <aside className="inspector">
      <div className="tabs">
        {(
          [
            ['room', 'Room / Phase'],
            ['state', 'Host State'],
            ['client', `实例 ${props.selected.toUpperCase()}`],
            ['network', 'Network'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="panel">
        {tab === 'room' &&
          (inspection ? (
            <>
              <dl>
                <dt>房间</dt>
                <dd>
                  {inspection.room.roomId} · {inspection.room.status} · v{inspection.room.roomVersion}
                </dd>
                <dt>邀请码</dt>
                <dd>{inspection.invite}</dd>
                <dt>对局</dt>
                <dd>{inspection.match ? `${inspection.match.matchId} · v${inspection.match.version}` : '—'}</dd>
                <dt>阶段</dt>
                <dd>{inspection.match?.phaseId ?? '—'}</dd>
                <dt>计时</dt>
                <dd>{inspection.match?.timerRemainingMs != null ? `${(inspection.match.timerRemainingMs / 1000).toFixed(1)}s` : '—'}</dd>
                <dt>暂停</dt>
                <dd>{inspection.paused ? inspection.paused.reasons.join(', ') : '否'}</dd>
              </dl>
              <table>
                <thead>
                  <tr>
                    <th>座位</th>
                    <th>昵称</th>
                    <th>准备</th>
                    <th>连接</th>
                    <th>链路</th>
                  </tr>
                </thead>
                <tbody>
                  {inspection.room.players.map((p) => {
                    const s = inspection.sessions.find((x) => x.playerId === p.playerId);
                    return (
                      <tr key={p.playerId}>
                        <td>{p.seat}</td>
                        <td>
                          {p.nickname}
                          {p.isHost ? '（房主）' : ''}
                        </td>
                        <td>{p.ready ? '✓' : ''}</td>
                        <td>{p.connected ? '在线' : '离线'}</td>
                        <td title={s?.link}>{s ? `${s.health} · ${Math.round(s.lastSeenAgoMs / 100) / 10}s` : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="row">
                <button onClick={() => controller.setFixture(ROLE_FIXTURE)} title="Debug Port：仅对下一局生效">
                  下一局固定角色（1-2狼 3预 4巫）
                </button>
                <button onClick={() => controller.setFixture(undefined)}>取消固定</button>
              </div>
            </>
          ) : (
            <p className="muted">实例 1 尚未创建房间。点击「一键开房+加入」。</p>
          ))}
        {tab === 'state' && (
          <>
            <p className="muted">测试专用：Host 完整状态的只读副本（含隐藏身份）。正式构建不包含。</p>
            <pre>{JSON.stringify(inspection?.match?.state ?? null, null, 2)}</pre>
          </>
        )}
        {tab === 'client' && selected?.status && (
          <>
            <dl>
              <dt>阶段</dt>
              <dd>{selected.status.client.phase}</dd>
              <dt>playerId</dt>
              <dd>{selected.status.client.playerId ?? '—'}</dd>
              <dt>链路</dt>
              <dd>{selected.status.client.link}</dd>
              <dt>Endpoint</dt>
              <dd>
                {selected.status.endpoint ? JSON.stringify(selected.status.endpoint) : '—'} · gen {selected.generation}
              </dd>
              <dt>错误</dt>
              <dd>{selected.status.client.error ? (ERROR_TEXT[selected.status.client.error] ?? selected.status.client.error) : '—'}</dd>
              <dt>快照</dt>
              <dd>{selected.status.client.snapshot ? `v${selected.status.client.snapshot.version} · ${selected.status.client.snapshot.phaseId}` : '—'}</dd>
            </dl>
            <h4>命令</h4>
            <ul className="cmds">
              {[...selected.status.client.commands].reverse().map((c) => (
                <li key={c.commandId}>
                  <code>{c.label}</code> {c.status}
                  {c.code ? ` (${c.code})` : ''}
                </li>
              ))}
            </ul>
            <h4>该玩家的授权视图（PlayerSnapshot）</h4>
            <pre>{JSON.stringify(selected.status.client.snapshot?.view ?? null, null, 2)}</pre>
          </>
        )}
        {tab === 'network' && <NetworkPanel controller={controller} views={props.views} />}
      </div>
    </aside>
  );
}

function NetworkPanel(props: { controller: SimulationController; views: InstanceView[] }) {
  const { controller, views } = props;
  const [from, setFrom] = useState('p2');
  const [to, setTo] = useState('p1');
  const [loss, setLoss] = useState(0.3);
  const [latency, setLatency] = useState(200);
  return (
    <>
      <h4>节点</h4>
      <table>
        <tbody>
          {views.map((v) => (
            <tr key={v.instanceId}>
              <td>{v.instanceId}</td>
              <td>{v.online ? '在线' : '断网'}</td>
              <td>
                <button onClick={() => (v.online ? controller.disconnect(v.instanceId) : controller.reconnect(v.instanceId))}>{v.online ? '断网' : '恢复'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>单方向链路故障</h4>
      <div className="row">
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          {views.map((v) => (
            <option key={v.instanceId}>{v.instanceId}</option>
          ))}
        </select>
        →
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {views.map((v) => (
            <option key={v.instanceId}>{v.instanceId}</option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>
          丢包 <input type="number" step={0.05} min={0} max={1} value={loss} onChange={(e) => setLoss(Number(e.target.value))} style={{ width: 60 }} />
        </label>
        <label>
          延迟ms <input type="number" value={latency} onChange={(e) => setLatency(Number(e.target.value))} style={{ width: 60 }} />
        </label>
      </div>
      <div className="row">
        <button
          onClick={() =>
            controller.setLinkFaults(from, to, { latencyMs: { min: latency * 0.8, max: latency * 1.2 }, packetLoss: loss, duplicateRate: 0.05, reorderRate: 0.1 })
          }
        >
          应用
        </button>
        <button onClick={() => controller.setLinkFaults(from, to, null)}>清除</button>
      </div>
      <p className="muted">故障在可靠消息层之下注入，包括 ACK 与重发。</p>
    </>
  );
}

function EventLog(props: { controller: SimulationController; views: InstanceView[] }) {
  const { controller } = props;
  const [filterNode, setFilterNode] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [hideAcks, setHideAcks] = useState(true);
  const [frozen, setFrozen] = useState<readonly PacketTraceEvent[] | null>(null);
  const packets = frozen ?? controller.packets();
  const rows = useMemo(
    () =>
      packets
        .filter((p) => !filterNode || p.from === filterNode || p.to === filterNode)
        .filter((p) => !filterType || (p.type ?? p.kind).includes(filterType))
        .filter((p) => !filterStatus || p.status === filterStatus)
        .filter((p) => !hideAcks || p.kind !== 'ack')
        .slice(-200)
        .reverse(),
    [packets, packets.length, filterNode, filterType, filterStatus, hideAcks],
  );
  const stats = useMemo(() => {
    let delivered = 0;
    let dropped = 0;
    for (const p of packets) {
      if (p.status === 'delivered') delivered++;
      if (p.status === 'dropped') dropped++;
    }
    return { delivered, dropped };
  }, [packets, packets.length]);
  return (
    <footer className="eventlog">
      <div className="row">
        <strong>Packet Inspector</strong>
        <span className="muted">
          已投递 {stats.delivered} · 丢弃 {stats.dropped}（最近 {packets.length} 条）
        </span>
        <select value={filterNode} onChange={(e) => setFilterNode(e.target.value)}>
          <option value="">全部实例</option>
          {props.views.map((v) => (
            <option key={v.instanceId}>{v.instanceId}</option>
          ))}
        </select>
        <input placeholder="消息类型" value={filterType} onChange={(e) => setFilterType(e.target.value.toUpperCase())} style={{ width: 120 }} />
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="queued">queued</option>
          <option value="delivered">delivered</option>
          <option value="dropped">dropped</option>
          <option value="duplicated">duplicated</option>
        </select>
        <label>
          <input type="checkbox" checked={hideAcks} onChange={(e) => setHideAcks(e.target.checked)} />
          隐藏 ACK
        </label>
        <button onClick={() => setFrozen(frozen ? null : [...controller.packets()])}>{frozen ? '继续' : '暂停'}</button>
        <button onClick={() => controller.clearPackets()}>清空</button>
      </div>
      <div className="log-table">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>来源</th>
              <th>目标</th>
              <th>类型</th>
              <th>分片</th>
              <th>字节</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={p.status}>
                <td>{(p.time / 1000).toFixed(2)}</td>
                <td>{p.from}</td>
                <td>{p.to}</td>
                <td>{p.type ?? p.kind}</td>
                <td>{p.part ?? ''}</td>
                <td>{p.size}</td>
                <td>
                  {p.status}
                  {p.reason ? ` · ${p.reason}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </footer>
  );
}
