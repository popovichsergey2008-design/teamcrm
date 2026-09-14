import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, IconName } from './Icon';
import { VoiceStatus } from './VoiceStatus';
import { api } from '../lib/api';
import { navigate, Route } from '../lib/router';
import { norm, score } from '../lib/palette-match';
import { Command, findCommands } from '../lib/commands';
import { setThemeChoice } from '../lib/theme';
import { useVoiceInput } from '../hooks/useVoiceInput';
import type { SearchResults, SemanticHit } from '../types';

/**
 * Командная строка (Ctrl+K).
 *
 * Два слоя, и это осознанно:
 *   1) МГНОВЕННЫЙ локальный — разделы и уже загруженные проекты и чаты. Отвечает на первое
 *      нажатие клавиши, сеть в набор текста не вмешивается;
 *   2) СЕРВЕРНЫЙ — задачи, чужие проекты, сообщения, люди, регламенты. Уходит с задержкой,
 *      чтобы не слать запрос на каждую букву, и дополняет список, не перетряхивая его.
 *
 * Права проверяет сервер: чужая переписка сюда не попадает даже теоретически.
 *
 * Третий слой — по смыслу — включается ЯВНЫМ действием, а не на каждую букву: он тратит
 * запрос к модели, и молча жечь деньги клиента на каждое нажатие нельзя. Поиск по
 * содержимому файлов — следующий шаг этапа.
 */

type Item = {
  key: string;
  group: string;
  title: string;
  hint?: string;
  icon: IconName;
  run: () => void;
};

/** Задержка перед запросом: столько человек набирает следующую букву. */
const DEBOUNCE_MS = 160;
const RECENT_KEY = 'teamcrm.recent';
const RECENT_MAX = 5;

const SECTIONS: { title: string; icon: IconName; route: Route; roles?: string[] }[] = [
  { title: 'Фокус дня', icon: 'target', route: { section: 'focus' } },
  { title: 'Задачи: все по всем проектам', icon: 'check-circle', route: { section: 'tasks' } },
  { title: 'Задачи: что я поручил', icon: 'send', route: { section: 'tasks', view: 'delegated' } },
  { title: 'Проекты и доски', icon: 'board', route: { section: 'projects' } },
  { title: 'Чаты & Миты', icon: 'chat', route: { section: 'chat' } },
  // Спросить ИИ — такой же пункт, как раздел: помощник живёт в чатах, а не в модалке.
  { title: 'Спросить ИИ — AnthillBot', icon: 'robot', route: { section: 'chat', chatId: 'anthill' } },
  { title: 'Пульс команды', icon: 'chart', route: { section: 'radar' }, roles: ['owner', 'manager'] },
  { title: 'Встречи', icon: 'record', route: { section: 'chat', view: 'meetings' } },
  { title: 'Настройки и интеграции', icon: 'settings', route: { section: 'settings' } },
  { title: 'Профиль', icon: 'user', route: { section: 'profile' } },
];

type Recent = { title: string; path: string; icon: IconName };

