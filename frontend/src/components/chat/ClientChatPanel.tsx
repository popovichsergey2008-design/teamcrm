import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { ApiError } from '../../lib/api';
import { overlayProps } from '../../lib/overlay';
import { useEscape } from '../../hooks/useEscape';
import { confirmAction } from '../ui/dialog';
import { Candidate, ClientOverview, clientChatApi } from './client-chat-api';
import './client-chat-panel.css';

const MigrationImport = lazy(() => import('../../pages/migration/MigrationImport'));

const DAYS = [7, 30, 90, 365];
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });

/**
 * «Клиент в чате» в «Сведениях» внешнего чата (#4902, п. 15).
 *
 * Ссылка для клиента без регистрации: он видит только этот разговор и статусы задач,
 * которые здесь ему открыли, и может позвонить. Отзыв — сразу: и переписка, и созвон.
 * Внизу — переход к переезду из Slack и Telegram (п. 4).
 */
export default function ClientChatPanel({ chatId }: { chatId: string }) {
  const [data, setData] = useState<ClientOverview | null>(null);
  const [err, setErr] = useState('');
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(90);
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [migration, setMigration] = useState(false);

  const load = useCallback(() => {
    clientChatApi.overview(chatId).then((d) => { setData(d); setErr(''); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не загрузилось'));
  }, [chatId]);
  useEffect(() => { setData(null); setMade(null); load(); }, [load]);

  const create = async () => {
    setBusy(true); setErr(''); setCopied(false);
    try {
      const r = await clientChatApi.createLink(chatId, { label: label.trim() || undefined, days });
      setMade(r.url); setLabel(''); load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ссылка не создалась'); } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!made) return;
    try { await navigator.clipboard.writeText(made); setCopied(true); } catch { setCopied(false); }
  };

  if (!data) return <div className={err ? 'error-text' : 'dim'}>{err || 'Загружаю…'}</div>;

  return (
    <div className="ccp">
      <p className="dim ccp-note">Клиент входит по ссылке без регистрации: видит только этот чат и статусы открытых ему задач, может позвонить.</p>

      <div className="ccp-row">
        <input className="input ccp-grow" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="Для кого: «ООО Вектор»" aria-label="Для кого ссылка" />
        <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Срок ссылки">
          {DAYS.map((d) => <option key={d} value={d}>{d === 365 ? 'год' : `${d} дн.`}</option>)}
        </select>
      </div>
      <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void create()} disabled={busy}>
        <Icon name="link" size={13} /> {busy ? 'Создаю…' : 'Ссылка для клиента'}
      </button>
      {made && (
        <div className="ccp-made">
          <code className="ccp-url">{made}</code>
          <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Скопировано' : 'Копировать'}</button>
          <span className="dim">Ссылка показывается один раз — сохраните или отправьте клиенту.</span>
        </div>
      )}
      {err && <div className="error-text">{err}</div>}

      {data.links.length > 0 && (
        <ul className="ccp-list" aria-label="Действующие ссылки">
          {data.links.map((l) => (
            <li key={l.id} className="ccp-item">
              <span className="ccp-grow">
                <b>{l.label || 'Ссылка для клиента'}</b>
                <span className="dim"> · до {date(l.expiresAt)} · входили: {l.guests}{l.author ? ` · ${l.author}` : ''}</span>
              </span>
              {l.canRevoke && (
                <button
                  className="ui-btn ui-btn-ghost ui-btn-sm" title="Отозвать: клиент сразу потеряет доступ к чату и созвону"
                  onClick={async () => {
                    if (!await confirmAction({ title: 'Отозвать ссылку?', description: 'Клиент сразу потеряет доступ к переписке и выйдет из созвона.', confirmLabel: 'Отозвать', danger: true })) return;
                    try { await clientChatApi.revokeLink(l.id); load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не отозвалось'); }
                  }}
                >Отозвать</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="ccp-sub">
        <b>Задачи, открытые клиенту</b>
        {data.tasks.length > 0 && <span className="dim"> · {data.summary}</span>}
      </div>
      {data.tasks.length === 0 && <div className="dim">Пока ни одной — клиент увидит только переписку.</div>}
      <ul className="ccp-list">
        {data.tasks.map((t) => (
          <li key={t.id} className="ccp-item">
            <span className="ccp-grow">{t.title} <span className="dim">· {t.statusLabel}{t.deadline && t.status !== 'done' ? `, срок ${date(t.deadline)}` : ''}</span></span>
            <button
              className="ui-btn ui-btn-ghost ui-btn-sm" title="Скрыть от клиента" aria-label={`Скрыть «${t.title}» от клиента`}
              onClick={async () => { try { await clientChatApi.closeTask(chatId, t.id); load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } }}
            ><Icon name="eye-off" size={13} /></button>
          </li>
        ))}
      </ul>
      {picking
        ? <TaskPicker chatId={chatId} onDone={() => { setPicking(false); load(); }} />
        : <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setPicking(true)}><Icon name="plus" size={13} /> Открыть задачу клиенту</button>}

      <button className="ui-btn ui-btn-ghost ui-btn-sm ccp-migr" onClick={() => setMigration(true)}>
        <Icon name="upload" size={13} /> Переезд из Slack и Telegram
      </button>
      {migration && <MigrationDrawer onClose={() => setMigration(false)} />}
    </div>
  );
}

function TaskPicker({ chatId, onDone }: { chatId: string; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Candidate[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => {
      clientChatApi.candidates(chatId, q.trim()).then(setList).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не загрузилось'));
    }, q ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [chatId, q]);
  const open = async (id: string) => {
    try { await clientChatApi.openTask(chatId, id); setList((l) => l?.filter((x) => x.id !== id) ?? l); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не открылось'); }
  };
  return (
    <div className="ccp-picker">
      <div className="ccp-row">
        <input className="input ccp-grow" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название или номер задачи" aria-label="Найти задачу" />
        <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onDone}>Готово</button>
      </div>
      {err && <div className="error-text">{err}</div>}
      {!list && <div className="dim">Ищу…</div>}
      {list && !list.length && <div className="dim">{q ? 'Не нашлось' : 'Задач чата и его проекта нет — найдите по названию'}</div>}
      <ul className="ccp-list">
        {list?.map((t) => (
          <li key={t.id} className="ccp-item">
            <span className="ccp-grow">{t.title} <span className="dim">· {t.statusLabel}{t.project ? ` · ${t.project}` : ''}</span></span>
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void open(t.id)}>Открыть</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MigrationDrawer({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Переезд из Slack и Telegram">
        <div className="drawer-head">
          <h3><Icon name="upload" size={18} /> Переезд из Slack и Telegram</h3>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть" aria-label="Закрыть"><Icon name="close" /></button>
        </div>
        <Suspense fallback={<div className="dim">Загружаю…</div>}><MigrationImport /></Suspense>
      </aside>
    </div>
  );
}
