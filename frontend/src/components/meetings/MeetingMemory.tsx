import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { ApiError, request } from '../../lib/api';
import { navigate } from '../../lib/router';
import './meeting-memory.css';

type Bucket = 'done' | 'review' | 'in_progress' | 'not_started';
interface PrevCard {
  found: true;
  meeting: { id: string; title: string | null; at: string; reason: string; reasonText: string };
  counts: Record<Bucket, number> & { total: number };
  tasks: { id: string; title: string; assignee: string | null; bucket: Bucket }[];
}
interface RecapPoint { sec: number | null; stamp: string | null; at: string; speaker: string | null; text: string }
interface Recap {
  status: 'ok' | 'no_recording' | 'no_stt' | 'empty' | 'error';
  source?: 'model' | 'rules' | 'chat' | 'empty';
  points: RecapPoint[];
  heardSec?: number;
  note: string | null;
}

const BUCKET: Record<Bucket, string> = { done: 'готово', review: 'на проверке', in_progress: 'в работе', not_started: 'не начато' };
const SOURCE: Record<string, string> = {
  model: 'ИИ по записи', rules: 'по ключевым репликам записи (без модели)', chat: 'по сообщениям чата звонка',
};
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * #4902, п. 12: «Встреча помнит прошлую и пересказывает опоздавшим».
 *
 * Карточка прошлой встречи (та же встреча, чат, тема или состав): сколько её задач
 * готово, на проверке, не начато — сразу после входа, запрос один и лёгкий.
 * «Кратко до сих пор» — пересказ на 15 секунд с метками записи; запрос идёт сокетом
 * созвона (запись живёт в процессе звонка), ответ приходит событием meet:recap-so-far.
 */
export default function MeetingMemory({ meetingId, recording, ask }: { meetingId: string; recording: boolean; ask: () => void }) {
  const [card, setCard] = useState<PrevCard | null>(null);
  const [hidden, setHidden] = useState(false);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [busy, setBusy] = useState(false);
  const [momentNote, setMomentNote] = useState('');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let tries = 0;
    let t: number | undefined;
    const load = () => {
      request<PrevCard | { found: false; pending?: boolean }>('GET', `/meeting-memory/previous?room=${encodeURIComponent(meetingId)}`)
        .then((r) => {
          if (!alive) return;
          if (r.found) setCard(r);
          // журнал звонка пишется при входе фоном — повторим через секунду
          else if (r.pending && tries++ < 2) t = window.setTimeout(load, 1200);
        })
        .catch(() => undefined);
    };
    load();
    return () => { alive = false; window.clearTimeout(t); };
  }, [meetingId]);

  useEffect(() => {
    const on = (e: Event) => {
      const p = (e as CustomEvent).detail as Recap & { meeting_id?: string };
      if (p?.meeting_id && p.meeting_id !== meetingId) return;
      window.clearTimeout(timer.current);
      setBusy(false);
      setRecap({ ...p, points: Array.isArray(p.points) ? p.points : [] });
    };
    window.addEventListener('meet:recap-so-far', on);
    return () => { window.removeEventListener('meet:recap-so-far', on); window.clearTimeout(timer.current); };
  }, [meetingId]);

  const askRecap = () => {
    setBusy(true);
    setMomentNote('');
    ask();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setBusy(false);
      setRecap({ status: 'error', points: [], note: 'Не дождались пересказа — попробуйте ещё раз.' });
    }, 60_000);
  };

  const openMoment = async (sec: number) => {
    try {
      const r = await request<{ ready: boolean; url: string | null }>('GET', `/meeting-memory/moment?room=${encodeURIComponent(meetingId)}&t=${sec}`);
      if (r.ready && r.url) navigate(r.url);
      else setMomentNote('Момент записи откроется после звонка, когда запись будет разобрана: метка останется в «Встречах».');
    } catch (e) {
      setMomentNote(e instanceof ApiError ? e.message : 'Не удалось открыть момент записи');
    }
  };

  const c = card?.counts;
  return (
    <div className="mmem">
      {card && !hidden && c && (
        <div className="mmem-card" role="status">
          <div className="mmem-head">
            <Icon name="clock" size={15} />
            <b>С прошлой встречи</b>
            <span className="mmem-dim">· {card.meeting.reasonText} · {day(card.meeting.at)}{card.meeting.title ? ` · ${card.meeting.title}` : ''}</span>
            <button type="button" className="msg-act mmem-close" onClick={() => setHidden(true)} title="Скрыть" aria-label="Скрыть карточку прошлой встречи">
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="mmem-counts">
            <span className="mmem-n is-done">Готово: <b>{c.done}</b></span>
            <span className="mmem-n is-review">На проверке: <b>{c.review}</b></span>
            {c.in_progress > 0 && <span className="mmem-n">В работе: <b>{c.in_progress}</b></span>}
            <span className="mmem-n is-idle">Не начато: <b>{c.not_started}</b></span>
            <span className="mmem-dim">из {c.total}</span>
          </div>
          <ul className="mmem-tasks">
            {card.tasks.slice(0, 5).map((t) => (
              <li key={t.id} className={`mmem-task is-${t.bucket}`}>
                <span className="mmem-task-title">{t.title}</span>
                <span className="mmem-dim">{t.assignee ? `${t.assignee} · ` : ''}{BUCKET[t.bucket]}</span>
              </li>
            ))}
            {card.counts.total > 5 && <li className="mmem-dim">и ещё {card.counts.total - 5}</li>}
          </ul>
        </div>
      )}

      <div className="mmem-bar">
        <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={askRecap} disabled={busy}
          title={recording ? 'Пересказ того, что уже обсудили, — за 15 секунд' : 'Запись не идёт: пересказ будет по сообщениям чата'}>
          <Icon name="sparkles" size={15} /> {busy ? 'Пересказываю…' : 'Кратко до сих пор'}
        </button>
        {recap && <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setRecap(null)}>Скрыть</button>}
      </div>

      {recap && (
        <div className="mmem-recap" role="status">
          {recap.points.length > 0 && (
            <ol className="mmem-points">
              {recap.points.map((p, i) => (
                <li key={i}>
                  {p.sec != null ? (
                    <button type="button" className="mmem-stamp" onClick={() => void openMoment(p.sec!)}
                      title={`Момент записи ${p.stamp} (${clock(p.at)})`}>
                      <Icon name="play" size={12} /> {p.stamp}
                    </button>
                  ) : <span className="mmem-stamp is-plain">{clock(p.at)}</span>}
                  {p.speaker && <b>{p.speaker}:</b>} {p.text}
                </li>
              ))}
            </ol>
          )}
          {recap.note && <div className="mmem-dim">{recap.note}</div>}
          {recap.source && SOURCE[recap.source] && recap.points.length > 0 && (
            <div className="mmem-dim">
              {SOURCE[recap.source]}{recap.heardSec ? ` · разобрано ${Math.max(1, Math.round(recap.heardSec / 60))} мин записи` : ''}
            </div>
          )}
          {momentNote && <div className="mmem-dim">{momentNote}</div>}
        </div>
      )}
    </div>
  );
}
