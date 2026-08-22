import { useState } from 'react';
import { Icon, IconName } from './Icon';
import { api } from '../lib/api';
import type { Focus } from '../types';

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

export const FOCUS_LABEL: Record<Focus['kind'], string> = {
  deep: 'Глубокий фокус',
  call: 'На созвоне',
  quick: 'Быстрые ответы',
  break: 'Перерыв',
  task: 'В работе',
};

/** Строка под именем в панели: что человек делает и до какого времени. */
export function focusLine(focus: Focus | null): string {
  if (!focus) return 'Фокус не задан';
  const what = focus.note?.trim() || FOCUS_LABEL[focus.kind];
  if (!focus.until) return what;
  const till = new Date(focus.until);
  const hh = String(till.getHours()).padStart(2, '0');
  const mm = String(till.getMinutes()).padStart(2, '0');
  return `${what} до ${hh}:${mm}`;
}

export function FocusMenu({ focus, onChange }: {
  focus: Focus | null;
  onChange: (focus: Focus | null) => void;
}) {
  const [note, setNote] = useState(focus?.note ?? '');
  const [duration, setDuration] = useState(1); // «1 час» — самый частый ответ
  const [busy, setBusy] = useState(false);

  const set = async (kind: Focus['kind'], preset?: string) => {
    setBusy(true);
    try {
      onChange(await api.setFocus({
        kind,
        note: (note.trim() || preset || '').slice(0, 160) || undefined,
        minutes: DURATIONS[duration].minutes(),
      }));
    } catch { /* панель не место для разбора ошибок сети */ }
    finally { setBusy(false); }
  };

  const clear = async () => {
    setBusy(true);
    try { await api.clearFocus(); onChange(null); }
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
          <button key={t.kind} className="focus-template" disabled={busy} onClick={() => set(t.kind, t.note)}>
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
      </div>

      {focus && (
        <button className="focus-clear" disabled={busy} onClick={clear}>
          <Icon name="close" size={14} /> Снять фокус
        </button>
      )}
    </div>
  );
}
