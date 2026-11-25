/** 纯规则入口：不依赖 UI、网络或平台，可在 Host 与测试中单独使用 */
export { chooseBotAction } from './bot';
export { ROLE_DECKS } from './config';
export { projectView } from './view';
export { werewolfRules } from './plugin';
export type { Role, WerewolfAction, WerewolfConfig, WerewolfPlayerView, WerewolfState } from './types';
