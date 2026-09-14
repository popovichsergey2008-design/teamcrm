import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { AuthedMedia } from '../AuthedMedia';
import { api, ApiError, ChatInfo, ChatMember, MaterialItem } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { humanSize } from '../../lib/attachments';
import { presenceKind, presenceLabel } from '../../lib/presence';
import { stampLabel } from '../../lib/chat-text';
import { placePopover, PopoverPlace } from '../../lib/popover';
import { toastSaved } from '../../lib/notifications';
import type { User } from '../../types';

const KIND_LABEL: Record<string, string> = {
  dm: 'Личный диалог', group: 'Групповой чат', channel: 'Канал', project: 'Чат проекта',
  self: 'Заметки — чат с собой', external: 'Внешний чат',
};
const ROLE_LABEL: Record<string, string> = { owner: 'Владелец', admin: 'Администраторы', member: 'Участники', external: 'Внешние' };
const ROLE_ORDER = ['owner', 'admin', 'member', 'external'];
const AUDIT_LABEL: Record<string, string> = {
  created: 'создал(а) чат', renamed: 'переименовал(а) чат', description_changed: 'изменил(а) описание',
  members_added: 'добавил(а) участников', member_removed: 'убрал(а) участника',
  admin_granted: 'назначил(а) администратора', admin_revoked: 'снял(а) администратора',
  pinned: 'закрепил(а) сообщение', unpinned: 'открепил(а) сообщение', task_created: 'создал(а) задачу из сообщения',
  call_started: 'начал(а) созвон',
};
type Tab = 'media' | 'files' | 'links' | 'voice' | 'docs';
const TABS: { key: Tab; label: string }[] = [
  { key: 'media', label: 'Медиа' }, { key: 'files', label: 'Файлы' }, { key: 'links', label: 'Ссылки' },
  { key: 'voice', label: 'Голосовые' }, { key: 'docs', label: 'Документы' },
];

/**
 * Сайдбар чата — кнопка ⓘ (ТЗ-5, этап 2).
 *
 * Отвечает на вопросы, ради которых раньше листали ленту: кто здесь и в какой
 * роли, где тот макет, что закрепляли, о чём договорились. Данные — от сервера
 * одним запросом (`/chats/:id/info`), материалы подгружаются по вкладке; при
 * любой правке чата (`chat.updated`) панель перечитывает себя сама.
 */
