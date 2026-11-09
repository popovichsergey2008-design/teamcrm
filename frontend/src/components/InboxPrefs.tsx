import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { INBOX_CHANGED, inboxApi, setInboxModes, type InboxMode, type InboxPref } from '../lib/inbox-api';

const LABEL: Record<InboxMode, string> = { push: 'Входящие и push', inbox: 'Только входящие', off: 'Не показывать' };

/**
 * «Входящие» по типам (#4807 §6.5, п. 6): «Входящие и push» / «Только входящие» /
 * «Не показывать». Решения и упоминания отключить нельзя — у них только push.
 */
export function InboxPrefs() {
  const [prefs, setPrefs] = useState<InboxPref[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { inboxApi.prefs().then(setPrefs).catch(() => setPrefs([])); }, []);

  const save = async (kind: InboxPref['kind'], mode: InboxMode) => {
    setErr('');
    const was = prefs;
    setPrefs((list) => (list ?? []).map((p) => (p.kind === kind ? { ...p, mode } : p)));
    try {
      const next = await inboxApi.setPref(kind, mode);
      setPrefs(next);
      setInboxModes(next);
      window.dispatchEvent(new Event(INBOX_CHANGED));
    } catch (e) {
      setPrefs(was);
      setErr(e instanceof ApiError ? e.message : 'Не сохранилось — попробуйте ещё раз');
    }
  };

  return (
    <div className="drawer-section">
      <div className="drawer-section-title">Входящие</div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
        Что попадает во «Входящие» и что приходит push-уведомлением и в Telegram. В глубоком
        фокусе всё копится без звука — после придёт одна сводка.
      </div>
      {prefs === null && <div className="dim">Загружаю…</div>}
      {prefs?.map((p) => (
        <label key={p.kind} className="notify-row inbox-pref">
          <span>{p.title}</span>
          <select
            className="ui-input ui-input-sm"
            style={{ marginLeft: 'auto', maxWidth: 180, flex: 'none' }}
            value={p.mode}
            onChange={(e) => void save(p.kind, e.target.value as InboxMode)}
            aria-label={`${p.title}: где показывать`}
          >
            {(Object.keys(LABEL) as InboxMode[]).filter((m) => !(p.locked && m === 'off')).map((m) => (
              <option key={m} value={m}>{LABEL[m]}</option>
            ))}
          </select>
        </label>
      ))}
      {prefs?.some((p) => p.locked) && <div className="dim" style={{ fontSize: 12 }}>Решения и упоминания отключить нельзя — можно только убрать push.</div>}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
