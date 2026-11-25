/** 纯规则入口：不依赖 UI、网络或平台，可在 Host 与测试中单独使用 */
export { chooseBotAction } from './bot';
export { ROLE_DECK, projectView, shuffle, werewolfRules } from './plugin';
export type { Role, WerewolfAction, WerewolfPlayerView, WerewolfState } from './types';
