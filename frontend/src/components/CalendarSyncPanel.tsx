import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, CalendarLink } from '../lib/api';

/**
 * Синхронизация календаря с Google (и любым другим, понимающим iCalendar).
 *
 * Без OAuth и это сказано человеку прямо. Приложение Google требует проверки и
 * согласия администратора домена — недели переписки ради того, что решается двумя
 * ссылками. Здесь обе:
 *
 *  - НАШИ ВСТРЕЧИ В GOOGLE: секретный адрес, который вставляют в «Другие календари →
 *    Подписаться по URL». Google ходит по нему сам.
 *  - ЧУЖИЕ ВСТРЕЧИ У НАС: «секретный адрес в формате iCal» из настроек Google-календаря.
 *
 * Чего нет — тоже сказано: записи в чужой календарь. Без OAuth её не бывает, и
 * обещать её нельзя.
 */
export function CalendarSyncPanel({ onClose }: { onClose: () => void }) {
  const [links, setLinks] = useState<CalendarLink[]>([]);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const reload = () => api.calendarLinks().then(setLinks).catch(() => setLinks([]));
  useEffect(() => { reload(); }, []);

  const exportLink = links.find((l) => l.kind === 'export');
  const imports = links.filter((l) => l.kind === 'import');

  const makeExport = async (rotate = false) => {
    if (rotate && !window.confirm('Сделать новый адрес? Старый перестанет работать, и календарь придётся переподключить в Google.')) return;
    setErr(''); setBusy(true);
    try { await api.calendarExportLink(rotate); await reload(); setMsg(rotate ? 'Адрес заменён' : 'Ссылка готова'); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось'); }
    finally { setBusy(false); }
  };

  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setMsg('Ссылка скопирована'); }
    catch { setMsg(value); } // буфер может быть запрещён политикой браузера — показываем адрес
  };

  const add = async () => {
    if (!url.trim()) return setErr('Вставьте адрес календаря');
    setErr(''); setMsg(''); setBusy(true);
    try {
      const r = await api.calendarAddImport(url.trim(), title.trim() || undefined);
      setUrl(''); setTitle('');
      setMsg(`Подключено. Встреч прочитано: ${r.imported}`);
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось подключить');
    } finally { setBusy(false); }
  };

  const sync = async (id: string) => {
    setErr(''); setBusy(true);
    try { const r = await api.calendarSyncLink(id); setMsg(`Обновлено. Встреч: ${r.synced}`); await reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось обновить'); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Отключить календарь? Его встречи исчезнут из нашего календаря.')) return;
    try { await api.calendarRemoveLink(id); await reload(); } catch { /* */ }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>Синхронизация календаря</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Наши встречи — в Google</div>
          <p className="dim">
            Секретная ссылка на ваш календарь. В Google: <b>Другие календари → Плюс → Подписаться по URL</b>.
            Встречи из TEAMCRM появятся там же, где остальная ваша жизнь, и будут обновляться сами.
          </p>
          {exportLink?.url ? (
            <>
              <div className="sync-link">
                <input className="input" readOnly value={exportLink.url} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn btn-sm" onClick={() => copy(exportLink.url!)}>
                  <Icon name="copy" size={14} /> Копировать
                </button>
              </div>
              <p className="dim">
                Ссылка секретная: у кого она есть, тот видит ваши встречи. Если она куда-то утекла —
                <button className="link-btn" onClick={() => makeExport(true)} disabled={busy}> сделайте новую</button>.
              </p>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => makeExport(false)} disabled={busy}>
              <Icon name="link" size={14} /> Создать ссылку
            </button>
          )}
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Чужой календарь — у нас</div>
          <p className="dim">
            В Google: <b>настройки нужного календаря → «Секретный адрес в формате iCal»</b>. Вставьте его
            сюда — встречи оттуда будут видны рядом с нашими, чтобы не назначать планёрку на занятое время.
            Обновляем раз в полчаса.
          </p>
          <input
            className="input" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            value={url} onChange={(e) => setUrl(e.target.value)}
          />
          <div className="sync-link">
            <input className="input" placeholder="Название (напр. «Личный»)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button className="btn btn-primary btn-sm" onClick={add} disabled={busy}>Подключить</button>
          </div>

          {imports.map((l) => (
            <div key={l.id} className="team-row team-head">
              <span>
                {l.title}
                <span className="dim" style={{ fontSize: 12 }}>
                  {' · '}встреч: {l.eventsCount}
                  {l.lastSyncAt ? ` · обновлено ${new Date(l.lastSyncAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
                </span>
                {/* Ошибку показываем словами: молча пустой календарь читается как «встреч нет» */}
                {l.lastError && <div className="error-text">{l.lastError}</div>}
              </span>
              <span>
                <button className="btn btn-ghost btn-sm" onClick={() => sync(l.id)} disabled={busy}>Обновить</button>
                <button className="btn btn-ghost btn-sm" onClick={() => remove(l.id)}>Отключить</button>
              </span>
            </div>
          ))}
        </div>

        {msg && <div className="dim">{msg}</div>}
        {err && <div className="error-text">{err}</div>}

        <p className="dim">
          Чего синхронизация НЕ делает: не пишет в ваш Google-календарь. Для записи нужен вход через
          Google с проверкой приложения и согласием администратора домена — это отдельное решение,
          а ссылки работают сегодня.
        </p>
      </aside>
    </div>
  );
}
