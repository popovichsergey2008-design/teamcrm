import { useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { navigate } from '../../lib/router';
import { SERVICE_COUNT, SERVICES, serviceDefaults, servicePrompt, type Service, type ServiceGroup } from './bot-services';
import './bot-v3.css';

type Conn = { mail: boolean; calendar: boolean; web: boolean };

/**
 * Вкладка «Что умеет бот» (#5035, п. 5): все 38 услуг в 8 группах, сверху поиск.
 * В группе — 3 главные, остальные по «+ ещё N». Вся строка нажимается; запрос сразу
 * не уходит — открывается карточка в чате (см. ServiceAsk).
 */
export default function BotServices({ conn, onPick, onConnectMail }: {
  conn: Conn; onPick: (s: Service) => void; onConnectMail: () => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const needle = q.trim().toLowerCase();
  const found = useMemo(() => (needle.length >= 2
    ? SERVICES.flatMap((g) => g.items.filter((s) => `${s.title} ${s.hint} ${g.title}`.toLowerCase().includes(needle)).map((s) => ({ g, s })))
    : null), [needle]);

  const row = (_g: ServiceGroup, s: Service) => {
    const plan = s.needs === 'web' && !conn.web;
    return (
      <button key={s.id} type="button" className="bv-svc" onClick={() => onPick(s)}>
        <span className="bv-svc-text">
          <span className="bv-svc-title">{s.title}</span>
          <span className="bv-svc-hint">{s.hint}</span>
        </span>
        {plan && <span className="bv-badge bv-badge-plan">«Расширенный»</span>}
        {s.partial && <span className="bv-badge">частично</span>}
        <Icon name="chevron-right" size={16} />
      </button>
    );
  };

  return (
    <div className="bv-pane" aria-label="Что умеет бот">
      <h2 className="bv-h">Что умеет бот</h2>
      <p className="bv-sub">{SERVICE_COUNT} услуг в {SERVICES.length} группах. Нажмите на услугу — бот покажет, что сделает, и спросит недостающее. Без вашего «да» ничего не создаётся.</p>
      <label className="bv-search">
        <Icon name="search" size={15} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти услугу: например, «отчёт», «встреча», «письмо»" aria-label="Найти услугу" />
      </label>
      {found ? (
        <div className="bv-group bv-found">
          {found.length ? found.map(({ g, s }) => row(g, s)) : <div className="bv-empty">Такой услуги нет — спросите бота своими словами во вкладке «Чат».</div>}
        </div>
      ) : (
        <div className="bv-grid">
          {SERVICES.map((g) => {
            const mailOff = g.id === 'mail' && !conn.mail;
            const shown = open[g.id] ? g.items : g.items.slice(0, 3);
            const rest = g.items.length - 3;
            return (
              <section key={g.id} className="bv-group">
                <header className="bv-group-head">
                  <span className="bv-emoji" aria-hidden="true">{g.emoji}</span>
                  <b>{g.title}</b>
                  {mailOff && <span className="bv-badge bv-badge-connect">подключить</span>}
                  <span className="bv-n">{g.items.length}</span>
                </header>
                {shown.map((s) => row(g, s))}
                {mailOff && (
                  <button type="button" className="ui-btn ui-btn-primary ui-btn-sm bv-connect" onClick={onConnectMail}>Подключить почту — 20 сек</button>
                )}
                {rest > 0 && (
                  <button type="button" className="bv-more" aria-expanded={!!open[g.id]} onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}>
                    {open[g.id] ? 'свернуть' : `+ ещё ${rest}`} <Icon name={open[g.id] ? 'chevron-up' : 'chevron-down'} size={12} />
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Карточка услуги в чате (#5035, макет 4): что бот сделает, параметры чипами, кнопка
 * действия и «Изменить текст запроса». Запрос уходит только по кнопке.
 */
export function ServiceAsk({ service: s, conn, onRun, onCancel, onConnectMail, onMatrix, onSupport }: {
  service: Service; conn: Conn;
  onRun: (text: string) => void; onCancel: () => void; onConnectMail: (resume: string) => void;
  onMatrix: () => void; onSupport: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => serviceDefaults(s));
  const [edit, setEdit] = useState<string | null>(null);
  const text = servicePrompt(s, values);
  const missing = (s.params ?? []).some((x) => x.text !== undefined && x.def === undefined && !values[x.key]?.trim());
  const needMail = s.needs === 'mail' && !conn.mail;
  const needWeb = s.needs === 'web' && !conn.web;
  const go = () => {
    if (s.action === 'matrix') { onMatrix(); return; }
    if (s.action === 'support') { onSupport(); return; }
    if (needMail) { onConnectMail(edit ?? text); return; }
    onRun(edit ?? text);
  };
  return (
    <>
      <div className="anthill-msg anthill-user"><div className="anthill-body">{s.title}</div></div>
      <div className="bv-ask" role="group" aria-label={`Услуга «${s.title}»`}>
        <div className="bv-ask-lead">{s.lead ?? s.title}.{(s.params ?? []).length ? ' Проверьте:' : ''}</div>
        {(s.params ?? []).length > 0 && (
          <div className="bv-ask-params">
            {(s.params ?? []).map((x) => (x.options ? (
              <label key={x.key} className="bv-chip">
                <span>{x.label}:</span>
                <select value={values[x.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [x.key]: e.target.value }))} aria-label={x.label}>
                  {x.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            ) : (
              <label key={x.key} className="bv-chip bv-chip-text">
                <span>{x.label}:</span>
                <input value={values[x.key] ?? ''} placeholder={x.text} onChange={(e) => setValues((v) => ({ ...v, [x.key]: e.target.value }))} aria-label={x.label} />
              </label>
            )))}
          </div>
        )}
        {s.note && <div className="bv-ask-note">{s.note}</div>}
        {needMail && <div className="bv-ask-note">Нужна почта — подключим за 20 секунд, затем выполню эту просьбу.</div>}
        {needWeb && <div className="bv-ask-note">Нужен тариф «Расширенный» — в нём бот ходит в интернет. <button type="button" className="link-btn" onClick={() => navigate({ section: 'settings', tab: 'ai-plan' })}>Тариф и ИИ</button></div>}
        {edit !== null && <textarea className="input bv-ask-edit" rows={3} value={edit} onChange={(e) => setEdit(e.target.value)} aria-label="Текст запроса" />}
        <div className="bv-ask-acts">
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={needWeb || (missing && edit === null)} onClick={go}>
            {needMail ? 'Подключить почту' : s.run ?? 'Запустить'}
          </button>
          {!s.action && edit === null && <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setEdit(text)}>Изменить текст запроса</button>}
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onCancel}>Отмена</button>
        </div>
        <div className="bv-ask-foot">Пока не нажмёте кнопку — ничего не отправлено и не создано.</div>
      </div>
    </>
  );
}
