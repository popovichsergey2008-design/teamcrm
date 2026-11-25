import { useEffect, useState } from 'react';
import { Dialog } from '../ui/dialog';
import { ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import { botApi, StartCard, StartScreen } from './bot-api';
import { buildPrompt, Scenario } from './bot-catalog';
import { SERVICE_COUNT } from './bot-services';
import './bot-start.css';

export interface BotStartProps {
  /** Новая просьба боту (сценарий или кнопка карточки). */
  onPrompt: (text: string) => void;
  /** Заготовка в строку ввода. */
  onFill: (text: string) => void;
  /** Включить микрофон строки ввода. */
  onVoice: () => void;
  /** Нужна почта: карточка подключения, после — исходная просьба. */
  onConnectMail: (resume?: string) => void;
}

/**
 * Стартовый экран QEVO-бота (#5035, п. 4): приветствие и строка о безопасности, до 3
 * карточек по данным человека (у каждой одна кнопка), 4 примера вопросов чипами —
 * нажатие подставляет текст в строку, не отправляет — и ссылка «Все услуги бота».
 * Чипы направлений, автопилоты и «Бот за неделю» переехали во вкладки.
 * На телефоне — 2 карточки и 2 примера (п. 9).
 */
const EXAMPLES: { label: string; fill?: string; voice?: boolean }[] = [
  { label: 'Что я пропустил в чатах?', fill: 'Что я пропустил в чатах?' },
  { label: 'Что решили про…?', fill: 'Что решили про ' },
  { label: 'Найди свободный час с…', fill: 'Найди свободный час с ' },
  { label: 'Поставь задачу голосом', voice: true },
];

export default function BotStart(p: BotStartProps & { name?: string | null; onAllServices: () => void; compact?: boolean }) {
  const [screen, setScreen] = useState<StartScreen | null>(null);
  useEffect(() => {
    void botApi.start().then(setScreen)
      .catch(() => setScreen({ cards: [], example: '', web: false, tz: null, connections: { mail: false, calendar: false, telegram: false } }));
  }, []);

  const onCard = (c: StartCard) => {
    const a = c.action;
    if (a.kind === 'prompt') p.onPrompt(a.prompt);
    else if (a.kind === 'review') {
      try { sessionStorage.setItem('teamcrm.focusReview', '1'); } catch { /* без флага — просто Фокус */ }
      navigate({ section: 'focus' });
    } else if (a.kind === 'voice') p.onVoice();
    else if (a.kind === 'link') navigate(a.href);
    else if (a.kind === 'connect') { if (a.source === 'mail') p.onConnectMail(); else navigate({ section: 'calendar' }); }
  };
  const h = new Date().getHours();
  const hello = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const first = (p.name ?? '').trim().split(' ')[0];
  const cards = (screen?.cards ?? []).slice(0, p.compact ? 2 : 3);
  // пример на данных человека («Что решили про „QEVO“ в ноябре?») — вместо общего второго
  const examples = screen?.example ? [EXAMPLES[0], { label: screen.example, fill: screen.example }, ...EXAMPLES.slice(2)] : EXAMPLES;
  const shown = p.compact ? [examples[0], examples[3]] : examples;

  return (
    <div className="bv-start" aria-label="Новый разговор">
      <h2 className="bv-hello">{p.compact ? 'Что сделать?' : `${hello}${first ? `, ${first}` : ''}. Что сделать?`}</h2>
      {!p.compact && <p className="bv-sub">Бот видит только ваши задачи, чаты и встречи. Всё, что касается коллег, — только после вашего «да».</p>}
      {screen === null ? (
        <div className="bv-cards"><div className="bv-start-card bv-skel" /><div className="bv-start-card bv-skel" /></div>
      ) : cards.length > 0 && (
        <div className="bv-cards">
          {cards.map((c) => (
            <div key={c.id} className="bv-start-card">
              <div className="bv-start-card-text">{c.text}</div>
              <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => onCard(c)}>{c.button}</button>
            </div>
          ))}
        </div>
      )}
      {!p.compact && <div className="bv-examples-label">Или спросите, например:</div>}
      <div className="bv-examples">
        {shown.map((e) => (
          <button key={e.label} type="button" className="bv-example" onClick={() => (e.voice ? p.onVoice() : p.onFill(e.fill ?? e.label))}>{e.label}</button>
        ))}
      </div>
      <button type="button" className="bv-all" onClick={p.onAllServices}>Все услуги бота{p.compact ? '' : ` — ${SERVICE_COUNT} штук`} →</button>
    </div>
  );
}

const defaults = (s: Scenario) => Object.fromEntries((s.params ?? []).map((x) => [x.key, x.def ?? (x.options ? x.options[0] : '')]));

