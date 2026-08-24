import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, IconName } from './Icon';
import { api } from '../lib/api';
import { navigate, Route } from '../lib/router';
import { norm, score } from '../lib/palette-match';

/**
 * Командная строка (Ctrl+K) — навигационный слой.
 *
 * По ТЗ у неё три слоя: поиск, поиск по смыслу и быстрые команды. Здесь сделан
 * первый и самый дешёвый: переход к разделу, проекту, чату и своей задаче без мыши.
 * Поиск по содержимому файлов, сообщениям и смыслу требует бэкенда и живёт в отдельном
 * этапе — но строка обязана работать уже сейчас, иначе подпись «Найти или сказать…»
 * в панели была бы обманом.
 *
 * Данные берём те, что и так есть в API: список проектов, чатов и своих задач.
 * Всё фильтруется на клиенте — открытие мгновенное, сеть в набор текста не вмешивается.
 */

type Item = {
  key: string;
  group: string;
  title: string;
  hint?: string;
  icon: IconName;
  run: () => void;
};

type Loaded = {
  projects: { id: string; name: string; status?: string }[];
  chats: { id: string; title?: string; kind?: string }[];
  tasks: { id: string; title: string; project_id: string; project_name?: string }[];
};

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

export function CommandPalette({ role, onClose, onCreate }: {
  role: string;
  onClose: () => void;
  /** Передаём то, что человек успел набрать: он уже сформулировал задачу — заново не спрашиваем. */
  onCreate: (opts: { text?: string; voice?: boolean }) => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [data, setData] = useState<Loaded>({ projects: [], chats: [], tasks: [] });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Окно открылось сразу, содержимое подтягивается следом — ждать сеть, чтобы
    // показать поле ввода, значит потерять всю скорость.
    let alive = true;
    Promise.allSettled([api.listProjects(true), api.listChats(), api.myTasks('mine')]).then((r) => {
      if (!alive) return;
      setData({
        projects: r[0].status === 'fulfilled' ? r[0].value : [],
        chats: r[1].status === 'fulfilled' ? r[1].value : [],
        tasks: r[2].status === 'fulfilled' ? r[2].value : [],
      });
    });
    return () => { alive = false; };
  }, []);

  const go = (to: Route) => { navigate(to); onClose(); };

  const items = useMemo<Item[]>(() => {
    const query = norm(q);
    const all: (Item & { rank: number })[] = [];
    const push = (item: Item, rank: number | null) => { if (rank !== null) all.push({ ...item, rank }); };

    for (const s of SECTIONS) {
      if (s.roles && !s.roles.includes(role)) continue;
      push(
        { key: `s:${s.title}`, group: 'Разделы', title: s.title, icon: s.icon, run: () => go(s.route) },
        query ? score(s.title, query) : 0,
      );
    }
    for (const p of data.projects) {
      push(
        {
          key: `p:${p.id}`,
          group: 'Проекты',
          title: p.name,
          hint: p.status === 'archived' ? 'в архиве' : undefined,
          icon: 'board',
          run: () => go({ section: 'projects', projectId: String(p.id) }),
        },
        query ? score(p.name, query) : 0,
      );
    }
    for (const c of data.chats) {
      const title = c.title ?? 'Чат';
      push(
        {
          key: `c:${c.id}`,
          group: 'Чаты',
          title,
          hint: c.kind === 'dm' ? 'личный' : undefined,
          icon: 'chat',
          run: () => go({ section: 'chat', chatId: String(c.id) }),
        },
        query ? score(title, query) : 0,
      );
    }
    for (const t of data.tasks) {
      push(
        {
          key: `t:${t.id}`,
          group: 'Мои задачи',
          title: t.title,
          hint: t.project_name,
          icon: 'check-circle',
          run: () => go({ section: 'projects', projectId: String(t.project_id), taskId: String(t.id) }),
        },
        query ? score(t.title, query) : null, // без запроса список своих задач не вываливаем: он длинный
      );
    }

    all.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title, 'ru'));

    // Создание задачи — всегда последним: это запасной ход, когда ничего не нашлось.
    const create: Item = {
      key: 'act:create',
      group: 'Действия',
      title: query ? `Создать задачу: «${q.trim()}»` : 'Создать задачу',
      hint: 'обычным языком, текстом или голосом',
      icon: 'zap',
      run: () => { onClose(); onCreate({ text: q.trim() || undefined }); },
    };

    // По группам, не больше шести в каждой: длинный список читать некогда, для того и палитра.
    const byGroup = new Map<string, Item[]>();
    for (const it of all) {
      const arr = byGroup.get(it.group) ?? [];
      if (arr.length < 6) arr.push(it);
      byGroup.set(it.group, arr);
    }
    return [...[...byGroup.values()].flat(), create];
  }, [q, data, role]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setActive(0); }, [q]);

  // держим выбранную строку в поле зрения при листании с клавиатуры
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

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
            placeholder="Найти раздел, проект, чат или задачу…"
            aria-label="Поиск"
          />
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
                  <span className="palette-title">{it.title}</span>
                  {it.hint && <span className="palette-hint">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette-foot">
          <span>↑↓ — выбор</span>
          <span>Enter — открыть</span>
          <span className="muted">Поиск по сообщениям и файлам появится позже</span>
        </div>
      </div>
    </div>
  );
}
