import { createHash } from 'crypto';

/**
 * Хеш состояния задачи — общий для импорта (YouGile → CRM) и выгрузки (CRM → YouGile).
 *
 * Импорт кладёт его в external_refs.external_hash и пропускает задачу, если хеш не изменился.
 * Выгрузка после успешной отправки записывает хеш ОЖИДАЕМОГО состояния YouGile — поэтому
 * вебхук о нашей же правке приходит «пустым» и не перезаписывает карточку обратно (защита от эха).
 * Поля и порядок менять нельзя, не пересчитав хеши: иначе один прогон импорта пройдёт вхолостую.
 */
export function taskStateHash(i: {
  title: string;
  description: string | null;
  localColumnId: string;
  assigned: string[];
  deadlineIso: string | null;
  completed: boolean;
}): string {
  return createHash('sha256')
    .update([
      i.title,
      i.description ?? '',
      i.localColumnId,
      i.assigned.join(','),
      i.deadlineIso ?? '',
      i.completed ? '1' : '0',
    ].join('|'))
    .digest('hex')
    .slice(0, 64);
}

/**
 * Ключ «наше сообщение» для чата задачи: по нему импорт узнаёт свой же комментарий,
 * вернувшийся из YouGile, и не создаёт дубль. Влезает в external_refs.external_id (64 симв.).
 */
export function chatEchoKey(taskExternalId: string, text: string): string {
  return 'e:' + createHash('sha256').update(`${taskExternalId}|${text}`).digest('hex').slice(0, 40);
}
