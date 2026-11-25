import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import {
  DOC_KIND_LABEL, DocDeadline, DocKind, docsApi, leftWords, Receipt, RECEIPT_CATEGORY_LABEL,
} from '../../lib/secretary-docs-api';
import { Icon } from '../Icon';
import { EmptyState } from '../EmptyState';
import { SkeletonList } from '../Skeleton';
import { Button } from '../ui/button';
import { confirmAction } from '../ui/dialog';
import { OptionSelect } from '../ui/option-select';
import { DateInput } from '../DateInput';
import { fetchBlob } from '../AuthedMedia';
import './secretary-docs.css';

/**
 * Вкладка «Документы» AI-агента (#1476): то, что раньше держал в голове живой секретарь.
 *
 *   «Сроки» — паспорт, виза, полис, договор: напоминание за 30/7/1 день и в день окончания
 *             карточкой в «Ждут решения» (+ push/Telegram по общим правилам тишины).
 *   «Чеки»  — сфотографировал чек → поля распознаёт модель → авансовый отчёт в Excel.
 *
 * Оба списка личные: видит только сам человек (сервер фильтрует по нему).
 */
export function SecretaryDocs() {
  const [part, setPart] = useState<'deadlines' | 'receipts'>(() => (sessionStorage.getItem('qevo.docs.part') === 'receipts' ? 'receipts' : 'deadlines'));
  const pick = (p: 'deadlines' | 'receipts') => { setPart(p); try { sessionStorage.setItem('qevo.docs.part', p); } catch { /* без хранилища */ } };
  return (
    <div className="sd">
      <div className="sd-seg" role="tablist" aria-label="Документы">
        <button type="button" role="tab" aria-selected={part === 'deadlines'} className={part === 'deadlines' ? 'is-on' : ''} onClick={() => pick('deadlines')}>
          <Icon name="calendar" size={14} /> Сроки документов
        </button>
        <button type="button" role="tab" aria-selected={part === 'receipts'} className={part === 'receipts' ? 'is-on' : ''} onClick={() => pick('receipts')}>
          <Icon name="money" size={14} /> Чеки и авансовый отчёт
        </button>
      </div>
      {part === 'deadlines' ? <Deadlines /> : <Receipts />}
    </div>
  );
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз');
const dateRu = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

// ───────────────────────────── сроки ─────────────────────────────

const REMIND_PRESETS: { label: string; days: number[] }[] = [
  { label: 'за 30, 7 и 1 день', days: [30, 7, 1] },
  { label: 'за 90, 30 и 7 дней', days: [90, 30, 7] },
  { label: 'за 60, 14 и 3 дня', days: [60, 14, 3] },
  { label: 'за 7 и 1 день', days: [7, 1] },
];
const presetOf = (days: number[]) => Math.max(0, REMIND_PRESETS.findIndex((p) => p.days.join() === [...days].sort((a, b) => b - a).join()));

function Deadlines() {
  const [items, setItems] = useState<DocDeadline[] | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState<null | { id?: string; kind: DocKind; title: string; expiresOn: string; preset: number; note: string }>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { docsApi.list().then(setItems).catch((e) => { setItems([]); setErr(errText(e)); }); }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!form) return;
    if (!form.expiresOn) { setErr('Укажите, до какого числа действует документ'); return; }
    setBusy(true); setErr('');
    try {
      const v = { kind: form.kind, title: form.title.trim(), expiresOn: form.expiresOn, remindDays: REMIND_PRESETS[form.preset].days, note: form.note.trim() || null };
      if (form.id) await docsApi.update(form.id, v); else await docsApi.add(v);
      setForm(null); load();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const renew = async (d: DocDeadline, renewed: boolean) => {
    try { await docsApi.update(d.id, { renewed }); load(); } catch (e) { setErr(errText(e)); }
  };
  const remove = async (d: DocDeadline) => {
    if (!(await confirmAction({ title: `Удалить «${d.title || DOC_KIND_LABEL[d.kind]}»?`, description: 'Напоминаний по нему больше не будет.', danger: true, confirmLabel: 'Удалить' }))) return;
    try { await docsApi.remove(d.id); load(); } catch (e) { setErr(errText(e)); }
  };

  return (
    <div className="sd-part">
      <p className="dim sd-lead">
        Напомню заранее, когда заканчивается паспорт, виза, полис или договор: карточкой в «Ждут решения» и уведомлением.
        Номера документов не нужны — только название и дата.
      </p>
      {err && <div className="error-text sd-err"><Icon name="alert" size={12} /> {err}</div>}
      {form ? (
        <div className="sd-form" role="group" aria-label={form.id ? 'Изменить документ' : 'Новый документ'}>
          <div className="sd-row2">
            <label className="sd-field">
              <span>Что за документ</span>
              <OptionSelect className="input" value={form.kind} aria-label="Вид документа" onChange={(e) => setForm({ ...form, kind: e.target.value as DocKind })}>
                {(Object.keys(DOC_KIND_LABEL) as DocKind[]).map((k) => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
              </OptionSelect>
            </label>
            <label className="sd-field">
              <span>Действует до</span>
              <DateInput type="date" className="input" value={form.expiresOn} aria-label="Действует до" onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
            </label>
          </div>
          <label className="sd-field">
            <span>Название <span className="dim">(чтобы отличать: «Загранпаспорт», «ОСАГО Kia», «Аренда офиса»)</span></span>
            <input className="input" value={form.title} maxLength={160} placeholder={DOC_KIND_LABEL[form.kind]} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <label className="sd-field">
            <span>Когда напомнить</span>
            <OptionSelect className="input" value={String(form.preset)} aria-label="Когда напомнить" onChange={(e) => setForm({ ...form, preset: Number(e.target.value) })}>
              {REMIND_PRESETS.map((p, i) => <option key={p.label} value={String(i)}>{p.label} и в день окончания</option>)}
            </OptionSelect>
          </label>
          <label className="sd-field">
            <span>Заметка <span className="dim">(необязательно)</span></span>
            <input className="input" value={form.note} maxLength={500} placeholder="Например: продлевать через Госуслуги" onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <div className="sd-actions">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}><Icon name="check" size={14} /> Сохранить</Button>
            <Button size="sm" variant="ghost" onClick={() => { setForm(null); setErr(''); }}>Отмена</Button>
          </div>
        </div>
      ) : (
        <div className="sd-actions">
          <Button size="sm" variant="outline" onClick={() => setForm({ kind: 'passport', title: '', expiresOn: '', preset: 0, note: '' })}>
            <Icon name="plus" size={14} /> Добавить документ
          </Button>
        </div>
      )}
      {items === null ? <SkeletonList rows={3} /> : items.length === 0 ? (
        !form && <EmptyState compact icon="calendar" title="Документов пока нет" hint="Добавьте паспорт, визу или полис — напомню заранее, чтобы не продлевать в последний день." />
      ) : (
        <ul className="sd-list">
          {items.map((d) => {
            const left = leftWords(d.expiresOn);
            return (
              <li key={d.id} className={`sd-item${d.renewedAt ? ' is-done' : ''}`}>
                <div className="sd-item-main">
                  <div className="sd-item-title">
                    {d.title || DOC_KIND_LABEL[d.kind]}
                    {d.renewedAt
                      ? <span className="sd-badge sd-badge-ok"><Icon name="check" size={12} /> продлён</span>
                      : <span className={`sd-badge sd-badge-${left.tone}`}>{left.text}</span>}
                  </div>
                  <div className="dim sd-item-sub">
                    {d.title ? `${DOC_KIND_LABEL[d.kind]} · ` : ''}до {dateRu(d.expiresOn)}
                    {d.note ? ` · ${d.note}` : ''}
                  </div>
                </div>
                <span className="sd-item-acts">
                  {d.renewedAt
                    ? <button type="button" className="sd-link" onClick={() => void renew(d, false)}>Вернуть напоминания</button>
                    : <button type="button" className="sd-link" onClick={() => void renew(d, true)}>Продлил</button>}
                  <button type="button" className="sd-icon" title="Изменить" aria-label={`Изменить ${d.title || DOC_KIND_LABEL[d.kind]}`}
                    onClick={() => setForm({ id: d.id, kind: d.kind, title: d.title, expiresOn: d.expiresOn, preset: presetOf(d.remindDays), note: d.note ?? '' })}>
                    <Icon name="edit" size={14} />
                  </button>
                  <button type="button" className="sd-icon" title="Удалить" aria-label={`Удалить ${d.title || DOC_KIND_LABEL[d.kind]}`} onClick={() => void remove(d)}>
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────────── чеки ─────────────────────────────

const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const money = (n: number | null, cur: string) => (n === null ? '—' : `${n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur === 'RUB' ? '₽' : cur}`);

function Receipts() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayIso());
  const [items, setItems] = useState<Receipt[] | null>(null);
  const [err, setErr] = useState('');
  const [uploading, setUploading] = useState(0);
  const [editId, setEditId] = useState<string | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => { docsApi.receipts(from || undefined, to || undefined).then(setItems).catch((e) => { setItems([]); setErr(errText(e)); }); }, [from, to]);
  useEffect(load, [load]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr('');
    const list = [...files].slice(0, 20);
    setUploading(list.length);
    for (const f of list) {
      try {
        const r = await docsApi.addReceiptFile(f);
        setItems((cur) => [r, ...(cur ?? [])]);
        if (r.status === 'failed') setEditId(r.id);
      } catch (e) { setErr(`«${f.name}»: ${errText(e)}`); }
      setUploading((n) => n - 1);
    }
    load();
  };
  const manual = async () => {
    try { const r = await docsApi.addReceiptManual(); setItems((cur) => [r, ...(cur ?? [])]); setEditId(r.id); } catch (e) { setErr(errText(e)); }
  };
  const patch = (r: Receipt) => setItems((cur) => (cur ?? []).map((x) => (x.id === r.id ? r : x)));
  const remove = async (r: Receipt) => {
    if (!(await confirmAction({ title: 'Удалить чек?', description: `${r.seller ?? 'Чек'} · ${money(r.total, r.currency)}. Фото тоже удалится.`, danger: true, confirmLabel: 'Удалить' }))) return;
    try { await docsApi.removeReceipt(r.id); setItems((cur) => (cur ?? []).filter((x) => x.id !== r.id)); } catch (e) { setErr(errText(e)); }
  };
  const totals = (items ?? []).reduce<Record<string, number>>((acc, r) => { if (r.total !== null) acc[r.currency] = (acc[r.currency] ?? 0) + r.total; return acc; }, {});

  return (
    <div className="sd-part">
      <p className="dim sd-lead">
        Сфотографируйте чек или загрузите PDF — дату, продавца, сумму и НДС заполню сам. Проверьте строки и скачайте авансовый отчёт в Excel для бухгалтерии.
      </p>
      {err && <div className="error-text sd-err"><Icon name="alert" size={12} /> {err}</div>}
      <div className="sd-actions">
        <Button size="sm" variant="primary" loading={uploading > 0} onClick={() => pickRef.current?.click()}>
          <Icon name="upload" size={14} /> {uploading > 0 ? `Распознаю… осталось ${uploading}` : 'Загрузить чеки'}
        </Button>
        <input ref={pickRef} type="file" accept="image/*,application/pdf" multiple hidden aria-label="Фото или PDF чеков"
          onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
        <Button size="sm" variant="ghost" onClick={() => void manual()}><Icon name="plus" size={14} /> Без фото</Button>
      </div>
      <div className="sd-period">
        <span className="dim">Период</span>
        <DateInput type="date" className="input" value={from} aria-label="С какого числа" onChange={(e) => setFrom(e.target.value)} />
        <span className="dim">—</span>
        <DateInput type="date" className="input" value={to} aria-label="По какое число" onChange={(e) => setTo(e.target.value)} />
      </div>
      {items === null ? <SkeletonList rows={3} /> : items.length === 0 ? (
        <EmptyState compact icon="money" title="Чеков за период нет" hint="Загрузите фото чеков — такси, гостиница, обед с клиентом." />
      ) : (
        <>
          <ul className="sd-list">
            {items.map((r) => (
              <ReceiptRow key={r.id} r={r} editing={editId === r.id} onEdit={() => setEditId(editId === r.id ? null : r.id)}
                onSaved={(x) => { patch(x); setEditId(null); }} onPatched={patch} onRemove={() => void remove(r)} />
            ))}
          </ul>
          <div className="sd-total">
            <span>Итого{Object.keys(totals).length ? ':' : ''} {Object.entries(totals).map(([cur, sum]) => money(Math.round(sum * 100) / 100, cur)).join(' + ') || '—'}</span>
            <Button size="sm" variant="outline" onClick={() => void docsApi.exportReceipts(from || undefined, to || undefined).catch((e) => setErr(errText(e)))}>
              <Icon name="download" size={14} /> Авансовый отчёт (Excel)
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ReceiptRow({ r, editing, onEdit, onSaved, onPatched, onRemove }: {
  r: Receipt; editing: boolean; onEdit: () => void; onSaved: (r: Receipt) => void; onPatched: (r: Receipt) => void; onRemove: () => void;
}) {
  const [v, setV] = useState({
    spentOn: r.spentOn ?? '', seller: r.seller ?? '', sellerInn: r.sellerInn ?? '', total: r.total === null ? '' : String(r.total).replace('.', ','),
    vat: r.vat === null ? '' : String(r.vat).replace('.', ','), category: r.category, purpose: r.purpose ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    setV({ spentOn: r.spentOn ?? '', seller: r.seller ?? '', sellerInn: r.sellerInn ?? '', total: r.total === null ? '' : String(r.total).replace('.', ','),
      vat: r.vat === null ? '' : String(r.vat).replace('.', ','), category: r.category, purpose: r.purpose ?? '' });
  }, [r]);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      onSaved(await docsApi.updateReceipt(r.id, {
        spentOn: v.spentOn || null, seller: v.seller || null, sellerInn: v.sellerInn || null,
        total: v.total ? v.total.replace(/\s/g, '').replace(',', '.') : null, vat: v.vat ? v.vat.replace(/\s/g, '').replace(',', '.') : null,
        category: v.category, purpose: v.purpose || null,
      }));
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const again = async () => {
    setBusy(true); setErr('');
    try { onPatched(await docsApi.recognize(r.id)); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const openPhoto = async () => {
    if (!r.fileId) return;
    try { const url = URL.createObjectURL(await fetchBlob(r.fileId)); window.open(url, '_blank', 'noopener'); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); } catch (e) { setErr(errText(e)); }
  };

  return (
    <li className={`sd-item sd-receipt${r.status === 'failed' ? ' is-failed' : ''}`}>
      <div className="sd-item-main">
        <div className="sd-item-title">
          {r.seller || (r.status === 'failed' ? 'Не распознан' : r.status === 'new' ? 'Распознаю…' : 'Без продавца')}
          <span className="sd-sum">{money(r.total, r.currency)}</span>
        </div>
        <div className="dim sd-item-sub">
          {[r.spentOn ? new Date(`${r.spentOn}T12:00:00`).toLocaleDateString('ru-RU') : 'дата не указана', RECEIPT_CATEGORY_LABEL[r.category] ?? 'Прочее',
            r.vat !== null ? `НДС ${money(r.vat, r.currency)}` : '', r.purpose ?? ''].filter(Boolean).join(' · ')}
        </div>
        {r.error && <div className="sd-warn"><Icon name="alert" size={12} /> {r.error}</div>}
        {err && <div className="error-text sd-err">{err}</div>}
      </div>
      <span className="sd-item-acts">
        {r.fileId && <button type="button" className="sd-icon" title="Открыть фото" aria-label="Открыть фото чека" onClick={() => void openPhoto()}><Icon name="image" size={14} /></button>}
        {r.fileId && r.status === 'failed' && <button type="button" className="sd-icon" title="Распознать ещё раз" aria-label="Распознать ещё раз" disabled={busy} onClick={() => void again()}><Icon name="refresh" size={14} /></button>}
        <button type="button" className="sd-icon" title="Поправить" aria-label="Поправить чек" aria-expanded={editing} onClick={onEdit}><Icon name="edit" size={14} /></button>
        <button type="button" className="sd-icon" title="Удалить" aria-label="Удалить чек" onClick={onRemove}><Icon name="trash" size={14} /></button>
      </span>
      {editing && (
        <div className="sd-form sd-receipt-form">
          <div className="sd-row2">
            <label className="sd-field"><span>Дата</span><DateInput type="date" className="input" value={v.spentOn} aria-label="Дата чека" onChange={(e) => setV({ ...v, spentOn: e.target.value })} /></label>
            <label className="sd-field"><span>Категория</span>
              <OptionSelect className="input" value={v.category} aria-label="Категория расхода" onChange={(e) => setV({ ...v, category: e.target.value })}>
                {Object.entries(RECEIPT_CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </OptionSelect>
            </label>
          </div>
          <div className="sd-row2">
            <label className="sd-field"><span>Продавец</span><input className="input" value={v.seller} maxLength={200} onChange={(e) => setV({ ...v, seller: e.target.value })} /></label>
            <label className="sd-field"><span>ИНН продавца</span><input className="input" value={v.sellerInn} inputMode="numeric" maxLength={12} onChange={(e) => setV({ ...v, sellerInn: e.target.value })} /></label>
          </div>
          <div className="sd-row2">
            <label className="sd-field"><span>Сумма</span><input className="input" value={v.total} inputMode="decimal" placeholder="0,00" onChange={(e) => setV({ ...v, total: e.target.value })} /></label>
            <label className="sd-field"><span>в т. ч. НДС</span><input className="input" value={v.vat} inputMode="decimal" placeholder="нет" onChange={(e) => setV({ ...v, vat: e.target.value })} /></label>
          </div>
          <label className="sd-field"><span>Назначение <span className="dim">(для бухгалтерии: «такси на встречу с клиентом»)</span></span>
            <input className="input" value={v.purpose} maxLength={300} onChange={(e) => setV({ ...v, purpose: e.target.value })} />
          </label>
          <div className="sd-actions">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}><Icon name="check" size={14} /> Сохранить</Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>Отмена</Button>
          </div>
        </div>
      )}
    </li>
  );
}
