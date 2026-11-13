import { lazyComponent } from '../lib/lazy';

/**
 * Чаты — своим куском (#4902): страница самая тяжёлая, а первый экран — задачи. Кусок
 * подтягивается, когда браузер простаивает (App), поэтому чат открывается так же быстро.
 */
export const ChatsPage = lazyComponent(
  () => import('./ChatsPage').then((m) => m.ChatsPage),
  <div className="center-screen"><div className="spinner" /></div>,
);