/** Куда человек ходил в последний раз: при пустой строке это полезнее пустоты. */
export function rememberVisit(entry: Recent) {
  try {
    const list: Recent[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    const next = [entry, ...list.filter((r) => r.path !== entry.path)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* переполненное хранилище — не повод ломать переход */ }
}

function readRecent(): Recent[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; }
}

/** Подсветка совпадения: человек должен видеть, за что зацепился поиск. */
function highlight(text: string, query: string): ReactNode {
  const q = norm(query);
  if (!q) return text;
  const at = norm(text).indexOf(q);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="palette-mark">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

/**
 * Куда ведёт находка из архива. У комментария известен только его собственный id и
 * название задачи — точной ссылки на него нет, поэтому открываем проект и честно
 * подписываем, что это комментарий, а не делаем вид, что ведём в нужное место.
 */
function hitRoute(h: SemanticHit): Route {
  if (h.sourceType === 'task') {
    return h.projectId
      ? { section: 'projects', projectId: String(h.projectId), taskId: String(h.sourceId) }
      : { section: 'projects' };
  }
  if (h.sourceType === 'meeting') return { section: 'chat', view: 'meetings' };
  if (h.projectId) return { section: 'projects', projectId: String(h.projectId) };
  return { section: 'settings', tab: 'knowledge' };
}

const HIT_LABEL: Record<string, string> = {
  task: 'задача', comment: 'комментарий', meeting: 'встреча',
  gdoc: 'документ', regulation: 'регламент',
};

export function CommandPalette({ role, onClose, onCreate, autoVoice }: {
  role: string;
  onClose: () => void;
  /** открыли кнопкой микрофона (мобильный экран) — сразу слушаем */
  autoVoice?: boolean;
  /** Передаём то, что человек успел набрать: он уже сформулировал задачу — заново не спрашиваем. */
  onCreate: (opts: { text?: string; voice?: boolean }) => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [local, setLocal] = useState<{ projects: any[]; chats: any[] }>({ projects: [], chats: [] });
  const [remote, setRemote] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [semantic, setSemantic] = useState<SemanticHit[] | null>(null);
  const [answer, setAnswer] = useState<{ text: string; sources: string[] } | null>(null);
  const [thinking, setThinking] = useState<'search' | 'answer' | null>(null);

  /*
    Esc закрывает окно откуда угодно.

    Раньше Escape ловило только поле ввода. После диктовки фокус уходил на кнопку
    микрофона — и Esc переставал работать, а другой видимой двери наружу не было:
    заказчик написал «окно невозможно закрыть». Слушаем клавишу на окне, на фазе
    перехвата, и гасим событие — иначе тот же Esc долетел бы до шторки под
    палитрой и закрыл заодно её, вместе с заполненной формой.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  // результат команды, показанный прямо в строке: «мои просроченные», «кто свободен» и т.п.
  const [inline, setInline] = useState<{ group: string; items: Item[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Распознанное дописываем в строку, а не заменяем ею: человек мог начать печатать,
  // а договорить голосом.
  const voice = useVoiceInput((text) => {
    setQ((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
    inputRef.current?.focus();
  });

  useEffect(() => {
    // Окно открылось сразу, содержимое подтягивается следом — ждать сеть, чтобы
    // показать поле ввода, значит потерять всю скорость.
    let alive = true;
    Promise.allSettled([api.listProjects(true), api.listChats()]).then((r) => {
      if (!alive) return;
      setLocal({
        projects: r[0].status === 'fulfilled' ? r[0].value : [],
        chats: r[1].status === 'fulfilled' ? r[1].value : [],
      });
    });
    return () => { alive = false; };
  }, []);

  // серверный поиск с задержкой; ответ на устаревший запрос выбрасываем
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setRemote(null); setSearching(false); return; }
    setSearching(true);
    let alive = true;
    const timer = setTimeout(() => {
      api.search(query)
        .then((res) => { if (alive) setRemote(res); })
        .catch(() => { if (alive) setRemote(null); })
        .finally(() => { if (alive) setSearching(false); });
    }, DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [q]);

  // Автозапуск ровно один раз: в режиме разработки эффекты вызываются дважды,
  // и без флага открывались бы два микрофонных потока подряд.
  const voiceStarted = useRef(false);
  useEffect(() => {
    if (!autoVoice || voiceStarted.current) return;
    voiceStarted.current = true;
    voice.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoVoice]);

  const go = (to: Route, remember?: Recent) => {
    if (remember) rememberVisit(remember);
    navigate(to);
    onClose();
  };

  /**
   * Выполнить команду. Меняющие состояние закрывают окно сразу — человек уже увидел,
   * что выбрал; показывающие данные раскрываются прямо в списке, чтобы не уводить
   * с экрана ради одного числа.
   */
  const runCommand = async (cmd: Command) => {
    const overdue = (t: any) => t.deadline_at && !t.closed_at && new Date(t.deadline_at) < new Date();
    const endOfDayMinutes = () => {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      return Math.max(1, Math.round((end.getTime() - Date.now()) / 60_000));
    };

    switch (cmd.kind) {
      case 'focus-deep-hour':
      case 'focus-deep-day':
      case 'focus-call':
      case 'focus-break': {
        const map = {
          'focus-deep-hour': { kind: 'deep', minutes: 60 },
          'focus-deep-day': { kind: 'deep', minutes: endOfDayMinutes() },
          'focus-call': { kind: 'call', minutes: 30 },
          'focus-break': { kind: 'break', minutes: 30 },
        } as const;
        const f = map[cmd.kind];
        await api.setFocus({ kind: f.kind, minutes: f.minutes }).catch(() => undefined);
        // панель показывает фокус и должна узнать о нём сразу, а не после перезагрузки
        window.dispatchEvent(new Event('teamcrm:focus-changed'));
        onClose();
        return;
      }
      case 'focus-clear':
        await api.clearFocus().catch(() => undefined);
        window.dispatchEvent(new Event('teamcrm:focus-changed'));
        onClose();
        return;
      case 'theme-dark': setThemeChoice('dark'); onClose(); return;
      case 'theme-light': setThemeChoice('light'); onClose(); return;
      case 'theme-system': setThemeChoice('system'); onClose(); return;

      case 'my-overdue': {
        setThinking('search');
        const tasks = await api.myTasks('mine').catch(() => []);
        const late = (tasks as any[]).filter(overdue);
        setInline({
          group: `Мои просроченные (${late.length})`,
          items: late.slice(0, 8).map((t) => ({
            key: `ov:${t.id}`, group: `Мои просроченные (${late.length})`, title: t.title,
            hint: `${t.project_name} · срок ${new Date(t.deadline_at).toLocaleDateString('ru-RU')}`,
            icon: 'alert' as IconName,
            run: () => go({ section: 'projects', projectId: String(t.project_id), taskId: String(t.id) }),
          })),
        });
        setThinking(null);
        return;
      }
      case 'who-free': {
        setThinking('search');
        const [users, focuses] = await Promise.all([
          api.listUsers().catch(() => []),
          api.focusTeam().catch(() => []),
        ]);
        const busy = new Map((focuses as any[]).map((f) => [String(f.userId), f]));
        const rows = (users as any[])
          .filter((u) => u.role !== 'client')
          .map((u) => {
            const f = busy.get(String(u.id));
            return {
              key: `wf:${u.id}`, group: 'Кто чем занят', title: u.fullName ?? u.full_name ?? u.email,
              hint: f ? (f.note || 'занят') + (f.until ? ` до ${new Date(f.until).getHours()}:${String(new Date(f.until).getMinutes()).padStart(2, '0')}` : '') : 'свободен',
              icon: (f ? 'clock' : 'check-circle') as IconName,
              run: () => go({ section: 'settings', tab: 'team' }),
            };
          })
          // свободные сверху: за ними и приходят с этим вопросом
          .sort((a, b) => Number(a.hint !== 'свободен') - Number(b.hint !== 'свободен'));
        setInline({ group: 'Кто чем занят', items: rows.slice(0, 10) });
        setThinking(null);
        return;
      }
      case 'at-risk': {
        setThinking('search');
        const radar = await api.radar().catch(() => null);
        const items: Item[] = [];
        for (const p of radar?.projects.filter((x) => x.overdue > 0) ?? []) {
          items.push({
            key: `risk:p:${p.id}`, group: 'Под риском', title: p.name,
            hint: `просрочено задач: ${p.overdue}`, icon: 'board',
            run: () => go({ section: 'projects', projectId: String(p.id) }),
          });
        }
        for (const t of radar?.stuck ?? []) {
          items.push({
            key: `risk:t:${t.id}`, group: 'Под риском', title: t.title,
            hint: `${t.project_name} · лежит на проверке`, icon: 'clock',
            run: () => go({ section: 'projects', projectId: String(t.project_id), taskId: String(t.id) }),
          });
        }
        setInline({
          group: 'Под риском',
          items: items.length ? items.slice(0, 10) : [{
            key: 'risk:none', group: 'Под риском', title: 'Ничего не горит',
            hint: 'нет просрочки и залежавшегося на проверке', icon: 'check-circle', run: () => undefined,
          }],
        });
        setThinking(null);
        return;
      }
      case 'day-summary': {
        setThinking('search');
        const [counters, mine] = await Promise.all([
          api.navCounters().catch(() => null),
          api.myTasks('mine', true).catch(() => []),
        ]);
        const today = new Date().toDateString();
        const closedToday = (mine as any[]).filter((t) => t.closed_at && new Date(t.closed_at).toDateString() === today).length;
        const late = (mine as any[]).filter(overdue).length;
        // Только посчитанное по данным: никаких «вы молодец» и придуманных процентов.
        const rows: Item[] = [
          { key: 'sum:done', group: 'Сводка дня', title: `Закрыто сегодня: ${closedToday}`, icon: 'check-circle', run: () => go({ section: 'focus' }) },
          { key: 'sum:decide', group: 'Сводка дня', title: `Ждут вашего решения: ${counters?.focus.decide ?? 0}`, icon: 'alert', run: () => go({ section: 'focus' }) },
          { key: 'sum:late', group: 'Сводка дня', title: `Просрочено у вас: ${late}`, icon: 'clock', run: () => go({ section: 'focus' }) },
        ];
        setInline({ group: 'Сводка дня', items: rows });
        setThinking(null);
        return;
      }
    }
  };

  const askSemantic = async () => {
    setThinking('search');
    try { setSemantic(await api.semanticSearch(q.trim())); }
    catch { setSemantic([]); }
    finally { setThinking(null); }
  };

  const askAi = async () => {
    setThinking('answer');
    try {
      const r = await api.brainAnswer(q.trim());
      setAnswer({ text: r.answer, sources: r.citations.map((c) => c.title).filter(Boolean) as string[] });
    } catch { setAnswer({ text: 'Не удалось получить ответ. Проверьте ключ модели в настройках ИИ.', sources: [] }); }
    finally { setThinking(null); }
  };

  const items = useMemo<Item[]>(() => {
    const query = norm(q);
    const seen = new Set<string>();
    const out: Item[] = [];
    const add = (item: Item) => { if (!seen.has(item.key)) { seen.add(item.key); out.push(item); } };

    if (inline) for (const it of inline.items) add(it);

    // Команды — сразу после результата: «не беспокоить», «кто свободен», «тёмная тема».
    for (const cmd of findCommands(q, role === 'owner' || role === 'manager')) {
      add({
        key: `cmd:${cmd.kind}`, group: 'Команды', title: cmd.title, hint: cmd.hint, icon: cmd.icon,
        run: () => { if (!thinking) runCommand(cmd); },
      });
    }

    if (!query) {
      for (const r of readRecent()) {
        add({
          key: `r:${r.path}`, group: 'Недавнее', title: r.title, icon: r.icon,
          run: () => { navigate(r.path); onClose(); },
        });
      }
    }

    // разделы — локально и всегда
    const sections = SECTIONS.filter((s) => !s.roles || s.roles.includes(role))
      .map((s) => ({ s, rank: query ? score(s.title, query) : 0 }))
      .filter((x) => x.rank !== null)
      .sort((a, b) => (a.rank as number) - (b.rank as number));
    for (const { s } of sections.slice(0, 6)) {
      add({
        key: `s:${s.title}`, group: 'Разделы', title: s.title, icon: s.icon,
        run: () => go(s.route, { title: s.title, path: '', icon: s.icon }),
      });
    }

    // проекты и чаты — сначала из уже загруженного (мгновенно), потом с сервера
    const localProjects = local.projects
      .map((p) => ({ p, rank: query ? score(p.name, query) : null }))
      .filter((x) => x.rank !== null)
      .sort((a, b) => (a.rank as number) - (b.rank as number));
    for (const { p } of localProjects.slice(0, 6)) {
      add({
        key: `p:${p.id}`, group: 'Проекты', title: p.name,
        hint: p.status === 'archived' ? 'в архиве' : undefined, icon: 'board',
        run: () => go({ section: 'projects', projectId: String(p.id) },
          { title: p.name, path: `/projects/${p.id}`, icon: 'board' }),
      });
    }
    for (const p of remote?.projects ?? []) {
      add({
        key: `p:${p.id}`, group: 'Проекты', title: p.name,
        hint: p.status === 'archived' ? 'в архиве' : undefined, icon: 'board',
        run: () => go({ section: 'projects', projectId: String(p.id) },
          { title: p.name, path: `/projects/${p.id}`, icon: 'board' }),
      });
    }

    const localChats = local.chats
      .map((c) => ({ c, rank: query ? score(c.title ?? 'Чат', query) : null }))
      .filter((x) => x.rank !== null)
      .sort((a, b) => (a.rank as number) - (b.rank as number));
    for (const { c } of localChats.slice(0, 6)) {
      add({
        key: `c:${c.id}`, group: 'Чаты', title: c.title ?? 'Чат',
        hint: c.kind === 'dm' ? 'личный' : undefined, icon: 'chat',
        run: () => go({ section: 'chat', chatId: String(c.id) },
          { title: c.title ?? 'Чат', path: `/chat/${c.id}`, icon: 'chat' }),
      });
    }
    for (const c of remote?.chats ?? []) {
      add({
        key: `c:${c.id}`, group: 'Чаты', title: c.title ?? 'Чат',
        hint: c.kind === 'dm' ? 'личный' : undefined, icon: 'chat',
        run: () => go({ section: 'chat', chatId: String(c.id) },
          { title: c.title ?? 'Чат', path: `/chat/${c.id}`, icon: 'chat' }),
      });
    }

    for (const t of remote?.tasks ?? []) {
      add({
        key: `t:${t.id}`, group: 'Задачи', title: t.title,
        hint: [t.project_name, t.closed ? 'завершена' : t.column_name].filter(Boolean).join(' · '),
        icon: 'check-circle',
        run: () => go({ section: 'projects', projectId: String(t.project_id), taskId: String(t.id) },
          { title: t.title, path: `/projects/${t.project_id}/task/${t.id}`, icon: 'check-circle' }),
      });
    }

    for (const m of remote?.messages ?? []) {
      add({
        key: `m:${m.id}`, group: 'Сообщения', title: m.body,
        hint: [m.author_name, m.chat_title ?? 'личный чат'].filter(Boolean).join(' · '),
        icon: 'chat',
        run: () => go({ section: 'chat', chatId: String(m.chat_id) },
          { title: m.chat_title ?? 'Чат', path: `/chat/${m.chat_id}`, icon: 'chat' }),
      });
    }

    for (const p of remote?.people ?? []) {
      add({
        key: `u:${p.id}`, group: 'Люди', title: p.full_name,
        hint: [p.position, p.email].filter(Boolean).join(' · '), icon: 'user',
        run: () => go({ section: 'settings', tab: 'team' }),
      });
    }

    for (const d of remote?.docs ?? []) {
      add({
        key: `d:${d.id}`, group: 'Регламенты', title: d.title, icon: 'book',
        run: () => go({ section: 'settings', tab: 'knowledge' }),
      });
    }

    // Третий слой — по смыслу. Сначала это ПРЕДЛОЖЕНИЕ (запрос к модели стоит денег),
    // после запуска — сами находки из архива.
    if (query.length >= 3) {
      if (semantic === null) {
        add({
          key: 'act:semantic', group: 'По смыслу',
          title: thinking === 'search' ? 'Ищу по смыслу…' : `Искать по смыслу: «${q.trim()}»`,
          hint: 'по архиву задач, встреч и документов', icon: 'sparkles',
          run: () => { if (!thinking) askSemantic(); },
        });
      } else if (semantic.length === 0) {
        add({
          key: 'act:semantic-empty', group: 'По смыслу', title: 'В архиве ничего похожего',
          hint: 'возможно, знания ещё не проиндексированы', icon: 'sparkles', run: () => undefined,
        });
      } else {
        for (const h of semantic) {
          add({
            key: `sem:${h.sourceType}:${h.sourceId}`, group: 'По смыслу',
            title: h.snippet.slice(0, 140),
            hint: [HIT_LABEL[h.sourceType] ?? h.sourceType, h.title, h.projectName].filter(Boolean).join(' · '),
            icon: 'sparkles',
            run: () => go(hitRoute(h)),
          });
        }
      }
      if (!answer) {
        add({
          key: 'act:ai', group: 'По смыслу',
          title: thinking === 'answer' ? 'Собираю ответ…' : 'Спросить ИИ',
          hint: 'ответ по архиву компании со ссылками на источники', icon: 'robot',
          run: () => { if (!thinking) askAi(); },
        });
      }
    }

    // Создание задачи — всегда последним: это запасной ход, когда ничего не нашлось.
    add({
      key: 'act:create',
      group: 'Действия',
      title: q.trim() ? `Создать задачу: «${q.trim()}»` : 'Создать задачу',
      hint: 'обычным языком, текстом или голосом',
      icon: 'zap',
      run: () => { onClose(); onCreate({ text: q.trim() || undefined }); },
    });

    return out;
  }, [q, local, remote, role, semantic, answer, thinking, inline]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setActive(0);
    // Смысловой слой относится к конкретной формулировке: при правке строки его
    // результаты устаревают, и оставлять их под новым запросом — обман.
    setSemantic(null);
    setAnswer(null);
    setInline(null);
  }, [q]);


  // держим выбранную строку в поле зрения при листании с клавиатуры
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, items.length]);

  const onKey = (e: React.KeyboardEvent) => {
    // Удержание пробела диктует, но только пока строка пуста: иначе человек не сможет
    // поставить пробел между словами, а это дороже любого удобства.
    if (e.key === ' ' && !q && !voice.recording) { e.preventDefault(); voice.start(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run(); }
    // Escape — общим обработчиком окна выше: он работает и когда фокус не в поле.
  };

  let lastGroup = '';

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Поиск и команды">
        <div className="palette-input-row">
          <Icon name="search" size={18} />
          <input
            className="palette-input"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            ref={inputRef}
            onKeyDown={onKey}
            onKeyUp={(e) => { if (e.key === ' ' && voice.recording) { e.preventDefault(); voice.stop(); } }}
            placeholder={voice.recording ? 'Говорите…' : 'Найти задачу, проект, сообщение, человека…'}
            aria-label="Поиск"
          />
          {searching && <span className="palette-searching" aria-hidden="true" />}
          <button
            className={`palette-mic${voice.recording ? ' recording' : ''}`}
            onClick={voice.toggle}
            title={voice.recording ? 'Остановить и распознать' : 'Продиктовать (или удерживайте пробел при пустой строке)'}
            aria-label="Голосовой ввод"
          >
            <Icon name={voice.recording ? 'stop' : 'mic'} size={16} />
          </button>
          {/* Настоящая кнопка, а не подпись «Esc»: подпись — подсказка для тех,
              кто и так знает, а крестик — дверь для всех остальных, и на касании тоже. */}
          <button className="palette-close" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть поиск">
            <Icon name="close" size={16} />
          </button>
        </div>

        <VoiceStatus
          recording={voice.recording}
          transcribing={voice.transcribing}
          error={voice.error}
          hint="отпустите пробел или нажмите «стоп»"
          className="palette-voice"
        />

        {answer && (
          <div className="palette-answer">
            <div className="palette-answer-head"><Icon name="robot" size={15} /> Ответ по архиву компании</div>
            <div>{answer.text}</div>
            {answer.sources.length > 0 && (
              <div className="palette-answer-src">Источники: {answer.sources.join(' · ')}</div>
            )}
          </div>
        )}

        <div className="palette-list" ref={listRef}>
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.key}>
                {head && <div className="palette-group">{head}</div>}
                <button
                  className={`palette-item${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={it.run}
                >
                  <Icon name={it.icon} size={16} />
                  <span className="palette-title">{highlight(it.title, q)}</span>
                  {it.hint && <span className="palette-hint">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette-foot">
          <span>↑↓ — выбор</span>
          <span>Enter — открыть</span>
          <span className="muted">Поиск по содержимому файлов — следующий шаг</span>
        </div>
      </div>
    </div>
  );
}
