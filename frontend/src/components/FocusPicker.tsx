import { useState } from 'react';
import { Icon, IconName } from './Icon';
import { api } from '../lib/api';
import type { Focus } from '../types';
import { FocusDialog } from './FocusMenu';

/**
 * Переключатель текущего фокуса.
 *
 * Смысл не в статусе ради статуса: коллега, видя «Работаю над макетом до 16:00»,
 * не пишет «ты тут?». Поэтому здесь спрашивают ровно две вещи — над чем и до когда,
 * и обе можно не заполнять: шаблон в один клик тоже считается ответом.
 */

const TEMPLATES: { kind: Focus['kind']; label: string; icon: IconName; note?: string }[] = [
  { kind: 'deep', label: 'Глубокий фокус', icon: 'target' },
  { kind: 'call', label: 'На созвоне', icon: 'phone' },
  { kind: 'quick', label: 'Быстрые ответы', icon: 'zap', note: 'Разбираю почту и чаты' },
  { kind: 'break', label: 'Обед / перерыв', icon: 'clock' },
];

/** #4782, п. 8: ручные статусы — «Занят» и «Отошёл» (presence), «Свободен» снимает всё. */
const MANUAL: { key: 'busy' | 'away' | 'free'; label: string; icon: IconName }[] = [
  { key: 'busy', label: 'Занят', icon: 'target' },
  { key: 'away', label: 'Отошёл', icon: 'user' },
  { key: 'free', label: 'Свободен', icon: 'check-circle' },
];

const DURATIONS: { label: string; minutes: () => number }[] = [
  { label: '30 мин', minutes: () => 30 },
  { label: '1 час', minutes: () => 60 },
  { label: '2 часа', minutes: () => 120 },
  {
    label: 'до конца дня',
    // «До конца дня» считаем по часам человека, а не по серверным:
    // в 19:00 это полтора часа, а не «до полуночи по UTC».
    minutes: () => {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      return Math.max(1, Math.round((end.getTime() - Date.now()) / 60_000));
    },
  },
];

export function FocusMenu({ focus, onChange, onDeep }: {
  focus: Focus | null;
  onChange: (focus: Focus | null) => void;
  /**
   * #4831: окно глубокого фокуса открывает тот, кто держит меню. Изнутри меню аккаунта
   * оно не жило: окно рисуется поверх страницы, первый же щелчок в нём считался
   * «мимо меню» — меню закрывалось и уносило окно, выбрать ничего было нельзя.
   */
  onDeep?: () => void;
}) {
  const [note, setNote] = useState(focus?.note ?? '');
  const [duration, setDuration] = useState(1); // «1 час» — самый частый ответ
  const [busy, setBusy] = useState(false);
  const [deepOpen, setDeepOpen] = useState(false);

  const set = async (kind: Focus['kind'], preset?: string) => {
    setBusy(true);
    try {
      const next = await api.setFocus({
        kind,
        note: (note.trim() || preset || '').slice(0, 160) || undefined,
        minutes: DURATIONS[duration].minutes(),
      });
      onChange(next);
      window.dispatchEvent(new Event('teamcrm:focus-changed'));
    } catch { /* панель не место для разбора ошибок сети */ }
    finally { setBusy(false); }
  };

  const manual = async (key: 'busy' | 'away' | 'free') => {
    setBusy(true);
    try {
      await api.setPresenceStatus(key === 'free' ? null : key);
      if (key === 'free' && focus) { await api.clearFocus(); onChange(null); }
      window.dispatchEvent(new Event('teamcrm:focus-changed'));
      window.dispatchEvent(new Event('teamcrm:presence-changed'));
    } catch { /* см. ниже */ }
    finally { setBusy(false); }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await api.clearFocus();
      onChange(null);
      window.dispatchEvent(new Event('teamcrm:focus-changed'));
    }
    catch { /* см. выше */ }
    finally { setBusy(false); }
  };

  return (
    <div className="focus-menu">
      <input
        className="input focus-note"
        placeholder="Над чем вы работаете?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={160}
      />

      <div className="focus-durations">
        {DURATIONS.map((d, i) => (
          <button
            key={d.label}
            className={`focus-chip${i === duration ? ' active' : ''}`}
            onClick={() => setDuration(i)}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="focus-templates">
        {TEMPLATES.map((t) => (
          <button key={t.kind} className="focus-template" disabled={busy} onClick={() => (t.kind === 'deep' ? (onDeep ? onDeep() : setDeepOpen(true)) : set(t.kind, t.note))}>
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
      </div>

      <div className="focus-templates">
        {MANUAL.map((m) => (
          <button key={m.key} className="focus-template" disabled={busy} onClick={() => void manual(m.key)}>
            <Icon name={m.icon} size={15} /> {m.label}
          </button>
        ))}
      </div>

      {deepOpen && <FocusDialog onClose={() => setDeepOpen(false)} onSaved={() => setDeepOpen(false)} />}
      {focus && (
        <button className="focus-clear" disabled={busy} onClick={clear}>
          <Icon name="close" size={14} /> Снять фокус
        </button>
      )}
    </div>
  );
}
