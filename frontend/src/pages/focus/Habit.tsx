import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Dialog } from '../../components/ui/dialog';
import { ApiError } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { dur, focusApi, HabitPrefs, WeekSummary } from './focus-api';

const CH: { id: HabitPrefs['channels'][number]; label: string }[] = [
  { id: 'telegram', label: 'Telegram' }, { id: 'push', label: 'Пуш' }, { id: 'email', label: 'Почта' },
];

/**
 * План утром и итоги недели (#4891, п. 12): время и канал — у каждого свои, всё можно
 * выключить. По умолчанию — в начале рабочего дня в Telegram и пушем.
 */
export function HabitSettings({ open, onClose, workStart }: { open: boolean; onClose: () => void; workStart: string }) {
  const [p, setP] = useState<HabitPrefs | null>(null);
  useEffect(() => { if (open) void focusApi.habitPrefs().then(setP).catch(() => undefined); }, [open]);
  const save = async (patch: Partial<HabitPrefs>) => {
    try { setP(await focusApi.saveHabitPrefs(patch)); toastSaved('Сохранено'); }
    catch (e) { toastSaved('Не получилось', e instanceof ApiError ? e.message : ''); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} size="sm" title="План утром и итоги недели">
      {!p ? <div className="dim">Загружаю…</div> : (
        <div className="fp-habit">
          <label className="fp-habit-row">
            <input type="checkbox" checked={p.planOn} onChange={(e) => void save({ planOn: e.target.checked })} />
            <span>Присылать план дня с кнопкой «✓ Принять»</span>
          </label>
          {p.planOn && (
            <label className="fp-habit-row">
              <span className="dim">Когда</span>
              <input className="input fp-time" type="time" value={p.planAt ?? workStart} onChange={(e) => void save({ planAt: e.target.value || null })} aria-label="Время плана" />
              {p.planAt && <button type="button" className="fp-link" onClick={() => void save({ planAt: null })}>в начале рабочего дня ({workStart})</button>}
            </label>
          )}
          <label className="fp-habit-row">
            <input type="checkbox" checked={p.weekOn} onChange={(e) => void save({ weekOn: e.target.checked })} />
            <span>Итоги недели в пятницу</span>
          </label>
          <div className="fp-habit-row" role="group" aria-label="Куда присылать">
            <span className="dim">Куда</span>
            {CH.map((c) => (
              <label key={c.id} className="fp-habit-ch">
                <input type="checkbox" checked={p.channels.includes(c.id)}
                  onChange={(e) => void save({ channels: e.target.checked ? [...p.channels, c.id] : p.channels.filter((x) => x !== c.id) })} />
                {c.label}
              </label>
            ))}
          </div>
          <div className="dim fp-small">Telegram — если он привязан в «Личном кабинете». Снимите все галочки или выключите пункты выше — и ничего приходить не будет.</div>
        </div>
      )}
    </Dialog>
  );
}

/** Итоги недели: часы глубокой работы, главные результаты, сравнение, лучшее время, прерывания. */
export function WeekCard({ onClose }: { onClose: () => void }) {
  const [w, setW] = useState<WeekSummary | null>(null);
  useEffect(() => { void focusApi.week().then(setW).catch(() => undefined); }, []);
  if (!w) return null;
  return (
    <section className="fp-card" aria-label="Итоги недели">
      <div className="fp-head"><b><Icon name="chart" size={15} /> Итоги недели</b>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-label="Закрыть" onClick={onClose}><Icon name="close" size={14} /></button></div>
      <div className="fp-nums">
        <div><b>{dur(w.deepMin)}</b><span>глубокой работы · {w.compare}</span></div>
        <div><b>{w.results.length}</b><span>главных результатов</span></div>
        <div><b>{w.bestTime ?? '—'}</b><span>лучшее время для фокуса</span></div>
        <div><b>{w.interruptions ?? '—'}</b><span>больше всего прерываний</span></div>
      </div>
      {w.results.length > 0 && <div className="fp-small">{w.results.map((r) => `«${r}»`).join(', ')}</div>}
    </section>
  );
}
