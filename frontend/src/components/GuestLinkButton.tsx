import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';

interface ChatOption {
  id: string;
  title: string;
}

/**
 * «Внешняя ссылка» — позвать человека со стороны, не заводя ему учётную запись.
 *
 * Раньше ссылка выдавалась в двух местах, и оба находились не там, где о ней думают:
 * внутри уже идущего созвона (когда гость нужен «прямо сейчас») и на вкладке встреч
 * (среди разбора записей). А зовут клиента обычно заранее и из разговора, который
 * с ним и ведут, — поэтому кнопка стоит в шапке раздела и знает про чаты.
 *
 * Ссылка ведёт в отдельную переговорную и больше никуда: гость не получает ни учётной
 * записи, ни доступа к проектам, ни к остальной переписке. Он ждёт в комнате ожидания,
 * пока его не впустят, а отзыв ссылки выводит его немедленно.
 */
export function GuestLinkButton({ chats = [], chatId, compact, label: caption }: {
  /** Чаты для выбора: ссылка подписывается разговором, ради которого выдана. */
  chats?: ChatOption[];
  /** Открыли из конкретного чата — он и предлагается по умолчанию. */
  chatId?: string | null;
  compact?: boolean;
  /** Подпись задаёт место: в тесной панели рядом с «Созвоном» хватает одного слова. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [forChat, setForChat] = useState(chatId ?? '');
  const [ttl, setTtl] = useState('24');
  /**
   * Когда встреча (datetime-local, по часам сотрудника). Пусто — ссылка открыта сразу.
   * С ним гость до начала видит время и отсчёт, а нам за 10 минут напомнят открыть
   * комнату: впустить гостя может только тот, кто внутри.
   */
  const [startsAt, setStartsAt] = useState('');
  const [made, setMade] = useState<{ startsAt: string | null } | null>(null);
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setForChat(chatId ?? ''); }, [chatId]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const create = async () => {
    setBusy(true); setErr(''); setCopied(false);
    try {
      const r = await api.createGuestLink({
        label: label.trim() || undefined,
        chatId: forChat || undefined,
        ttlHours: Number(ttl) || 24,
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
      });
      setUrl(r.url);
      setMade({ startsAt: r.startsAt ?? null });
      // Копируем сразу: адрес показывается один раз — в базе только его отпечаток.
      try { await navigator.clipboard.writeText(r.url); setCopied(true); } catch { /* покажем текстом */ }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать ссылку');
    } finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setErr('Скопируйте адрес вручную'); }
  };

  const close = () => {
    setOpen(false); setUrl(''); setLabel(''); setErr(''); setCopied(false); setStartsAt(''); setMade(null);
  };

  return (
    <span className="guest-link-btn" ref={boxRef}>
      <button
        className={`ui-btn ui-btn-sm ${compact ? 'ui-btn-ghost' : 'ui-btn-outline'}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Ссылка для человека со стороны: он войдёт в браузере, без регистрации"
      >
        <Icon name="link" size={15} /> {caption ?? (compact ? 'Ссылка' : 'Внешняя ссылка')}
      </button>

      {open && (
        <div className="guest-link-pop" role="dialog" aria-label="Ссылка для внешнего участника">
          <div className="call-starter-head">Ссылка для внешнего участника</div>

          {!url ? (
            <>
              <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
                Гость откроет её в браузере и будет ждать, пока вы впустите. Ничего, кроме
                этого разговора, он не увидит.
              </div>
              <input
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Для кого — например, «ООО Вектор»"
                maxLength={120}
                autoFocus
              />
              {chats.length > 0 && (
                <select className="input" style={{ marginTop: 6 }} value={forChat} onChange={(e) => setForChat(e.target.value)}>
                  <option value="">— без привязки к чату —</option>
                  {chats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              )}
              <label className="guest-link-when">
                <span className="dim">Когда встреча (необязательно)</span>
                <input
                  className="input"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              </label>
              {startsAt && (
                <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                  Гость увидит время и отсчёт, войти сможет за 15 минут. Вам за 10 минут напомним открыть комнату.
                </div>
              )}
              <select className="input" style={{ marginTop: 6 }} value={ttl} onChange={(e) => setTtl(e.target.value)}>
                <option value="4">Действует 4 часа</option>
                <option value="24">Действует сутки</option>
                <option value="72">Действует 3 дня</option>
                <option value="168">Действует неделю</option>
                <option value="720">Действует 30 дней</option>
              </select>
              {err && <div className="error-text">{err}</div>}
              <button className="ui-btn ui-btn-primary ui-btn-sm guest-link-go" onClick={create} disabled={busy}>
                {busy ? 'Создаю…' : 'Создать ссылку'}
              </button>
            </>
          ) : (
            <>
              <div className="dim" style={{ fontSize: 12 }}>
                {copied ? 'Ссылка скопирована — отправьте её гостю. ' : 'Скопируйте и отправьте гостю. '}
                <b>Второй раз показать её нельзя</b>: в базе хранится только отпечаток.
              </div>
              {made?.startsAt && <MeetingNote at={made.startsAt} />}
              <code className="guest-links-url">{url}</code>
              {err && <div className="error-text">{err}</div>}
              <div className="team-rate" style={{ marginTop: 6 }}>
                <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={copy}>
                  <Icon name="copy" size={14} /> Копировать
                </button>
                <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={close}>Готово</button>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}

/** «Встреча 2 октября в 09:00 — за 10 минут напомним открыть комнату». */
function MeetingNote({ at }: { at: string }) {
  const when = new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
      <Icon name="calendar" size={13} /> Встреча {when}. За 10 минут напомним открыть комнату, а если гость
      придёт раньше вас — сразу сообщим.
    </div>
  );
}

/**
 * Ссылка для гостя из события календаря.
 *
 * Время и комната — из события: «Войти в созвон» в нём ведёт туда же, куда придёт
 * гость. Иначе сотрудники собирались бы по календарю в одной комнате, а гость ждал бы
 * в другой.
 */
export function EventGuestLinkButton({ eventId, onRoom }: {
  eventId: string;
  /** У события появилась комната (раньше её не было) — показать «Войти в созвон». */
  onRoom?: (roomId: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [at, setAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.createGuestLink({ eventId });
      setUrl(r.url); setAt(r.startsAt ?? null);
      onRoom?.(r.roomId);
      try { await navigator.clipboard.writeText(r.url); setCopied(true); } catch { /* покажем текстом */ }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать ссылку');
    } finally { setBusy(false); }
  };

  if (!url) {
    return (
      <>
        <button
          className="ui-btn ui-btn-outline ui-btn-sm"
          onClick={create}
          disabled={busy}
          title="Ссылка для человека со стороны: он войдёт в браузере, без регистрации, в комнату этой встречи"
        >
          <Icon name="link" size={14} /> {busy ? 'Создаю…' : 'Ссылка для гостя'}
        </button>
        {err && <div className="error-text">{err}</div>}
      </>
    );
  }
  return (
    <div className="event-guest-link">
      <div className="dim" style={{ fontSize: 12 }}>
        {copied ? 'Ссылка скопирована — отправьте её гостю. ' : 'Скопируйте и отправьте гостю. '}
        Второй раз показать её нельзя.
      </div>
      <code className="guest-links-url">{url}</code>
      {at && <MeetingNote at={at} />}
      {!copied && (
        <button
          className="ui-btn ui-btn-primary ui-btn-sm"
          onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setErr('Скопируйте адрес вручную'); } }}
        >
          <Icon name="copy" size={14} /> Копировать
        </button>
      )}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
