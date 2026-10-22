import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, request } from '../../lib/api';
import { useAuth } from '../../state/auth';
import { navigate, useRoute } from '../../lib/router';
import { forgetProject } from '../../lib/last-project';
import { askBot } from '../../lib/bot-ask';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { Icon } from '../Icon';
import { VoiceStatus } from '../VoiceStatus';
import { PROJECTS_CHANGED } from '../ProjectsNav';
import { nameSuggestions, phraseDeadline, phraseTitle, type Sphere } from './phrase';
import { Spot } from './Spot';

/**
 * Qevo-бот первого запуска (#4620, «Старт», пункт 2): три вопроса → первый проект →
 * показ, как ставится задача → ответы на вопросы. Реплики бота и кнопки — дословно
 * из документа; что сверх документа (ошибки, «нет прав»), сказано коротко и честно.
 *
 * Обучение (подсказки приложения) ждёт, пока идёт бот и создаётся первая задача, —
 * и включается, когда человек пошёл по разделам (пункт 3).
 */

type Step = 'q1' | 'q2' | 'q3' | 'creating' | 'created' | 'task' | 'adding' | 'card' | 'ask' | 'norights';
type Msg = { id: number; from: 'bot' | 'me'; text: ReactNode };
interface Starter { projectId: string; name: string; columns: { id: string; name: string }[]; taskIds: string[] }

const Q1 = 'Привет! Я Qevo-бот, твой личный проводник. Давай за 1 минуту соберем твой первый проект. Для чего ты планируешь использовать Qevo в первую очередь?';
const Q2 = 'Отлично! Как назовем твой первый проект или направление? Выбери из подсказок ниже, напиши или просто скажи голосом';
const Q3 = 'Супер! Ты будешь вести этот проект один или с командой? Выбери удобные этапы движения задач:';
const CREATED = 'Твой первый проект создан! Теперь самое главное — давай я за 10 секунд покажу, как в Qevo ставится задача.';
const HOW = 'В Qevo не нужно заполнять сложные поля. Напиши свою первую реальную задачу или просто зажми кнопку микрофона и скажи, например: "Подготовить план встречи завтра к 15:00" — я сам распознаю голос и поставлю срок!';
const ENGINEER = 'Позвать живого инженера (25 сек) или перенести старые задачи за меня';

const SPHERES: { key: Exclude<Sphere, 'custom'>; label: string }[] = [
  { key: 'business', label: 'Бизнес и команда' },
  { key: 'it', label: 'IT, продукт и маркетинг' },
  { key: 'services', label: 'Услуги, стройка, производство' },
  { key: 'personal', label: 'Личные дела и задачи' },
];
const SAY = 'Сказать голосом';
const SOLO = 'Пока работаю один';
const TEAM = 'Работаю с командой';
const ASK_INVITE = 'Как пригласить сотрудников в этот проект?';
const ASK_TG = 'Как ставить задачи через Telegram и ИИ-секретаря?';
const ASK_PROJECT = 'Как создать еще один проект или общую доску?';

const NARROW = '(max-width: 720px)';

