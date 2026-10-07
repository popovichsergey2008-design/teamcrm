import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { SkeletonList } from '../../components/Skeleton';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { confirmAction, promptText } from '../../components/ui/dialog';
import { Field } from '../../components/ui/field';
import { OptionSelect } from '../../components/ui/option-select';
import {
  api, ApiError, ClientActivity, ClientCard, ClientContact, ClientContacts, ClientDeal, ClientFile, ClientMeeting, ClientNote, ClientTask,
} from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import { useAuth } from '../../state/auth';
import { CURRENCIES, dateRu, dateTimeRu, FILE_CATEGORY, MEMBER_ROLE, money, SOURCE, STAGE, STAGE_KEYS } from './labels';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

// ── Контакты (п. 23–28) ───────────────────────────────────────────────────────────
const FIELD_RU: Record<string, string> = { phone: 'Телефон', email: 'Почта', telegram: 'Telegram', whatsapp: 'WhatsApp' };

export function ContactsTab({ clientId, initial, canEdit, onChanged }: { clientId: string; initial: ClientContacts; canEdit: boolean; onChanged: () => void }) {
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState<ClientContact | 'new' | null>(null);
  const [err, setErr] = useState('');

  const reveal = async (c: ClientContact, field: string) => {
    const reason = data.requireReason
      ? await promptText({ title: 'Зачем нужен контакт?', placeholder: 'Причину увидит владелец', confirmLabel: 'Показать', singleLine: true, minLength: 3 })
      : '';
    if (reason === null) return;
    try {
      const r = await api.revealClientContact(c.id, field, reason || undefined);
      setData((d) => ({ ...d, items: d.items.map((x) => (x.id === c.id ? { ...x, fields: { ...x.fields, [field]: { value: r.value, masked: false } } } : x)) }));
    } catch (e) { setErr(errText(e, 'Контакт не открыт')); }
  };

  const save = async (v: Record<string, unknown>) => {
    try {
      setData(editing === 'new' ? await api.addClientContact(clientId, v) : await api.updateClientContact((editing as ClientContact).id, v));
      setEditing(null); onChanged(); toastSaved();
    } catch (e) { setErr(errText(e, 'Не удалось сохранить')); }
  };

  const remove = async (c: ClientContact) => {
    if (!(await confirmAction({ title: `Убрать контакт «${c.firstName}»?`, confirmLabel: 'Убрать' }))) return;
    setData(await api.removeClientContact(c.id)); onChanged();
  };

  if (data.hidden) return <p className="dim">Контакты клиентов вам закрыты — это решает владелец организации.</p>;
  return (
    <div className="cl-list">
      {err && <div className="error-text" role="alert">{err}</div>}
      {data.items.length === 0 && <p className="dim">Контактов пока нет.</p>}
      {data.items.map((c) => (
        <div key={c.id} className="cl-item">
          <div className="cl-item-main">
            <b>{c.firstName} {c.lastName ?? ''}</b>
            {c.isPrimary && <Badge tone="info">основной</Badge>}
            {c.position && <span className="dim">{c.position}</span>}
          </div>
          <div className="cl-fields">
            {(['phone', 'email', 'telegram', 'whatsapp'] as const).map((f) => c.fields[f].value && (
              <span key={f} className="cl-field">
                <span className="dim">{FIELD_RU[f]}:</span>{' '}
                {c.fields[f].masked ? <span className="cl-masked">{c.fields[f].value}</span>
                  : f === 'email' ? <a href={`mailto:${c.fields[f].value}`}>{c.fields[f].value}</a>
                  : f === 'phone' ? <a href={`tel:${String(c.fields[f].value).replace(/[^\d+]/g, '')}`}>{c.fields[f].value}</a>
                  : <span>{c.fields[f].value}</span>}
                {c.fields[f].masked && data.canReveal && <Button variant="ghost" size="sm" onClick={() => void reveal(c, f)}><Icon name="eye" size={13} /> Показать</Button>}
              </span>
            ))}
          </div>
          {canEdit && (
            <div className="cl-item-acts">
              {!c.isPrimary && <Button variant="ghost" size="sm" onClick={() => void api.updateClientContact(c.id, { isPrimary: true }).then((d) => { setData(d); onChanged(); })}>Сделать основным</Button>}
              <Button variant="ghost" size="sm" onClick={() => setEditing(c)}><Icon name="edit" size={13} /> Изменить</Button>
              <Button variant="ghost" size="sm" onClick={() => void remove(c)}><Icon name="trash" size={13} /></Button>
            </div>
          )}
        </div>
      ))}
      {canEdit && !editing && <Button variant="outline" size="sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> Добавить контакт</Button>}
      {editing && <ContactForm initial={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function ContactForm({ initial, onSave, onCancel }: { initial: ClientContact | null; onSave: (v: Record<string, unknown>) => void; onCancel: () => void }) {
  // при правке поле с маской не подставляем: человек ввёл бы маску как значение
  const val = (f: 'phone' | 'email' | 'telegram' | 'whatsapp') => (initial && !initial.fields[f].masked ? initial.fields[f].value ?? '' : '');
  const [v, setV] = useState<Record<string, string>>({
    firstName: initial?.firstName ?? '', lastName: initial?.lastName ?? '', position: initial?.position ?? '',
    phone: val('phone'), email: val('email'), telegram: val('telegram'), whatsapp: val('whatsapp'), preferredChannel: initial?.preferredChannel ?? '',
  });
  const set = (k: string, x: string) => setV((o) => ({ ...o, [k]: x }));
  const submit = () => {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      // скрытое поле, которое не трогали, не перезаписываем пустым
      if (initial && ['phone', 'email', 'telegram', 'whatsapp'].includes(k) && initial.fields[k as 'phone'].masked && !x) continue;
      out[k] = x;
    }
    onSave(out);
  };
  return (
    <div className="cl-form cl-inline-form">
      <div className="cl-form-row">
        <Field label="Имя"><input className="input" autoFocus value={v.firstName} onChange={(e) => set('firstName', e.target.value)} /></Field>
        <Field label="Фамилия"><input className="input" value={v.lastName} onChange={(e) => set('lastName', e.target.value)} /></Field>
      </div>
      <Field label="Должность"><input className="input" value={v.position} onChange={(e) => set('position', e.target.value)} /></Field>
      <div className="cl-form-row">
        <Field label="Телефон" hint={initial?.fields.phone.masked ? 'скрыт — пусто оставит прежний' : undefined}><input className="input" type="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Почта" hint={initial?.fields.email.masked ? 'скрыта — пусто оставит прежнюю' : undefined}><input className="input" type="email" value={v.email} onChange={(e) => set('email', e.target.value)} /></Field>
      </div>
      <div className="cl-form-row">
        <Field label="Telegram"><input className="input" value={v.telegram} onChange={(e) => set('telegram', e.target.value)} /></Field>
        <Field label="WhatsApp"><input className="input" value={v.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} /></Field>
      </div>
      <Field label="Удобный канал">
        <OptionSelect className="input" value={v.preferredChannel} onChange={(e) => set('preferredChannel', e.target.value)} aria-label="Удобный канал">
          <option value="">Не важно</option>
          {Object.entries(FIELD_RU).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </OptionSelect>
      </Field>
      <div className="cl-form-acts">
        <Button variant="primary" size="sm" disabled={!v.firstName.trim()} onClick={submit}>Сохранить</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Отмена</Button>
      </div>
    </div>
  );
}

// ── Сделки (п. 29–30) ─────────────────────────────────────────────────────────────
export function DealsTab({ clientId, initial, canEdit, users, onChanged }: {
  clientId: string; initial: ClientDeal[]; canEdit: boolean; users: { id: string; name: string }[]; onChanged: () => void;
}) {
  const [deals, setDeals] = useState(initial);
  const [form, setForm] = useState<ClientDeal | 'new' | null>(null);
  const [err, setErr] = useState('');
  const save = async (v: Record<string, unknown>) => {
    try {
      setDeals(form === 'new' ? await api.addClientDeal(clientId, v) : await api.updateClientDeal((form as ClientDeal).id, v));
      setForm(null); onChanged(); toastSaved();
    } catch (e) { setErr(errText(e, 'Не удалось сохранить сделку')); }
  };
  const stage = async (d: ClientDeal, s: string) => {
    let lostReason: string | undefined;
    if (s === 'lost') {
      const r = await promptText({ title: 'Почему сделка проиграна?', placeholder: 'Цена, сроки, выбрали другого…', confirmLabel: 'Сохранить', singleLine: true });
      if (r === null) return;
      lostReason = r || undefined;
    }
    try { setDeals(await api.updateClientDeal(d.id, { stage: s, ...(lostReason ? { lostReason } : {}) })); onChanged(); }
    catch (e) { setErr(errText(e, 'Не удалось сменить стадию')); }
  };
  return (
    <div className="cl-list">
      {err && <div className="error-text" role="alert">{err}</div>}
      {deals.length === 0 && <p className="dim">Сделок пока нет.</p>}
      {deals.map((d) => (
        <div key={d.id} className="cl-item">
          <div className="cl-item-main">
            <b>{d.title}</b>
            <span className="cl-deal-sum">{money(d.amount, d.currency)}</span>
            {d.probability != null && <span className="dim">{d.probability}%</span>}
          </div>
          <div className="cl-fields">
            {canEdit ? (
              <OptionSelect value={d.stage} onChange={(e) => void stage(d, e.target.value)} aria-label="Стадия">
                {STAGE_KEYS.map((k) => <option key={k} value={k}>{STAGE[k].label}</option>)}
              </OptionSelect>
            ) : <Badge tone={STAGE[d.stage]?.tone}>{STAGE[d.stage]?.label ?? d.stage}</Badge>}
            {d.ownerName && <span className="dim">{d.ownerName}</span>}
            {d.closeDate && <span className="dim">закрытие {dateRu(d.closeDate)}</span>}
            {d.nextAction && <span>→ {d.nextAction}</span>}
            {d.lostReason && <span className="dim">причина: {d.lostReason}</span>}
          </div>
          {canEdit && (
            <div className="cl-item-acts">
              <Button variant="ghost" size="sm" onClick={() => setForm(d)}><Icon name="edit" size={13} /> Изменить</Button>
              <Button variant="ghost" size="sm" onClick={() => void confirmAction({ title: `Убрать сделку «${d.title}»?`, confirmLabel: 'Убрать' }).then(async (ok) => { if (ok) { setDeals(await api.removeClientDeal(d.id)); onChanged(); } })}><Icon name="trash" size={13} /></Button>
            </div>
          )}
        </div>
      ))}
      {canEdit && !form && <Button variant="outline" size="sm" onClick={() => setForm('new')}><Icon name="plus" size={14} /> Создать сделку</Button>}
      {!canEdit && <p className="dim">Заводят и правят сделки руководители.</p>}
      {form && <DealForm initial={form === 'new' ? null : form} users={users} onCancel={() => setForm(null)} onSave={save} />}
    </div>
  );
}

function DealForm({ initial, users, onSave, onCancel }: { initial: ClientDeal | null; users: { id: string; name: string }[]; onSave: (v: Record<string, unknown>) => void; onCancel: () => void }) {
  const { user } = useAuth();
  const [v, setV] = useState<Record<string, string>>({
    title: initial?.title ?? '', stage: initial?.stage ?? 'new', amount: initial?.amount != null ? String(initial.amount) : '',
    currency: initial?.currency ?? 'RUB', probability: initial?.probability != null ? String(initial.probability) : '',
    ownerId: initial?.ownerId ?? String(user?.id ?? ''), nextAction: initial?.nextAction ?? '', closeDate: initial?.closeDate?.slice(0, 10) ?? '',
  });
  const set = (k: string, x: string) => setV((o) => ({ ...o, [k]: x }));
  const submit = () => onSave({
    title: v.title.trim(), stage: v.stage, currency: v.currency, ownerId: v.ownerId || null, nextAction: v.nextAction,
    amount: v.amount ? Number(v.amount.replace(/\s/g, '').replace(',', '.')) : null,
    probability: v.probability ? Math.max(0, Math.min(100, Math.round(Number(v.probability)))) : null,
    closeDate: v.closeDate || null,
  });
  return (
    <div className="cl-form cl-inline-form">
      <Field label="Название сделки"><input className="input" autoFocus value={v.title} onChange={(e) => set('title', e.target.value)} placeholder="Внедрение, поставка…" /></Field>
      <div className="cl-form-row">
        <Field label="Сумма"><input className="input" inputMode="decimal" value={v.amount} onChange={(e) => set('amount', e.target.value)} /></Field>
        <Field label="Валюта">
          <OptionSelect className="input" value={v.currency} onChange={(e) => set('currency', e.target.value)} aria-label="Валюта">
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </OptionSelect>
        </Field>
        <Field label="Вероятность, %"><input className="input" inputMode="numeric" value={v.probability} onChange={(e) => set('probability', e.target.value)} /></Field>
      </div>
      <div className="cl-form-row">
        <Field label="Стадия">
          <OptionSelect className="input" value={v.stage} onChange={(e) => set('stage', e.target.value)} aria-label="Стадия">
            {STAGE_KEYS.map((k) => <option key={k} value={k}>{STAGE[k].label}</option>)}
          </OptionSelect>
        </Field>
        <Field label="Ответственный">
          <OptionSelect className="input" value={v.ownerId} onChange={(e) => set('ownerId', e.target.value)} aria-label="Ответственный">
            <option value="">Не назначен</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </OptionSelect>
        </Field>
        <Field label="Дата закрытия"><input className="input" type="date" value={v.closeDate} onChange={(e) => set('closeDate', e.target.value)} /></Field>
      </div>
      <Field label="Следующий шаг"><input className="input" value={v.nextAction} onChange={(e) => set('nextAction', e.target.value)} placeholder="Например: созвон с финдиректором" /></Field>
      <div className="cl-form-acts">
        <Button variant="primary" size="sm" disabled={!v.title.trim()} onClick={submit}>Сохранить</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Отмена</Button>
      </div>
    </div>
  );
}

// ── Проекты (п. 31) ───────────────────────────────────────────────────────────────
export function ProjectsTab({ clientId, initial, canEdit }: { clientId: string; initial: ClientCard['projects']; canEdit: boolean }) {
  const [list, setList] = useState(initial);
  const [all, setAll] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { if (canEdit) api.listProjects().then((p: any[]) => setAll(p.map((x) => ({ id: String(x.id), name: x.name })))).catch(() => undefined); }, [canEdit]);
  const linked = new Set(list.map((p) => p.id));
  return (
    <div className="cl-list">
      {list.length === 0 && <p className="dim">Проектов клиента нет.</p>}
      {list.map((p) => (
        <div key={p.id} className="cl-item">
          <div className="cl-item-main">
            <button type="button" className="cl-link" onClick={() => navigate({ section: 'projects', projectId: p.id })}><Icon name="board" size={14} /> {p.name}</button>
            {p.status === 'archived' && <Badge tone="neutral">архив</Badge>}
          </div>
          <div className="cl-fields">
            {p.pmName && <span className="dim">Руководитель: {p.pmName}</span>}
            <span className="dim">Сделано {p.done} из {p.total}</span>
            {p.total > 0 && <span className="cl-progress"><span style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} /></span>}
          </div>
          {canEdit && <div className="cl-item-acts"><Button variant="ghost" size="sm" onClick={() => void api.unlinkClientProject(clientId, p.id).then(setList)}>Отвязать</Button></div>}
        </div>
      ))}
      {canEdit && (
        <OptionSelect value="" onChange={(e) => e.target.value && void api.linkClientProject(clientId, e.target.value).then(setList)} aria-label="Привязать проект">
          <option value="">Привязать проект…</option>
          {all.filter((p) => !linked.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </OptionSelect>
      )}
    </div>
  );
}

// ── Задачи (п. 32) ────────────────────────────────────────────────────────────────
export function TasksTab({ clientId, onCreate }: { clientId: string; onCreate: () => void }) {
  const [filter, setFilter] = useState('open');
  const [list, setList] = useState<ClientTask[] | null>(null);
  useEffect(() => { setList(null); api.clientTasks(clientId, filter).then(setList).catch(() => setList([])); }, [clientId, filter]);
  return (
    <div className="cl-list">
      <div className="cl-chips" role="group" aria-label="Какие задачи">
        {[['open', 'Открытые'], ['overdue', 'Просроченные'], ['approval', 'На согласовании'], ['all', 'Все']].map(([k, l]) => (
          <button key={k} type="button" className={`fd-chip${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
        ))}
        <Button variant="outline" size="sm" onClick={onCreate}><Icon name="plus" size={13} /> Создать задачу</Button>
      </div>
      {!list && <SkeletonList rows={3} />}
      {list?.length === 0 && <p className="dim">Задач нет.</p>}
      {list?.map((t) => (
        <button key={t.id} type="button" className={`cl-item cl-item-btn${t.closed ? ' cl-done' : ''}`} onClick={() => t.projectId && navigate({ section: 'projects', projectId: t.projectId, taskId: t.id })}>
          <div className="cl-item-main"><b>{t.title}</b>{t.deadlineAt && !t.closed && new Date(t.deadlineAt) < new Date() && <Badge tone="danger">просрочена</Badge>}</div>
          <div className="cl-fields dim">{[t.projectName, t.column, t.assigneeName, t.deadlineAt ? `до ${new Date(t.deadlineAt).toLocaleDateString('ru-RU')}` : null].filter(Boolean).join(' · ')}</div>
        </button>
      ))}
    </div>
  );
}

// ── Встречи (п. 35) ───────────────────────────────────────────────────────────────
export function MeetingsTab({ clientId, onCreate }: { clientId: string; onCreate: () => void }) {
  const [data, setData] = useState<{ upcoming: ClientMeeting[]; past: ClientMeeting[] } | null>(null);
  useEffect(() => { api.clientMeetings(clientId).then(setData).catch(() => setData({ upcoming: [], past: [] })); }, [clientId]);
  const row = (m: ClientMeeting) => (
    <button key={`${m.kind}${m.id}`} type="button" className="cl-item cl-item-btn" onClick={() => navigate(m.kind === 'meeting' ? { section: 'chat', view: 'meetings' } : { section: 'calendar' })}>
      <div className="cl-item-main"><Icon name={m.kind === 'meeting' ? 'video' : 'calendar'} size={14} /> <b>{m.title}</b></div>
      <div className="cl-fields dim">{dateTimeRu(m.startsAt)}{m.kind === 'meeting' ? ' · запись и итоги' : ''}</div>
    </button>
  );
  if (!data) return <SkeletonList rows={3} />;
  return (
    <div className="cl-list">
      <div className="cl-chips"><Button variant="outline" size="sm" onClick={onCreate}><Icon name="plus" size={13} /> Создать встречу</Button></div>
      <h4 className="cl-h4">Предстоящие</h4>
      {data.upcoming.length ? data.upcoming.map(row) : <p className="dim">Нет.</p>}
      <h4 className="cl-h4">Прошедшие</h4>
      {data.past.length ? data.past.map(row) : <p className="dim">Нет.</p>}
    </div>
  );
}

// ── Чаты (п. 34) ──────────────────────────────────────────────────────────────────
export function ChatsTab({ clientId }: { clientId: string }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.clientChats>> | null>(null);
  useEffect(() => { api.clientChats(clientId).then(setList).catch(() => setList([])); }, [clientId]);
  if (!list) return <SkeletonList rows={3} />;
  return (
    <div className="cl-list">
      {list.length === 0 && <p className="dim">Связанных чатов, где вы участник, нет. Внешний чат с клиентом заводится в «Чатах» — с привязкой к клиенту.</p>}
      {list.map((c) => (
        <button key={c.id} type="button" className="cl-item cl-item-btn" onClick={() => navigate({ section: 'chat', chatId: c.id })}>
          <div className="cl-item-main"><Icon name="chat" size={14} /> <b>{c.title ?? 'Чат'}</b>{c.external && <Badge tone="info">с клиентом</Badge>}</div>
          <div className="cl-fields dim">{c.lastMessageAt ? `последнее сообщение ${dateTimeRu(c.lastMessageAt)}` : 'сообщений нет'}</div>
        </button>
      ))}
    </div>
  );
}

// ── Файлы (п. 38) ─────────────────────────────────────────────────────────────────
export function FilesTab({ clientId, canEdit }: { clientId: string; canEdit: boolean }) {
  const [list, setList] = useState<ClientFile[] | null>(null);
  const [category, setCategory] = useState('other');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.clientFiles(clientId).then(setList).catch(() => setList([])); }, [clientId]);
  const upload = async (f: File | null) => {
    if (!f) return;
    setBusy(true); setErr('');
    try {
      const up = await api.uploadFile(f, 'client_file', clientId);
      setList(await api.addClientFile(clientId, String(up.id), category));
      toastSaved('Файл добавлен');
    } catch (e) { setErr(errText(e, 'Файл не загрузился')); }
    finally { setBusy(false); }
  };
  if (!list) return <SkeletonList rows={3} />;
  const groups = Object.keys(FILE_CATEGORY).map((k) => ({ k, items: list.filter((f) => f.category === k) })).filter((g) => g.items.length);
  return (
    <div className="cl-list">
      {canEdit && (
        <div className="cl-chips">
          <OptionSelect value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Категория файла">
            {Object.entries(FILE_CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </OptionSelect>
          <label className="cl-file">
            <Icon name="upload" size={14} /> {busy ? 'Загружаю…' : 'Добавить файл'}
            <input type="file" disabled={busy} onChange={(e) => { void upload(e.target.files?.[0] ?? null); e.currentTarget.value = ''; }} />
          </label>
        </div>
      )}
      {err && <div className="error-text" role="alert">{err}</div>}
      {list.length === 0 && <p className="dim">Файлов нет — договоры, счета и КП удобно держать здесь.</p>}
      {groups.map((g) => (
        <div key={g.k}>
          <h4 className="cl-h4">{FILE_CATEGORY[g.k]}</h4>
          {g.items.map((f) => (
            <div key={f.id} className="cl-item">
              <div className="cl-item-main">
                <a href={`/api/files/${f.fileId}`} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); void openFile(f.fileId); }}><Icon name="file" size={14} /> {f.name}</a>
                <span className="dim">{Math.max(1, Math.round(f.size / 1024))} КБ · {f.uploadedBy ?? ''} · {dateRu(f.createdAt)}</span>
              </div>
              {canEdit && <div className="cl-item-acts"><Button variant="ghost" size="sm" aria-label="Убрать файл" onClick={() => void api.removeClientFile(clientId, f.id).then(setList)}><Icon name="trash" size={13} /></Button></div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

async function openFile(fileId: string) {
  const { tokens } = await import('../../lib/api');
  const { apiUrl } = await import('../../lib/origin');
  const res = await fetch(apiUrl(`/api/files/${fileId}`), { headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {} });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── Заметки (п. 39) ───────────────────────────────────────────────────────────────
export function NotesTab({ clientId, onChanged }: { clientId: string; onChanged: () => void }) {
  const { user } = useAuth();
  const [list, setList] = useState<ClientNote[] | null>(null);
  const [body, setBody] = useState('');
  const [priv, setPriv] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.clientNotes(clientId).then(setList).catch(() => setList([])); }, [clientId]);
  const add = async () => {
    try { setList(await api.addClientNote(clientId, { body, isPrivate: priv })); setBody(''); setPriv(false); onChanged(); }
    catch (e) { setErr(errText(e, 'Заметка не сохранилась')); }
  };
  return (
    <div className="cl-list">
      <div className="cl-form cl-inline-form">
        <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Что важно помнить о клиенте…" aria-label="Новая заметка" />
        <div className="cl-form-acts">
          <Checkbox checked={priv} onCheckedChange={setPriv} label="Личная — видна только мне и руководству" />
          <Button variant="primary" size="sm" disabled={!body.trim()} onClick={() => void add()}>Добавить заметку</Button>
        </div>
      </div>
      {err && <div className="error-text" role="alert">{err}</div>}
      {!list && <SkeletonList rows={3} />}
      {list?.map((n) => (
        <div key={n.id} className={`cl-item${n.pinned ? ' cl-pinned' : ''}`}>
          <p className="cl-note-text">{n.body}</p>
          <div className="cl-fields dim">
            {n.authorName} · {dateTimeRu(n.createdAt)}
            {n.isPrivate && <Badge tone="neutral"><Icon name="lock" size={11} /> личная</Badge>}
          </div>
          <div className="cl-item-acts">
            <Button variant="ghost" size="sm" aria-pressed={n.pinned} onClick={() => void api.updateClientNote(n.id, { pinned: !n.pinned }).then((l) => { setList(l); onChanged(); })}><Icon name="pin" size={13} /> {n.pinned ? 'Открепить' : 'Закрепить'}</Button>
            {String(n.authorId) === String(user?.id) && <Button variant="ghost" size="sm" aria-label="Удалить заметку" onClick={() => void api.deleteClientNote(n.id).then(setList)}><Icon name="trash" size={13} /></Button>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Лента (п. 40) ─────────────────────────────────────────────────────────────────
const KINDS: [string, string][] = [['all', 'Все'], ['task', 'Задачи'], ['chat', 'Чаты'], ['meeting', 'Встречи'], ['deal', 'Сделки'], ['file', 'Файлы'], ['note', 'Заметки']];
const KIND_ICON: Record<string, 'check-circle' | 'chat' | 'calendar' | 'money' | 'file' | 'edit' | 'eye' | 'user' | 'building' | 'board'> = {
  task: 'check-circle', chat: 'chat', meeting: 'calendar', deal: 'money', file: 'file', note: 'edit', reveal: 'eye', contact: 'user', client: 'building', project: 'board',
};

export function ActivityTab({ clientId }: { clientId: string }) {
  const [kind, setKind] = useState('all');
  const [list, setList] = useState<ClientActivity[] | null>(null);
  useEffect(() => { setList(null); api.clientActivity(clientId, kind === 'all' ? undefined : kind).then(setList).catch(() => setList([])); }, [clientId, kind]);
  return (
    <div className="cl-list">
      <div className="cl-chips" role="group" aria-label="Что показывать">
        {KINDS.map(([k, l]) => <button key={k} type="button" className={`fd-chip${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
      </div>
      {!list && <SkeletonList rows={5} />}
      {list?.length === 0 && <p className="dim">Событий нет.</p>}
      <ol className="cl-timeline">
        {list?.map((a) => (
          <li key={a.id}>
            <Icon name={KIND_ICON[a.kind] ?? 'info'} size={14} />
            <span>{a.title}</span>
            <span className="dim">{a.actor ? `${a.actor} · ` : ''}{dateTimeRu(a.at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Профиль: все поля и команда клиента ──────────────────────────────────────────
export function ProfileTab({ card, canEdit, users, onSave, onTeam }: {
  card: ClientCard; canEdit: boolean; users: { id: string; name: string }[];
  onSave: (b: Record<string, unknown>) => Promise<void> | void; onTeam: (c: ClientCard) => void;
}) {
  const c = card.client;
  const [v, setV] = useState<Record<string, string>>({
    name: c.name, legalName: c.legalName ?? '', segment: c.segment ?? '', source: c.source ?? '', website: c.website ?? '',
    country: c.country ?? '', city: c.city ?? '', address: c.address ?? '', taxId: c.taxId ?? '',
    registrationNumber: c.registrationNumber ?? '', description: c.description ?? '', type: c.type,
  });
  const [member, setMember] = useState({ userId: '', role: 'account' });
  const [err, setErr] = useState('');
  const set = (k: string, x: string) => setV((o) => ({ ...o, [k]: x }));
  const dis = !canEdit;
  return (
    <div className="cl-list">
      <div className="cl-form">
        <div className="cl-form-row">
          <Field label="Название / имя"><input className="input" disabled={dis} value={v.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Тип">
            <OptionSelect className="input" disabled={dis} value={v.type} onChange={(e) => set('type', e.target.value)} aria-label="Тип">
              <option value="company">Компания</option><option value="person">Частное лицо</option>
            </OptionSelect>
          </Field>
        </div>
        <Field label="Юридическое название"><input className="input" disabled={dis} value={v.legalName} onChange={(e) => set('legalName', e.target.value)} /></Field>
        <div className="cl-form-row">
          <Field label="Сегмент"><input className="input" disabled={dis} value={v.segment} onChange={(e) => set('segment', e.target.value)} placeholder="VIP, Key Account…" /></Field>
          <Field label="Источник">
            <OptionSelect className="input" disabled={dis} value={v.source} onChange={(e) => set('source', e.target.value)} aria-label="Источник">
              <option value="">—</option>
              {Object.entries(SOURCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </OptionSelect>
          </Field>
        </div>
        <div className="cl-form-row">
          <Field label="Сайт"><input className="input" disabled={dis} value={v.website} onChange={(e) => set('website', e.target.value)} /></Field>
          <Field label="ИНН / налоговый номер"><input className="input" disabled={dis} value={v.taxId} onChange={(e) => set('taxId', e.target.value)} /></Field>
          <Field label="Рег. номер"><input className="input" disabled={dis} value={v.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} /></Field>
        </div>
        <div className="cl-form-row">
          <Field label="Страна"><input className="input" disabled={dis} value={v.country} onChange={(e) => set('country', e.target.value)} /></Field>
          <Field label="Город"><input className="input" disabled={dis} value={v.city} onChange={(e) => set('city', e.target.value)} /></Field>
        </div>
        <Field label="Адрес"><input className="input" disabled={dis} value={v.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="Описание"><textarea className="input" rows={4} disabled={dis} value={v.description} onChange={(e) => set('description', e.target.value)} /></Field>
        {canEdit && <div className="cl-form-acts"><Button variant="primary" size="sm" onClick={() => void onSave(v)}>Сохранить профиль</Button></div>}
      </div>

      <h4 className="cl-h4">Команда клиента</h4>
      {err && <div className="error-text" role="alert">{err}</div>}
      {card.team.length === 0 && <p className="dim">Кроме ответственного — никого.</p>}
      {card.team.map((m) => (
        <div key={m.userId} className="cl-item">
          <div className="cl-item-main"><b>{m.name}</b><span className="dim">{MEMBER_ROLE[m.role] ?? m.role}</span></div>
          {canEdit && <div className="cl-item-acts"><Button variant="ghost" size="sm" onClick={() => void api.removeClientMember(c.id, m.userId).then(onTeam)}>Убрать</Button></div>}
        </div>
      ))}
      {canEdit && (
        <div className="cl-chips">
          <OptionSelect value={member.userId} onChange={(e) => setMember((x) => ({ ...x, userId: e.target.value }))} aria-label="Сотрудник">
            <option value="">Добавить сотрудника…</option>
            {users.filter((u) => !card.team.some((m) => m.userId === u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </OptionSelect>
          <OptionSelect value={member.role} onChange={(e) => setMember((x) => ({ ...x, role: e.target.value }))} aria-label="Роль">
            {Object.entries(MEMBER_ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </OptionSelect>
          <Button variant="outline" size="sm" disabled={!member.userId} onClick={() => void api.setClientMember(c.id, member.userId, member.role).then((x) => { onTeam(x); setMember({ userId: '', role: 'account' }); }).catch((e) => setErr(errText(e, 'Не получилось')))}>Добавить</Button>
        </div>
      )}
    </div>
  );
}
