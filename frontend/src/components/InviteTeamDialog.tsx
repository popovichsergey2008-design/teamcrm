import { useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import { parseEmails } from '../lib/emails';

interface Result {
  email: string;
  ok: boolean;
  link?: string;
  error?: string;
}

/**
 * Позвать команду (ТЗ-11, разд. 24–26).
 *
 * Почты вводятся СПИСКОМ, а не по одной: их копируют из письма, из таблицы, из чата —
 * и вводить пятерых через одно поле с кнопкой «пригласить» человек бросает на третьем.
 *
 * Результат показываем по каждому адресу отдельно: часть приглашений почти всегда не
 * уходит — кто-то уже в компании, где-то опечатка. Одно общее «не получилось» заставило
 * бы начинать заново и звать тех, кого уже позвали.
 *
 * Ссылку отдаём рядом с каждым адресом: почта может быть не настроена или письмо уйдёт
 * в спам, и тогда её передают в мессенджере — этим же окном.
 */
export function InviteTeamDialog({ onClose, onDone }: {
  onClose: () => void;
  /** Позвали хотя бы одного: шаг пути закрывается, список команды перечитывается. */
  onDone: () => void;
}) {
  useEscape(onClose);
  const [text, setText] = useState('');
  const [role, setRole] = useState('member');
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const emails = parseEmails(text);

  const send = async () => {
    if (!emails.length) { setErr('Введите хотя бы один адрес'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.inviteMany(emails, role);
      setResults(r.results);
      if (r.results.some((x) => x.ok)) onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Приглашения не отправились');
    } finally { setBusy(false); }
  };

  const [copied, setCopied] = useState('');
  const copy = (email: string, link: string) => {
    void navigator.clipboard?.writeText(link)
      .then(() => { setCopied(email); window.setTimeout(() => setCopied(''), 2000); })
      .catch(() => setErr('Буфер обмена недоступен — ссылка в поле ниже'));
  };

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
      <div className="modal-card onb-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="users" size={16} /> Пригласить команду</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        {!results && (
          <>
            <div className="field">
              <label htmlFor="inv-emails">Почты сотрудников</label>
              <textarea
                id="inv-emails"
                className="input"
                rows={5}
                value={text}
                placeholder={'petr@company.ru\nolga@company.ru, ivan@company.ru'}
                onChange={(e) => setText(e.target.value)}
              />
              <span className="dim tpl-hint">
                По одной в строке или через запятую — как удобнее скопировать.
                {emails.length > 0 && ` Распознали адресов: ${emails.length}.`}
              </span>
            </div>

            <div className="field">
              <label htmlFor="inv-role">Роль</label>
              <select id="inv-role" className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="member">Сотрудник — работает в своих проектах и задачах</option>
                <option value="manager">Руководитель — ведёт проекты и команду</option>
              </select>
              <span className="dim tpl-hint">Роль можно изменить позже в разделе «Команда».</span>
            </div>

            {err && <div className="error-text">{err}</div>}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Отмена</button>
              <button className="btn btn-primary" onClick={send} disabled={busy || !emails.length}>
                {busy ? 'Отправляю…' : emails.length > 1 ? `Пригласить (${emails.length})` : 'Пригласить'}
              </button>
            </div>
          </>
        )}

        {results && (
          <>
            <div className="dim tpl-hint">
              Каждому ушло письмо со ссылкой. Если почта не дойдёт, ссылку можно скопировать
              и передать любым другим способом — она одноразовая и действует неделю.
            </div>
            <ul className="inv-results">
              {results.map((r) => (
                <li key={r.email} className={r.ok ? 'inv-ok' : 'inv-fail'}>
                  <Icon name={r.ok ? 'check-circle' : 'alert'} size={15} />
                  <span className="inv-email">{r.email}</span>
                  {r.ok
                    ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => r.link && copy(r.email, r.link)}>
                        {copied === r.email ? 'Скопировано' : 'Скопировать ссылку'}
                      </button>
                    )
                    : <span className="dim inv-error">{r.error}</span>}
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setResults(null); setText(''); }}>Позвать ещё</button>
              <button className="btn btn-primary" onClick={onClose}>Готово</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
