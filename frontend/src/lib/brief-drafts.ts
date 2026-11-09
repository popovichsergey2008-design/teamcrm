/**
 * #4839 (09.11): пункты утренней планерки больше НЕ раскладываются в «Черновики».
 *
 * Раньше (#1525, фича 6) бриф сам клал их туда — и заказчик увидел четыре черновика
 * «Планерка: просрочено «…» — Борис», «непонятно откуда взялись и о чём они». Пункты
 * планерки живут в карточке брифа: там видно, откуда они, и каждый ставится задачей
 * кнопкой. Здесь — только уборка того, что уже успели разложить.
 */
import { listDrafts, removeDraft } from './task-draft';

const doneKey = (uid: string) => `qevo.brief.drafts:${uid}`;

/** Убрать из «Черновиков» пункты планерки, разложенные прежней версией брифа. */
export function dropBriefDrafts(userId: string | undefined): number {
  if (!userId) return 0;
  let done: string[] = [];
  try { done = JSON.parse(localStorage.getItem(doneKey(userId)) ?? '[]') as string[]; } catch { done = []; }
  // ключ есть только у тех, кому бриф уже раскладывал, — остальным убирать нечего
  if (!done.length) return 0;
  const gone = listDrafts(userId).filter((d) => d.kind === 'form' && d.title.startsWith('Планерка: '));
  for (const d of gone) removeDraft(d.id);
  try { localStorage.removeItem(doneKey(userId)); } catch { /* без хранилища — уберём в следующий раз */ }
  return gone.length;
}
