import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';

/**
 * Переписка глазами внешнего участника.
 *
 * Человек со стороны открывает ссылку и попадает ровно в один разговор: без учётной
 * записи, без задач, проектов и остальной переписки. Всё, что он видит, — этот чат;
 * всё, что видят про него сотрудники, — имя, которым он представился.
 *
 * Обновление опросом, а не сокетом: у гостя нет учётной записи, а тянуть ради него
 * авторизацию в реальном времени — лишний механизм там, где разговор идёт минутами,
 * а не миллисекундами.
 */
const POLL_MS = 5000;

export function GuestChat({ token, orgName }: { token: string; orgName?: string | null }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const feedRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    api.guestChatMessages(token)
      .then(setMessages)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Разговор недоступен'));
  }, [token]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // лента всегда внизу: читают последнее, а не начало переписки
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBody(''); setBusy(true);
    try {
      const sent = await api.guestChatSend(token, text);
      setMessages((prev) => [...prev, sent]);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Сообщение не отправлено');
      setBody(text);
    } finally { setBusy(false); }
  };

  return (
    <div className="guest-chat">
      <div className="chat-head">
        <span><Icon name="chat" size={15} /> <b>Переписка{orgName ? ` · ${orgName}` : ''}</b></span>
      </div>

      <div className="chat-feed" ref={feedRef}>
        {messages.length === 0 && (
          <div className="dim" style={{ padding: 12 }}>
            Здесь будет переписка. Напишите первым — вам ответят.
          </div>
        )}
        {messages.map((m) => {
          // своё сообщение узнаём по имени гостя: учётной записи у него нет
          const mine = !!m.guest_name;
          return (
            <div key={m.id} className={`chat-line ${mine ? 'mine' : ''}`}>
              <div className={`chat-msg ${mine ? 'mine' : ''}`}>
                <div className="chat-author">{m.guest_name ?? m.author_name ?? 'Сотрудник'}</div>
                <div className="chat-body">{m.body}</div>
              </div>
              <div className="chat-time">
                {new Date(m.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          );
        })}
      </div>

      {err && <div className="error-text" style={{ padding: '0 12px' }}>{err}</div>}

      <div className="chat-input">
        <input
          className="input"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Сообщение…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="btn btn-primary btn-sm" onClick={send} disabled={busy || !body.trim()} title="Отправить">
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}
