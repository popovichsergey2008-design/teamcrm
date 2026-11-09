import { lazyComponent } from '../lib/lazy';

/*
  Просмотр снимков открывают по щелчку — грузим его тогда же, а не в первом экране
  (#4834: окно стало больше — щелчок, перетаскивание, «На весь экран»).
*/
export const Lightbox = lazyComponent(() => import('./Lightbox').then((m) => m.Lightbox));
export type { LightboxItem } from './Lightbox';
