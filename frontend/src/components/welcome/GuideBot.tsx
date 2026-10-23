import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, request } from '../../lib/api';
import { useAuth } from '../../state/auth';
import { navigate, useRoute } from '../../lib/router';
import { forgetProject } from '../../lib/last-project';
import { askBot } from '../../lib/bot-ask';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { CLIENTS_ENABLED } from '../../config';
import { Icon } from '../Icon';
import type { IconName } from '../Icon';
import { VoiceStatus } from '../VoiceStatus';
import { PROJECTS_CHANGED } from '../ProjectsNav';
import { nameSuggestions, phraseDeadline, phraseTitle, type Sphere } from './phrase';
import { answered, at, back as stepBack, built, canBack, canForward, initial, keyOf, starterBody, sync, TOTAL, type BotState, type Starter } from './flow';
import { Spot } from './Spot';

/**
 * Qevo-бот первого запуска (#4620, «Старт», пункт 2; #4632 — «вести за ручку»):
 * сфера → название → один или с командой → проект → «Данные о проекте» → первая
 * задача → ответы на вопросы.
 *
 * #4632: у каждого шага — «Назад» и «Вперёд» и счётчик «шаг N из M»; бота можно
 * свернуть в кнопку и закрыть. Где он остановился, лежит в ui_prefs.welcome.bot —
 * переживает переход по разделам и перезагрузку. Вернулся и поменял ответ — тот же
 * проект правится, второй не создаётся (flow.ts).
 *
 * Обучение (подсказки приложения) ждёт, пока бот открыт, и идёт своим чередом,
 * когда он свёрнут или закрыт.
 */

type Msg = { id: number; from: 'bot' | 'me'; text: ReactNode };

const Q1 = 'Привет! Я Qevo-бот, твой личный проводник. Давай за 1 минуту соберем твой первый проект. Для чего ты планируешь использовать Qevo в первую очередь?';
const Q2 = 'Отлично! Как назовем твой первый проект или направление? Выбери из подсказок ниже, напиши или просто скажи голосом';
const Q3 = 'Супер! Ты будешь вести этот проект один или с командой? Выбери удобные этапы движения задач:';
const HOW = 'В Qevo не нужно заполнять сложные поля. Напиши свою первую реальную задачу или просто зажми кнопку микрофона и скажи, например: "Подготовить план встречи завтра к 15:00" — я сам распознаю голос и поставлю срок!';
const ENGINEER = 'Позвать живого инженера (25 сек) или перенести старые задачи за меня';
/** #4632, шаг «Данные о проекте» — смысл слов заказчика с созвона. */
const INFO = 'Чтобы QEVO сам ставил задачи из встреч и чатов — без ошибок и лишних вопросов, — расскажи ему о проекте как можно больше. Чем полнее заполнишь, тем быстрее и точнее дальше всё будет делаться за тебя автоматически. Вот что стоит заполнить:';
const INFO_LATER_ASK = 'Это работа не на минуту — можно и отдельно. Заполнишь сейчас или сначала поставим первую задачу?';
const NOW = 'Заполню сейчас';
const LATER = 'Сделаю потом';
const DONE_FILL = 'Готово, дальше';
const LEADS = 'И последнее перед задачей: кто у тебя руководит направлениями — программированием, контентом, дизайном? Отметь их, и QEVO сам будет ставить задачи нужному руководителю. Можно пропустить и настроить потом в «Настройки → Команда».';
const S_LEADS = at('leads');
const S_TASK = at('task');
const S_ASK = at('ask');
const ASK_INTRO = 'Готово — первая задача стоит на доске со сроком. Спрашивай что угодно — голосом или текстом, а вот частые вопросы:';

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

