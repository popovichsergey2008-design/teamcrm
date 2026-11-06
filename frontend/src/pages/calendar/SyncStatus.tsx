import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { api, type CalendarLink } from '../../lib/api';
import { google, type GoogleCalendarSettings, type GoogleStatus } from '../../lib/google';

const ago = (iso: string | null) => {
  if (!iso) return 'ещё не обновлялся';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return 'обновлено только что';
  if (m < 60) return `последнее обновление — ${m} мин назад`;
  const h = Math.round(m / 60);
  return h < 24 ? `последнее обновление — ${h} ч назад` : `последнее обновление — ${new Date(iso).toLocaleDateString('ru-RU')}`;
};

/**
 * Состояние подключённых календарей (#4787, п. 17) — только то, что реально работает:
 * подключён ли Google, учитывается ли занятость, пишутся ли встречи туда, когда обновлялось.
 * При ошибке — «Не удалось обновить календарь. Повторить».
 */
export function SyncStatus({ onSynced }: { onSynced?: () => void }) {
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [cal, setCal] = useState<GoogleCalendarSettings | null>(null);
  const [links, setLinks] = useState<CalendarLink[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    google.status().then(setSt).catch(() => setSt(null));
    google.calendarSettings().then(setCal).catch(() => setCal(null));
    api.calendarLinks().then(setLinks).catch(() => setLinks([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const retry = async () => {
    setBusy(true);
    try {
      if (st?.account?.calendar) await google.syncCalendar();
      for (const l of links.filter((x) => x.kind === 'import')) await api.calendarSyncLink(l.id).catch(() => undefined);
      onSynced?.();
    } catch { /* ошибку покажет перечитанное состояние */ }
    finally { setBusy(false); load(); }
  };

  const g = st?.account?.calendar ? cal : null;
  const imports = links.filter((l) => l.kind === 'import');
  const failed = (g?.lastError ?? null) || imports.find((l) => l.lastError)?.lastError || null;
  if (!g && !imports.length) {
    return <div className="cal-sync-status dim"><Icon name="plug" size={13} /> Внешние календари не подключены</div>;
  }
  return (
    <div className={`cal-sync-status${failed ? ' bad' : ''}`} role="status">
      {g && (
        <div>
          <Icon name="check-circle" size={13} /> Google подключён.
          {' '}{g.pullEvents ? 'Занятость учитывается.' : 'Занятость не учитывается.'}
          {' '}{g.pushMeetings ? 'Запись событий в Google включена.' : 'Встречи в Google не записываются.'}
          {' '}<span className="dim">{ago(g.lastPullAt).replace(/^./, (c) => c.toUpperCase())}.</span>
        </div>
      )}
      {imports.map((l) => (
        <div key={l.id}>
          <Icon name="calendar" size={13} /> {l.title || 'Подключённый календарь'}: занятость учитывается · <span className="dim">{ago(l.lastSyncAt)}</span>
        </div>
      ))}
      {failed && (
        <div className="cal-sync-err">
          <Icon name="alert" size={13} /> Не удалось обновить календарь.{' '}
          <button className="cal-due-link" onClick={() => void retry()} disabled={busy}>{busy ? 'Обновляю…' : 'Повторить'}</button>
        </div>
      )}
      {!failed && (
        <button className="cal-due-link" onClick={() => void retry()} disabled={busy}>{busy ? 'Обновляю…' : 'Обновить сейчас'}</button>
      )}
    </div>
  );
}
