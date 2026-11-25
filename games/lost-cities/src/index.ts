import type { GamePluginDefinition } from '@we/game-app';
import { chooseBotAction } from './rules/bot';
import { lostCitiesRules } from './rules/plugin';
import type { LostCitiesPlayerView } from './rules/types';
import { lostCitiesPresentation } from './scenes/presentation';

/** 静态注册：Host 使用规则插件，Client 使用表现插件 */
export const lostCitiesGame: GamePluginDefinition = {
  rules: lostCitiesRules,
  presentation: lostCitiesPresentation,
  icon: '🗺️',
  summary: '2 人 · 策略卡牌',
  bot: (view, rng) => chooseBotAction(view as LostCitiesPlayerView, rng),
};
