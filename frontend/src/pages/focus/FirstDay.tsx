import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import { focusApi, hm, PlusDay } from './focus-api';

type Rec = { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; start: () => void; stop: () => void };

/**
 * Первый день нового пользователя за 60 секунд (#4891, п. 11): рабочие часы → «Что главное
 * сегодня?» (текстом или голосом) → принять план. Фраза превращается в задачи с оценками и
 * раскладывается по дню. Календарь — по желанию, одной кнопкой. Пустого экрана нет.
 */
export function FirstDay({ day, onDone }: { day: PlusDay; onDone: (d: PlusDay) => void }) {
  const [step, setStep] = useState(1);
  const [ws, setWs] = useState(day.workStart || '09:00');
  const [we, setWe] = useState(day.workEnd || '18:00');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [listening, setListening] = useState<Rec | null>(null);
  const [proposal, setProposal] = useState<{ taskId: string; title: string; startsAt: string; endsAt: string }[]>([]);
  const Speech = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;
  const voice = () => {
    if (listening) { listening.stop(); return; }
    if (!Speech) return;
    const r = new Speech();
    r.lang = 'ru-RU'; r.interimResults = false;
    r.onresult = (e) => setText((t) => `${t}${t ? ' ' : ''}${Array.from(e.results).map((x) => x[0].transcript).join(' ')}`);
    r.onend = () => setListening(null);
    r.start(); setListening(r);
  };
  const make = async () => {
    setBusy(true); setErr('');
    try {
      const r = await focusApi.firstDay({ workStart: ws, workEnd: we, text });
      setProposal(r.proposal);
      onDone(r.day);
      setStep(3);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };
  const accept = async () => {
    setBusy(true); setErr('');
    try { onDone(await focusApi.firstDayAccept(proposal)); toastSaved('План принят', 'задачи стоят в календаре'); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };
  return (
    <section className="fp-card fp-first" aria-label="Первый день">
      <div className="fp-head"><b>Соберём ваш первый день — меньше минуты</b><span className="dim fp-small">шаг {step} из 3</span></div>
      {step === 1 && (
        <>
          <div>Когда вы обычно работаете?</div>
          <div className="fp-acts">
            <input className="input fp-time" type="time" value={ws} onChange={(e) => setWs(e.target.value)} aria-label="Начало рабочего дня" /> —
            <input className="input fp-time" type="time" value={we} onChange={(e) => setWe(e.target.value)} aria-label="Конец рабочего дня" />
            <button type="button" className="ui-btn ui-btn-primary" disabled={!ws || !we || ws >= we} onClick={() => setStep(2)}>Дальше</button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <div>Что главное сегодня?</div>
          <textarea className="input" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Например: дописать отчёт для клиента, потом созвон с Иваном и проверить макет" aria-label="Что главное сегодня" />
          <div className="fp-acts">
            <button type="button" className="ui-btn ui-btn-primary" disabled={busy || text.trim().length < 3} onClick={() => void make()}>{busy ? 'Раскладываю…' : 'Разложить по дню'}</button>
            {Speech && <button type="button" className="ui-btn ui-btn-outline" aria-pressed={!!listening} onClick={voice}><Icon name="mic" size={14} /> {listening ? 'Стоп' : 'Голосом'}</button>}
            <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setStep(1)}>Назад</button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <div>Вот ваш день:</div>
          {proposal.length
            ? proposal.map((p) => <div key={p.taskId} className="fp-tl-row"><span className="fp-tl-time dim">{hm(p.startsAt)}</span><span className="fp-tl-slot task"><b>{p.title}</b></span></div>)
            : <div className="dim fp-small">Задачи созданы; свободных окон сегодня не нашлось — они в тройке дня.</div>}
          <div className="fp-acts">
            <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={() => void accept()}>Принять план</button>
            <button type="button" className="ui-btn ui-btn-ghost" onClick={() => navigate({ section: 'calendar' })}><Icon name="calendar" size={14} /> Подключить Google- или Яндекс-календарь</button>
          </div>
        </>
      )}
      {err && <div className="tv2-callout tv2-callout-danger" role="alert">{err}</div>}
    </section>
  );
}
