import type { RuleOption } from '@we/multiplayer';
import type { Board, Role, WerewolfConfig, WerewolfTimers } from './types';

/** 板子配置（规则文档 §2） */
export const ROLE_DECKS: Record<Board, readonly Role[]> = {
  6: ['wolf', 'wolf', 'villager', 'villager', 'seer', 'witch'],
  9: ['wolf', 'wolf', 'wolf', 'villager', 'villager', 'villager', 'seer', 'witch', 'hunter'],
};

const DEFAULT_TIMERS: WerewolfTimers = {
  wolfMs: 40_000,
  wolfRevoteMs: 15_000,
  witchMs: 20_000,
  seerMs: 20_000,
  seerRevealMs: 3_000,
  hunterMs: 15_000,
  badgeMs: 15_000,
  sheriffSignupMs: 15_000,
  sheriffOrderMs: 15_000,
  pkSpeechMs: 30_000,
  voteMs: 15_000,
  lastWordsMs: 30_000,
  deadRoleDelayMs: { min: 3_000, max: 8_000 },
};

/** 规则文档 §14 的默认值 */
export const DEFAULT_CONFIG: WerewolfConfig = {
  board: 6,
  sheriff: false,
  witchSelfSave: 'never',
  wolfKill: 'majority',
  selfExplode: true,
  speechSec: 60,
  timers: DEFAULT_TIMERS,
};

/** 0 表示不计时 */
const SPEECH_SECONDS = [60, 90, 120, 0] as const;

type RuleKey = 'board' | 'sheriff' | 'witchSelfSave' | 'wolfKill' | 'selfExplode' | 'speechSec';

interface RuleDef {
  key: RuleKey;
  label: string;
  choices: readonly { value: string; label: string }[];
  get(c: WerewolfConfig): string;
  set(c: WerewolfConfig, value: string): WerewolfConfig;
}

const bool = (v: string): boolean => v === 'on';

const RULES: readonly RuleDef[] = [
  {
    key: 'board',
    label: '板子',
    choices: [
      { value: '6', label: '6 人预女局' },
      { value: '9', label: '9 人预女猎局' },
    ],
    get: (c) => String(c.board),
    set: (c, v) => ({ ...c, board: Number(v) as Board }),
  },
  {
    key: 'sheriff',
    label: '警长',
    choices: [
      { value: 'off', label: '不设警长' },
      { value: 'on', label: '首日竞选警长' },
    ],
    get: (c) => (c.sheriff ? 'on' : 'off'),
    set: (c, v) => ({ ...c, sheriff: bool(v) }),
  },
  {
    key: 'witchSelfSave',
    label: '女巫自救',
    choices: [
      { value: 'never', label: '全程不可自救' },
      { value: 'first-night', label: '仅首夜可自救' },
      { value: 'always', label: '全程可自救' },
    ],
    get: (c) => c.witchSelfSave,
    set: (c, v) => ({ ...c, witchSelfSave: v as WerewolfConfig['witchSelfSave'] }),
  },
  {
    key: 'wolfKill',
    label: '狼刀决策',
    choices: [
      { value: 'majority', label: '最高票（平票重投一次）' },
      { value: 'unanimous', label: '全体狼人一致' },
    ],
    get: (c) => c.wolfKill,
    set: (c, v) => ({ ...c, wolfKill: v as WerewolfConfig['wolfKill'] }),
  },
  {
    key: 'selfExplode',
    label: '狼人自爆',
    choices: [
      { value: 'on', label: '允许' },
      { value: 'off', label: '禁止' },
    ],
    get: (c) => (c.selfExplode ? 'on' : 'off'),
    set: (c, v) => ({ ...c, selfExplode: bool(v) }),
  },
  {
    key: 'speechSec',
    label: '发言时长',
    choices: SPEECH_SECONDS.map((n) => ({ value: String(n), label: n === 0 ? '不计时' : `${n} 秒` })),
    get: (c) => String(c.speechSec),
    set: (c, v) => ({ ...c, speechSec: Number(v) }),
  },
];

export function ruleOptions(config: WerewolfConfig): RuleOption[] {
  return RULES.map((r) => ({ key: r.key, label: r.label, value: r.get(config), choices: r.choices }));
}

export function setRuleOption(config: WerewolfConfig, key: string, value: string): WerewolfConfig | null {
  const rule = RULES.find((r) => r.key === key);
  if (!rule || !rule.choices.some((c) => c.value === value)) return null;
  return rule.set(config, value);
}

const isMs = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 600_000;
const oneOf = <T>(v: unknown, values: readonly T[]): v is T => values.includes(v as T);

export function isValidConfig(c: unknown): c is WerewolfConfig {
  if (typeof c !== 'object' || c === null) return false;
  const x = c as Record<string, unknown>;
  if (!oneOf(x.board, [6, 9] as const) || typeof x.sheriff !== 'boolean' || typeof x.selfExplode !== 'boolean') return false;
  if (!oneOf(x.witchSelfSave, ['never', 'first-night', 'always'] as const) || !oneOf(x.wolfKill, ['majority', 'unanimous'] as const)) return false;
  if (!oneOf(x.speechSec, SPEECH_SECONDS)) return false;
  const t = x.timers as Record<string, unknown> | undefined;
  if (typeof t !== 'object' || t === null) return false;
  const keys = Object.keys(DEFAULT_TIMERS).filter((k) => k !== 'deadRoleDelayMs');
  if (!keys.every((k) => isMs(t[k]))) return false;
  const d = t.deadRoleDelayMs as { min?: unknown; max?: unknown } | undefined;
  return !!d && isMs(d.min) && isMs(d.max) && d.min <= d.max;
}
