import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { ApiError } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { navigate } from '../../lib/router';
import { calApi, dayLabel, hhmm, PhrasePreview } from './cal-api';

const REPEAT: Record<string, string> = {
  daily: 'каждый день', weekdays: 'по будням', weekly: 'каждую неделю', biweekly: 'раз в две недели', monthly: 'каждый месяц',
};

/**
 * Событие одной фразой или голосом (#4892, п. 3): «завтра в 15 созвон с Глебом и
 * Константином про CRM, 30 мин». Предпросмотр сразу под полем: когда и свободны ли все
 * (а если нет — какое время ближе), участники, ссылка на звонок, повестка из задач.
 * Ничего не создаётся без «Создать и пригласить».
 */
export function PhraseBar({ onCreated, onEdit }: {
  onCreated: () => void;
  /** «Изменить» — открыть обычную форму с тем же черновиком. */
  onEdit: (draft: { title: string; startsAt: string; endsAt: string; participantIds: string[]; description: string; allDay: boolean }) => void;
}) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PhrasePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [useSuggestion, setUseSuggestion] = useState(false);
  const [showAgenda, setShowAgenda] = useState(false);
  const seq = useRef(0);

  // предпросмотр — по паузе в наборе, а не на каждую букву
  useEffect(() => {
    const t = text.trim();
    if (t.length < 6) { setPreview(null); setErr(''); return; }
    const my = ++seq.current;
    const timer = window.setTimeout(() => {
      calApi.phrase(t).then((p) => { if (my === seq.current) { setPreview(p); setErr(''); setUseSuggestion(false); } })
        .catch((e) => { if (my === seq.current) setErr(e instanceof ApiError ? e.message : 'Не удалось разобрать'); });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [text]);

  const voice = useVoiceInput(async (heard) => { setText(heard); });

  const when = preview && (useSuggestion && preview.suggestion ? preview.suggestion : preview.startsAt ? { startsAt: preview.startsAt, endsAt: preview.endsAt! } : null);

  const create = async () => {
    if (!preview || !when) return;
    setBusy(true); setErr('');
    try {
      await calApi.create({
        title: preview.title, startsAt: when.startsAt, endsAt: when.endsAt, allDay: preview.allDay, location: preview.location,
        participantIds: preview.people.map((p) => p.id), repeat: preview.repeat, via: 'phrase',
        agendaTaskIds: preview.agenda.slice(0, 5).map((a) => a.id),
      });
      toastSaved(preview.people.length ? 'Встреча создана, приглашения отправлены' : 'Событие создано', preview.title);
      setText(''); setPreview(null);
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать');
    } finally { setBusy(false); }
  };

  const edit = () => {
    if (!preview) return;
    const s = when?.startsAt ?? new Date(Date.now() + 3600_000).toISOString();
    const e = when?.endsAt ?? new Date(Date.parse(s) + 3600_000).toISOString();
    onEdit({
      title: preview.title, startsAt: s, endsAt: e, allDay: preview.allDay, participantIds: preview.people.map((p) => p.id),
      description: preview.agenda.length ? preview.agenda.map((a, i) => `${i + 1}. ${a.title} — #${a.id}`).join('\n') : '',
    });
    setText(''); setPreview(null);
  };

  return (
    <div className="cal-phrase">
      <div className={`cal-phrase-field${preview ? ' open' : ''}`}>
        <Icon name="plus" size={16} />
        <input
          className="cal-phrase-input"
          value={text}
          placeholder="Опишите событие: «завтра в 15 созвон с Глебом про CRM, 30 мин»…"
          aria-label="Опишите событие"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && preview && when && !busy) { e.preventDefault(); void create(); }
            if (e.key === 'Escape') { setText(''); setPreview(null); }
          }}
        />
        <button type="button" className={`cal-phrase-mic${voice.recording ? ' on' : ''}`} onClick={voice.toggle} disabled={voice.transcribing}
          title={voice.recording ? 'Остановить запись' : 'Продиктовать встречу голосом'} aria-label={voice.recording ? 'Остановить запись' : 'Продиктовать встречу голосом'}>
          <Icon name={voice.transcribing ? 'clock' : 'mic'} size={15} />
        </button>
      </div>
      {(text.trim().length > 0 && !preview && !err) && <div className="cal-phrase-hint dim"><Icon name="mic" size={12} /> можно голосом · Enter — создать</div>}
      {voice.error && <div className="cal-phrase-err">{voice.error}</div>}
      {err && <div className="cal-phrase-err">{err}</div>}
      {preview && (
        <div className="cal-phrase-card">
          <div className="cal-phrase-title">{preview.title}</div>
          <div className="cal-phrase-row">
            <span className="dim">Когда</span>
            <span>
              {when ? <>{dayLabel(when.startsAt)} · {preview.allDay ? 'весь день' : `${hhmm(when.startsAt)}–${hhmm(when.endsAt)}`}</> : <span className="dim">время не названо — нажмите «Изменить»</span>}
              {preview.repeat && <span className="cal-pill"> {REPEAT[preview.repeat] ?? preview.repeat}</span>}
              {when && !useSuggestion && preview.allFree && <span className="cal-pill ok">{preview.people.length ? 'все свободны' : 'вы свободны'}</span>}
              {when && useSuggestion && <span className="cal-pill ok">все свободны</span>}
              {!useSuggestion && preview.busy.length > 0 && (
                <span className="cal-pill warn">
                  {preview.busy.join(', ')} занято
                  {preview.suggestion && <> → <button type="button" className="cal-link" onClick={() => setUseSuggestion(true)}>предложить {preview.suggestion.label}</button></>}
                </span>
              )}
            </span>
          </div>
          <div className="cal-phrase-row">
            <span className="dim">Участники</span>
            <span>{preview.people.length ? [...preview.people.map((p) => p.name.split(' ')[0]), 'вы'].join(' · ') : 'только вы'}</span>
          </div>
          {preview.call && (
            <div className="cal-phrase-row"><span className="dim">Звонок</span><span>ссылка QEVO создастся автоматически</span></div>
          )}
          <div className="cal-phrase-row">
            <span className="dim">Повестка</span>
            <span>
              {preview.agenda.length ? (
                <>{preview.agenda.length} {preview.agenda.length === 1 ? 'открытая задача' : 'открытые задачи'}{preview.topic ? ` по ${preview.topic}` : ''} · <button type="button" className="cal-link" onClick={() => setShowAgenda((v) => !v)}>{showAgenda ? 'скрыть' : 'посмотреть'}</button></>
              ) : <span className="dim">задач по теме нет — повестку можно собрать в карточке встречи</span>}
            </span>
          </div>
          {showAgenda && preview.agenda.length > 0 && (
            <ol className="cal-phrase-agenda">
              {preview.agenda.map((a) => (
                <li key={a.id}>
                  <button type="button" className="cal-link" onClick={() => navigate({ section: 'projects', projectId: a.projectId, taskId: a.id })}>#{a.id}</button> {a.title}
                  {a.overdueDays ? <span className="cal-overdue"> · просрочено {a.overdueDays} дн.</span> : null}
                </li>
              ))}
            </ol>
          )}
          <div className="cal-phrase-actions">
            <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void create()} disabled={busy || !when}>
              {busy ? 'Создаю…' : preview.people.length ? 'Создать и пригласить' : 'Создать'}
            </button>
            <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={edit}>Изменить</button>
          </div>
        </div>
      )}
    </div>
  );
}
