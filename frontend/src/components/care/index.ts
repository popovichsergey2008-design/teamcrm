import { lazyComponent } from '../../lib/lazy';

/** Карточки заботы на пустых экранах (ТЗ-34): тексты и стили грузятся по первому показу. */
export const CareEmpty = lazyComponent(() => import('./CareEmpty').then((m) => m.CareEmpty));