/**
 * Предпросмотр (п. 3): клик по сценарию не отправляет запрос сразу — параметры чипами с
 * умными значениями, «Запустить»; для регулярного — время с поясом, первый выпуск, куда
 * придёт, что внутри, «Показать пример» и «Включить». Без «Включить» регулярная задача
 * не создаётся.
 */
function Preview({ scenario: s, onRun, onFill, onClose }: {
  scenario: Scenario; onRun: (text: string) => void; onFill: (text: string) => void; onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => defaults(s));
  const [editText, setEditText] = useState<string | null>(null);
  const [phrase, setPhrase] = useState(s.schedule?.phrase ?? '');
  const [sched, setSched] = useState<{ label: string; firstRun: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const text = buildPrompt(s, values);
  const missing = (s.params ?? []).some((x) => x.text !== undefined && x.def === undefined && !values[x.key]?.trim());
  useEffect(() => {
    if (!s.schedule || !phrase.trim()) return;
    const t = window.setTimeout(() => { void botApi.schedulePreview(phrase).then(setSched).catch(() => setSched(null)); }, 300);
    return () => window.clearTimeout(t);
  }, [phrase, s.schedule]);
  const enable = async () => {
    setBusy(true);
    try {
      await botApi.addSchedule({ title: s.schedule!.title, instruction: text, schedule: phrase });
      void botApi.ran(s.id).catch(() => undefined);
      toastSaved('Включено', `${sched?.label ?? phrase} · первый выпуск ${sched?.firstRun ?? ''}`);
      window.dispatchEvent(new Event('teamcrm:bot-schedules'));
      onClose();
    } catch (e) { toastSaved('Не получилось', e instanceof ApiError ? e.message : ''); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title={s.label}>
      <div className="bs-prev">
        {(s.params ?? []).map((x) => (
          <div key={x.key} className="bs-param">
            <span className="dim">{x.label}</span>
            {x.options ? (
              <span className="bs-opts">
                {x.options.map((o) => (
                  <button key={o} type="button" className={`bs-chip${values[x.key] === o ? ' on' : ''}`} aria-pressed={values[x.key] === o} onClick={() => setValues((v) => ({ ...v, [x.key]: o }))}>{o}</button>
                ))}
              </span>
            ) : (
              <input className="input" value={values[x.key] ?? ''} placeholder={x.text} onChange={(e) => setValues((v) => ({ ...v, [x.key]: e.target.value }))} aria-label={x.label} />
            )}
          </div>
        ))}
        {s.schedule && (
          <div className="bs-sched">
            <div className="bs-param"><span className="dim">Когда</span>
              <input className="input" value={phrase} onChange={(e) => setPhrase(e.target.value)} aria-label="Расписание" /></div>
            <div className="bs-sched-info">
              <div><span className="dim">Расписание:</span> {sched?.label ?? '…'}</div>
              <div><span className="dim">Первый выпуск:</span> {sched?.firstRun ?? '…'}</div>
              <div><span className="dim">Куда придёт:</span> чат «Заметки» и Telegram, если он привязан</div>
              <div><span className="dim">Что внутри:</span> {text}</div>
            </div>
          </div>
        )}
        {editText !== null ? (
          <textarea className="input" rows={3} value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Текст запроса" />
        ) : null}
        <div className="bs-acts">
          {s.schedule ? (
            <>
              <button type="button" className="ui-btn ui-btn-primary ui-btn-md" disabled={busy || !sched || missing} onClick={() => void enable()}>Включить</button>
              <button type="button" className="ui-btn ui-btn-outline ui-btn-md" disabled={missing} onClick={() => onRun(editText ?? text)}>Показать пример</button>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" onClick={onClose}>Отмена</button>
            </>
          ) : (
            <>
              <button type="button" className="ui-btn ui-btn-primary ui-btn-md" disabled={missing && editText === null} onClick={() => onRun(editText ?? text)}>{s.run ?? 'Запустить'}</button>
              {editText === null
                ? <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => setEditText(text)}>Изменить текст запроса</button>
                : <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => onFill(editText)}>В строку ввода</button>}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** «Присылать это каждый будний день в 9:00?» под ответом (п. 7) — тот же предпросмотр с «Включить». */
export function ScheduleFromAnswer({ ask, onClose, onRun }: {
  ask: { title: string; instruction: string; phrase: string }; onClose: () => void; onRun: (text: string) => void;
}) {
  const s: Scenario = { id: 'answer-schedule', label: 'Присылать регулярно', prompt: ask.instruction, schedule: { phrase: ask.phrase, title: ask.title } };
  return <Preview scenario={s} onClose={onClose} onRun={onRun} onFill={onRun} />;
}