export function GuideBot({ hidden, onEngineer, onClose }: {
  hidden: boolean; onEngineer: () => void; onClose: () => void;
}) {
  const { user } = useAuth();
  const route = useRoute();
  const [msgs, setMsgs] = useState<Msg[]>(() => [{ id: 1, from: 'bot', text: Q1 }]);
  const [step, setStep] = useState<Step>('q1');
  const [draft, setDraft] = useState('');
  const [spot, setSpot] = useState<'none' | 'task' | 'card' | 'project'>('none');
  const [phrase, setPhrase] = useState('');
  const [err, setErr] = useState('');
  /** Ушёл по разделам после первой задачи — бот сворачивается, подсказки включаются. */
  const [mini, setMini] = useState(false);
  const answers = useRef<{ sphere: Sphere; sphereText?: string; name: string }>({ sphere: 'custom', name: '' });
  const made = useRef<Starter | null>(null);
  const firstTask = useRef<string | null>(null);
  const askedAt = useRef<string | null>(null);
  const feed = useRef<HTMLDivElement | null>(null);
  const seq = useRef(1);

  const say = (from: Msg['from'], text: ReactNode) => setMsgs((m) => [...m, { id: ++seq.current, from, text }]);

  useEffect(() => { const el = feed.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, step]);

  // Путь: после первой задачи ушёл в другой раздел — сворачиваемся, обучение идёт своим чередом.
  const path = window.location.pathname;
  useEffect(() => {
    if (step !== 'ask' || spot !== 'none') return;
    if (askedAt.current == null) { askedAt.current = path; return; }
    if (path !== askedAt.current) setMini(true);
  }, [route, step, spot, path]);

  // ── голос: отвечает на текущий вопрос, в задаче — сама фраза ──
  const sink = useRef<(t: string) => void>(() => undefined);
  const voice = useVoiceInput((t) => sink.current(t));
  /** «Зажми кнопку микрофона»: держал — отпустил и запись ушла; коротко нажал — запись до второго нажатия. */
  const press = useRef<{ at: number; mine: boolean }>({ at: 0, mine: false });

  const answerSphere = async (sphere: Sphere | null, text: string) => {
    say('me', text);
    let s = sphere;
    if (!s) {
      s = await request<{ sphere: Sphere }>('POST', '/onboarding/starter/answer', { step: 'sphere', text })
        .then((r) => r.sphere).catch(() => 'custom' as Sphere);
      answers.current.sphereText = text;
    }
    answers.current.sphere = s;
    say('bot', Q2);
    setStep('q2');
  };

  const answerName = (text: string) => {
    const name = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) return;
    say('me', name);
    answers.current.name = name;
    say('bot', Q3);
    setStep('q3');
  };

  const answerTeam = async (team: boolean | null, text: string) => {
    say('me', text);
    let t = team;
    if (t === null) {
      t = await request<{ team: boolean | null }>('POST', '/onboarding/starter/answer', { step: 'team', text })
        .then((r) => r.team).catch(() => null);
    }
    if (t === null) { say('bot', 'Выбери кнопкой: один или с командой.'); return; }
    await create(t);
  };

  const create = async (team: boolean) => {
    setStep('creating'); setErr('');
    try {
      const r = await request<Starter>('POST', '/onboarding/starter', { ...answers.current, team });
      made.current = r;
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      say('bot', CREATED);
      setStep('created');
      // доска нового проекта — и сразу к строке создания задачи
      window.setTimeout(() => { navigate({ section: 'projects', projectId: r.projectId }); setStep('task'); setSpot('task'); }, 1600);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FORBIDDEN') {
        say('bot', 'Создавать проекты в этой компании вам пока нельзя — это делает руководитель. Позовите живого инженера: он всё настроит за вас.');
        setStep('norights');
      } else {
        setErr(e instanceof ApiError ? e.message : 'Не получилось создать проект — попробуйте ещё раз');
        setStep('q3');
      }
    }
  };

  /** Фраза → задача в первой колонке со сроком (разбор команды + час из фразы). */
  const addTask = async (text: string) => {
    const p = made.current;
    const said = text.trim();
    if (!p || said.length < 3 || step === 'adding') return;
    setStep('adding'); setErr('');
    try {
      const parsed = await api.nlParse(said, p.projectId, 'board').catch(() => null);
      const body = {
        projectId: p.projectId, columnId: p.columns[0]?.id,
        title: phraseTitle(parsed?.task?.title || said).slice(0, 255),
        deadlineAt: phraseDeadline(said, parsed?.task?.deadline ?? null, new Date()) ?? undefined,
        assigneeId: user ? String(user.id) : undefined,
      };
      const task = await api.createTask(body).catch((e) => {
        // компания требует подтверждать теги — первая задача без них, как «Без тегов»
        if (e instanceof ApiError && JSON.stringify(e.details ?? '').includes('TASK_TAGS_NOT_CONFIRMED')) {
          return api.createTask({ ...body, confirmedWithoutTags: true });
        }
        throw e;
      });
      firstTask.current = String(task.id);
      setPhrase('');
      setStep('card'); setSpot('card');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось поставить задачу — попробуйте ещё раз');
      setStep('task');
    }
  };

  const toAsk = () => {
    setSpot('none');
    setStep('ask');
    say('bot', 'Готово — первая задача стоит на доске со сроком. Спрашивай что угодно — голосом или текстом, а вот частые вопросы:');
  };

  // ── быстрые вопросы: настоящие действия, а не текст ──
  const canInvite = user?.role === 'owner' || user?.role === 'manager';
  const askInvite = async () => {
    say('me', ASK_INVITE);
    if (!canInvite) {
      say('bot', 'Приглашать сотрудников может владелец или руководитель компании — попросите его, или позовите живого инженера.');
      return;
    }
    try {
      const r = await api.createInviteLink({ role: 'member' });
      const link = `${window.location.origin}/?join=${r.token}`;
      let copied = false;
      try { await navigator.clipboard.writeText(link); copied = true; } catch { /* без доступа к буферу — ссылка на экране */ }
      say('bot', (
        <>
          {copied ? 'Ссылка-приглашение готова и уже скопирована' : 'Ссылка-приглашение готова'} — отправьте её сотрудникам.
          {made.current ? ` Проект «${made.current.name}» они увидят сразу после входа.` : ''}
          <span className="wl-linkrow">
            <input className="input" readOnly value={link} aria-label="Ссылка-приглашение" onFocus={(e) => e.currentTarget.select()} />
            {typeof navigator.share === 'function' && (
              <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => { void navigator.share({ url: link, title: 'Приглашение в Qevo' }).catch(() => undefined); }}>
                <Icon name="send" size={14} /> Отправить
              </button>
            )}
          </span>
        </>
      ));
    } catch (e) {
      say('bot', e instanceof ApiError ? e.message : 'Не получилось сделать ссылку — попробуйте ещё раз.');
    }
  };

  const askTelegram = async () => {
    say('me', ASK_TG);
    try {
      const st = await api.telegramStatus();
      if (!st.botUrl) {
        say('bot', 'Telegram-бот у вашей компании ещё не подключён — позовите живого инженера, он подключит.');
        return;
      }
      let url = st.botUrl;
      if (!st.linked) {
        const { code } = await api.telegramLinkCode();
        url = `${st.botUrl}${st.botUrl.includes('?') ? '&' : '?'}start=${encodeURIComponent(code)}`;
      }
      window.open(url, '_blank', 'noopener');
      say('bot', (
        <>
          {st.linked
            ? 'Telegram уже привязан — открыл чат с ботом.'
            : 'Открыл Telegram: нажмите «Запустить» — и аккаунт привяжется сам.'}
          {' '}В Telegram приходят уведомления о задачах и сводки ИИ-секретаря, а дейлик можно сдать голосом. Задачу голосом ставьте здесь, в QEVO Bot.
          <span className="wl-linkrow">
            <a className="ui-btn ui-btn-outline ui-btn-sm" href={url} target="_blank" rel="noreferrer"><Icon name="link" size={14} /> Открыть Telegram</a>
          </span>
        </>
      ));
    } catch (e) {
      say('bot', e instanceof ApiError ? e.message : 'Не получилось открыть привязку — попробуйте ещё раз.');
    }
  };

  const askProject = () => {
    say('me', ASK_PROJECT);
    say('bot', 'Подсветил кнопку «Новый проект». Общая доска — это тоже проект: по умолчанию его видит вся команда.');
    // без этого «Проекты» вернули бы на последнюю доску, а кнопка — в списке проектов
    forgetProject();
    navigate({ section: 'projects' });
    setSpot('project');
  };

  // ── ввод: текст или голос ──
  sink.current = (t: string) => {
    if (spot === 'task') { setPhrase(t); void addTask(t); return; }
    submit(t);
  };
  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setDraft('');
    if (step === 'q1') void answerSphere(null, text);
    else if (step === 'q2') answerName(text);
    else if (step === 'q3') void answerTeam(null, text);
    else if (step === 'ask' || step === 'norights') { say('me', text); askBot(text); setMini(true); }
  };

  const narrow = window.matchMedia(NARROW).matches;
  const busy = step === 'creating' || step === 'created' || step === 'adding';
  const showPanel = !hidden && !mini && spot === 'none';
  // обучение ждёт, пока бот открыт: после первой задачи человек пошёл по разделам — бот
  // свернулся, и подсказки включаются (пункт 3: «без наслоения окон»)
  const hold = !hidden && !mini;

  return (
    <>
      {hold && <i data-tour-hold hidden />}

      {!hidden && spot === 'task' && (
        <Spot selector='[data-tour="board-new"]' wait={10000}>
          <p className="wl-spot-text">{HOW}</p>
          <form className="wl-phrase" onSubmit={(e) => { e.preventDefault(); void addTask(phrase); }}>
            <input
              className="input"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="Подготовить план встречи завтра к 15:00"
              aria-label="Первая задача"
              disabled={step === 'adding'}
              autoFocus={!narrow}
            />
            <button
              type="button"
              className={`wl-mic${voice.recording ? ' is-rec' : ''}`}
              title="Зажмите и говорите (или нажмите, чтобы начать и закончить)"
              aria-label={voice.recording ? 'Закончить запись' : 'Сказать голосом'}
              aria-pressed={voice.recording}
              disabled={step === 'adding' || voice.transcribing}
              onPointerDown={() => {
                if (voice.recording) { press.current = { at: 0, mine: false }; voice.stop(); return; }
                press.current = { at: Date.now(), mine: true };
                void voice.start();
              }}
              onPointerUp={() => {
                if (press.current.mine && Date.now() - press.current.at > 450) voice.stop();
                press.current.mine = false;
              }}
              // с клавиатуры (Enter/пробел) указателя нет — обычное «нажал — начал, нажал — закончил»
              onClick={(e) => { if (e.detail === 0) voice.toggle(); }}
            >
              <Icon name={voice.recording ? 'stop' : 'mic'} size={18} />
            </button>
            <button type="submit" className="ui-btn ui-btn-primary ui-btn-md" disabled={step === 'adding' || phrase.trim().length < 3}>
              {step === 'adding' ? 'Ставлю…' : 'Поставить'}
            </button>
          </form>
          <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} hint="отпустите кнопку" />
          {err && <div className="error-text" role="alert">{err}</div>}
        </Spot>
      )}

      {!hidden && spot === 'card' && (
        <Spot selector={firstTask.current ? `[data-task-id="${firstTask.current}"]` : undefined} wait={6000}>
          <ul className="wl-tips">
            <li style={{ animationDelay: '0s' }}>
              <Icon name="arrow-right" size={16} />
              <span>{narrow ? 'Сменить статус: кнопка со стрелками на карточке → «В работе».' : 'Перетащите карточку в колонку «В работе» — так меняется статус.'}</span>
            </li>
            <li style={{ animationDelay: '1.5s' }}>
              <Icon name="paperclip" size={16} />
              <span>Откройте карточку: внутри — чек-лист подзадач и кнопка, чтобы приложить файл.</span>
            </li>
            <li style={{ animationDelay: '3s' }}>
              <Icon name="user-plus" size={16} />
              <span>Там же поле «Исполнитель» — назначьте ответственного в 1 клик.</span>
            </li>
          </ul>
          <div className="wl-spot-acts">
            <button className="ui-btn ui-btn-primary ui-btn-md" onClick={toAsk} autoFocus>Понятно</button>
          </div>
        </Spot>
      )}

      {!hidden && spot === 'project' && (
        <Spot selector=".projects-search ~ .ui-btn-primary" wait={6000} passThrough onTargetClick={() => setSpot('none')}>
          <p className="wl-spot-text">Нажмите «Новый проект»: название и пара слов о нём — и доска с колонками готова.</p>
          <div className="wl-spot-acts">
            <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => setSpot('none')}>Понятно</button>
          </div>
        </Spot>
      )}

      {!hidden && mini && (
        <div className="wl-mini">
          <button className="wl-mini-open" onClick={() => setMini(false)}><Icon name="robot" size={16} /> Qevo-бот</button>
          <button className="wl-mini-x" onClick={onClose} aria-label="Закрыть Qevo-бота" title="Закрыть"><Icon name="close" size={14} /></button>
        </div>
      )}

      {showPanel && (
        <section className="wl-bot" role="dialog" aria-label="Qevo-бот">
          <header className="wl-bot-head">
            <span className="wl-bot-mark" aria-hidden="true"><Icon name="robot" size={18} /></span>
            <b>Qevo-бот</b>
            {step === 'ask' && (
              <button className="wl-icon-btn" onClick={() => setMini(true)} aria-label="Свернуть" title="Свернуть"><Icon name="minimize" size={15} /></button>
            )}
            <button className="wl-icon-btn" onClick={onClose} aria-label="Закрыть Qevo-бота" title="Закрыть"><Icon name="close" size={16} /></button>
          </header>

          <div className="wl-feed" ref={feed} aria-live="polite">
            {msgs.map((m) => <div key={m.id} className={`wl-msg wl-msg-${m.from}`}>{m.text}</div>)}
            {busy && <div className="wl-msg wl-msg-bot wl-typing" aria-label="Qevo-бот печатает"><i /><i /><i /></div>}
          </div>

          <div className="wl-chips">
            {step === 'q1' && (
              <>
                {SPHERES.map((s) => <button key={s.key} className="wl-chip" onClick={() => void answerSphere(s.key, s.label)}>{s.label}</button>)}
                <button className="wl-chip" onClick={() => void voice.start()} disabled={voice.recording}><Icon name="mic" size={14} /> {SAY}</button>
              </>
            )}
            {step === 'q2' && nameSuggestions(answers.current.sphere).map((n) => (
              <button key={n} className="wl-chip" onClick={() => answerName(n)}>{n}</button>
            ))}
            {step === 'q3' && (
              <>
                <button className="wl-chip wl-chip-col" onClick={() => void answerTeam(false, SOLO)}>
                  <b>{SOLO}</b><span>«Сделать», «В работе», «Готово»</span>
                </button>
                <button className="wl-chip wl-chip-col" onClick={() => void answerTeam(true, TEAM)}>
                  <b>{TEAM}</b><span>«Бэклог», «В работе», «На проверке», «Готово»</span>
                </button>
              </>
            )}
            {step === 'ask' && (
              <>
                <button className="wl-chip" onClick={() => void askInvite()}><Icon name="user-plus" size={14} /> {ASK_INVITE}</button>
                <button className="wl-chip" onClick={() => void askTelegram()}><Icon name="send" size={14} /> {ASK_TG}</button>
                <button className="wl-chip" onClick={askProject}><Icon name="folder" size={14} /> {ASK_PROJECT}</button>
              </>
            )}
          </div>

          {err && step !== 'task' && <div className="error-text wl-err" role="alert">{err}</div>}
          <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} hint="нажмите ещё раз, чтобы закончить" />

          {(step === 'q1' || step === 'q2' || step === 'q3' || step === 'ask' || step === 'norights') && (
            <form className="wl-compose" onSubmit={(e) => { e.preventDefault(); submit(draft); }}>
              <input
                className="input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={step === 'ask' || step === 'norights' ? 'Спросите что угодно…' : 'Напишите ответ…'}
                aria-label="Ответ Qevo-боту"
              />
              <button type="button" className={`wl-mic${voice.recording ? ' is-rec' : ''}`} onClick={voice.toggle} disabled={voice.transcribing}
                aria-label={voice.recording ? 'Закончить запись' : 'Сказать голосом'} aria-pressed={voice.recording} title="Сказать голосом">
                <Icon name={voice.recording ? 'stop' : 'mic'} size={18} />
              </button>
              <button type="submit" className="wl-send" disabled={!draft.trim()} aria-label="Отправить" title="Отправить"><Icon name="send" size={16} /></button>
            </form>
          )}

          {/* Мостик к живому инженеру — всегда (шаг 5) */}
          <button className="wl-engineer" onClick={onEngineer}>
            <span className="wl-pulse" aria-hidden="true" /> {ENGINEER}
          </button>
        </section>
      )}
    </>
  );
}