/** Перечень «Данные о проекте»: что и где заполнять — только то, что в продукте есть на самом деле. */
type InfoItem = { icon: IconName; title: string; text: string; where: string; to: 'settings' | 'clients' };
const INFO_ITEMS: InfoItem[] = [
  { icon: 'edit', title: 'Описание проекта', text: 'о чём проект, что делаем и для кого', where: 'доска проекта → «Настройки» → «Описание и ключевые слова»', to: 'settings' },
  { icon: 'tag', title: 'Ключевые слова', text: 'как проект называют в переписке и на созвонах: «Альфа», «сайт Альфабет»', where: 'там же', to: 'settings' },
  { icon: 'user', title: 'Руководитель проекта', text: 'кто за него отвечает', where: '«Настройки» → «Ответственный»', to: 'settings' },
  { icon: 'handshake', title: 'Клиент и контакты', text: 'заказчик, кто с его стороны отвечает, телефоны и почта', where: '«Клиенты» → карточка клиента → «Контакты», а во вкладке «Проекты» — привязать этот проект', to: 'clients' },
  { icon: 'paperclip', title: 'Файлы: договор, ТЗ, бриф, прайс', text: 'всё, что есть по проекту', where: 'карточка клиента → «Файлы»; главное из них — коротко в описание проекта: его ИИ читает, когда разбирает встречи и чаты', to: 'clients' },
];
/** Разделы окна «Настройки проекта», которые подсвечиваем, пока человек заполняет. */
const GLOW_TITLES = ['Описание и ключевые слова', 'Ответственный'];
const SETTINGS_BTN = '.board-actions button[title^="Настройки проекта"]';

const NARROW = '(max-width: 720px)';

