import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import type { MailAccount, MailCategory, MailMessage, MailProvider } from '../lib/api';
import { overlayProps } from '../lib/overlay';
import { Select } from './ui/select';
import { confirmAction } from './ui/dialog';

const PROVIDER_LABEL: Record<string, string> = {
  gmail: 'Gmail', yandex: 'Яндекс Почта', mailru: 'Mail.ru', outlook: 'Outlook / Microsoft 365', custom: 'Другой сервер (IMAP)',
};

const CATEGORY: { key: MailCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'critical', label: 'Важно' },
  { key: 'action', label: 'Требуют действия' },
  { key: 'client', label: 'От клиентов' },
  { key: 'invoice', label: 'Счета' },
  { key: 'fyi', label: 'К сведению' },
  { key: 'newsletter', label: 'Рассылки' },
];

/**
 * Личная почта (ТЗ-18, §8.1–8.2).
 *
 * Ящик подключается паролем приложения; письма забираются раз в 5 минут и
 * разбираются по категориям правилами. Ответить можно через QEVO Bot: «ответь на
 * письмо #N» — черновик ляжет в «Черновики» ящика, отправка — только по кнопке.
 * Ящик личный: его письма не видит никто, включая владельца организации.
 */
export function MailPanel({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [providers, setProviders] = useState<MailProvider[]>([]);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [cat, setCat] = useState<MailCategory | 'all'>('all');
  const [open, setOpen] = useState<(MailMessage & { body: string }) | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ provider: 'gmail', email: '', password: '', imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '465' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.mailAccounts().then((a) => { setAccounts(a); if (!a.length) setAdding(true); }).catch(() => setAccounts([]));
    api.mailMessages().then(setMessages).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    api.mailProviders().then(setProviders).catch(() => undefined);
  }, [load]);

  const connect = async () => {
    setBusy(true); setErr('');
    try {
      await api.mailConnect({
        provider: form.provider, email: form.email.trim(), password: form.password,
        ...(form.provider === 'custom' ? {
          imapHost: form.imapHost.trim(), imapPort: Number(form.imapPort), smtpHost: form.smtpHost.trim(), smtpPort: Number(form.smtpPort),
        } : {}),
      });
      setForm((f) => ({ ...f, email: '', password: '' }));
      setAdding(false);
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подключить ящик'); }
    finally { setBusy(false); }
  };

  const disconnect = async (a: MailAccount) => {
    if (!(await confirmAction({ title: `Отключить ${a.email}?`, description: 'Разобранные письма из QEVO удалятся. В самом ящике ничего не изменится.', danger: true }))) return;
    await api.mailDisconnect(a.id).catch(() => undefined);
    load();
  };

  const hint = providers.find((p) => p.id === form.provider)?.hint;
  const shown = cat === 'all' ? messages : messages.filter((m) => m.category === cat);

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="mail" size={18} /> Почта</h3>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="anthill-pane">
          <div className="dim">
            Секретарь разбирает ваш ящик: важное, требующее ответа, письма клиентов, счета. Ответить можно через
            QEVO Bot — «ответь на письмо #12»: черновик ляжет в «Черновики» вашего ящика, отправка — только по
            вашей кнопке. Письма видите только вы.
          </div>

          {accounts?.map((a) => (
            <div key={a.id} className="anthill-card anthill-task">
              <div className="anthill-task-top">
                <span className="anthill-task-title">{a.email}</span>
                <span className={`ui-badge ${a.status === 'ok' ? 'ui-badge-ok' : 'ui-badge-warn'}`}>{a.status === 'ok' ? 'подключён' : 'ошибка'}</span>
              </div>
              <div className="dim anthill-task-what">
                {PROVIDER_LABEL[a.provider] ?? a.provider}
                {a.lastSyncAt ? ` · проверено ${new Date(a.lastSyncAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
              </div>
              {a.lastError && <div className="error-text">{a.lastError}</div>}
              <div className="anthill-task-acts">
                <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { void disconnect(a); }}>Отключить</button>
              </div>
            </div>
          ))}

          {!adding && (
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={13} /> Подключить ящик</button>
          )}

          {adding && (
            <div className="anthill-card">
              <div className="anthill-group-head">Подключить ящик</div>
              <Select
                ariaLabel="Почтовик"
                value={form.provider}
                onValueChange={(v) => setForm((f) => ({ ...f, provider: v }))}
                options={Object.entries(PROVIDER_LABEL).map(([value, label]) => ({ value, label }))}
              />
              <input className="input" type="email" placeholder="Адрес почты" aria-label="Адрес почты" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              <input className="input" type="password" placeholder="Пароль приложения" aria-label="Пароль приложения" autoComplete="new-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
              {form.provider === 'custom' && (
                <>
                  <span className="anthill-form-acts">
                    <input className="input" placeholder="Сервер IMAP" aria-label="Сервер IMAP" value={form.imapHost} onChange={(e) => setForm((f) => ({ ...f, imapHost: e.target.value }))} />
                    <input className="input anthill-adm-num" inputMode="numeric" aria-label="Порт IMAP" value={form.imapPort} onChange={(e) => setForm((f) => ({ ...f, imapPort: e.target.value }))} />
                  </span>
                  <span className="anthill-form-acts">
                    <input className="input" placeholder="Сервер SMTP" aria-label="Сервер SMTP" value={form.smtpHost} onChange={(e) => setForm((f) => ({ ...f, smtpHost: e.target.value }))} />
                    <input className="input anthill-adm-num" inputMode="numeric" aria-label="Порт SMTP" value={form.smtpPort} onChange={(e) => setForm((f) => ({ ...f, smtpPort: e.target.value }))} />
                  </span>
                </>
              )}
              {hint && <div className="dim">{hint}</div>}
              {err && <div className="error-text">{err}</div>}
              <div className="anthill-form-acts">
                <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !form.email.trim() || !form.password} onClick={() => { void connect(); }}>
                  {busy ? 'Проверяю вход…' : 'Подключить'}
                </button>
                {!!accounts?.length && <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setAdding(false)}>Отмена</button>}
              </div>
            </div>
          )}

          {!!accounts?.length && (
            <div className="anthill-group">
              <div className="anthill-form-acts">
                <Select ariaLabel="Категория писем" size="sm" value={cat} onValueChange={(v) => setCat(v as MailCategory | 'all')} options={CATEGORY.map((c) => ({ value: c.key, label: c.label }))} />
                <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={load} title="Обновить"><Icon name="refresh" size={13} /></button>
              </div>
              {shown.length === 0 && <div className="dim">Писем здесь нет — новые появятся в течение 5 минут после прихода.</div>}
              {shown.map((m) => (
                <button key={m.id} className="anthill-card anthill-task" onClick={() => { api.mailMessage(m.id).then(setOpen).catch(() => undefined); }}>
                  <span className="anthill-task-top">
                    <span className="anthill-task-title">{m.isRead ? '' : '● '}#{m.id} {m.subject || 'Без темы'}</span>
                    <span className="dim">{m.sentAt ? new Date(m.sentAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                  </span>
                  <span className="dim anthill-task-what">
                    {m.from}{m.client ? ` · клиент ${m.client}` : ''} · {CATEGORY.find((c) => c.key === m.category)?.label}{m.reason ? ` (${m.reason})` : ''}
                  </span>
                  {open?.id === m.id && <span className="anthill-task-what">{open.body}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
