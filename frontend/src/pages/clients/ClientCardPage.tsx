import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/Avatar';
import { EmptyState } from '../../components/EmptyState';
import { SkeletonList } from '../../components/Skeleton';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { confirmAction, promptText } from '../../components/ui/dialog';
import { OptionSelect } from '../../components/ui/option-select';
import { Tabs } from '../../components/ui/tabs';
import { api, ApiError, ClientCard } from '../../lib/api';
import { initialsOf } from '../../lib/initials';
import { navigate } from '../../lib/router';
import { getSocket } from '../../lib/socket';
import { toastSaved } from '../../lib/notifications';
import { ago, dateTimeRu, HEALTH, money, SOURCE, STAGE, STATUS, STATUS_KEYS, TYPE } from './labels';
import { ContactsTab, DealsTab, NotesTab, ActivityTab, FilesTab, TasksTab, MeetingsTab, ChatsTab, ProjectsTab, ProfileTab } from './tabs';
import { QuickTaskDialog, QuickMeetingDialog, MergeDialog } from './dialogs';

type Tab = 'overview' | 'contacts' | 'deals' | 'projects' | 'tasks' | 'meetings' | 'chats' | 'files' | 'notes' | 'activity' | 'profile';

const SOURCE_RU: Record<string, string> = { manual: 'записано вручную', task: 'из задачи', meeting: 'встреча', deal: 'из сделки' };

/**
 * Карточка клиента (ТЗ-17, п. 19–42, 105): за 5 секунд — кто это, кто отвечает,
 * что сейчас, что открыто, что дальше. Шапка и сводка — одним запросом; тяжёлые
 * вкладки (файлы, вся лента, все задачи) грузятся при открытии (п. 64).
 */
