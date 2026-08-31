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
export function GuestLinkButton({ chats = [], chatId, compact }: {
  /** Чаты для выбора: ссылка подписывается разговором, ради которого выдана. */
  chats?: ChatOption[];
  /** Открыли из конкретного чата — он и предлагается по умолчанию. */
  chatId?: string | null;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [forChat, setForChat] = useState(chatId ?? '');
  const [ttl, setTtl] = useState('24');
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
      });
      setUrl(r.url);
      // Копируем сразу: адрес показывается один раз — в базе только его отпечаток.
      try { await navigator.clipboard.writeText(r.url); setCopied(true); } catch { /* покажем текстом */ }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать ссылку');
    } finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setErr('Скопируйте адрес вручную'); }
  };

  const close = () => { setOpen(false); setUrl(''); setLabel(''); setErr(''); setCopied(false); };

  return (
    <span className="guest-link-btn" ref={boxRef}>
      <button
        className={`btn btn-sm ${compact ? 'btn-ghost' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Ссылка для человека со стороны: он войдёт в браузере, без регистрации"
      >
        <Icon name="link" size={15} /> {compact ? 'Ссылка' : 'Внешняя ссылка'}
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
              <select className="input" style={{ marginTop: 6 }} value={ttl} onChange={(e) => setTtl(e.target.value)}>
                <option value="4">Действует 4 часа</option>
                <option value="24">Действует сутки</option>
                <option value="72">Действует 3 дня</option>
                <option value="168">Действует неделю</option>
                <option value="720">Действует 30 дней</option>
              </select>
              {err && <div className="error-text">{err}</div>}
              <button className="btn btn-primary btn-sm guest-link-go" onClick={create} disabled={busy}>
                {busy ? 'Создаю…' : 'Создать ссылку'}
              </button>
            </>
          ) : (
            <>
              <div className="dim" style={{ fontSize: 12 }}>
                {copied ? 'Ссылка скопирована — отправьте её гостю. ' : 'Скопируйте и отправьте гостю. '}
                <b>Второй раз показать её нельзя</b>: в базе хранится только отпечаток.
              </div>
              <code className="guest-links-url">{url}</code>
              {err && <div className="error-text">{err}</div>}
              <div className="team-rate" style={{ marginTop: 6 }}>
                <button className="btn btn-primary btn-sm" onClick={copy}>
                  <Icon name="copy" size={14} /> Копировать
                </button>
                <button className="btn btn-ghost btn-sm" onClick={close}>Готово</button>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