export function GuideBot({ hidden, start, onSave, onEngineer, onClose }: {
  hidden: boolean;
  /** Сохранённое место (перезагрузка, другой раздел) — продолжаем с него. */
  start: BotState | null;
  onSave: (s: BotState) => void;
  onEngineer: () => void;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const route = useRoute();
  const [s, setS] = useState<BotState>(() => start ?? initial());
  const [notes, setNotes] = useState<Record<number, Msg[]>>({});
  const [busy, setBusy] = useState(false);
  const [noRights, setNoRights] = useState(false);
  const [draft, setDraft] = useState('');
  /** Разовые подсветки шага «вопросы»: кнопка «Новый проект». */
  const [extra, setExtra] = useState<'project' | null>(null);
  const [phrase, setPhrase] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const [asking, setAsking] = useState(false);
  /** «Заполню сейчас»: подсветка кнопки «Настройки» на доске проекта. */
  const [pointSettings, setPointSettings] = useState(false);
  const askedAt = useRef<string | null>(null);
  const feed = useRef<HTMLDivElement | null>(null);
  const seq = useRef(1);
  const sRef = useRef(s);
  sRef.current = s;

  const patch = (p: Partial<BotState>) => setS((v) => ({ ...v, ...p }));
  const note = (step: number, text: ReactNode, from: Msg['from'] = 'bot') =>
    setNotes((n) => ({ ...n, [step]: [...(n[step] ?? []), { id: ++seq.current, from, text }] }));

  // где остановились — в ui_prefs (переживает перезагрузку); первое — то, что пришло
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    const t = window.setTimeout(() => onSave(s), 300);
    return () => window.clearTimeout(t);
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = feed.current; if (el) el.scrollTop = el.scrollHeight; }, [s.step, notes, busy, s.mini]);

  const key = keyOf(s);
  const board = () => { if (s.project) navigate({ section: 'projects', projectId: s.project.projectId }); };

  // Продолжили после перезагрузки на шаге задачи — к доске проекта: подсказка — у её кнопки.
  useEffect(() => {
    if (start && (key === 'task' || (key === 'info' && s.filling)) && !s.mini) board();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Путь: после первой задачи ушёл в другой раздел — сворачиваемся, обучение идёт своим чередом.
  const path = window.location.pathname;
  useEffect(() => {
    if (key !== 'ask' || extra) return;
    if (askedAt.current == null) { askedAt.current = path; return; }
    if (path !== askedAt.current) patch({ mini: true });
  }, [route, key, extra, path]);

  // Заполняет данные проекта: подсвечиваем нужные разделы окна «Настройки проекта».
  useEffect(() => {
    if (hidden || key !== 'info' || !s.filling) return undefined;
    const mark = () => {
      for (const el of Array.from(document.querySelectorAll('.modal-card .drawer-section'))) {
        const t = el.querySelector('.drawer-section-title')?.textContent?.trim() ?? '';
        el.classList.toggle('wl-glow', GLOW_TITLES.includes(t));
      }
    };
    mark();
    const t = window.setInterval(mark, 400);
    return () => {
      window.clearInterval(t);
      document.querySelectorAll('.wl-glow').forEach((el) => el.classList.remove('wl-glow'));
    };
  }, [hidden, key, s.filling]);

  // ── голос: отвечает на текущий вопрос, в задаче — сама фраза ──
  const sink = useRef<(t: string) => void>(() => undefined);
  const voice = useVoiceInput((t) => sink.current(t));
  /** «Зажми кнопку микрофона»: держал — отпустил и запись ушла; коротко нажал — запись до второго нажатия. */
  const press = useRef<{ at: number; mine: boolean }>({ at: 0, mine: false });

  // ── шаги ──
  const answerSphere = async (sphere: Sphere | null, text: string) => {
    let sp = sphere;
    let sphereText: string | undefined;
    if (!sp) {
      setBusy(true);
      sp = await request<{ sphere: Sphere }>('POST', '/onboarding/starter/answer', { step: 'sphere', text })
        .then((r) => r.sphere).catch(() => 'custom' as Sphere);
      setBusy(false);
      sphereText = text;
    }
    patch({ sphere: sp, sphereText, step: 2 });
  };

  const answerName = (text: string) => {
    const name = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) return;
    patch({ name, step: 3 });
  };

  const answerTeam = async (team: boolean | null, text: string) => {
    let t = team;
    if (t === null) {
      setBusy(true);
      t = await request<{ team: boolean | null }>('POST', '/onboarding/starter/answer', { step: 'team', text })
        .then((r) => r.team).catch(() => null);
      setBusy(false);
    }
    if (t === null) { note(3, 'Выбери кнопкой: один или с командой.'); return; }
    await leaveTeam({ ...sRef.current, team: t });
  };

  /** Уход с третьего шага: проекта нет — создать; ответы поменялись — поправить тот же. */
  const leaveTeam = async (next: BotState) => {
    setS(next);
    const todo = sync(next);
    if (!todo) { patch({ step: 4 }); return; }
    setBusy(true); setErr(''); setNoRights(false);
    try {
      const r = await request<Starter & { revised?: boolean }>('POST', '/onboarding/starter', starterBody(next));
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      setS((v) => built(v, r));
      if (todo === 'update') note(4, `Поправил проект — теперь «${r.name}»${r.revised ? ', этапы доски под новый ответ' : ''}. Второй проект не создавал.`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FORBIDDEN') {
        note(3, 'Создавать проекты в этой компании вам пока нельзя — это делает руководитель. Позовите живого инженера: он всё настроит за вас.');
        setNoRights(true);
      } else if (e instanceof ApiError && e.code === 'NOT_FOUND' && next.project) {
        // проект успели удалить — соберём заново
        setS((v) => ({ ...v, project: null, built: null }));
        setErr('Прошлый проект не нашёлся — нажмите ещё раз, соберу заново');
      } else {
        setErr(e instanceof ApiError ? e.message : 'Не получилось создать проект — попробуйте ещё раз');
      }
    } finally { setBusy(false); }
  };

  /** К первой задаче: доска проекта, подсказка у кнопки «Новая задача». */
  const toTask = (why: 'later' | 'filled') => {
    if (why === 'later') {
      note(4, user?.role === 'owner'
        ? 'Хорошо — это можно сделать отдельно, задача не быстрая. Я оставил напоминание «Данные о проекте» в списке «Настройка QEVO».'
        : 'Хорошо — это можно сделать отдельно, задача не быстрая.');
    } else {
      note(4, 'Отлично! Теперь QEVO точнее поймёт, о каком проекте речь.');
      // окно «Настройки проекта» закрываем: иначе оно закрывает кнопку «Новая задача»
      document.querySelector<HTMLButtonElement>('.modal-card .drawer-head button[aria-label="Закрыть"]')?.click();
    }
    patch({ step: S_LEADS, filling: false, mini: false });
    setPointSettings(false);
  };
  /** «Кто руководит направлениями»: настроить сейчас — «Настройки → Команда → Структура». */
  const toTaskStep = () => { patch({ step: S_TASK, mini: false }); board(); };

  const fillNow = (to: InfoItem['to'] = 'settings') => {
    if (to === 'clients' && CLIENTS_ENABLED) {
      navigate({ section: 'clients' });
      patch({ filling: true, mini: true });
      return;
    }
    board();
    patch({ filling: true, mini: false });
    setPointSettings(true);
  };

  const goBack = () => {
    setErr(''); setExtra(null); setNoRights(false); setPointSettings(false);
    setS((v) => stepBack(v));
    const prev = s.step - 1;
    if (prev === S_TASK) board();
  };
  const goForward = () => {
    if (!canForward(s) || busy) return;
    setErr('');
    if (key === 'team') { void leaveTeam(s); return; }
    if (key === 'info') { toTask(s.filling ? 'filled' : 'later'); return; }
    patch({ step: s.step + 1, filling: false });
    if (s.step + 1 === S_TASK) board();
  };

  /** Фраза → задача в первой колонке со сроком (разбор команды + час из фразы). */
  const addTask = async (text: string) => {
    const p = s.project;
    const said = text.trim();
    if (!p || said.length < 3 || adding) return;
    setAdding(true); setErr('');
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
      setPhrase('');
      patch({ task: String(task.id) });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось поставить задачу — попробуйте ещё раз');
    } finally { setAdding(false); }
  };

  const toAsk = () => { askedAt.current = null; patch({ step: S_ASK }); };

  // ── быстрые вопросы: настоящие действия, а не текст ──
  const canInvite = user?.role === 'owner' || user?.role === 'manager';
  const askInvite = async () => {
    note(S_ASK, ASK_INVITE, 'me');
    if (!canInvite) {
      note(S_ASK, 'Приглашать сотрудников может владелец или руководитель компании — попросите его, или позовите живого инженера.');
      return;
    }
    try {
      const r = await api.createInviteLink({ role: 'member' });
      const link = `${window.location.origin}/?join=${r.token}`;
      let copied = false;
      try { await navigator.clipboard.writeText(link); copied = true; } catch { /* без доступа к буферу — ссылка на экране */ }
      note(S_ASK, (
        <>
          {copied ? 'Ссылка-приглашение готова и уже скопирована' : 'Ссылка-приглашение готова'} — отправьте её сотрудникам.
          {s.project ? ` Проект «${s.project.name}» они увидят сразу после входа.` : ''}
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
      note(S_ASK, e instanceof ApiError ? e.message : 'Не получилось сделать ссылку — попробуйте ещё раз.');
    }
  };

  const askTelegram = async () => {
    note(S_ASK, ASK_TG, 'me');
    try {
      const st = await api.telegramStatus();
      if (!st.botUrl) {
        note(S_ASK, 'Telegram-бот у вашей компании ещё не подключён — позовите живого инженера, он подключит.');
        return;
      }
      let url = st.botUrl;
      if (!st.linked) {
        const { code } = await api.telegramLinkCode();
        url = `${st.botUrl}${st.botUrl.includes('?') ? '&' : '?'}start=${encodeURIComponent(code)}`;
      }
      window.open(url, '_blank', 'noopener');
      note(S_ASK, (
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
      note(S_ASK, e instanceof ApiError ? e.message : 'Не получилось открыть привязку — попробуйте ещё раз.');
    }
  };

  const askProject = () => {
    note(S_ASK, ASK_PROJECT, 'me');
    note(S_ASK, 'Подсветил кнопку «Новый проект». Общая доска — это тоже проект: по умолчанию его видит вся команда.');
    // без этого «Проекты» вернули бы на последнюю доску, а кнопка — в списке проектов
    forgetProject();
    navigate({ section: 'projects' });
    setExtra('project');
  };

  // ── ввод: текст или голос ──
  const spot = hidden || s.mini || asking ? 'none'
    : extra === 'project' ? 'project'
      : key === 'task' ? (s.task ? 'card' : 'task')
        : key === 'info' && s.filling && pointSettings ? 'settings' : 'none';
  sink.current = (t: string) => {
    if (spot === 'task') { setPhrase(t); void addTask(t); return; }
    submit(t);
  };
  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setDraft('');
    if (key === 'sphere') void answerSphere(null, text);
    else if (key === 'name') answerName(text);
    else if (key === 'team') void answerTeam(null, text);
    else if (key === 'ask' || noRights) { note(s.step, text, 'me'); askBot(text); patch({ mini: true }); }
  };

  const narrow = window.matchMedia(NARROW).matches;
  const showPanel = !hidden && !s.mini && !asking && spot === 'none';
  // обучение ждёт, пока бот открыт: свернул или закрыл — подсказки включаются
  const hold = !hidden && !s.mini;

  const sphereLabel = s.sphereText || SPHERES.find((x) => x.key === s.sphere)?.label || '';
  const nav = (
    <Nav
      step={s.step}
      back={canBack(s) && !busy ? goBack : undefined}
      forward={canForward(s) && !busy && !noRights ? goForward : undefined}
      onMin={() => { setExtra(null); setPointSettings(false); patch({ mini: true }); }}
      onClose={() => setAsking(true)}
    />
  );

  /** Разговор — по шагам до текущего: «Назад» убирает лишнее, «Вперёд» возвращает. */
  const items: { id: string; from: 'bot' | 'me'; text: ReactNode }[] = [];
  const push = (id: string, from: 'bot' | 'me', text: ReactNode) => items.push({ id, from, text });
  const pushNotes = (k: number) => (notes[k] ?? []).forEach((m) => push(`n${m.id}`, m.from, m.text));
  push('q1', 'bot', Q1); pushNotes(1);
  if (s.step >= 2) { push('a1', 'me', sphereLabel); push('q2', 'bot', Q2); pushNotes(2); }
  if (s.step >= 3) { push('a2', 'me', s.name); push('q3', 'bot', Q3); pushNotes(3); }
  if (s.step >= 4 && s.project) {
    push('a3', 'me', s.team ? TEAM : SOLO);
    push('made', 'bot', `Твой первый проект «${s.project.name}» создан!`);
    push('info', 'bot', (
      <>
        {INFO}
        <ul className="wl-check">
          {INFO_ITEMS.filter((it) => it.to === 'settings' || CLIENTS_ENABLED).map((it) => (
            <li key={it.title}>
              <Icon name={it.icon} size={16} />
              <span><b>{it.title}</b> — {it.text}. <span className="wl-where">Где: {it.where}.</span></span>
            </li>
          ))}
        </ul>
        {s.step === 4 && !s.filling && INFO_LATER_ASK}
      </>
    ));
    pushNotes(4);
  }
  if (s.step >= S_LEADS) { push('leads', 'bot', LEADS); pushNotes(S_LEADS); }
  if (s.step >= S_TASK) { push('t', 'bot', 'Первая задача — на доске проекта: подсветил, где её ставить.'); pushNotes(S_TASK); }
  if (s.step >= S_ASK) { push('ask', 'bot', ASK_INTRO); pushNotes(S_ASK); }

  return (
    <>
      {hold && <i data-tour-hold hidden />}

      {asking && !hidden && (
        <div className="wl-confirm" role="alertdialog" aria-labelledby="wl-confirm-t">
          <p id="wl-confirm-t">Закрыть помощника? Вернуть можно в меню профиля → «Быстрый старт».</p>
          <div className="wl-spot-acts">
            <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => setAsking(false)} autoFocus>Остаться</button>
            <button className="ui-btn ui-btn-primary ui-btn-md" onClick={onClose}>Закрыть</button>
          </div>
        </div>
      )}

      {spot === 'task' && (
        <Spot selector='[data-tour="board-new"]' wait={10000}>
          {nav}
          <p className="wl-spot-text">{HOW}</p>
          <form className="wl-phrase" onSubmit={(e) => { e.preventDefault(); void addTask(phrase); }}>
            <input
              className="input"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="Подготовить план встречи завтра к 15:00"
              aria-label="Первая задача"
              disabled={adding}
              autoFocus={!narrow}
            />
            <button
              type="button"
              className={`wl-mic${voice.recording ? ' is-rec' : ''}`}
              title="Зажмите и говорите (или нажмите, чтобы начать и закончить)"
              aria-label={voice.recording ? 'Закончить запись' : 'Сказать голосом'}
              aria-pressed={voice.recording}
              disabled={adding || voice.transcribing}
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
            <button type="submit" className="ui-btn ui-btn-primary ui-btn-md" disabled={adding || phrase.trim().length < 3}>
              {adding ? 'Ставлю…' : 'Поставить'}
            </button>
          </form>
          <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} hint="отпустите кнопку" />
          {err && <div className="error-text" role="alert">{err}</div>}
        </Spot>
      )}

      {spot === 'card' && (
        <Spot selector={s.task ? `[data-task-id="${s.task}"]` : undefined} wait={6000}>
          {nav}
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

      {spot === 'settings' && (
        <Spot selector={SETTINGS_BTN} wait={8000} passThrough onTargetClick={() => { setPointSettings(false); patch({ mini: true }); }}>
          {nav}
          <p className="wl-spot-text">Нажми «Настройки» — там описание, ключевые слова и ответственный. Нужные поля подсвечу, а сам подожду внизу: как заполнишь — нажми «{DONE_FILL}».</p>
          <div className="wl-spot-acts">
            <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => toTask('later')}>{LATER}</button>
            <button className="ui-btn ui-btn-outline ui-btn-md" onClick={() => toTask('filled')}>{DONE_FILL}</button>
          </div>
        </Spot>
      )}

      {spot === 'project' && (
        <Spot selector=".projects-search ~ .ui-btn-primary" wait={6000} passThrough onTargetClick={() => setExtra(null)}>
          <p className="wl-spot-text">Нажмите «Новый проект»: название и пара слов о нём — и доска с колонками готова.</p>
          <div className="wl-spot-acts">
            <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => setExtra(null)}>Понятно</button>
          </div>
        </Spot>
      )}

      {!hidden && s.mini && !asking && (
        <div className="wl-mini">
          <button className="wl-mini-open" onClick={() => { patch({ mini: false }); if (key === 'task') board(); }} aria-label={`Развернуть Qevo-бота, шаг ${s.step} из ${TOTAL}`}>
            <Icon name="robot" size={16} /> Qevo-бот · шаг {s.step} из {TOTAL}
          </button>
          {key === 'info' && s.filling && (
            <button className="wl-mini-go" onClick={() => toTask('filled')}>{DONE_FILL}</button>
          )}
          <button className="wl-mini-x" onClick={() => setAsking(true)} aria-label="Закрыть Qevo-бота" title="Закрыть"><Icon name="close" size={14} /></button>
        </div>
      )}

      {showPanel && (
        <section className="wl-bot" role="dialog" aria-label="Qevo-бот">
          <header className="wl-bot-head">
            <span className="wl-bot-mark" aria-hidden="true"><Icon name="robot" size={18} /></span>
            <b>Qevo-бот</b>
            <button className="wl-icon-btn" onClick={() => patch({ mini: true })} aria-label="Свернуть" title="Свернуть"><Icon name="minimize" size={15} /></button>
            <button className="wl-icon-btn" onClick={() => setAsking(true)} aria-label="Закрыть Qevo-бота" title="Закрыть"><Icon name="close" size={16} /></button>
          </header>
          <Nav step={s.step} back={canBack(s) && !busy ? goBack : undefined} forward={canForward(s) && !busy && !noRights ? goForward : undefined} />

          <div className="wl-feed" ref={feed} aria-live="polite">
            {items.map((m) => <div key={m.id} className={`wl-msg wl-msg-${m.from}`}>{m.text}</div>)}
            {busy && <div className="wl-msg wl-msg-bot wl-typing" aria-label="Qevo-бот печатает"><i /><i /><i /></div>}
          </div>

          <div className="wl-chips">
            {key === 'sphere' && (
              <>
                {SPHERES.map((x) => (
                  <button key={x.key} className={`wl-chip${s.sphere === x.key && !s.sphereText ? ' is-on' : ''}`} aria-pressed={s.sphere === x.key && !s.sphereText}
                    disabled={busy} onClick={() => void answerSphere(x.key, x.label)}>{x.label}</button>
                ))}
                <button className="wl-chip" onClick={() => void voice.start()} disabled={voice.recording || busy}><Icon name="mic" size={14} /> {SAY}</button>
              </>
            )}
            {key === 'name' && [...new Set([...(s.name ? [s.name] : []), ...nameSuggestions(s.sphere ?? 'custom')])].map((n) => (
              <button key={n} className={`wl-chip${n === s.name ? ' is-on' : ''}`} aria-pressed={n === s.name} onClick={() => answerName(n)}>{n}</button>
            ))}
            {key === 'team' && !noRights && (
              <>
                <button className={`wl-chip wl-chip-col${s.team === false ? ' is-on' : ''}`} aria-pressed={s.team === false} disabled={busy} onClick={() => void answerTeam(false, SOLO)}>
                  <b>{SOLO}</b><span>«Сделать», «В работе», «Готово»</span>
                </button>
                <button className={`wl-chip wl-chip-col${s.team === true ? ' is-on' : ''}`} aria-pressed={s.team === true} disabled={busy} onClick={() => void answerTeam(true, TEAM)}>
                  <b>{TEAM}</b><span>«Бэклог», «В работе», «На проверке», «Готово»</span>
                </button>
              </>
            )}
            {key === 'info' && (
              s.filling ? (
                <>
                  <button className="wl-chip" onClick={() => fillNow('settings')}><Icon name="settings" size={14} /> Показать, где заполнять</button>
                  {CLIENTS_ENABLED && <button className="wl-chip" onClick={() => fillNow('clients')}><Icon name="handshake" size={14} /> Открыть «Клиенты»</button>}
                  <button className="wl-chip is-on" onClick={() => toTask('filled')}><Icon name="check" size={14} /> {DONE_FILL}</button>
                </>
              ) : (
                <>
                  <button className="wl-chip is-on" onClick={() => fillNow('settings')}><Icon name="edit" size={14} /> {NOW}</button>
                  <button className="wl-chip" onClick={() => toTask('later')}><Icon name="clock" size={14} /> {LATER}</button>
                </>
              )
            )}
            {key === 'leads' && (
              <>
                {canInvite && <button className="wl-chip is-on" onClick={() => { patch({ mini: true }); navigate('/settings/team?tab=structure'); }}><Icon name="users" size={14} /> Настроить сейчас</button>}
                <button className={`wl-chip${canInvite ? '' : ' is-on'}`} onClick={toTaskStep}><Icon name="clock" size={14} /> Пропустить</button>
              </>
            )}
            {key === 'task' && (
              <button className="wl-chip is-on" onClick={() => { patch({ mini: false }); board(); }}>
                <Icon name="board" size={14} /> {s.task ? 'Показать задачу на доске' : 'Поставить первую задачу'}
              </button>
            )}
            {key === 'ask' && (
              <>
                <button className="wl-chip" onClick={() => void askInvite()}><Icon name="user-plus" size={14} /> {ASK_INVITE}</button>
                <button className="wl-chip" onClick={() => void askTelegram()}><Icon name="send" size={14} /> {ASK_TG}</button>
                <button className="wl-chip" onClick={askProject}><Icon name="folder" size={14} /> {ASK_PROJECT}</button>
              </>
            )}
          </div>

          {err && <div className="error-text wl-err" role="alert">{err}</div>}
          <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} hint="нажмите ещё раз, чтобы закончить" />

          {(key === 'sphere' || key === 'name' || key === 'team' || key === 'ask') && (
            <form className="wl-compose" onSubmit={(e) => { e.preventDefault(); submit(draft); }}>
              <input
                className="input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={key === 'ask' || noRights ? 'Спросите что угодно…' : answered(s) ? 'Другой ответ…' : 'Напишите ответ…'}
                aria-label="Ответ Qevo-боту"
              />
              <button type="button" className={`wl-mic${voice.recording ? ' is-rec' : ''}`} onClick={voice.toggle} disabled={voice.transcribing}
                aria-label={voice.recording ? 'Закончить запись' : 'Сказать голосом'} aria-pressed={voice.recording} title="Сказать голосом">
                <Icon name={voice.recording ? 'stop' : 'mic'} size={18} />
              </button>
              <button type="submit" className="wl-send" disabled={!draft.trim() || busy} aria-label="Отправить" title="Отправить"><Icon name="send" size={16} /></button>
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

/** «Назад» · «шаг N из M» · «Вперёд»; в подсветках — ещё «Свернуть» и «Закрыть». */
function Nav({ step, back, forward, onMin, onClose }: {
  step: number; back?: () => void; forward?: () => void; onMin?: () => void; onClose?: () => void;
}) {
  return (
    <div className="wl-nav">
      <button className="wl-nav-btn" onClick={back} disabled={!back} aria-label="Назад, к прошлому шагу">
        <Icon name="chevron-left" size={15} /> Назад
      </button>
      <span className="wl-stepno" aria-live="polite">Шаг {step} из {TOTAL}</span>
      <button className="wl-nav-btn" onClick={forward} disabled={!forward} aria-label="Вперёд, к следующему шагу">
        Вперёд <Icon name="chevron-right" size={15} />
      </button>
      {onMin && <button className="wl-icon-btn" onClick={onMin} aria-label="Свернуть" title="Свернуть"><Icon name="minimize" size={15} /></button>}
      {onClose && <button className="wl-icon-btn" onClick={onClose} aria-label="Закрыть Qevo-бота" title="Закрыть"><Icon name="close" size={16} /></button>}
    </div>
  );
}
