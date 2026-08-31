import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';

interface GuestLink {
  id: string;
  room_id: string;
  label: string | null;
  expires_at: string;
  uses: number;
  last_used_at: string | null;
  author: string | null;
  /** Разговор, ради которого ссылка выдана: через неделю «для кого» уже загадка. */
  chat_title?: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

/**
 * Встречи с внешними гостями.
 *
 * Нужна ровно из-за сценария «ссылку отправили заранее»: гость придёт в КОНКРЕТНУЮ
 * комнату и будет ждать там, а начатый заново созвон — это другая комната, и человек
 * за дверью так и останется один. Отсюда кнопка «Войти» рядом с каждой ссылкой.
 *
 * Скопировать адрес повторно нельзя намеренно: в базе лежит только хэш токена —
 * ссылку невозможно ни подсмотреть через доступ к базе, ни восстановить. Потеряли —
 * выпускайте новую, старую отзовите.
 */
export function GuestMeetsPanel({ onEnter }: { onEnter: (roomId: string) => void }) {
  const [links, setLinks] = useState<GuestLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /** Срок действия: клиенту ссылку шлют и на завтра, и на следующую неделю. */
  const [ttl, setTtl] = useState('24');

  const reload = useCallback(
    () => api.listGuestLinks().then(setLinks).catch(() => undefined).finally(() => setLoaded(true)),
    [],
  );
  useEffect(() => { void reload(); }, [reload]);

  const create = async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await api.createGuestLink({
        label: label.trim() || undefined,
        ttlHours: Number(ttl) || 24,
      });
      setFresh({ id: r.id, url: r.url });
      setLabel('');
      setCopied(false);
      try { await navigator.clipboard.writeText(r.url); setCopied(true); } catch { /* покажем адрес */ }
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать ссылку');
    } finally {
      setBusy(false);
    }
  };

  const enter = async (id: string) => {
    setErr('');
    try {
      const r = await api.openGuestLink(id);
      onEnter(r.roomId);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось открыть встречу');
    }
  };

  const revoke = async (id: string) => {
    setErr('');
    try {
      const r = await api.revokeGuestLink(id);
      if (fresh?.id === id) setFresh(null);
      if (r.kicked > 0) setErr(`Ссылка отозвана, гостей выведено из встречи: ${r.kicked}`);
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось отозвать ссылку');
    }
  };

  return (
    <section className="card guest-links">
      <h3><Icon name="link" size={16} /> Встречи с гостями</h3>
      <p className="dim" style={{ fontSize: 12, marginTop: -4 }}>
        Ссылку можно отправить заранее: клиент откроет её в браузере, без регистрации,
        и будет ждать в комнате ожидания, пока вы его не впустите.
      </p>

      <div className="guest-links-new">
        <input
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Для кого — например, «ООО Вектор»"
          maxLength={120}
        />
        <select className="input" value={ttl} onChange={(e) => setTtl(e.target.value)} aria-label="Срок действия">
          <option value="4">4 часа</option>
          <option value="24">Сутки</option>
          <option value="72">3 дня</option>
          <option value="168">Неделя</option>
          <option value="720">30 дней</option>
        </select>
        <button className="btn btn-primary btn-sm" onClick={create} disabled={busy}>
          <Icon name="plus" size={15} /> Создать ссылку
        </button>
      </div>

      {fresh && (
        <div className="pnl-good guest-links-fresh">
          <Icon name="check-circle" size={15} />
          <span>
            {copied ? 'Ссылка скопирована — отправьте её гостю. ' : 'Скопируйте ссылку и отправьте гостю. '}
            <b>Второй раз показать её нельзя</b> — в базе хранится только отпечаток.
          </span>
          <code className="guest-links-url">{fresh.url}</code>
        </div>
      )}

      {err && <div className="error-text">{err}</div>}

      {!loaded ? null : links.length === 0 ? (
        <p className="dim">Действующих гостевых ссылок нет.</p>
      ) : (
        <ul className="guest-links-list">
          {links.map((l) => (
            <li key={l.id}>
              <span className="guest-links-who">
                <b>{l.label || 'Без подписи'}</b>
                <span className="dim">
                  {l.chat_title ? `для чата «${l.chat_title}» · ` : ''}
                  до {when(l.expires_at)}
                  {l.uses > 0 ? ` · входов: ${l.uses}` : ' · ещё не входили'}
                  {l.author ? ` · ${l.author}` : ''}
                </span>
              </span>
              <span className="guest-links-actions">
                <button className="btn btn-sm" onClick={() => enter(l.id)} title="Войти в ту же комнату, куда придёт гость">
                  <Icon name="phone" size={15} /> Войти
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => revoke(l.id)} title="Отозвать: гость по этой ссылке больше не войдёт, а сидящий сейчас — выйдет">
                  Отозвать
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
