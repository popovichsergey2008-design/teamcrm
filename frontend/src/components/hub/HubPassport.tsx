import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar';
import { Button } from '../ui/button';
import { Tabs } from '../ui/tabs';
import { Textarea } from '../ui/field';
import { OptionSelect } from '../ui/option-select';
import { confirmAction, promptText } from '../ui/dialog';
import { api, ApiError, type ClientContact, type HubDecision, type HubItem, type HubKind, type HubMember, type HubSection, type HubView } from '../../lib/api';
import { navigate } from '../../lib/router';
import { initialsOf } from '../../lib/initials';
import { overlayProps } from '../../lib/overlay';
import { useEscape } from '../../hooks/useEscape';
import { useAuth } from '../../state/auth';
import { toastSaved } from '../../lib/notifications';
import { MAX_TASK_FILE_BYTES } from '../../lib/task-files';
import { HUB_CATEGORIES, dayLabel, guessFileCategory, guessLinkCategory, normalizeUrl, safeHref } from '../../lib/hub';
import { AiMark, AskBox, DecisionRow, ItemRow, errText } from './parts';
import './hub.css';

export type HubTab = 'passport' | 'team' | 'knowledge' | 'decisions' | 'search';

/**
 * «Паспорт проекта» — Инфоцентр на весь экран (#4659).
 *
 * Пять вкладок по разделам из ТЗ: паспорт, команда, база знаний, решения, поиск.
 * Правка на месте — у всех, кто видит проект (кроме клиента: ему Инфоцентр не
 * показываем вовсе); каждое изменение сервер подписывает автором. Записи ИИ помечены
 * и снимаются одним нажатием. На телефоне окно — на весь экран.
 */
