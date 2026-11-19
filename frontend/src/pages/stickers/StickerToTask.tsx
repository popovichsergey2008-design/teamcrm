import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { api, ApiError } from '../../lib/api';
import { dayLabel, parseYmd, setPendingStickerTask, stickersApi, stickersChanged, type Sticker } from '../../lib/stickers-api';
import { toastSaved } from '../../lib/notifications';

/**
 * Стикер → задача или встреча (#4997, пункт 7). Задачу собирает общее окно постановки: ИИ сам
 * ставит название, проект, исполнителя и срок по тексту — переписывать не нужно. Когда задача
 * создана, стикер становится «Готово» со ссылкой на неё. «В календарь» — событие на время стикера.
 * `source: 'calendar'` — открыли пункт «В календарь».
 */
export function StickerToTask({ sticker, onClose, onDone }: { sticker: Sticker; onClose: () => void; onDone: () => void }) {
  const calendar = sticker.source === 'calendar';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const text = sticker.body ?? sticker.text;

  const toTask = () => {
    setPendingStickerTask(sticker.id);
    const when = sticker.date ? ` срок ${dayLabel(sticker.date)}${sticker.time ? ` ${sticker.time}` : ''}` : '';
    window.dispatchEvent(new CustomEvent('teamcrm:quick-task', { detail: { text: `${text}${when}` } }));
    onClose();
  };

  const toCalendar = async () => {
    if (!sticker.date || !sticker.time) return;
    setBusy(true); setErr('');
    try {
      const start = parseYmd(sticker.date);
      const [h, m] = sticker.time.split(':').map(Number);
      start.setHours(h, m, 0, 0);
      const end = new Date(start.getTime() + 30 * 60_000);
      const ev = await api.calendarCreate({ title: sticker.text.slice(0, 255), description: sticker.body ?? undefined, startsAt: start.toISOString(), endsAt: end.toISOString() });
      const eventId = String(ev?.id ?? ev?.event?.id ?? '');
      if (eventId) await stickersApi.update(sticker.id, { eventId });
      stickersChanged();
      toastSaved('В календаре', `${dayLabel(sticker.date)} · ${sticker.time}`);
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось поставить в календарь'); }
    finally { setBusy(false); }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="ui-modal" role="dialog" aria-modal="true" aria-label={calendar ? 'В календарь' : 'Сделать задачей'} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <header className="ui-modal-head">
          <h2 className="ui-modal-title"><Icon name={calendar ? 'calendar' : 'check-circle'} size={18} /> {calendar ? 'В календарь' : 'Сделать задачей'}</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={16} /></Button>
        </header>
        <div className={`st-note st-${sticker.color}`} style={{ cursor: 'default', margin: '8px 0 12px' }}>
          {sticker.text}
          {sticker.date && <div className="st-note-meta">{dayLabel(sticker.date)}{sticker.time ? ` · ${sticker.time}` : ''}</div>}
        </div>
        <p className="dim" style={{ fontSize: 13, margin: '0 0 12px' }}>
          {calendar
            ? 'Событие встанет в календарь на время стикера, на 30 минут. Стикер останется на доске.'
            : 'Откроется окно новой задачи: ИИ сам заполнит название, проект, исполнителя и срок по тексту стикера — проверьте и нажмите «Создать». Стикер станет «Готово» со ссылкой на задачу.'}
        </p>
        {err && <div className="error-text" role="alert">{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          {calendar
            ? <Button variant="primary" disabled={busy} onClick={() => void toCalendar()}>{busy ? 'Ставлю…' : 'Поставить в календарь'}</Button>
            : <Button variant="primary" onClick={toTask}>Открыть задачу</Button>}
        </div>
      </div>
    </div>
  );
}
