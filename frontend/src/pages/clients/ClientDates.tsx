import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { CLIENT_DATE_LABEL, ClientDate, ClientDateKind, docsApi } from '../../lib/secretary-docs-api';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { OptionSelect } from '../../components/ui/option-select';
import { confirmAction } from '../../components/ui/dialog';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/**
 * «Важные даты» клиента (#1476, F11): день рождения контакта, день компании, начало
 * сотрудничества. Накануне ответственный за клиента получает карточку секретаря
 * с черновиком поздравления — сами клиенту ничего не отправляем.
 */
export function ClientDates({ clientId, canEdit, contacts }: {
  clientId: string; canEdit: boolean; contacts: { id: string; firstName: string; lastName: string | null }[];
}) {
  const [items, setItems] = useState<ClientDate[] | null>(null);
  const [form, setForm] = useState<null | { kind: ClientDateKind; contactId: string; title: string; month: number; day: number; year: string }>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { docsApi.clientDates(clientId).then(setItems).catch(() => setItems([])); }, [clientId]);
  useEffect(load, [load]);

  const save = async () => {
    if (!form) return;
    setBusy(true); setErr('');
    try {
      setItems(await docsApi.addClientDate(clientId, {
        kind: form.kind, contactId: form.contactId || null, title: form.title.trim() || null,
        month: form.month, day: form.day, year: form.year ? Number(form.year) : null,
      }));
      setForm(null);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось сохранить'); } finally { setBusy(false); }
  };
  const remove = async (d: ClientDate) => {
    if (!(await confirmAction({ title: 'Удалить дату?', description: 'Напоминания о ней больше не будет.', danger: true, confirmLabel: 'Удалить' }))) return;
    try { setItems(await docsApi.removeClientDate(d.id)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось удалить'); }
  };
  const what = (d: ClientDate) => {
    if (d.kind === 'birthday') return d.person ? `День рождения — ${d.person}` : 'День рождения';
    if (d.kind === 'other') return d.title || 'Важная дата';
    return `${CLIENT_DATE_LABEL[d.kind]}${d.year ? ` (с ${d.year})` : ''}`;
  };
  const days = form ? new Date(2024, form.month, 0).getDate() : 31;

  return (
    <section className="cl-box">
      <h3><Icon name="party" size={13} /> Важные даты</h3>
      {items === null ? <p className="dim">Загружаю…</p> : items.length === 0 && !form ? (
        <p className="dim">Добавьте день рождения контакта или дату начала сотрудничества — накануне напомню и подготовлю поздравление.</p>
      ) : items.map((d) => (
        <div key={d.id} className="cl-mini-row">
          <b>{d.day} {MONTHS[d.month - 1]}</b>
          <span className="dim">{what(d)}</span>
          {canEdit && (
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-icon-sm" title="Удалить" aria-label={`Удалить: ${what(d)}`} onClick={() => void remove(d)}>
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
      ))}
      {err && <p className="error-text">{err}</p>}
      {form && (
        <div className="cl-dates-form">
          <OptionSelect className="input" value={form.kind} aria-label="Что за дата" onChange={(e) => setForm({ ...form, kind: e.target.value as ClientDateKind })}>
            {(Object.keys(CLIENT_DATE_LABEL) as ClientDateKind[]).map((k) => <option key={k} value={k}>{CLIENT_DATE_LABEL[k]}</option>)}
          </OptionSelect>
          {form.kind === 'birthday' && (
            <OptionSelect className="input" value={form.contactId} aria-label="Чей день рождения" onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
              <option value="">Контакт не выбран</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName ?? ''}</option>)}
            </OptionSelect>
          )}
          {form.kind === 'other' && (
            <input className="input" value={form.title} maxLength={160} placeholder="Например: годовщина открытия филиала" aria-label="Что за дата" onChange={(e) => setForm({ ...form, title: e.target.value })} />
          )}
          <div className="cl-dates-day">
            <OptionSelect className="input" value={String(Math.min(form.day, days))} aria-label="День" onChange={(e) => setForm({ ...form, day: Number(e.target.value) })}>
              {Array.from({ length: days }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
            </OptionSelect>
            <OptionSelect className="input" value={String(form.month)} aria-label="Месяц" onChange={(e) => setForm({ ...form, month: Number(e.target.value) })}>
              {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
            </OptionSelect>
            {(form.kind === 'partnership' || form.kind === 'company') && (
              <input className="input cl-dates-year" value={form.year} inputMode="numeric" maxLength={4} placeholder="год" aria-label="Год (для «5 лет вместе»)"
                onChange={(e) => setForm({ ...form, year: e.target.value.replace(/\D/g, '') })} />
            )}
          </div>
          <div className="cl-dates-acts">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>Сохранить</Button>
            <Button size="sm" variant="ghost" onClick={() => { setForm(null); setErr(''); }}>Отмена</Button>
          </div>
        </div>
      )}
      {canEdit && !form && (
        <Button variant="ghost" size="sm" onClick={() => { const n = new Date(); setForm({ kind: 'birthday', contactId: contacts[0]?.id ?? '', title: '', month: n.getMonth() + 1, day: n.getDate(), year: '' }); }}>
          <Icon name="plus" size={13} /> Добавить дату
        </Button>
      )}
    </section>
  );
}