export function ClientCardPage({ clientId }: { clientId: string }) {
  const [card, setCard] = useState<ClientCard | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [why, setWhy] = useState(false);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [dialog, setDialog] = useState<null | 'task' | 'meeting' | 'merge'>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setCard(await api.clientCard(clientId)); setErr(''); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть клиента'); }
  }, [clientId]);

  useEffect(() => {
    void load();
    api.clientOptions().then((o) => setUsers(o.users)).catch(() => undefined);
    const s = getSocket();
    const onEvt = (p: { clientId?: string }) => { if (!p?.clientId || String(p.clientId) === clientId) void load(); };
    const evs = ['client.updated', 'client.contact.created', 'client.contact.updated', 'client.deal.updated', 'client.archived'];
    evs.forEach((e) => s.on(e, onEvt));
    window.addEventListener('teamcrm:tasks-changed', load as () => void);
    return () => { evs.forEach((e) => s.off(e, onEvt)); window.removeEventListener('teamcrm:tasks-changed', load as () => void); };
  }, [load, clientId]);

  const patch = async (b: Record<string, unknown>) => {
    setBusy(true);
    try { setCard(await api.updateClient(clientId, b)); toastSaved(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
    finally { setBusy(false); }
  };

  if (err && !card) {
    return (
      <div className="page cl-page">
        <div className="page-head"><Button variant="ghost" size="sm" onClick={() => navigate({ section: 'clients' })}><Icon name="arrow-left" size={14} /> Клиенты</Button></div>
        <EmptyState icon="alert" title="Клиент не открывается" hint={err} />
      </div>
    );
  }
  if (!card) return <div className="page cl-page"><SkeletonList rows={6} /></div>;

  const c = card.client;
  const can = card.can;
  const primary = card.contacts.items.find((x) => x.isPrimary) ?? card.contacts.items[0];
  const openDeals = card.deals.filter((d) => !['won', 'lost'].includes(d.stage));

  /** Позвонить: телефон основного контакта — открываем через «Показать» (с журналом), затем tel:. */
  const call = async () => {
    if (!primary?.fields.phone.value) return;
    let phone = primary.fields.phone.value;
    if (primary.fields.phone.masked) {
      const reason = card.contacts.requireReason
        ? await promptText({ title: 'Зачем нужен телефон?', placeholder: 'Причину увидит владелец', confirmLabel: 'Показать', singleLine: true, minLength: 3 })
        : '';
      if (reason === null) return;
      try { phone = (await api.revealClientContact(primary.id, 'phone', reason || undefined)).value ?? ''; }
      catch (e) { setErr(e instanceof ApiError ? e.message : 'Телефон не открыт'); return; }
    }
    window.location.href = `tel:${phone.replace(/[^\d+]/g, '')}`;
  };

  const archive = async () => {
    if (c.archived) { await api.restoreClient(clientId); toastSaved('Клиент возвращён из архива'); void load(); return; }
    if (!(await confirmAction({ title: `Убрать «${c.name}» в архив?`, description: 'История, задачи, сделки и встречи сохранятся. Вернуть можно в любой момент.', confirmLabel: 'В архив' }))) return;
    await api.archiveClient(clientId); toastSaved('Клиент в архиве'); void load();
  };

  const removeForever = async () => {
    if (!(await confirmAction({ title: `Удалить «${c.name}» насовсем?`, description: 'Клиент, его контакты, заметки и файлы исчезнут без возврата. Задачи и проекты останутся без привязки.', confirmLabel: 'Удалить насовсем', danger: true }))) return;
    try { await api.deleteClient(clientId); navigate({ section: 'clients' }); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось удалить'); }
  };

  const setNextAction = async () => {
    const text = await promptText({ title: 'Следующее действие', placeholder: 'Например: прислать КП после встречи', defaultValue: c.nextAction ?? '', confirmLabel: 'Сохранить', singleLine: true });
    if (text === null) return;
    void patch({ nextAction: text, nextActionAt: null });
  };

  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'overview', label: 'Обзор' },
    { value: 'contacts', label: 'Контакты', count: card.contacts.items.length },
    ...(can.deals ? [{ value: 'deals' as Tab, label: 'Сделки', count: openDeals.length }] : []),
    { value: 'projects', label: 'Проекты', count: card.projects.length },
    { value: 'tasks', label: 'Задачи', count: card.tasks.open },
    { value: 'meetings', label: 'Встречи', count: card.meetings.upcoming.length },
    { value: 'chats', label: 'Чаты' },
    { value: 'files', label: 'Файлы' },
    { value: 'notes', label: 'Заметки' },
    { value: 'activity', label: 'Лента' },
    { value: 'profile', label: 'Профиль' },
  ];

  return (
    <div className="page cl-page">
      <div className="page-head cl-card-head">
        <Button variant="ghost" size="sm" onClick={() => navigate({ section: 'clients' })} aria-label="К списку клиентов"><Icon name="arrow-left" size={14} /> Клиенты</Button>
      </div>

      <div className="cl-body cl-card">
        {c.archived && (
          <div className="tv2-callout" role="status">
            <Icon name="archive" size={15} /> Клиент в архиве — история сохранена.
            {can.archive && <Button variant="outline" size="sm" onClick={() => void archive()}>Вернуть из архива</Button>}
          </div>
        )}
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}

        {/* Шапка: кто это и кто отвечает (п. 20) */}
        <header className="cl-hero">
          <div className="cl-hero-main">
            <span className={`cl-hero-ava${c.type === 'person' ? ' person' : ''}`} aria-hidden="true">{initialsOf(c.name)}</span>
            <div className="cl-hero-text">
              <h2 className="cl-hero-name">{c.name}</h2>
              <div className="cl-hero-meta">
                <span className="dim">{TYPE[c.type]}</span>
                {can.edit ? (
                  <OptionSelect value={c.status} onChange={(e) => void patch({ status: e.target.value })} aria-label="Статус" disabled={busy}>
                    {STATUS_KEYS.map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
                  </OptionSelect>
                ) : <Badge tone={STATUS[c.status]?.tone}>{STATUS[c.status]?.label}</Badge>}
                {c.segment && <Badge tone="outline">{c.segment}</Badge>}
                {card.health.level && <Badge tone={HEALTH[card.health.level].tone} title={card.health.signals.join(' · ')}>{HEALTH[card.health.level].label}</Badge>}
              </div>
              <div className="cl-hero-meta">
                <span className="dim">Ответственный:</span>
                {can.edit ? (
                  <OptionSelect value={c.ownerId ?? ''} onChange={(e) => void patch({ ownerId: e.target.value || null })} aria-label="Ответственный" disabled={busy}>
                    <option value="">Не назначен</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </OptionSelect>
                ) : <b>{c.ownerName ?? 'не назначен'}</b>}
                {primary && <span className="dim">· Контакт: <b>{primary.firstName} {primary.lastName ?? ''}</b>{primary.position ? `, ${primary.position}` : ''}</span>}
              </div>
            </div>
          </div>
          <div className="cl-actions">
            {primary?.fields.phone.value && card.contacts.canReveal && <Button variant="outline" size="sm" onClick={() => void call()}><Icon name="phone" size={14} /> Позвонить</Button>}
            <Button variant="outline" size="sm" onClick={() => setTab('chats')}><Icon name="chat" size={14} /> Написать</Button>
            <Button variant="outline" size="sm" onClick={() => setDialog('task')}><Icon name="check-circle" size={14} /> Задача</Button>
            <Button variant="outline" size="sm" onClick={() => setDialog('meeting')}><Icon name="calendar" size={14} /> Встреча</Button>
            {can.editDeals && <Button variant="outline" size="sm" onClick={() => setTab('deals')}><Icon name="money" size={14} /> Сделка</Button>}
            <Button variant="outline" size="sm" onClick={() => setTab('notes')}><Icon name="edit" size={14} /> Заметка</Button>
            {can.edit && <Button variant="ghost" size="sm" onClick={() => setDialog('merge')} title="Объединить с дубликатом"><Icon name="copy" size={14} /> Объединить</Button>}
            {can.archive && <Button variant="ghost" size="sm" onClick={() => void archive()}><Icon name="archive" size={14} /> {c.archived ? 'Из архива' : 'В архив'}</Button>}
            {can.delete && c.archived && <Button variant="ghost" size="sm" onClick={() => void removeForever()}><Icon name="trash" size={14} /> Удалить</Button>}
          </div>
        </header>

        {/* Следующее действие — самый важный блок (п. 42) */}
        <section className={`cl-next${card.nextAction ? '' : ' empty'}`} aria-label="Следующее действие">
          <Icon name="arrow-right" size={16} />
          {card.nextAction ? (
            <span className="cl-next-text">
              <b>Дальше:</b> {card.nextAction.text}
              {card.nextAction.at && <span className="dim"> · {dateTimeRu(card.nextAction.at)}</span>}
              <span className="dim"> · {SOURCE_RU[card.nextAction.source] ?? card.nextAction.source}</span>
            </span>
          ) : <span className="cl-next-text">По клиенту нет следующего действия.</span>}
          <span className="cl-next-acts">
            {!card.nextAction && <Button variant="primary" size="sm" onClick={() => setDialog('task')}>Создать задачу</Button>}
            {!card.nextAction && <Button variant="outline" size="sm" onClick={() => setDialog('meeting')}>Запланировать встречу</Button>}
            {can.edit && <Button variant="ghost" size="sm" onClick={() => void setNextAction()}><Icon name="edit" size={13} /> {c.nextAction ? 'Изменить' : 'Записать своё'}</Button>}
          </span>
        </section>

        {/* QEVO AI — кратко о клиенте, только по фактам и с источниками (п. 21–22, 57) */}
        <section className="cl-ai" aria-label="Кратко о клиенте">
          <div className="cl-ai-head">
            <span><Icon name="sparkles" size={15} /> QEVO AI — кратко о клиенте</span>
            {card.summary.enough && <Button variant="ghost" size="sm" aria-expanded={why} onClick={() => setWhy((v) => !v)}>Почему?</Button>}
          </div>
          {!card.summary.enough ? <p className="dim">Недостаточно данных для вывода.</p> : (
            <ul className="cl-ai-lines">
              {card.summary.lines.map((l) => (
                <li key={l.text}>{l.text}{why && l.sources.length > 0 && <span className="cl-src"> {l.sources.map(sourceLabel).join(' · ')}</span>}</li>
              ))}
            </ul>
          )}
          {/* «нет следующего действия» уже сказано блоком выше — здесь не повторяем */}
          {card.summary.risks.some((r) => r.text !== 'По клиенту нет следующего действия.') && (
            <ul className="cl-ai-risks">
              {card.summary.risks.filter((r) => r.text !== 'По клиенту нет следующего действия.').map((r) => (
                <li key={r.text}><Icon name="alert" size={13} /> {r.text}{why && <span className="cl-src"> {r.sources.map(sourceLabel).join(' · ')}</span>}</li>
              ))}
            </ul>
          )}
        </section>

        <Tabs<Tab> value={tab} onValueChange={setTab} items={tabs} ariaLabel="Разделы карточки клиента" className="cl-tabs" />

        <div className="cl-tab-body">
          {tab === 'overview' && (
            <div className="cl-overview">
              <section className="cl-box">
                <h3>Контакты</h3>
                {card.contacts.hidden ? <p className="dim">Контакты клиентов вам закрыты.</p>
                  : card.contacts.items.length === 0 ? <p className="dim">Контактов нет.</p>
                  : card.contacts.items.slice(0, 3).map((x) => (
                    <div key={x.id} className="cl-mini-row">
                      <b>{x.firstName} {x.lastName ?? ''}</b>{x.isPrimary && <Badge tone="info">основной</Badge>}
                      <span className="dim">{[x.position, x.fields.phone.value, x.fields.email.value].filter(Boolean).join(' · ')}</span>
                    </div>
                  ))}
                <Button variant="ghost" size="sm" onClick={() => setTab('contacts')}>Все контакты</Button>
              </section>
              {can.deals && (
                <section className="cl-box">
                  <h3>Сделки</h3>
                  {openDeals.length === 0 ? <p className="dim">Открытых сделок нет.</p> : openDeals.slice(0, 3).map((d) => (
                    <div key={d.id} className="cl-mini-row">
                      <b>{d.title}</b><Badge tone={STAGE[d.stage]?.tone}>{STAGE[d.stage]?.label ?? d.stage}</Badge>
                      <span className="dim">{money(d.amount, d.currency)}{d.probability != null ? ` · ${d.probability}%` : ''}</span>
                    </div>
                  ))}
                  <Button variant="ghost" size="sm" onClick={() => setTab('deals')}>Все сделки</Button>
                </section>
              )}
              <section className="cl-box">
                <h3>Задачи</h3>
                <p>Открытых: <b>{card.tasks.open}</b>{card.tasks.overdue ? <span className="cl-late"> · просрочено {card.tasks.overdue}</span> : null}</p>
                {card.tasks.top.slice(0, 3).map((t) => (
                  <button key={t.id} type="button" className="cl-link-row" onClick={() => t.projectId && navigate({ section: 'projects', projectId: t.projectId, taskId: t.id })}>
                    {t.title}{t.deadlineAt && <span className="dim"> · до {new Date(t.deadlineAt).toLocaleDateString('ru-RU')}</span>}
                  </button>
                ))}
                <Button variant="ghost" size="sm" onClick={() => setTab('tasks')}>Все задачи</Button>
              </section>
              <section className="cl-box">
                <h3>Встречи</h3>
                {card.meetings.upcoming.length === 0 ? <p className="dim">Ближайших встреч нет.</p> : card.meetings.upcoming.slice(0, 3).map((m) => (
                  <div key={`${m.kind}${m.id}`} className="cl-mini-row"><b>{m.title}</b><span className="dim">{dateTimeRu(m.startsAt)}</span></div>
                ))}
                <Button variant="ghost" size="sm" onClick={() => setTab('meetings')}>Все встречи</Button>
              </section>
              <section className="cl-box">
                <h3>Команда клиента</h3>
                <div className="cl-team">
                  {c.ownerName && <span className="cl-team-item"><Badge tone="info">ответственный</Badge> {c.ownerName}</span>}
                  {card.team.map((m) => (
                    <span key={m.userId} className="cl-team-item"><Avatar path={m.avatarUrl} fallback={initialsOf(m.name)} className="avatar-sm" /> {m.name}</span>
                  ))}
                  {!card.team.length && !c.ownerName && <span className="dim">Пока никого.</span>}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setTab('profile')}>Настроить</Button>
              </section>
              {card.pinnedNotes.length > 0 && (
                <section className="cl-box">
                  <h3><Icon name="pin" size={13} /> Закреплённые заметки</h3>
                  {card.pinnedNotes.map((n) => <p key={n.id} className="cl-note-text">{n.body}</p>)}
                </section>
              )}
              <section className="cl-box cl-box-dim">
                <p className="dim">Последняя активность: {ago(c.lastActivityAt)} · Источник: {c.source ? SOURCE[c.source] ?? c.source : '—'} · Заведён {new Date(c.createdAt).toLocaleDateString('ru-RU')}</p>
              </section>
            </div>
          )}
          {tab === 'contacts' && <ContactsTab clientId={clientId} initial={card.contacts} canEdit={can.edit} onChanged={() => void load()} />}
          {tab === 'deals' && <DealsTab clientId={clientId} initial={card.deals} canEdit={can.editDeals} users={users} onChanged={() => void load()} />}
          {tab === 'projects' && <ProjectsTab clientId={clientId} initial={card.projects} canEdit={can.edit} />}
          {tab === 'tasks' && <TasksTab clientId={clientId} onCreate={() => setDialog('task')} />}
          {tab === 'meetings' && <MeetingsTab clientId={clientId} onCreate={() => setDialog('meeting')} />}
          {tab === 'chats' && <ChatsTab clientId={clientId} />}
          {tab === 'files' && <FilesTab clientId={clientId} canEdit={can.edit} />}
          {tab === 'notes' && <NotesTab clientId={clientId} onChanged={() => void load()} />}
          {tab === 'activity' && <ActivityTab clientId={clientId} />}
          {tab === 'profile' && <ProfileTab card={card} canEdit={can.edit} users={users} onSave={patch} onTeam={setCard} />}
        </div>
      </div>

      {dialog === 'task' && <QuickTaskDialog clientId={clientId} clientName={c.name} users={users} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
      {dialog === 'meeting' && <QuickMeetingDialog clientId={clientId} clientName={c.name} ownerId={c.ownerId} users={users} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
      {dialog === 'merge' && <MergeDialog keepId={clientId} keepName={c.name} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
    </div>
  );
}

function sourceLabel(s: string): string {
  const [kind, id] = s.split(':');
  return ({ task: `задача #${id}`, deal: `сделка #${id}`, event: `встреча #${id}`, client: 'карточка клиента', activity: 'лента' } as Record<string, string>)[kind] ?? s;
}
