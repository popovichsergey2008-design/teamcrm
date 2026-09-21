import { useEffect } from 'react';
import { api, type SyncChange } from '../lib/api';
import { getSocket } from '../lib/socket';
import { OFFLINE_FLUSHED_EVENT } from './useOfflineQueue';

const CURSOR_KEY = 'teamcrm.sync-cursor';
/** Пришли изменения после разрыва: экраны перечитывают то, что их касается. */
export const SYNC_EVENT = 'teamcrm:sync';
export interface SyncDetail { reset: boolean; changes: SyncChange[] }

/**
 * Delta-sync (ТЗ-9, волна 9): догнать пропущенное после разрыва.
 *
 * Живые события идут по сокету, но пока телефон был без сети или в фоне, они
 * потерялись. Поэтому при возврате — сеть появилась, приложение вернулось на экран,
 * сокет переподключился, очередь ушла — спрашиваем сервер «что изменилось после моего
 * курсора» и рассылаем ссылки экранам: доска перечитает проект, чат — переписку,
 * лента задачи — комментарии. Только если их это касается — иначе ничего не мигает.
 *
 * Первый заход без курсора — не история: берём голову журнала и живём дальше.
 * `reset` (курсор старше журнала) — сигнал перечитать всё без разбора.
 */
export function useDeltaSync(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    let busy = false;
    let hiddenAt = 0;

    const pull = async () => {
      if (busy || !navigator.onLine) return;
      busy = true;
      try {
        let cursor: string | null = null;
        try { cursor = localStorage.getItem(CURSOR_KEY); } catch { /* приватный режим */ }
        const all: SyncChange[] = [];
        let reset = false;
        for (let page = 0; page < 10; page++) {
          const r = await api.mobileSync(cursor);
          if (!alive) return;
          cursor = r.cursor;
          reset = reset || r.reset;
          all.push(...r.changes);
          if (!r.more) break;
        }
        try { if (cursor) localStorage.setItem(CURSOR_KEY, cursor); } catch { /* приватный режим */ }
        if (reset || all.length) {
          window.dispatchEvent(new CustomEvent<SyncDetail>(SYNC_EVENT, { detail: { reset, changes: all } }));
          if (reset || all.some((c) => c.entity_type === 'task')) window.dispatchEvent(new Event('teamcrm:tasks-changed'));
        }
      } catch { /* нет сети — догоним в следующий раз */ }
      finally { busy = false; }
    };

    void pull();
    const onOnline = () => { void pull(); };
    const onVisible = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      // короткое переключение между приложениями ничего не пропустило — сокет жив
      if (Date.now() - hiddenAt > 15_000) void pull();
    };
    const onReconnect = () => { void pull(); };
    const onFlushed = () => { void pull(); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    const socket = getSocket();
    socket.io.on('reconnect', onReconnect);
    window.addEventListener(OFFLINE_FLUSHED_EVENT, onFlushed);
    return () => {
      alive = false;
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      socket.io.off('reconnect', onReconnect);
      window.removeEventListener(OFFLINE_FLUSHED_EVENT, onFlushed);
    };
  }, [signedIn]);
}

/** Касается ли пачка изменений этого места: перечитывать или нет. */
export function syncTouches(
  d: SyncDetail,
  where: { type: SyncChange['entity_type'] | SyncChange['entity_type'][]; parentId?: string | null; entityId?: string | null },
): boolean {
  if (d.reset) return true;
  const types = Array.isArray(where.type) ? where.type : [where.type];
  return d.changes.some((c) => types.includes(c.entity_type)
    && (where.parentId == null || String(c.parent_id) === String(where.parentId))
    && (where.entityId == null || String(c.entity_id) === String(where.entityId)));
}
