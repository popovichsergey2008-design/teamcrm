import './notification-center.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, CenterItem, NotificationCategory } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { navigate, parsePath } from '../../lib/router';
import { stampLabel } from '../../lib/chat-text';
import { initialsOf } from '../../lib/initials';
import { overlayProps, useBackClose } from '../../lib/overlay';
import { setCenterUnread, useCenterUnread } from '../../lib/notification-center';
import { useEscape } from '../../hooks/useEscape';
import { useIsPhone } from '../../hooks/useMediaQuery';
import { Avatar } from '../Avatar';
import { Icon, IconName } from '../Icon';

/** Фильтр по виду — те же виды, что считает сервер. */
const KINDS: { value: NotificationCategory; label: string }[] = [
  { value: 'task', label: 'Задачи' },
  { value: 'comment', label: 'Комментарии' },
  { value: 'mention', label: 'Упоминания' },
  { value: 'chat', label: 'Чаты' },
  { value: 'meet', label: 'Встречи' },
  { value: 'other', label: 'Прочее' },
];

const KIND_ICON: Record<NotificationCategory, IconName> = {
  task: 'board', comment: 'chat', mention: 'at', chat: 'chat', meet: 'video', other: 'bell',
};

const PRIORITY: Record<string, string> = { low: 'низкий', normal: 'обычный', high: 'высокий', urgent: 'срочно' };

