import type { GamePluginDefinition } from '@we/game-app';
import { chooseBotAction } from './rules/bot';
import { werewolfRules } from './rules/plugin';
import type { WerewolfPlayerView } from './rules/types';
import { werewolfPresentation } from './scenes/presentation';

/** 静态注册：Host 使用规则插件，Client 使用表现插件 */
export const werewolfGame: GamePluginDefinition = {
  rules: werewolfRules,
  presentation: werewolfPresentation,
  bot: (view, rng) => chooseBotAction(view as WerewolfPlayerView, rng),
};