export function HubPassport({ projectId, view, reload, initialTab = 'passport', initialAdd, aiBadge, onOpenRun, onCollect, onClose }: {
  projectId: string;
  view: HubView;
  reload: () => Promise<unknown>;
  initialTab?: HubTab;
  initialAdd?: boolean;
  /** «+2 решения, +1 ссылка» — на телефоне и в «Списке» колонки нет, бейдж живёт здесь. */
  aiBadge?: string;
  onOpenRun?: () => void;
  /** «Собрать сейчас» — только руководству и владельцу проекта. */
  onCollect?: () => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const [tab, setTab] = useState<HubTab>(initialTab);
  const [err, setErr] = useState('');
  const canEdit = view.canEdit;
  const ctx: Ctx = { projectId, view, canEdit, reload, setErr };
  const team = view.team.members.length + view.team.contacts.length + view.team.clientContacts.length;

  return (
    <div className="modal-overlay ui-modal-overlay hub-overlay" {...overlayProps(onClose)}>
      <div className="ui-modal hub-passport" role="dialog" aria-modal="true" aria-labelledby="hub-passport-title" onClick={(e) => e.stopPropagation()}>
        <header className="ui-modal-head">
          <div className="ui-modal-title-wrap">
            <h2 id="hub-passport-title" className="ui-modal-title"><Icon name="book" size={18} /> Паспорт проекта</h2>
            <span className="ui-modal-sub">{view.project.name}</span>
          </div>
          <span className="hub-head-acts">
            {onCollect && (
              <Button variant="ghost" size="sm" onClick={onCollect} title="ИИ разберёт события проекта за последние сутки">
                <Icon name="refresh" size={14} /> Собрать сейчас
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={16} /></Button>
          </span>
        </header>
        {aiBadge && onOpenRun && (
          <button type="button" className="hub-badge hub-badge-wide" onClick={onOpenRun} title="Посмотреть, что добавил ИИ">
            <Icon name="sparkles" size={13} /> <span>ИИ обновил: {aiBadge}</span>
          </button>
        )}
        <Tabs
          className="hub-tabs"
          ariaLabel="Разделы паспорта"
          value={tab}
          onValueChange={(t) => { setErr(''); setTab(t); }}
          items={[
            { value: 'passport', label: 'Паспорт' },
            { value: 'team', label: 'Команда', count: team },
            { value: 'knowledge', label: 'База знаний', count: view.knowledge.length },
            { value: 'decisions', label: 'Решения', count: view.decisions.total },
            { value: 'search', label: 'Поиск' },
          ]}
        />
        <div className="ui-modal-body hub-passport-body">
          {err && <p className="hub-err" role="alert">{err}</p>}
          {tab === 'passport' && <PassportTab ctx={ctx} />}
          {tab === 'team' && <TeamTab ctx={ctx} />}
          {tab === 'knowledge' && <KnowledgeTab ctx={ctx} startAdd={initialAdd} />}
          {tab === 'decisions' && <DecisionsTab ctx={ctx} />}
          {tab === 'search' && (
            <div className="hub-search-tab">
              <AskBox projectId={projectId} big />
              <p className="hub-hint">Например: «Какой у нас основной цвет кнопок?» или «Где инструкция по выгрузке отчётов?». ИИ отвечает по базе знаний, решениям, задачам и переписке проекта — со ссылками на источники.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface Ctx {
  projectId: string;
  view: HubView;
  canEdit: boolean;
  reload: () => Promise<unknown>;
  setErr: (s: string) => void;
}

const EMPTY_AI = 'ИИ соберёт сам каждое утро в 8:00 — из созвонов, чатов и закрытых задач проекта.';

// ── Паспорт ────────────────────────────────────────────────────────────────────

function PassportTab({ ctx }: { ctx: Ctx }) {
  const p = ctx.view.project;
  const save = (field: 'mission' | 'audience' | 'description') => async (value: string) => {
    await api.hubPassport(ctx.projectId, { [field]: value });
    await ctx.reload();
    toastSaved();
  };
  return (
    <>
      <EditableText label="Миссия" hint="Одно-два предложения: зачем проект и для кого." value={p.mission} max={300} rows={2} canEdit={ctx.canEdit} onSave={save('mission')} />
      <EditableText label="Аудитория и позиционирование" value={p.audience} max={1000} rows={3} canEdit={ctx.canEdit} onSave={save('audience')} />
      <EditableText label="Описание" hint="По описанию ИИ узнаёт проект в переписке и голосом." value={p.description} max={2000} rows={4} canEdit={ctx.canEdit} onSave={save('description')} />
      {(p.targetDate || p.clientName) && (
        <dl className="hub-facts">
          {p.targetDate && <><dt>Срок проекта</dt><dd>{dayLabel(p.targetDate)}</dd></>}
          {p.clientName && <><dt>Клиент</dt><dd>{p.clientName}</dd></>}
        </dl>
      )}
      <h3 className="hub-sub">Сайт, приложение, соцсети</h3>
      <ItemsBlock ctx={ctx} section="passport" items={ctx.view.passport} kinds={['link', 'note']} empty="Добавьте сайт, веб-приложение, админку, Telegram-канал или бота." />
    </>
  );
}

function EditableText({ label, hint, value, max, rows, canEdit, onSave }: {
  label: string; hint?: string; value: string | null; max: number; rows: number; canEdit: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const id = `hub-f-${label.replace(/\s+/g, '-')}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await onSave(draft.trim()); setEditing(false); }
    catch (ex) { setErr(errText(ex, 'Не удалось сохранить')); }
    finally { setBusy(false); }
  };
  if (editing) {
    return (
      <form className="hub-field" onSubmit={(e) => void submit(e)}>
        <label className="hub-field-label" htmlFor={id}>{label}</label>
        <Textarea id={id} value={draft} onChange={(e) => setDraft(e.target.value)} rows={rows} maxLength={max} autoFocus />
        <span className="hub-field-foot">
          <span className="hub-hint">{hint ?? ''} {draft.length}/{max}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(value ?? ''); setEditing(false); }}>Отмена</Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>Сохранить</Button>
        </span>
        {err && <p className="hub-err" role="alert">{err}</p>}
      </form>
    );
  }
  return (
    <div className="hub-field">
      <span className="hub-field-head">
        <span className="hub-field-label">{label}</span>
        {canEdit && <Button variant="ghost" size="sm" onClick={() => { setDraft(value ?? ''); setEditing(true); }} aria-label={`Изменить: ${label}`}><Icon name="edit" size={13} /> Изменить</Button>}
      </span>
      {value ? <p className="hub-field-text">{value}</p> : <p className="hub-hint">{canEdit ? (hint ?? 'Не заполнено.') : 'Не заполнено.'}</p>}
    </div>
  );
}

// ── Записи: список, добавление, правка ─────────────────────────────────────────

function ItemsBlock({ ctx, section, items, kinds, empty, grouped, startAdd }: {
  ctx: Ctx; section: HubSection; items: HubItem[]; kinds: HubKind[]; empty: string; grouped?: boolean; startAdd?: boolean;
}) {
  const [adding, setAdding] = useState(!!startAdd && ctx.canEdit);
  const [editing, setEditing] = useState<HubItem | null>(null);
  const pin = async (it: HubItem) => {
    try { await api.hubUpdateItem(ctx.projectId, it.id, { pinned: !it.pinned }); await ctx.reload(); }
    catch (e) { ctx.setErr(errText(e, 'Не удалось закрепить')); }
  };
  const remove = async (it: HubItem) => {
    if (!(await confirmAction({ title: `Убрать «${it.title}»?`, description: 'Запись пропадёт из Инфоцентра у всей команды.', confirmLabel: 'Убрать', danger: true }))) return;
    try { await api.hubRemoveItem(ctx.projectId, it.id); await ctx.reload(); }
    catch (e) { ctx.setErr(errText(e, 'Не удалось убрать')); }
  };
  const row = (it: HubItem) => (editing?.id === it.id ? (
    <li key={it.id} className="hub-row-edit">
      <ItemForm ctx={ctx} section={section} kinds={[it.kind]} item={it} onDone={() => setEditing(null)} />
    </li>
  ) : (
    <ItemRow key={it.id} item={it} canEdit={ctx.canEdit} onPin={pin} onEdit={setEditing} onRemove={remove} onError={ctx.setErr} />
  ));
  const groups = grouped
    ? HUB_CATEGORIES[section]
      .map((c) => ({ ...c, items: items.filter((i) => (i.category ?? 'other') === c.value || (c.value === 'other' && !HUB_CATEGORIES[section].some((x) => x.value === i.category))) }))
      .filter((g) => g.items.length)
    : [{ value: 'all', label: '', items }];

  return (
    <div className="hub-block">
      {!items.length && !adding && (
        <div className="hub-empty">
          <Icon name="sparkles" size={18} />
          <span><b>{empty}</b><br />{EMPTY_AI}</span>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.value} className="hub-group">
          {g.label && <h4 className="hub-group-title">{g.label}</h4>}
          <ul className="hub-list">{g.items.map(row)}</ul>
        </div>
      ))}
      {ctx.canEdit && (adding
        ? <ItemForm ctx={ctx} section={section} kinds={kinds} onDone={() => setAdding(false)} />
        : <Button variant="outline" size="sm" className="hub-add" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Добавить</Button>)}
    </div>
  );
}

const KIND_LABEL: Record<HubKind, string> = { link: 'Ссылка', file: 'Файл', note: 'Заметка', contact: 'Контакт' };

function ItemForm({ ctx, section, kinds, item, onDone }: {
  ctx: Ctx; section: HubSection; kinds: HubKind[]; item?: HubItem; onDone: () => void;
}) {
  const [kind, setKind] = useState<HubKind>(item?.kind ?? kinds[0]);
  const [title, setTitle] = useState(item?.title ?? '');
  const [url, setUrl] = useState(item?.url ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [category, setCategory] = useState(item?.category ?? (section === 'team' ? 'contractor' : 'other'));
  const [contact, setContact] = useState({ name: '', role: '', phone: '', email: '', telegram: '', ...(item?.contact ?? {}) });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const touchedCategory = useRef(!!item);
  const cats = HUB_CATEGORIES[section];

  const onUrl = (v: string) => {
    setUrl(v);
    const n = normalizeUrl(v);
    if (n && !touchedCategory.current) {
      const g = guessLinkCategory(n);
      if (g.section === section) setCategory(g.category);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      if (kind === 'file' && !item) {
        if (!files.length) { setErr('Выберите файл'); return; }
        const failed: string[] = [];
        for (const f of files) {
          if (f.size > MAX_TASK_FILE_BYTES) { failed.push(`${f.name} (больше 25 МБ)`); continue; }
          setBusy(`Загружаю ${f.name}…`);
          try {
            const up = await api.uploadFile(f, 'project_hub', ctx.projectId);
            await api.hubAddItem(ctx.projectId, {
              section, kind: 'file', fileId: up.id, title: files.length === 1 && title.trim() ? title.trim() : f.name,
              category: touchedCategory.current ? category : guessFileCategory(f.name),
            });
          } catch (ex) { failed.push(`${f.name} (${errText(ex, 'сеть оборвалась')})`); }
        }
        await ctx.reload();
        if (failed.length) { setErr(`Не загрузились: ${failed.join('; ')}`); setBusy(''); return; }
        toastSaved(files.length === 1 ? 'Файл добавлен' : `Добавлено файлов: ${files.length}`);
        onDone();
        return;
      }
      const payload: Record<string, unknown> = { title: title.trim(), category };
      if (kind === 'link') {
        const n = normalizeUrl(url);
        if (!n) { setErr('Нужна ссылка вида https://…'); return; }
        payload.url = n;
        if (!payload.title) payload.title = n.replace(/^https?:\/\/(www\.)?/, '').slice(0, 200);
      }
      if (kind === 'note') {
        if (!body.trim()) { setErr('Напишите текст заметки'); return; }
        payload.body = body.trim();
        if (!payload.title) payload.title = body.trim().split('\n')[0].slice(0, 80);
      }
      if (kind === 'contact') {
        if (!String(contact.name ?? '').trim()) { setErr('Укажите имя'); return; }
        const c = Object.fromEntries(Object.entries(contact).map(([k, v]) => [k, String(v ?? '').trim() || null]));
        payload.contact = c;
        payload.title = String(contact.name ?? '').trim();
      }
      if (!payload.title) { setErr('Укажите название'); return; }
      setBusy('Сохраняю…');
      if (item) await api.hubUpdateItem(ctx.projectId, item.id, payload);
      else await api.hubAddItem(ctx.projectId, { section, kind, ...payload } as never);
      await ctx.reload();
      toastSaved(item ? 'Сохранено' : 'Добавлено');
      onDone();
    } catch (ex) {
      setErr(errText(ex, 'Не удалось сохранить'));
    } finally { setBusy(''); }
  };

  const fid = `hub-${section}-${item?.id ?? 'new'}`;
  return (
    <form className="hub-form" onSubmit={(e) => void submit(e)}>
      {!item && kinds.length > 1 && (
        <span className="kv2-seg" role="group" aria-label="Что добавить">
          {kinds.map((k) => (
            <button key={k} type="button" className="kv2-seg-btn" aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
          ))}
        </span>
      )}
      {kind === 'link' && (
        <label className="hub-form-row">
          <span className="hub-field-label">Адрес</span>
          <input className="ui-input ui-input-md" value={url} onChange={(e) => onUrl(e.target.value)} placeholder="https://figma.com/…" inputMode="url" maxLength={2000} autoFocus={!item} />
        </label>
      )}
      {kind === 'file' && !item && (
        <label className="hub-form-row">
          <span className="hub-field-label">Файл (до 25 МБ)</span>
          <input type="file" multiple className="hub-file" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </label>
      )}
      {kind === 'contact' ? (
        <div className="hub-form-grid">
          {([['name', 'Имя'], ['role', 'Роль'], ['phone', 'Телефон'], ['email', 'Почта'], ['telegram', 'Telegram']] as const).map(([k, l]) => (
            <label key={k} className="hub-form-row">
              <span className="hub-field-label">{l}</span>
              <input className="ui-input ui-input-md" value={String(contact[k] ?? '')} onChange={(e) => setContact((c) => ({ ...c, [k]: e.target.value }))} maxLength={k === 'role' ? 100 : 200} autoFocus={k === 'name' && !item} />
            </label>
          ))}
        </div>
      ) : (
        <label className="hub-form-row">
          <span className="hub-field-label">Название{kind === 'file' && files.length > 1 ? ' (у каждого файла — его имя)' : ''}</span>
          <input className="ui-input ui-input-md" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
            placeholder={kind === 'link' ? 'Например: Макеты в Figma' : kind === 'file' ? 'Как называть файл в списке' : 'Коротко, о чём заметка'}
            disabled={kind === 'file' && files.length > 1} />
        </label>
      )}
      {kind === 'note' && (
        <label className="hub-form-row">
          <span className="hub-field-label">Текст</span>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} />
        </label>
      )}
      <label className="hub-form-row">
        <span className="hub-field-label" id={`${fid}-cat`}>Категория</span>
        <OptionSelect value={category} onChange={(e) => { touchedCategory.current = true; setCategory(e.target.value); }} aria-labelledby={`${fid}-cat`} className="input">
          {cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </OptionSelect>
      </label>
      {err && <p className="hub-err" role="alert">{err}</p>}
      <span className="hub-field-foot">
        {busy && <span className="hub-hint" role="status">{busy}</span>}
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>Отмена</Button>
        <Button type="submit" variant="primary" size="sm" disabled={!!busy}>{item ? 'Сохранить' : 'Добавить'}</Button>
      </span>
    </form>
  );
}

// ── Команда ────────────────────────────────────────────────────────────────────

function TeamTab({ ctx }: { ctx: Ctx }) {
  const { user } = useAuth();
  const { owner, members, contacts, clientContacts } = ctx.view.team;
  const write = async (userId: string) => {
    try { const dm = await api.openDm(userId); navigate({ section: 'chat', chatId: String(dm.id) }); }
    catch (e) { ctx.setErr(errText(e, 'Не удалось открыть чат')); }
  };
  const list = owner && !members.some((m) => String(m.userId) === String(owner.id))
    ? [{ userId: owner.id, name: owner.name, avatarUrl: owner.avatarUrl ?? null, roleTitle: null, responsibility: null, isOwner: true } as HubMember, ...members]
    : members;
  return (
    <>
      <h3 className="hub-sub">Кто за что отвечает</h3>
      {list.length ? (
        <ul className="hub-list">
          {list.map((m) => <MemberRow key={m.userId} ctx={ctx} m={m} me={String(m.userId) === String(user?.id)} onWrite={write} />)}
        </ul>
      ) : <p className="hub-hint">В проекте пока нет участников — они появляются, когда у человека есть задачи на доске.</p>}

      <h3 className="hub-sub">Подрядчики и контакты</h3>
      <ContactsBlock ctx={ctx} items={contacts} />

      {clientContacts.length > 0 && (
        <>
          <h3 className="hub-sub">Со стороны клиента{ctx.view.project.clientName ? ` — ${ctx.view.project.clientName}` : ''}</h3>
          <ul className="hub-list">{clientContacts.map((c) => <ClientContactRow key={c.id} c={c} onError={ctx.setErr} />)}</ul>
        </>
      )}
    </>
  );
}

function MemberRow({ ctx, m, me, onWrite }: { ctx: Ctx; m: HubMember; me: boolean; onWrite: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState(m.roleTitle ?? '');
  const [resp, setResp] = useState(m.responsibility ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await api.hubMember(ctx.projectId, m.userId, { roleTitle: role.trim(), responsibility: resp.trim() }); await ctx.reload(); setEditing(false); toastSaved(); }
    catch (ex) { ctx.setErr(errText(ex, 'Не удалось сохранить')); }
    finally { setBusy(false); }
  };
  return (
    <li className="hub-member">
      <Avatar path={m.avatarUrl} fallback={initialsOf(m.name)} className="avatar-sm" />
      <span className="hub-member-main">
        <span className="hub-member-name">{m.name}{me ? ' (вы)' : ''}{m.isOwner && <span className="ui-badge ui-badge-info">руководитель</span>}</span>
        {editing ? (
          <form className="hub-member-form" onSubmit={(e) => void save(e)}>
            <input className="ui-input ui-input-sm" value={role} onChange={(e) => setRole(e.target.value)} maxLength={60} placeholder="Роль: PM, дизайнер…" aria-label={`Роль: ${m.name}`} autoFocus />
            <input className="ui-input ui-input-sm" value={resp} onChange={(e) => setResp(e.target.value)} maxLength={300} placeholder="За что отвечает" aria-label={`Зона ответственности: ${m.name}`} />
            <span className="hub-field-foot">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Отмена</Button>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>Сохранить</Button>
            </span>
          </form>
        ) : (
          <span className="hub-row-meta">
            {[m.roleTitle, m.responsibility].filter(Boolean).join(' — ') || (ctx.canEdit ? 'Роль не указана' : '')}
          </span>
        )}
      </span>
      {!editing && (
        <span className="hub-row-acts">
          {ctx.canEdit && <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label={`Изменить роль: ${m.name}`} title="Роль и зона ответственности"><Icon name="edit" size={14} /></Button>}
          {!me && <Button variant="ghost" size="icon-sm" onClick={() => onWrite(m.userId)} aria-label={`Написать: ${m.name}`} title="Написать лично"><Icon name="chat" size={14} /></Button>}
        </span>
      )}
    </li>
  );
}

function ContactsBlock({ ctx, items }: { ctx: Ctx; items: HubItem[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const remove = async (it: HubItem) => {
    if (!(await confirmAction({ title: `Убрать контакт «${it.title}»?`, confirmLabel: 'Убрать', danger: true }))) return;
    try { await api.hubRemoveItem(ctx.projectId, it.id); await ctx.reload(); }
    catch (e) { ctx.setErr(errText(e, 'Не удалось убрать')); }
  };
  return (
    <div className="hub-block">
      {!items.length && !adding && (
        <div className="hub-empty"><Icon name="sparkles" size={18} /><span><b>Подрядчики, дизайнеры со стороны, контакты заказчика.</b><br />{EMPTY_AI}</span></div>
      )}
      <ul className="hub-list">
        {items.map((it) => editing === it.id ? (
          <li key={it.id} className="hub-row-edit"><ItemForm ctx={ctx} section="team" kinds={['contact']} item={it} onDone={() => setEditing(null)} /></li>
        ) : (
          <li key={it.id} className="hub-member">
            <span className="hub-row-icon" aria-hidden="true"><Icon name={it.category === 'client' ? 'building' : it.category === 'contractor' ? 'handshake' : 'user'} size={16} /></span>
            <span className="hub-member-main">
              <span className="hub-member-name">{it.contact?.name ?? it.title}</span>
              {it.contact?.role && <span className="hub-row-meta">{it.contact.role}</span>}
              <span className="hub-contact-fields">
                {it.contact?.phone && <a href={`tel:${it.contact.phone.replace(/[^\d+]/g, '')}`}><Icon name="phone" size={12} /> {it.contact.phone}</a>}
                {it.contact?.email && <a href={`mailto:${it.contact.email}`}><Icon name="mail" size={12} /> {it.contact.email}</a>}
                {it.contact?.telegram && (() => {
                  const tg = it.contact.telegram.replace(/^@/, '');
                  const href = safeHref(/^https?:/i.test(tg) ? tg : `https://t.me/${tg}`);
                  return href ? <a href={href} target="_blank" rel="noopener noreferrer"><Icon name="send" size={12} /> {it.contact.telegram}</a> : null;
                })()}
              </span>
              <AiMark item={it} inline />
            </span>
            {ctx.canEdit && (
              <span className="hub-row-acts">
                <Button variant="ghost" size="icon-sm" onClick={() => setEditing(it.id)} aria-label="Изменить" title="Изменить"><Icon name="edit" size={14} /></Button>
                <Button variant="ghost" size="icon-sm" onClick={() => void remove(it)} aria-label="Убрать" title="Убрать"><Icon name="trash" size={14} /></Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {ctx.canEdit && (adding
        ? <ItemForm ctx={ctx} section="team" kinds={['contact']} onDone={() => setAdding(false)} />
        : <Button variant="outline" size="sm" className="hub-add" onClick={() => setAdding(true)}><Icon name="user-plus" size={14} /> Добавить контакт</Button>)}
    </div>
  );
}

const FIELD_RU: Record<string, string> = { phone: 'Телефон', email: 'Почта', telegram: 'Telegram', whatsapp: 'WhatsApp' };

/** Контакт клиента — затушёван, как в карточке клиента; «Показать» пишет в журнал раскрытий. */
function ClientContactRow({ c, onError }: { c: ClientContact; onError: (s: string) => void }) {
  const [fields, setFields] = useState(c.fields);
  const reveal = async (field: keyof ClientContact['fields']) => {
    const apply = (value: string | null) => setFields((f) => ({ ...f, [field]: { value, masked: false } }));
    try { apply((await api.revealClientContact(c.id, field)).value); }
    catch (e) {
      // политика компании может требовать причину — спрашиваем и пробуем ещё раз
      if (!(e instanceof ApiError)) { onError('Контакт не открыт'); return; }
      const reason = await promptText({ title: 'Зачем нужен контакт?', placeholder: 'Причину увидит владелец', confirmLabel: 'Показать', singleLine: true, minLength: 3 });
      if (reason === null) return;
      try { apply((await api.revealClientContact(c.id, field, reason)).value); }
      catch (ex) { onError(errText(ex, 'Контакт не открыт')); }
    }
  };
  return (
    <li className="hub-member">
      <span className="hub-row-icon" aria-hidden="true"><Icon name="building" size={16} /></span>
      <span className="hub-member-main">
        <span className="hub-member-name">{c.firstName} {c.lastName ?? ''}{c.isPrimary && <span className="ui-badge ui-badge-info">основной</span>}</span>
        {c.position && <span className="hub-row-meta">{c.position}</span>}
        <span className="hub-contact-fields">
          {(['phone', 'email', 'telegram', 'whatsapp'] as const).map((f) => fields[f]?.value && (
            <span key={f}>
              <span className="hub-row-meta">{FIELD_RU[f]}:</span> {fields[f].value}
              {fields[f].masked && (
                <Button variant="ghost" size="sm" onClick={() => void reveal(f)} aria-label={`Показать: ${FIELD_RU[f]}`}><Icon name="eye" size={13} /> Показать</Button>
              )}
            </span>
          ))}
        </span>
      </span>
    </li>
  );
}

// ── База знаний ────────────────────────────────────────────────────────────────

function KnowledgeTab({ ctx, startAdd }: { ctx: Ctx; startAdd?: boolean }) {
  return (
    <>
      <p className="hub-hint">ТЗ и спецификации, брендбук, макеты, репозитории, API и регламенты. Закреплённое видно прямо в колонке на доске.</p>
      <ItemsBlock ctx={ctx} section="knowledge" items={ctx.view.knowledge} kinds={['link', 'file', 'note']} grouped startAdd={startAdd}
        empty="Положите сюда ТЗ, брендбук и ссылку на макеты." />
    </>
  );
}

// ── Решения ────────────────────────────────────────────────────────────────────

function DecisionsTab({ ctx }: { ctx: Ctx }) {
  const [items, setItems] = useState<HubDecision[]>(ctx.view.decisions.items);
  const [total, setTotal] = useState(ctx.view.decisions.total);
  const [busy, setBusy] = useState(false);
  const load = async (before?: string) => {
    setBusy(true);
    try {
      const r = await api.hubDecisions(ctx.projectId, before);
      setItems((xs) => (before ? [...xs, ...r.items.filter((d) => !xs.some((x) => x.id === d.id))] : r.items));
      setTotal(r.total);
    } catch (e) { ctx.setErr(errText(e, 'Не удалось загрузить решения')); }
    finally { setBusy(false); }
  };
  // ctx.view обновляется по hub.changed — список перечитываем вместе с ним
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [ctx.view]);
  if (!items.length && !busy) {
    return (
      <div className="hub-empty">
        <Icon name="sparkles" size={18} />
        <span><b>Решений пока нет.</b><br />Они появляются сами — из итогов созвонов и рабочих чатов проекта, с датой и ссылкой на место, где договорились.</span>
      </div>
    );
  }
  return (
    <>
      <ul className="hub-list hub-decisions">{items.map((d) => <DecisionRow key={d.id} d={d} />)}</ul>
      {items.length < total && (
        <Button variant="outline" size="sm" className="hub-add" disabled={busy} onClick={() => void load(items[items.length - 1]?.decidedAt)}>
          Показать ещё ({total - items.length})
        </Button>
      )}
    </>
  );
}
