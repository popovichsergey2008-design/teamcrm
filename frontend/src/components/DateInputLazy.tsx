import { lazyComponent } from '../lib/lazy';

/**
 * #4840: поле даты для мест первого экрана («Чаты»: «Отложить», гостевая ссылка) —
 * грузится по первому показу, чтобы не тянуть календарь и время в стартовый кусок.
 */
export const DateInput = lazyComponent(() => import('./DateInput').then((m) => m.DateInput));
