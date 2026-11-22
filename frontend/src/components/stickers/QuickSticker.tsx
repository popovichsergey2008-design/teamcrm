import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { ApiError } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import {
  addDays, dayLabel, nextWeekday, STICKER_COLORS, stickersApi, stickersChanged, ymd,
  type StickerColor,
} from '../../lib/stickers-api';
import './stickers.css';

type DateChoice = 'today' | 'tomorrow' | 'fri' | 'pick' | 'none';

/**
 * Быстрое окно «＋ Стикер» (#4997, шаги 1.1–1.3). Жёлтый листок поверх страницы, страницу
 * не уводит. Enter — сохранить, Esc — закрыть, Alt+N — открыть с любого экрана.
 * Дата из текста подхватывается сама, пока человек печатает; щелчок по кнопке даты главнее.
 */
export function QuickSticker({ prefill, onClose }: { prefill: { text?: string; sourceRef?: Record<string, unknown>; source?: string }; onClose: () => void }) {
  const today = ymd(new Date());
  const [text, setText] = useState(prefill.text ?? '');
  const [choice, setChoice] = useState<DateChoice>('today');
  const [picked, setPicked] = useState(today);
  const [time, setTime] = useState<string | null>(null);
  const [color, setColor] = useState<StickerColor>('yellow');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const touchedDate = useRef(false);
  const touchedColor = useRef(false);
  const usedVoice = useRef(false);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const voice = useVoiceInput((t) => { usedVoice.current = true; setText((v) => (v.trim() ? `${v.trim()} ${t}` : t)); });

  useEffect(() => { ta.current?.focus(); }, []);
  const fri = nextWeekday(today, 5);

  // дата и время из текста — пока печатает (шаг 1.2), с задержкой, чтобы не дёргать сервер на каждую букву
  useEffect(() => {
    if (!text.trim()) { setHint(''); setTime(null); return; }
    const t = window.setTimeout(() => {
      stickersApi.parse(text).then((r) => {
        setTime(r.time);
        if (!touchedColor.current) setColor(r.color);
        if (!r.date) { setHint(''); return; }
        setHint(r.label);
        if (touchedDate.current) return;
        if (r.date === today) setChoice('today');
        else if (r.date === addDays(today, 1)) setChoice('tomorrow');
        else if (r.date === fri) setChoice('fri');
        else { setChoice('pick'); setPicked(r.date); }
      }).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(t);
  }, [text, today, fri]);

  const dateOf = (c: DateChoice): string | null => (
    c === 'today' ? today : c === 'tomorrow' ? addDays(today, 1) : c === 'fri' ? fri : c === 'pick' ? picked : null
  );

  const save = useCallback(async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr('');
    try {
      const date = dateOf(choice);
      const s = await stickersApi.create({
        text: text.trim(), date, time: date ? time : null, color,
        source: prefill.source ?? (usedVoice.current ? 'voice' : 'manual'), sourceRef: prefill.sourceRef,
      });
      stickersChanged();
      toastSaved('📌 Стикер приклеен', s.date ? `${dayLabel(s.date)}${s.time ? ` · ${s.time}` : ''}` : 'в «Идеи без даты»');
      onClose();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось сохранить'); }
    finally { setBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, busy, choice, picked, time, color, prefill]);

  const pick = (c: DateChoice) => { touchedDate.current = true; setChoice(c); };
  const chip = (c: DateChoice, label: React.ReactNode, title?: string) => (
    <button type="button" className={`qs-chip${choice === c ? ' is-on' : ''}`} aria-pressed={choice === c} onClick={() => pick(c)} title={title}>{label}</button>
  );

  return (
    <div className="qs-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`qs-card st-${color}`} role="dialog" aria-label="Новый стикер"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          if (e.key === 'Enter' && !e.shiftKey && !(e.target as HTMLElement).closest('input[type=date]')) { e.preventDefault(); void save(); }
        }}>
        <div className="qs-kicker"><Icon name="plus" size={13} /> Стикер</div>
        <textarea ref={ta} className="qs-text" rows={2} value={text} placeholder="Что не забыть?" maxLength={6000}
          onChange={(e) => setText(e.target.value)} aria-label="Текст стикера" />
        {hint && <div className="qs-hint"><Icon name="calendar" size={13} /> {hint}</div>}
        <div className="qs-row">
          {chip('today', 'Сегодня')}
          {chip('tomorrow', 'Завтра')}
          {chip('fri', 'Пт', dayLabel(fri))}
          <label className={`qs-chip qs-pick${choice === 'pick' ? ' is-on' : ''}`} title="Выбрать дату">
            <Icon name="calendar" size={14} />
            {choice === 'pick' && <span>{dayLabel(picked)}</span>}
            <input type="date" value={picked} min={today} onChange={(e) => { if (e.target.value) { setPicked(e.target.value); pick('pick'); } }} aria-label="Выбрать дату" />
          </label>
          {chip('none', 'Без даты')}
          {time && choice !== 'none' && (
            <span className="qs-time" title="Время из текста — напомню в этот час">
              <Icon name="clock" size={13} /> {time}
              <button type="button" className="qs-x" onClick={() => setTime(null)} aria-label="Без времени"><Icon name="close" size={11} /></button>
            </span>
          )}
        </div>
        <div className="qs-row qs-bottom">
          <span className="qs-colors" role="radiogroup" aria-label="Цвет">
            {STICKER_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} className={`qs-dot st-${c}${color === c ? ' is-on' : ''}`}
                onClick={() => { touchedColor.current = true; setColor(c); }} aria-label={`Цвет: ${c}`} />
            ))}
          </span>
          <button type="button" className={`qs-mic${voice.recording ? ' is-rec' : ''}`} onClick={voice.toggle} disabled={voice.transcribing}
            title={voice.recording ? 'Стоп' : 'Наговорить'} aria-label={voice.recording ? 'Остановить запись' : 'Наговорить'}>
            <Icon name={voice.recording ? 'stop' : 'mic'} size={16} />
          </button>
        </div>
        {(err || voice.error) && (
          <div className="qs-err" role="alert" style={{ display: 'flex', gap: 8 }}>
            <span style={{ flex: 1 }}>{err || voice.error}</span>
            <button type="button" aria-label="Закрыть" onClick={() => { setErr(''); voice.clearError(); }} style={{ border: 0, background: 'transparent', color: 'inherit', fontSize: 18, lineHeight: 1, cursor: 'pointer' }}>×</button>
          </div>
        )}
        {voice.transcribing && <div className="qs-hint">Распознаю…</div>}
        <div className="qs-foot">
          <kbd>Enter</kbd> сохранить · <kbd>Esc</kbd> закрыть · <kbd>Alt+N</kbd> с любого экрана
          <button type="button" className="qs-save" onClick={() => void save()} disabled={busy || !text.trim()}>{busy ? '…' : 'Сохранить'}</button>
        </div>
      </div>
    </div>
  );
}
