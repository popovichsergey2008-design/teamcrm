import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ApiError } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { overlayProps } from '../../lib/overlay';
import { calApi, Suggestion, WeekAssistant } from './cal-api';

/**
 * «Ассистент недели» (#4892, п. 2): до четырёх подсказок по важности, у каждой одна
 * кнопка. Нажатие открывает предпросмотр «было → стало»; изменение делается только
 * по «Применить», после чего подсказка исчезает, а сетка обновляется без перезагрузки.
 * «Не предлагать такое» — ассистент запоминает.
 */
export function AssistantPanel({ from, to, refreshKey, onChanged, onWindows, onClose }: {
  from: string; to: string; refreshKey: number;
  onChanged: () => void;
  /** Свободные окна, которые предлагает ассистент, — пунктиром в сетке. */
  onWindows: (w: { startsAt: string; endsAt: string; label: string }[]) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<WeekAssistant | null>(null);
  const [open, setOpen] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    calApi.assistant(from, to).then((d) => {
      if (!alive) return;
      setData(d);
      onWindows(d.suggestions.filter((s) => s.window).map((s) => ({ ...s.window!, label: 'свободно для фокуса' })));
    }).catch(() => { if (alive) setData({ insight: { meetingMin: 0, workMin: 0, meetingText: '', overlaps: 0, backToBack: 0, focusWindows: 0, windows: [] }, suggestions: [] }); });
    return () => { alive = false; };
    // onWindows — колбэк родителя, перезапрос по нему не нужен
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, refreshKey]);

  const apply = async (s: Suggestion) => {
    setBusy(true); setErr('');
    try {
      await calApi.apply(s.key, from, to);
      toastSaved('Готово', s.action.label);
      setOpen(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось применить');
    } finally { setBusy(false); }
  };

  const dismiss = async (s: Suggestion) => {
    await calApi.dismiss(s.kind).catch(() => undefined);
    setOpen(null);
    setData((d) => (d ? { ...d, suggestions: d.suggestions.filter((x) => x.kind !== s.kind) } : d));
    toastSaved('Больше не предложу', s.title);
  };

  return (
    <aside className="cal-assist" aria-label="Ассистент недели" id="cal-assistant">
      <div className="cal-assist-head">
        <span>Ассистент недели</span>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} aria-label="Скрыть ассистента"><Icon name="close" size={14} /></button>
      </div>
      {!data && <div className="dim cal-small">Смотрю на неделю…</div>}
      {data && (
        <div className="cal-assist-stat dim">
          {data.insight.meetingText}
          {data.insight.overlaps > 0 && <> · накладки: {data.insight.overlaps}</>}
          {data.insight.focusWindows > 0 && <> · окон для фокуса: {data.insight.focusWindows}</>}
        </div>
      )}
      {data && !data.suggestions.length && <div className="cal-assist-empty dim">На этой неделе всё в порядке — накладок, перегруженных дней и встреч без повестки нет.</div>}
      {data?.suggestions.map((s) => (
        <div key={s.key} className={`cal-assist-card tone-${s.tone}`}>
          <div className="cal-assist-title">{s.title}</div>
          <div className="cal-assist-text">{s.text}</div>
          <div className="cal-assist-actions">
            <button type="button" className={`ui-btn ui-btn-sm ${s.tone === 'danger' ? 'ui-btn-primary' : 'ui-btn-outline'}`} onClick={() => { setErr(''); setOpen(s); }}>{s.action.label}</button>
            <button type="button" className="cal-link dim" onClick={() => void dismiss(s)}>Не предлагать такое</button>
          </div>
        </div>
      ))}

      {open && (
        <div className="drawer-overlay" {...overlayProps(() => setOpen(null))}>
          <div className="ui-modal cal-preview" role="dialog" aria-label="Предпросмотр изменения" onClick={(e) => e.stopPropagation()}>
            <h3 className="ui-modal-title">Предпросмотр: {open.action.label.toLowerCase()}</h3>
            <div className="dim cal-small">{open.text}</div>
            <table className="cal-preview-table">
              <tbody>
                {open.preview.map((r, i) => (
                  <tr key={i}>
                    <td>{r.label}</td>
                    {(r.before || r.after) && <><td className="dim">{r.before}</td><td>→</td><td><b>{r.after}</b></td></>}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="dim cal-small">Ничего не изменится без «Применить».{open.kind === 'overlap' || open.kind === 'heavy_day' ? ' Участники получат новое приглашение.' : ''}</div>
            {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={14} /> {err}</div>}
            <div className="cal-dialog-actions">
              <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void apply(open)}>{busy ? 'Применяю…' : 'Применить'}</button>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setOpen(null)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