/** «21 октября, 21:00» — как крайний срок в Битриксе. */
function moment(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return `${day}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Центр уведомлений (#4655) — история всего, что касается человека, как в Битриксе:
 * «Ольга добавила вас наблюдателем в задачу [#379] Автоподстановка врачей», под ней
 * исполнитель и срок. Всплывашка гаснет через шесть секунд, а строка здесь остаётся,
 * пока её не прочтут: щелчок ведёт к задаче и гасит строку, «Прочитать все» — все.
 *
 * Отдельным куском сборки со своими стилями: в первый экран попадает только значок.
 * На телефоне — во весь экран (общие правила шторки `.drawer`).
 */
export function NotificationCenter({ onClose }: { onClose: () => void }) {
  const unread = useCenterUnread();
  // #4703: на телефоне «Назад» закрывает уведомления, а не уводит с экрана под ними
  useBackClose(onClose);
  const phone = useIsPhone();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [kind, setKind] = useState<NotificationCategory | null>(null);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CenterItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Номер запроса: ответ на устаревший фильтр не должен затереть свежий список. */
  const seq = useRef(0);
  /** #4796: выбор долгим нажатием — несколько уведомлений и одно действие на все. */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const togglePick = (id: string) => setPicked((prev) => {
    const next = new Set(prev ?? []);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next.size ? next : null;
  });

  useEscape(onClose);

  // поиск — после паузы в наборе, а не на каждую букву
  useEffect(() => {
    const t = window.setTimeout(() => setQ(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const load = useCallback((before: string | null) => {
    const my = ++seq.current;
    setBusy(true);
    setFailed(false);
    api.notificationCenter({ before, unread: unreadOnly, category: kind, q })
      .then((page) => {
        if (my !== seq.current) return;
        setCenterUnread(page.unread);
        setItems((prev) => (before && prev ? [...prev, ...page.items] : page.items));
        setNext(page.next);
      })
      .catch(() => { if (my === seq.current) setFailed(true); })
      .finally(() => { if (my === seq.current) setBusy(false); });
  }, [unreadOnly, kind, q]);

  // новый фильтр — список с начала
  useEffect(() => {
    setItems(null);
    setNext(null);
    listRef.current?.scrollTo({ top: 0 });
    load(null);
  }, [load]);

  // Пришло новое, пока центр открыт, — сверху списка, не сбивая прокрутку ниже.
  useEffect(() => {
    const socket = getSocket();
    const fresh = () => {
      api.notificationCenter({ unread: unreadOnly, category: kind, q })
        .then((page) => setItems((prev) => {
          if (!prev) return page.items;
          const known = new Set(prev.map((x) => x.id));
          return [...page.items.filter((x) => !known.has(x.id)), ...prev];
        }))
        .catch(() => undefined);
    };
    socket.on('inbox.item', fresh);
    return () => { socket.off('inbox.item', fresh); };
  }, [unreadOnly, kind, q]);

  // Бесконечная прокрутка: дошли до низа — следующая страница истории.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !next || busy) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) load(next);
    }, { root: listRef.current, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [next, busy, load]);

  const markLocal = (ids: Set<string> | 'all') => setItems((prev) => prev?.map((x) => (
    (ids === 'all' || ids.has(x.id)) && !x.readAt ? { ...x, readAt: new Date().toISOString() } : x
  )) ?? prev);

  const open = (it: CenterItem) => {
    if (!it.readAt) {
      markLocal(new Set([it.id]));
      void api.notificationsRead([it.id]).then((r) => setCenterUnread(r.unread)).catch(() => undefined);
    }
    if (it.path) { navigate(parsePath(it.path)); onClose(); }
  };

  const applyPicked = (read: boolean) => {
    if (!picked) return;
    const ids = [...picked];
    setItems((prev) => prev?.map((x) => (picked.has(x.id) ? { ...x, readAt: read ? (x.readAt ?? new Date().toISOString()) : null } : x)) ?? prev);
    setPicked(null);
    void (read ? api.notificationsRead(ids) : api.notificationsUnread(ids)).then((r) => setCenterUnread(r.unread)).catch(() => undefined);
  };

  const readAll = () => {
    markLocal('all');
    void api.notificationsReadAll(kind).then((r) => {
      setCenterUnread(r.unread);
      if (unreadOnly) setItems([]);
    }).catch(() => undefined);
  };

  const filtered = unreadOnly || kind || q;

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer nc-drawer" role="dialog" aria-label="Уведомления" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="bell" size={18} /> <span className="nc-title">Уведомления</span></h3>
          <span className="nc-head-actions">
            {/* #4703: на телефоне «Прочитать все» — строкой под поиском, чтобы заголовок не обрезался */}
            {!phone && (
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={readAll} disabled={unread === 0} title="Отметить всё прочитанным" aria-label="Прочитать все">
                <Icon name="check-check" size={15} /> <span className="nc-read-label">Прочитать все</span>
              </button>
            )}
            <button className="drawer-close" onClick={onClose} aria-label="Закрыть" title="Закрыть"><Icon name="close" size={16} /></button>
          </span>
        </div>

        {picked && (
          <div className="nc-select-bar" role="toolbar" aria-label="Выбранные уведомления">
            <b>Выбрано: {picked.size}</b>
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => applyPicked(true)}><Icon name="check-check" size={14} /> Прочитано</button>
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => applyPicked(false)}><Icon name="bell" size={14} /> Не прочитано</button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setPicked(null)}>Отмена</button>
          </div>
        )}

        <label className="nc-search">
          <Icon name="search" size={15} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={phone ? 'Поиск' : 'Поиск: задача, человек, текст или #номер'}
            title="Поиск: задача, человек, текст или #номер"
            aria-label="Поиск по уведомлениям"
          />
        </label>
        {phone && (
          <button className="ui-btn ui-btn-ghost ui-btn-sm nc-read-phone" onClick={readAll} disabled={unread === 0} title="Отметить всё прочитанным">
            <Icon name="check-check" size={15} /> Прочитать все
          </button>
        )}
        <div className="nc-filters" role="group" aria-label="Фильтр уведомлений">
          <button className={`nc-chip${!unreadOnly ? ' active' : ''}`} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>Все</button>
          <button className={`nc-chip${unreadOnly ? ' active' : ''}`} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
            Непрочитанные{unread > 0 ? ` · ${unread > 99 ? '99+' : unread}` : ''}
          </button>
          <span className="nc-sep" aria-hidden="true" />
          {KINDS.map((k) => (
            <button
              key={k.value}
              className={`nc-chip${kind === k.value ? ' active' : ''}`}
              aria-pressed={kind === k.value}
              onClick={() => setKind((v) => (v === k.value ? null : k.value))}
            >
              {k.label}
            </button>
          ))}
        </div>

        <div className="nc-list" ref={listRef}>
          {items === null && !failed && <div className="nc-empty"><div className="spinner" /></div>}
          {failed && items === null && (
            <div className="nc-empty">
              Не удалось загрузить. <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => load(null)}>Повторить</button>
            </div>
          )}
          {items?.length === 0 && (
            <div className="nc-empty">
              <Icon name="bell" size={22} />
              {filtered ? 'Ничего не нашлось' : 'Уведомлений пока нет. Здесь появится всё, что происходит в ваших задачах.'}
            </div>
          )}
          {items && items.length > 0 && (
            <ul className="nc-items">
              {items.map((it) => (
                <Row key={it.id} it={it} onOpen={open} picked={picked?.has(it.id) ?? false} selecting={!!picked}
                  onPick={() => togglePick(it.id)} />
              ))}
            </ul>
          )}
          {next && <div ref={sentinel} className="nc-more">{busy && <div className="spinner" />}</div>}
        </div>
      </aside>
    </div>
  );
}

/** Одна строка истории: аватар автора, «кто что сделал [#номер] Задача», подробности, время. */
function Row({ it, onOpen, picked, selecting, onPick }: {
  it: CenterItem; onOpen: (it: CenterItem) => void;
  /** #4796: выбор долгим нажатием; в режиме выбора короткое нажатие тоже выбирает */
  picked: boolean; selecting: boolean; onPick: () => void;
}) {
  const hold = useRef<number | null>(null);
  const held = useRef(false);
  const startHold = () => {
    held.current = false;
    hold.current = window.setTimeout(() => { held.current = true; onPick(); navigator.vibrate?.(15); }, 500);
  };
  const stopHold = () => { if (hold.current) window.clearTimeout(hold.current); hold.current = null; };
  const d = it.details ?? {};
  const unread = !it.readAt;
  const alarm = it.eventKey === 'task.overdue' || it.eventKey === 'task.deadline_soon';
  const lines: [string, string][] = [];
  if (it.task) {
    if (d.assignee) lines.push(['Исполнитель', d.assignee]);
    if (d.deadline) lines.push(['Крайний срок', moment(d.deadline)]);
    if (d.shiftTo) lines.push(['Новый срок', moment(d.shiftTo)]);
    if (d.status) lines.push(['Статус', d.status]);
    if (it.eventKey === 'task.priority') lines.push(['Приоритет', d.priority ? PRIORITY[d.priority] ?? d.priority : 'без приоритета']);
  }
  // #4665: «Задача поставлена от вас» — пункты разбора нейросети готовыми строками
  const fields = Array.isArray(d.fields) ? d.fields.filter((f) => Array.isArray(f) && f.length === 2) : [];
  lines.push(...fields);
  const quote = d.comment || d.reason || (!d.phrase && !fields.length ? it.body : '');
  return (
    <li>
      <a
        className={`nc-item${unread ? ' nc-unread' : ''}${picked ? ' nc-picked' : ''}`}
        href={it.path ?? undefined}
        aria-pressed={selecting ? picked : undefined}
        onPointerDown={startHold} onPointerUp={stopHold} onPointerLeave={stopHold} onPointerCancel={stopHold}
        onContextMenu={(e) => { if (held.current || selecting) e.preventDefault(); }}
        onClick={(e) => {
          // Ctrl/Cmd-клик — в новой вкладке, как у обычной ссылки
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          if (held.current) { held.current = false; return; } // долгое нажатие уже выбрало строку
          if (selecting) { onPick(); return; }
          onOpen(it);
        }}
      >
        {selecting && <span className="nc-check" aria-hidden="true">{picked && <Icon name="check" size={12} />}</span>}
        {it.actor
          ? <Avatar path={it.actor.avatarUrl} fallback={initialsOf(it.actor.name)} className="avatar-sm nc-avatar" />
          : <span className={`nc-avatar nc-icon${alarm ? ' nc-icon-alarm' : ''}`}><Icon name={alarm ? 'alert' : KIND_ICON[it.category] ?? 'bell'} size={16} /></span>}
        <span className="nc-main">
          <span className="nc-text">
            {d.phrase && it.task ? (
              <>
                {it.actor && <b>{it.actor.name} </b>}
                {d.phrase} <span className="nc-task">[#{it.task.id}] {it.task.title}</span>
              </>
            ) : it.title}
          </span>
          {lines.map(([k, v]) => <span key={k} className="nc-line"><span className="nc-key">{k}:</span> {v}</span>)}
          {quote && <span className="nc-quote">{quote}</span>}
          <span className="nc-time">{stampLabel(it.createdAt)}</span>
        </span>
        {unread && <span className="nc-dot" title="Не прочитано" aria-label="Не прочитано" />}
      </a>
    </li>
  );
}
