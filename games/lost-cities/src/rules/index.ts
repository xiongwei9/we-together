/** 纯规则入口：不依赖 UI、网络或平台，可在 Host 与测试中单独使用 */
export { chooseBotAction } from './bot';
export { createDeck, scoreColumn } from './cards';
export { projectView } from './view';
export { lostCitiesRules } from './plugin';
export type { Card, Color, LostCitiesAction, LostCitiesConfig, LostCitiesPlayerView, LostCitiesState } from './types';
