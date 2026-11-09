import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { notifyChatsChanged, SEEN_EVENT, TOAST_EVENT, ToastPayload } from '../lib/notifications';
import { api } from '../lib/api';

interface Toast extends ToastPayload { id: number }
// #4710: на секунду дольше — заказчик не успевал прочитать
const LIFETIME_MS = 7000;
const SAVED_LIFETIME_MS = 2500;
/** Убрали мышь с всплывашки, которую читали, — ещё столько, чтобы дочитать. */
const AFTER_HOVER_MS = 3000;
// #4710: столбиком, как в Telegram — несколько сразу, новое снизу
const MAX_VISIBLE = 4;
const MAX_MISSED = 20;

/** Человек печатает: поле ввода, многострочное поле или редактируемый блок. */
function isTyping(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return !el.readOnly && /^(text|search|email|url|tel|password|number|)$/.test(el.type);
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Всплывающие уведомления о новых сообщениях.
 *
 * Раньше о сообщении сообщал только счётчик в шапке и системное уведомление
 * браузера — а его разрешение обычно не выдают, и человек не узнавал ни о чём.
 * Это видно всегда: клик открывает чат с сообщением.
 *
 * #4710: исчезнувшее не пропадает — оно уходит в «Пропущенные» (строка внизу справа),
 * оттуда его можно открыть. Пока мышь на всплывашке, она не гаснет. Как в Telegram:
 * столбиком, у сообщения — «Прочитано», над столбиком — «Прочитать все» и «Скрыть все».
 */
export function Toasts({ onOpenChat, onOpenFeed, onOpenFocus, onOpenMeetings, onOpenSupport, onOpenInbox }: {
  onOpenChat: (chatId?: string, threadId?: string) => void;
  onOpenFeed?: () => void;
  onOpenFocus?: () => void;
  onOpenMeetings?: () => void;
  /** Служба заботы: щелчок открывает разговор — в консоли это единственный вид новостей. */
  onOpenSupport?: (conversationId?: string) => void;
  /** Ящик уведомлений оболочки: перейти по пути и отметить прочитанным. */
  onOpenInbox?: (id?: string, path?: string) => void;
}) {
  const [items, setItems] = useState<Toast[]>([]);
  const [missed, setMissed] = useState<Toast[]>([]);
  const [missedOpen, setMissedOpen] = useState(false);
  /*
    #4830: пока человек пишет сообщение или комментарий, всплывашки уходят с глаз —
    они стояли поверх поля ввода (особенно на ноутбуке). Ничего не теряется: погасшее
    само уходит в «Пропущенные», а стопка возвращается, как только фокус ушёл из поля.
  */
  const [typing, setTyping] = useState(() => isTyping(document.activeElement));
  useEffect(() => {
    const sync = () => setTyping(isTyping(document.activeElement));
    // focusout срабатывает до того, как фокус переехал, — сверяемся на следующем такте
    const onOut = () => window.setTimeout(sync, 0);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', onOut);
    return () => { document.removeEventListener('focusin', sync); document.removeEventListener('focusout', onOut); };
  }, []);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  /** Погасла сама — не прочитана: новость уходит в «Пропущенные», «Сохранено» — просто исчезает. */
  const expire = (t: Toast) => {
    timers.current.delete(t.id);
    setItems((prev) => prev.filter((x) => x.id !== t.id));
    if (t.kind !== 'saved') setMissed((prev) => [t, ...prev.filter((x) => x.id !== t.id)].slice(0, MAX_MISSED));
  };
  const arm = (t: Toast, ms: number) => {
    clearTimeout(timers.current.get(t.id));
    timers.current.set(t.id, setTimeout(() => expire(t), ms));
  };
  const drop = (id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((prev) => prev.filter((x) => x.id !== id));
    setMissed((prev) => prev.filter((x) => x.id !== id));
  };

  useEffect(() => {
    let seq = 0;
    const all = timers.current;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastPayload>).detail;
      if (!detail) return;
      const item: Toast = { ...detail, id: ++seq };
      // копить бесконечно нельзя: при активной переписке экран заполнится целиком;
      // вытесненная — тоже не прочитана, ей место в «Пропущенных»
      setItems((prev) => {
        // та же тема (напоминание о той же встрече) — прежняя карточка уступает место новой
        const same = item.replaceKey ? prev.filter((x) => x.replaceKey === item.replaceKey) : [];
        for (const old of same) { clearTimeout(all.get(old.id)); all.delete(old.id); }
        const next = [...prev.filter((x) => !same.includes(x)), item];
        for (const old of next.slice(0, -MAX_VISIBLE)) { clearTimeout(all.get(old.id)); queueMicrotask(() => expire(old)); }
        return next.slice(-MAX_VISIBLE);
      });
      // «Сохранено» гаснет быстрее: это ответ на действие, а не новость, ради
      // которой стоит держать место на экране.
      if (item.expireAt) arm(item, Math.max(LIFETIME_MS, item.expireAt - Date.now()));
      else if (!item.sticky) arm(item, item.kind === 'saved' ? SAVED_LIFETIME_MS : LIFETIME_MS);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      for (const t of all.values()) clearTimeout(t);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /*
    #4832: чат прочитан или задача открыта (где угодно — в разделе, в карточке, с другого
    места) — их всплывашки и «Пропущенные» уходят сами. Раньше висело уведомление о
    сообщении, на которое уже ответили.
  */
  useEffect(() => {
    const onSeen = (e: Event) => {
      const d = (e as CustomEvent<{ chatId?: string; threadId?: string; taskId?: string }>).detail ?? {};
      const task = d.taskId ? `/task/${d.taskId}` : '';
      const hit = (t: Toast) => (!!d.chatId && t.chatId === d.chatId && !t.threadId && (!t.section || t.section === 'chat'))
        || (!!d.threadId && t.threadId === d.threadId)
        || (!!task && !!t.inboxPath && (t.inboxPath + '/').startsWith(task + '/'));
      setItems((prev) => prev.filter((t) => !hit(t) || (clearTimeout(timers.current.get(t.id)), false)));
      setMissed((prev) => prev.filter((t) => !hit(t)));
    };
    window.addEventListener(SEEN_EVENT, onSeen);
    return () => window.removeEventListener(SEEN_EVENT, onSeen);
  }, []);

  /** Сообщение прочитано: чат отмечаем на сервере, его всплывашки убираем отовсюду. */
  const markRead = (list: Toast[]) => {
    const chats = [...new Set(list.filter((t) => t.chatId && (!t.section || t.section === 'chat')).map((t) => t.chatId as string))];
    const gone = new Set(list.map((t) => t.id));
    for (const t of [...items, ...missed]) if (t.chatId && chats.includes(t.chatId)) gone.add(t.id);
    for (const id of gone) drop(id);
    if (chats.length) void Promise.allSettled(chats.map((id) => api.markChatRead(id))).then(notifyChatsChanged);
  };
  /** Скрыть с глаз, но не потерять: всё видимое — в «Пропущенные». */
  const hideAll = () => {
    for (const t of items) clearTimeout(timers.current.get(t.id));
    const news = items.filter((t) => t.kind !== 'saved');
    setMissed((prev) => [...news.reverse(), ...prev.filter((x) => !news.some((n) => n.id === x.id))].slice(0, MAX_MISSED));
    setItems([]);
    setMissedOpen(false);
  };

  const open = (t: Toast) => {
    drop(t.id);
    // «Сохранено» никуда не ведёт: щелчок просто убирает её с глаз.
    if (t.kind === 'saved') return;
    if (t.section === 'feed') onOpenFeed?.();
    else if (t.section === 'focus') onOpenFocus?.();
    else if (t.section === 'meetings') onOpenMeetings?.();
    else if (t.section === 'support') onOpenSupport?.(t.conversationId);
    else if (t.section === 'inbox') onOpenInbox?.(t.inboxId, t.inboxPath);
    else onOpenChat(t.chatId, t.threadId);
    if (missed.length <= 1) setMissedOpen(false);
  };

  const card = (t: Toast, live: boolean) => (
    <button
      key={t.id}
      className={`toast${t.kind === 'saved' ? ' toast-saved' : ''}`}
      onClick={() => open(t)}
      // читают — не гасим; ушли — даём дочитать
      onMouseEnter={live ? () => clearTimeout(timers.current.get(t.id)) : undefined}
      onMouseLeave={live && !t.sticky && !t.expireAt ? () => arm(t, t.kind === 'saved' ? SAVED_LIFETIME_MS : AFTER_HOVER_MS) : undefined}
      title={t.kind === 'saved' ? 'Скрыть'
        : t.section === 'feed' ? 'Открыть ленту'
        : t.section === 'focus' ? 'Открыть фокус дня'
          : t.section === 'meetings' ? 'Открыть встречи'
            : t.section === 'support' ? 'Открыть обращение'
              : t.section === 'inbox' ? 'Открыть'
                : 'Открыть сообщение'}
    >
      <Icon
        name={t.kind === 'saved' ? 'check' : t.section === 'support' ? 'support' : t.section === 'chat' || !t.section ? 'chat' : 'bell'}
        size={16}
      />
      <span className="toast-text">
        <span className="toast-title">{t.title}</span>
        <span className="toast-body">{t.body}</span>
      </span>
      {t.chatId && (!t.section || t.section === 'chat') && (
        <span
          className="toast-close"
          role="button"
          aria-label="Отметить прочитанным"
          title="Прочитано"
          onClick={(e) => { e.stopPropagation(); markRead([t]); }}
        >
          <Icon name="check-check" size={14} />
        </span>
      )}
      <span
        className="toast-close"
        role="button"
        aria-label="Скрыть"
        title="Скрыть"
        onClick={(e) => { e.stopPropagation(); drop(t.id); }}
      >
        <Icon name="close" size={13} />
      </span>
    </button>
  );

  if (!items.length && !missed.length) return null;
  const shownCards = [...(missedOpen ? missed : []), ...items].filter((t) => t.kind !== 'saved');
  return (
    <div
      className={`toasts${typing && !missedOpen ? ' toasts-typing' : ''}`}
      aria-hidden={typing && !missedOpen ? true : undefined}
      style={missedOpen ? { maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' } : undefined}
    >
      {shownCards.length >= 2 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => markRead(shownCards)}>
            <Icon name="check-check" size={14} /> Прочитать все
          </button>
          <button className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => (missedOpen && !items.length ? setMissedOpen(false) : hideAll())}>
            <Icon name="close" size={14} /> Скрыть все
          </button>
        </div>
      )}
      {missedOpen && missed.map((t) => card(t, false))}
      {missed.length > 0 && (
        // #4830: свёрнутые «Пропущенные» — маленький значок с числом, а не карточка во всю ширину над полем ввода
        <button className={`toast${missedOpen ? '' : ' toast-missed'}`} onClick={() => setMissedOpen((v) => !v)} aria-expanded={missedOpen} aria-label={`Пропущенные уведомления: ${missed.length}`} title={missedOpen ? 'Свернуть' : 'Пропущенные уведомления — показать, что пришло, пока вас не было'}>
          <Icon name="bell" size={16} />
          {missedOpen ? (
            <span className="toast-text">
              <span className="toast-title">Пропущенные уведомления · {missed.length}</span>
              <span className="toast-body">Свернуть</span>
            </span>
          ) : <span className="toast-missed-n">{missed.length}</span>}
          <span
            className="toast-close"
            role="button"
            aria-label="Очистить пропущенные"
            title="Очистить"
            onClick={(e) => { e.stopPropagation(); setMissed([]); setMissedOpen(false); }}
          >
            <Icon name="close" size={13} />
          </span>
        </button>
      )}
      {items.map((t) => card(t, true))}
    </div>
  );
}
