import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { Dialog } from '../ui/dialog';
import { ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import { botApi, StartCard, StartScreen } from './bot-api';
import { buildPrompt, CATALOG, Direction, dirStatus, needMet, Scenario, START_CHIPS, STATUS_LABEL } from './bot-catalog';
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
 * «Помощь и бот → Новый разговор» (#4893, п. 1): сверху — 3–4 карточки по данным
 * человека с одной кнопкой результата, пример вопроса на его данных, чипы ролей и
 * разделов; десять аккордеонов ушли в каталог «Все возможности» (п. 6).
 */
export default function BotStart(p: BotStartProps) {
  const [screen, setScreen] = useState<StartScreen | null>(null);
  const [catalog, setCatalog] = useState<string | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  useEffect(() => { void botApi.start().then(setScreen).catch(() => undefined); }, []);
  const conn = { mail: !!screen?.connections.mail, calendar: !!screen?.connections.calendar, web: !!screen?.web };

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

  const pick = (s: Scenario) => {
    setCatalog(null);
    if (s.action === 'voice') { p.onVoice(); return; }
    if (s.action === 'focus') { navigate({ section: 'focus' }); return; }
    if (s.action === 'focus-review') { try { sessionStorage.setItem('teamcrm.focusReview', '1'); } catch { /* */ } navigate({ section: 'focus' }); return; }
    if (s.action === 'pulse') { navigate({ section: 'radar' }); return; }
    if (s.action === 'fill') { p.onFill(s.prompt); return; }
    if (!needMet(s.needs, conn) && s.needs === 'mail') { p.onConnectMail(buildPrompt(s, defaults(s))); return; }
    setScenario(s);
  };

  return (
    <div className="bs" aria-label="Новый разговор">
      {screen === null ? <div className="bs-cards"><div className="bs-card bs-skel" /><div className="bs-card bs-skel" /></div> : (
        <div className="bs-cards">
          {screen.cards.map((c) => (
            <div key={c.id} className="bs-card">
              <div className="bs-card-text">{c.text}</div>
              <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => onCard(c)}>{c.button}</button>
            </div>
          ))}
        </div>
      )}
      {screen?.example && (
        <button type="button" className="bs-example" onClick={() => p.onFill(screen.example)}>
          <Icon name="sparkles" size={13} /> Например: «{screen.example}»
        </button>
      )}
      <div className="bs-chips" role="group" aria-label="Роли и разделы">
        {START_CHIPS.map((c) => (
          <button key={c.dir} type="button" className="bs-chip" onClick={() => setCatalog(c.dir)}>{c.label}</button>
        ))}
        <button type="button" className="bs-chip bs-chip-all" onClick={() => setCatalog('')}>Все возможности →</button>
      </div>
      {catalog !== null && <Catalog focus={catalog} conn={conn} onPick={pick} onClose={() => setCatalog(null)} />}
      {scenario && (
        <Preview scenario={scenario} onClose={() => setScenario(null)}
          onRun={(text) => { setScenario(null); void botApi.ran(scenario.id).catch(() => undefined); p.onPrompt(text); }}
          onFill={(text) => { setScenario(null); p.onFill(text); }} />
      )}
    </div>
  );
}

const defaults = (s: Scenario) => Object.fromEntries((s.params ?? []).map((x) => [x.key, x.def ?? (x.options ? x.options[0] : '')]));

/** «Все возможности» (п. 6): направления со статусом, поиск, популярное в компании. */
function Catalog({ focus, conn, onPick, onClose }: {
  focus: string; conn: { mail: boolean; calendar: boolean; web: boolean }; onPick: (s: Scenario) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(focus || null);
  const [popular, setPopular] = useState<{ id: string; n: number }[]>([]);
  useEffect(() => { void botApi.popular().then(setPopular).catch(() => undefined); }, []);
  const all = useMemo(() => CATALOG.flatMap((d) => d.items.map((s) => ({ d, s }))), []);
  const found = q.trim().length >= 2 ? all.filter(({ s, d }) => `${s.label} ${d.title}`.toLowerCase().includes(q.trim().toLowerCase())) : null;
  const pop = popular.map((x) => all.find((a) => a.s.id === x.id)).filter((x): x is { d: Direction; s: Scenario } => !!x);
  const row = ({ d, s }: { d: Direction; s: Scenario }) => {
    const ok = needMet(s.needs, conn);
    return (
      <button key={`${d.id}-${s.id}`} type="button" className="bs-scn" onClick={() => onPick(s)}>
        {s.wow && <Icon name="sparkles" size={12} />}
        <span className="bs-scn-label">{s.label}</span>
        {s.schedule && <span className="bs-badge">регулярно</span>}
        {!ok && <span className={`bs-badge ${s.needs === 'web' ? 'plan' : 'connect'}`}>{s.needs === 'mail' ? 'подключить почту' : s.needs === 'web' ? 'нужен интернет по тарифу' : 'подключить календарь'}</span>}
        <Icon name="arrow-right" size={13} />
      </button>
    );
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title="Все возможности бота">
      <div className="bs-cat">
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск: письма, встречи, отчёты…" aria-label="Поиск по возможностям" />
        {found ? (
          <div className="bs-scns">{found.length ? found.map(row) : <div className="dim">Ничего не нашлось — спросите бота своими словами.</div>}</div>
        ) : (
          <>
            {pop.length > 0 && (
              <section>
                <div className="bs-sub">Популярное в вашей компании</div>
                <div className="bs-scns">{pop.map(row)}</div>
              </section>
            )}
            {CATALOG.map((d) => {
              const st = dirStatus(d, conn);
              const on = open === d.id;
              return (
                <section key={d.id} className={`bs-dir${on ? ' is-open' : ''}`}>
                  <button type="button" className="bs-dir-head" aria-expanded={on} onClick={() => setOpen(on ? null : d.id)}>
                    <Icon name={d.icon} size={15} /> <span className="bs-dir-title">{d.title}</span>
                    <span className={`bs-status ${st}`}>{STATUS_LABEL[st]}</span>
                    <Icon name={on ? 'chevron-up' : 'chevron-down'} size={14} />
                  </button>
                  {on && <div className="bs-scns">{d.items.map((s) => row({ d, s }))}</div>}
                </section>
              );
            })}
          </>
        )}
      </div>
    </Dialog>
  );
}

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