export function ChatInfoPanel({ chatId, meId, users, onClose, onJumpTo, onWriteTo, onCall, onMention, onChanged, onLeft, canCall, onTasksOf, onCalendar }: {
  chatId: string;
  meId: string;
  users: User[];
  onClose: () => void;
  /** Показать сообщение в ленте — прыжок с подсветкой. */
  onJumpTo: (messageId: string) => void;
  onWriteTo: (userId: string) => void;
  onCall?: (memberIds: string[]) => void;
  onMention: (name: string) => void;
  /** Название или состав изменились — список чатов должен перечитаться. */
  onChanged: () => void;
  onLeft: () => void;
  canCall: boolean;
  /** Открыть задачи сотрудника и календарь — переходы делает страница, панель их не знает. */
  onTasksOf: (userId: string) => void;
  onCalendar: () => void;
}) {
  const [info, setInfo] = useState<ChatInfo | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ about: true, members: true, materials: false, pinned: false, saved: false, history: false });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const load = useCallback(() => {
    api.chatInfo(chatId).then((i) => { setInfo(i); setErr(''); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить сведения'));
  }, [chatId]);
  useEffect(() => { setInfo(null); load(); }, [load]);
  useEffect(() => {
    const socket = getSocket();
    const onUpdated = (p: { chatId: string }) => { if (String(p.chatId) === String(chatId)) load(); };
    socket.on('chat.updated', onUpdated);
    socket.on('chat.pinned', onUpdated);
    return () => { socket.off('chat.updated', onUpdated); socket.off('chat.pinned', onUpdated); };
  }, [chatId, load]);

  if (err) return <aside className="chat-info"><div className="chat-info-head"><b>Сведения</b><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={15} /></button></div><div className="error-text" style={{ padding: 12 }}>{err}</div></aside>;
  if (!info) return <aside className="chat-info"><div className="chat-info-head"><b>Сведения</b></div><div className="dim" style={{ padding: 12 }}>Загружаю…</div></aside>;

  const { chat, members, me, counts } = info;
  const manageable = (chat.kind === 'group' || chat.kind === 'channel') && me.canManage;

  return (
    <aside className="chat-info" aria-label="Сведения о чате">
      <div className="chat-info-head">
        <b><Icon name="info" size={15} /> Сведения</b>
        <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть" aria-label="Закрыть сведения"><Icon name="close" size={15} /></button>
      </div>
      <div className="chat-info-body">
        <Section title="О чате" open={open.about} onToggle={() => toggle('about')}>
          <AboutBlock chat={chat} manageable={manageable} onChanged={() => { load(); onChanged(); }} />
        </Section>

        <Section
          title={`Участники`}
          count={members.length}
          open={open.members}
          onToggle={() => toggle('members')}
          extra={(chat.kind === 'group' || chat.kind === 'channel') && (
            <AddPeople chatId={chatId} users={users} members={members} onAdded={() => { load(); onChanged(); }} />
          )}
        >
          <MembersBlock
            chatId={chatId}
            members={members}
            meId={meId}
            manageable={manageable}
            ownerId={chat.createdBy}
            canCall={canCall}
            onWriteTo={onWriteTo}
            onCall={onCall}
            onMention={onMention}
            onChanged={() => { load(); onChanged(); }}
            onLeft={onLeft}
            leaveable={chat.kind === 'group' || chat.kind === 'channel'}
            onTasksOf={onTasksOf}
            onCalendar={onCalendar}
          />
        </Section>

        <Section title="Материалы" count={counts.media + counts.files + counts.links + counts.voice + counts.docs} open={open.materials} onToggle={() => toggle('materials')}>
          <MaterialsBlock chatId={chatId} counts={counts} onJumpTo={onJumpTo} />
        </Section>

        <Section title="Закреплено" count={counts.pinned} open={open.pinned} onToggle={() => toggle('pinned')}>
          <PinnedBlock chatId={chatId} onJumpTo={onJumpTo} />
        </Section>

        <Section title="Избранное" open={open.saved} onToggle={() => toggle('saved')}>
          <SavedBlock chatId={chatId} onJumpTo={onJumpTo} />
        </Section>

        <Section title="История" open={open.history} onToggle={() => toggle('history')}>
          <HistoryBlock chatId={chatId} />
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, count, open, onToggle, extra, children }: {
  title: string; count?: number; open: boolean; onToggle: () => void; extra?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="ci-section">
      <div className="ci-section-head">
        <button className="ci-section-toggle" onClick={onToggle} aria-expanded={open}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          <span>{title}</span>
          {typeof count === 'number' && count > 0 && <span className="ci-count">{count}</span>}
        </button>
        {extra}
      </div>
      {open && <div className="ci-section-body">{children}</div>}
    </div>
  );
}

/** Название и описание — правятся на месте, если есть право; остальное читается. */
function AboutBlock({ chat, manageable, onChanged }: { chat: ChatInfo['chat']; manageable: boolean; onChanged: () => void }) {
  const [title, setTitle] = useState(chat.title ?? '');
  const [desc, setDesc] = useState(chat.description ?? '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTitle(chat.title ?? ''); setDesc(chat.description ?? ''); }, [chat.title, chat.description]);

  const save = async () => {
    setBusy(true);
    try {
      if (title.trim() && title.trim() !== (chat.title ?? '')) await api.renameChat(chat.id, title.trim());
      if (desc.trim() !== (chat.description ?? '')) await api.setChatDescription(chat.id, desc);
      toastSaved();
      setEditing(false);
      onChanged();
    } catch { /* сервер ответил — ошибка уже видна всплывашкой запроса */ }
    finally { setBusy(false); }
  };

  return (
    <div className="ci-about">
      {editing ? (
        <>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название" aria-label="Название чата" />
          <textarea className="input" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Описание: о чём этот чат, правила" aria-label="Описание чата" />
          <div className="ci-row-actions">
            <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>Сохранить</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Отмена</button>
          </div>
        </>
      ) : (
        <>
          <div className="ci-title">
            {chat.title ?? KIND_LABEL[chat.kind] ?? 'Чат'}
            {manageable && (
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} title="Изменить название и описание" aria-label="Изменить название и описание">
                <Icon name="edit" size={13} />
              </button>
            )}
          </div>
          {chat.description
            ? <div className="ci-desc">{chat.description}</div>
            : manageable && <button className="ci-link" onClick={() => setEditing(true)}>Добавить описание</button>}
        </>
      )}
      <dl className="ci-facts">
        <dt>Тип</dt><dd>{KIND_LABEL[chat.kind] ?? chat.kind}</dd>
        {(chat.kind === 'channel' || chat.kind === 'group') && <><dt>Доступ</dt><dd>{chat.isPrivate ? 'закрытый' : 'открытый — вступить может любой'}</dd></>}
        {chat.isExternal && <><dt>Внешний</dt><dd>есть участник со стороны — он видит всё сказанное здесь</dd></>}
        {chat.projectName && <><dt>Проект</dt><dd><a href={`/projects/${chat.projectId}`}>{chat.projectName}</a></dd></>}
        {chat.clientName && <><dt>Клиент</dt><dd>{chat.clientName}</dd></>}
        <dt>Создан</dt><dd>{stampLabel(chat.createdAt)}{chat.createdByName ? ` · ${chat.createdByName}` : ''}</dd>
      </dl>
    </div>
  );
}

function MembersBlock({ chatId, members, meId, manageable, ownerId, canCall, onWriteTo, onCall, onMention, onChanged, onLeft, leaveable, onTasksOf, onCalendar }: {
  chatId: string; members: ChatMember[]; meId: string; manageable: boolean; ownerId: string | null; canCall: boolean;
  onWriteTo: (userId: string) => void; onCall?: (memberIds: string[]) => void; onMention: (name: string) => void;
  onChanged: () => void; onLeft: () => void; leaveable: boolean;
  onTasksOf: (userId: string) => void; onCalendar: () => void;
}) {
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<{ userId: string; at: PopoverPlace } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const t = window.setTimeout(() => document.addEventListener('click', close), 0);
    return () => { window.clearTimeout(t); document.removeEventListener('click', close); };
  }, [menu]);

  const filtered = q.trim() ? members.filter((m) => m.fullName.toLowerCase().includes(q.trim().toLowerCase())) : members;
  const groups = ROLE_ORDER.map((r) => ({ role: r, list: filtered.filter((m) => m.role === r) })).filter((g) => g.list.length);

  const act = async (fn: () => Promise<unknown>) => {
    setMenu(null);
    try { await fn(); onChanged(); } catch { /* ошибка запроса показана всплывашкой */ }
  };
  const target = menu ? members.find((m) => m.userId === menu.userId) : null;

  return (
    <div className="ci-members">
      {members.length > 6 && (
        <input className="input ci-search" placeholder="Найти участника" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Найти участника" />
      )}
      {groups.map((g) => (
        <div key={g.role} className="ci-role-group">
          <div className="ci-role-title">{ROLE_LABEL[g.role] ?? g.role}</div>
          {g.list.map((m) => {
            const pr = { online: m.online, status: m.status, lastSeenAt: m.lastSeenAt };
            const kind = presenceKind(pr);
            const isMe = String(m.userId) === String(meId);
            return (
              <div key={m.userId} className="ci-member">
                <span className="bar-avatar">
                  <Avatar path={m.avatarUrl} fallback={m.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
                  <span className={`bar-dot bar-dot-${kind}`} aria-hidden="true" />
                </span>
                <span className="ci-member-main">
                  <span className="ci-member-name">{m.fullName}{isMe ? <span className="dim"> · вы</span> : ''}</span>
                  <span className={`bar-status bar-status-${kind}`}>{m.role === 'external' ? 'внешний пользователь' : presenceLabel(pr)}</span>
                </span>
                {!isMe && (
                  <button
                    className="msg-icon ci-member-more"
                    onClick={(e) => { e.stopPropagation(); setMenu({ userId: m.userId, at: placePopover(e.currentTarget.getBoundingClientRect(), 300, window.innerWidth) }); }}
                    title="Действия"
                    aria-label={`Действия: ${m.fullName}`}
                  >
                    <Icon name="more" size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {menu && target && (
        <span className="msg-menu pop-fixed" role="menu" style={{ left: menu.at.x, top: menu.at.y, transform: menu.at.up ? 'translateY(-100%)' : undefined }} onClick={(e) => e.stopPropagation()}>
          <button className="msg-menu-item" onClick={() => { setMenu(null); onWriteTo(target.userId); }}><Icon name="chat" size={13} /> Написать лично</button>
          {canCall && onCall && (
            <button className="msg-menu-item" onClick={() => { setMenu(null); onCall([target.userId]); }}><Icon name="phone" size={13} /> Позвонить</button>
          )}
          <button className="msg-menu-item" onClick={() => { setMenu(null); onMention(target.fullName); }}><Icon name="hash" size={13} /> Упомянуть</button>
          <button className="msg-menu-item" onClick={() => { setMenu(null); onTasksOf(target.userId); }}>
            <Icon name="check-circle" size={13} /> Задачи сотрудника
          </button>
          <button className="msg-menu-item" onClick={() => { setMenu(null); onCalendar(); }}>
            <Icon name="calendar" size={13} /> Календарь
          </button>
          {manageable && target.role !== 'owner' && (
            <>
              <button className="msg-menu-item" onClick={() => act(() => api.setChatMemberRole(chatId, target.userId, target.role === 'admin' ? 'member' : 'admin'))}>
                <Icon name="star" size={13} /> {target.role === 'admin' ? 'Снять администратора' : 'Сделать администратором'}
              </button>
              <button className="msg-menu-item msg-menu-danger" onClick={() => act(() => api.removeChatMember(chatId, target.userId))}>
                <Icon name="trash" size={13} /> Удалить из чата
              </button>
            </>
          )}
        </span>
      )}
      {leaveable && String(ownerId) !== String(meId) && (
        <button className="ci-link ci-leave" onClick={() => api.leaveChat(chatId).then(onLeft).catch(() => undefined)}>
          <Icon name="logout" size={13} /> Выйти из чата
        </button>
      )}
    </div>
  );
}

/** «Человек +»: несколько сразу, или целый отдел — по группам из карточек сотрудников. */
function AddPeople({ chatId, users, members, onAdded }: { chatId: string; users: User[]; members: ChatMember[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const inChat = useMemo(() => new Set(members.map((m) => String(m.userId))), [members]);
  const candidates = useMemo(
    () => users.filter((u) => u.isActive !== false && !inChat.has(String(u.id)) && (!q.trim() || u.fullName.toLowerCase().includes(q.trim().toLowerCase()))),
    [users, inChat, q],
  );
  const departments = useMemo(() => {
    const map = new Map<string, { name: string; ids: string[] }>();
    for (const u of users) for (const g of u.groups ?? []) {
      if (inChat.has(String(u.id))) continue;
      const d = map.get(g.id) ?? { name: g.name, ids: [] };
      d.ids.push(String(u.id)); map.set(g.id, d);
    }
    return [...map.values()].filter((d) => d.ids.length);
  }, [users, inChat]);

  const submit = async () => {
    if (!picked.size) return;
    setBusy(true);
    try { await api.addChatMembers(chatId, [...picked]); setPicked(new Set()); setOpen(false); setQ(''); onAdded(); }
    catch { /* всплывашка запроса */ }
    finally { setBusy(false); }
  };

  return (
    <>
      <button className="msg-icon" onClick={() => setOpen((v) => !v)} title="Добавить участников" aria-label="Добавить участников">
        <Icon name="user-plus" size={15} />
      </button>
      {open && (
        <div className="ci-add">
          <input className="input" autoFocus placeholder="Имя сотрудника" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Имя сотрудника" />
          {departments.length > 0 && !q && (
            <div className="ci-add-deps">
              {departments.map((d) => (
                <button key={d.name} className="people-chip" onClick={() => setPicked((p) => new Set([...p, ...d.ids]))} title={`Добавить отдел целиком: ${d.ids.length}`}>
                  <Icon name="users" size={11} /> {d.name} · {d.ids.length}
                </button>
              ))}
            </div>
          )}
          <div className="ci-add-list">
            {candidates.slice(0, 40).map((u) => (
              <label key={u.id} className="ci-add-row">
                <input type="checkbox" checked={picked.has(String(u.id))} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(String(u.id)); else n.delete(String(u.id)); return n; })} />
                <Avatar path={u.avatarUrl ?? null} fallback={u.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
                <span>{u.fullName}</span>
              </label>
            ))}
            {candidates.length === 0 && <div className="dim">Некого добавить</div>}
          </div>
          <div className="ci-row-actions">
            <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy || !picked.size}>Добавить{picked.size ? ` (${picked.size})` : ''}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); setPicked(new Set()); }}>Отмена</button>
          </div>
        </div>
      )}
    </>
  );
}

function MaterialsBlock({ chatId, counts, onJumpTo }: { chatId: string; counts: ChatInfo['counts']; onJumpTo: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('media');
  const [items, setItems] = useState<MaterialItem[] | null>(null);
  useEffect(() => {
    setItems(null);
    api.chatMaterials(chatId, tab).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [chatId, tab]);
  return (
    <div className="ci-materials">
      <div className="ci-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`ci-tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}{counts[t.key] ? <span className="ci-count">{counts[t.key]}</span> : null}
          </button>
        ))}
      </div>
      {!items && <div className="dim">Загружаю…</div>}
      {items && items.length === 0 && <div className="dim">Пока пусто</div>}
      {items && tab === 'media' && (
        <div className="ci-grid">
          {items.map((it) => (
            <div key={`${it.messageId}-${it.fileId}`} className="ci-grid-item" title={`${it.authorName ?? ''} · ${stampLabel(it.createdAt)}`}>
              <AuthedMedia fileId={String(it.fileId)} name={it.name ?? ''} mime={it.mime ?? 'image/*'} className="ci-thumb" onOpen={() => onJumpTo(it.messageId)} />
            </div>
          ))}
        </div>
      )}
      {items && tab !== 'media' && items.map((it) => (
        <button key={`${it.messageId}-${it.fileId ?? it.url}`} className="ci-item" onClick={() => onJumpTo(it.messageId)} title="Показать в чате">
          <Icon name={tab === 'links' ? 'link' : tab === 'voice' ? 'mic' : 'file'} size={14} />
          <span className="ci-item-main">
            <span className="ci-item-name">{tab === 'links' ? it.url : it.name}</span>
            <span className="dim">{it.authorName ?? ''} · {stampLabel(it.createdAt)}{it.size ? ` · ${humanSize(it.size)}` : ''}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function PinnedBlock({ chatId, onJumpTo }: { chatId: string; onJumpTo: (id: string) => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => { api.chatPinned(chatId).then(setItems).catch(() => setItems([])); }, [chatId]);
  if (!items) return <div className="dim">Загружаю…</div>;
  if (!items.length) return <div className="dim">Ничего не закреплено. Закрепляйте договорённости, доступы и ссылки — из меню сообщения.</div>;
  return (
    <>
      {items.map((m) => (
        <button key={m.id} className="ci-item" onClick={() => onJumpTo(String(m.id))} title="Показать в чате">
          <Icon name="flag" size={14} />
          <span className="ci-item-main">
            <span className="ci-item-name">{m.body || m.file_name || 'вложение'}</span>
            <span className="dim">{m.author_name ?? ''} · {stampLabel(m.created_at)}</span>
          </span>
        </button>
      ))}
    </>
  );
}

function SavedBlock({ chatId, onJumpTo }: { chatId: string; onJumpTo: (id: string) => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => { api.chatSavedIn(chatId).then(setItems).catch(() => setItems([])); }, [chatId]);
  if (!items) return <div className="dim">Загружаю…</div>;
  if (!items.length) return <div className="dim">Сохранённых сообщений из этого чата нет — «Сохранить» есть в меню сообщения.</div>;
  return (
    <>
      {items.map((m) => (
        <button key={m.id} className="ci-item" onClick={() => onJumpTo(String(m.id))} title="Показать в чате">
          <Icon name="star" size={14} />
          <span className="ci-item-main">
            <span className="ci-item-name">{m.body || m.file_name || 'вложение'}</span>
            <span className="dim">{m.author_name ?? ''} · {stampLabel(m.created_at)}</span>
          </span>
        </button>
      ))}
    </>
  );
}

function HistoryBlock({ chatId }: { chatId: string }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.chatAudit>> | null>(null);
  useEffect(() => { api.chatAudit(chatId).then(setItems).catch(() => setItems([])); }, [chatId]);
  if (!items) return <div className="dim">Загружаю…</div>;
  if (!items.length) return <div className="dim">Пока ничего не происходило.</div>;
  const detailOf = (a: { action: string; detail: Record<string, unknown> }) => {
    const d = a.detail ?? {};
    if (a.action === 'renamed') return `«${d.from ?? ''}» → «${d.to ?? ''}»`;
    if (a.action === 'members_added') return Array.isArray(d.names) ? (d.names as string[]).join(', ') : '';
    if (a.action === 'member_removed' || a.action === 'admin_granted' || a.action === 'admin_revoked') return String(d.name ?? '');
    if (a.action === 'task_created') return `#${d.taskId ?? ''} ${d.title ?? ''}`;
    return '';
  };
  return (
    <>
      {items.map((a) => (
        <div key={a.id} className="ci-audit">
          <span className="ci-item-name">{a.actor_name ?? 'Система'} {AUDIT_LABEL[a.action] ?? a.action}{detailOf(a) ? `: ${detailOf(a)}` : ''}</span>
          <span className="dim">{stampLabel(a.created_at)}</span>
        </div>
      ))}
    </>
  );
}
