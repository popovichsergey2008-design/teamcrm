import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, IconName } from './Icon';
import { api } from '../lib/api';
import { navigate, Route } from '../lib/router';
import { norm, score } from '../lib/palette-match';
import type { SearchResults } from '../types';

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
 * Поиск по смыслу и по содержимому файлов — следующие шаги этапа.
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
  { title: 'Проекты и доски', icon: 'board', route: { section: 'projects' } },
  { title: 'Командный чат', icon: 'chat', route: { section: 'chat' } },
  { title: 'Пульс команды', icon: 'chart', route: { section: 'radar' }, roles: ['owner', 'manager'] },
  { title: 'Встречи', icon: 'record', route: { section: 'chat', view: 'meetings' } },
  { title: 'Входящие', icon: 'inbox', route: { section: 'focus', view: 'inbox' }, roles: ['owner', 'manager'] },
  { title: 'Клиенты и сделки', icon: 'handshake', route: { section: 'projects', view: 'clients' }, roles: ['owner', 'manager'] },
  { title: 'Настройки и интеграции', icon: 'settings', route: { section: 'settings' } },
  { title: 'Личный кабинет', icon: 'user', route: { section: 'profile' } },
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

export function CommandPalette({ role, onClose, onCreate }: {
  role: string;
  onClose: () => void;
  /** Передаём то, что человек успел набрать: он уже сформулировал задачу — заново не спрашиваем. */
  onCreate: (opts: { text?: string; voice?: boolean }) => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [local, setLocal] = useState<{ projects: any[]; chats: any[] }>({ projects: [], chats: [] });
  const [remote, setRemote] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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

  const go = (to: Route, remember?: Recent) => {
    if (remember) rememberVisit(remember);
    navigate(to);
    onClose();
  };

  const items = useMemo<Item[]>(() => {
    const query = norm(q);
    const seen = new Set<string>();
    const out: Item[] = [];
    const add = (item: Item) => { if (!seen.has(item.key)) { seen.add(item.key); out.push(item); } };

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
  }, [q, local, remote, role]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setActive(0); }, [q]);

  // держим выбранную строку в поле зрения при листании с клавиатуры
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, items.length]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
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
            onKeyDown={onKey}
            placeholder="Найти задачу, проект, сообщение, человека…"
            aria-label="Поиск"
          />
          {searching && <span className="palette-searching" aria-hidden="true" />}
          <button
            className="palette-mic"
            onClick={() => { onClose(); onCreate({ text: q.trim() || undefined, voice: true }); }}
            title="Продиктовать голосом"
          >
            <Icon name="mic" size={16} />
          </button>
          <kbd className="nav-kbd">Esc</kbd>
        </div>

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
          <span className="muted">Поиск по смыслу и по содержимому файлов — следующий шаг</span>
        </div>
      </div>
    </div>
  );
}
