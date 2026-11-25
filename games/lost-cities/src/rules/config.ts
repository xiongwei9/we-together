import type { RuleOption } from '@we/multiplayer';
import type { LostCitiesConfig } from './types';

/** 规则文档 §9.1 的默认值 */
export const DEFAULT_CONFIG: LostCitiesConfig = {
  rounds: 3,
  turnSec: 30,
  roundEndMs: 20_000,
};

const ROUNDS = [3, 1] as const;
const TURN_SECONDS = [30, 60, 0] as const;

interface RuleDef {
  key: 'rounds' | 'turnSec';
  label: string;
  choices: readonly { value: string; label: string }[];
  get(c: LostCitiesConfig): string;
  set(c: LostCitiesConfig, value: string): LostCitiesConfig;
}

const RULES: readonly RuleDef[] = [
  {
    key: 'rounds',
    label: '比赛轮数',
    choices: [
      { value: '3', label: '标准 3 轮' },
      { value: '1', label: '快速 1 轮' },
    ],
    get: (c) => String(c.rounds),
    set: (c, v) => ({ ...c, rounds: Number(v) as LostCitiesConfig['rounds'] }),
  },
  {
    key: 'turnSec',
    label: '回合时间',
    choices: TURN_SECONDS.map((n) => ({ value: String(n), label: n === 0 ? '不计时' : `${n} 秒` })),
    get: (c) => String(c.turnSec),
    set: (c, v) => ({ ...c, turnSec: Number(v) as LostCitiesConfig['turnSec'] }),
  },
];

export function ruleOptions(config: LostCitiesConfig): RuleOption[] {
  return RULES.map((r) => ({ key: r.key, label: r.label, value: r.get(config), choices: r.choices }));
}

export function setRuleOption(config: LostCitiesConfig, key: string, value: string): LostCitiesConfig | null {
  const rule = RULES.find((r) => r.key === key);
  if (!rule || !rule.choices.some((c) => c.value === value)) return null;
  return rule.set(config, value);
}

const oneOf = <T>(v: unknown, values: readonly T[]): v is T => values.includes(v as T);

export function isValidConfig(c: unknown): c is LostCitiesConfig {
  if (typeof c !== 'object' || c === null) return false;
  const x = c as Record<string, unknown>;
  const ms = x.roundEndMs;
  return oneOf(x.rounds, ROUNDS) && oneOf(x.turnSec, TURN_SECONDS) && typeof ms === 'number' && Number.isFinite(ms) && ms >= 1_000 && ms <= 600_000;
}
