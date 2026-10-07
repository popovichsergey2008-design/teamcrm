import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field } from '../../components/ui/field';
import { OptionSelect } from '../../components/ui/option-select';
import { api, ApiError, ClientDuplicate } from '../../lib/api';
import { useAuth } from '../../state/auth';
import { navigate } from '../../lib/router';
import { SOURCE, STATUS, STATUS_KEYS } from './labels';

const MATCH: Record<string, string> = { email: 'почта', phone: 'телефон', domain: 'сайт', tax_id: 'ИНН', name: 'название' };

/**
 * Новый клиент за 20–30 секунд (п. 17): тип, название, ответственный, телефон, почта,
 * сайт, источник. Остальное — под «Подробнее». Похожий клиент — предупреждаем ещё до
 * сохранения и даём открыть существующего; объединять сами не объединяем (п. 18).
 */
export function NewClientDialog({ onClose, onCreated, users }: {
  onClose: () => void;
  onCreated: (id: string) => void;
  users: { id: string; name: string }[];
}) {
  const { user } = useAuth();
  const [v, setV] = useState<Record<string, string>>({ type: 'company', ownerId: String(user?.id ?? ''), source: 'manual', status: 'active' });
  const [more, setMore] = useState(false);
  const [dups, setDups] = useState<ClientDuplicate[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const timer = useRef<number | null>(null);
  const set = (k: string, val: string) => setV((x) => ({ ...x, [k]: val }));

  // проверка дублей на лету — по мере ввода названия, почты, телефона, сайта и ИНН
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    const p = new URLSearchParams();
    for (const k of ['name', 'email', 'phone', 'website', 'taxId']) if (v[k]?.trim()) p.set(k, v[k].trim());
    if (![...p.keys()].length || (v.name ?? '').trim().length < 2 && !v.email && !v.phone && !v.website && !v.taxId) { setDups([]); return; }
    timer.current = window.setTimeout(() => {
      api.clientDuplicates(p.toString()).then(setDups).catch(() => setDups([]));
    }, 400);
    // проверяем только по полям, по которым ищутся дубли, — не на каждое нажатие в форме
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.name, v.email, v.phone, v.website, v.taxId]);

  const submit = async (force = false) => {
    setBusy(true); setErr('');
    try {
      const body: Record<string, unknown> = { force };
      for (const [k, val] of Object.entries(v)) if (val !== '') body[k] = val;
      const r = await api.createClient(body);
      onCreated(r.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') {
        const d = (e.details as { duplicates?: ClientDuplicate[] } | undefined)?.duplicates;
        if (d?.length) setDups(d);
        setErr('Похоже, такой клиент уже есть — проверьте список ниже.');
      } else setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const person = v.type === 'person';
  return (
    <Dialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Новый клиент"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          {dups.length > 0
            ? <Button variant="outline" disabled={busy || !v.name?.trim()} onClick={() => void submit(true)}>Создать всё равно</Button>
            : null}
          <Button variant="primary" disabled={busy || !v.name?.trim() || dups.length > 0} onClick={() => void submit(false)}>Создать</Button>
        </>
      )}
    >
      <div className="cl-form">
        <div className="cl-type" role="radiogroup" aria-label="Тип клиента">
          {(['company', 'person'] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={v.type === t} className={`cl-type-btn${v.type === t ? ' on' : ''}`} onClick={() => set('type', t)}>
              <Icon name={t === 'person' ? 'user' : 'building'} size={15} /> {t === 'person' ? 'Частное лицо' : 'Компания'}
            </button>
          ))}
        </div>
        <Field label={person ? 'Имя' : 'Название'}>
          <input className="input" autoFocus value={v.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder={person ? 'Иван Петров' : 'Acme GmbH'} />
        </Field>
        {!person && (
          <Field label="Контактное лицо">
            <input className="input" value={v.contactName ?? ''} onChange={(e) => set('contactName', e.target.value)} placeholder="Имя и фамилия" />
          </Field>
        )}
        <div className="cl-form-row">
          <Field label="Телефон"><input className="input" type="tel" value={v.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="+7 999 123-45-67" /></Field>
          <Field label="Почта"><input className="input" type="email" value={v.email ?? ''} onChange={(e) => set('email', e.target.value)} placeholder="ivan@acme.ru" /></Field>
        </div>
        <div className="cl-form-row">
          <Field label="Ответственный">
            <OptionSelect className="input" value={v.ownerId ?? ''} onChange={(e) => set('ownerId', e.target.value)} aria-label="Ответственный">
              <option value="">Не назначен</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </OptionSelect>
          </Field>
          <Field label="Источник">
            <OptionSelect className="input" value={v.source ?? 'manual'} onChange={(e) => set('source', e.target.value)} aria-label="Источник">
              {Object.entries(SOURCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </OptionSelect>
          </Field>
        </div>
        {!person && <Field label="Сайт"><input className="input" value={v.website ?? ''} onChange={(e) => set('website', e.target.value)} placeholder="acme.ru" /></Field>}

        <button type="button" className="cl-more" aria-expanded={more} onClick={() => setMore((x) => !x)}>
          <Icon name={more ? 'chevron-up' : 'chevron-down'} size={13} /> Подробнее
        </button>
        {more && (
          <>
            <div className="cl-form-row">
              <Field label="Статус">
                <OptionSelect className="input" value={v.status ?? 'active'} onChange={(e) => set('status', e.target.value)} aria-label="Статус">
                  {STATUS_KEYS.map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
                </OptionSelect>
              </Field>
              <Field label="Сегмент"><input className="input" value={v.segment ?? ''} onChange={(e) => set('segment', e.target.value)} placeholder="VIP, Key Account…" /></Field>
            </div>
            {!person && <Field label="Юридическое название"><input className="input" value={v.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} /></Field>}
            <div className="cl-form-row">
              <Field label="ИНН / налоговый номер"><input className="input" value={v.taxId ?? ''} onChange={(e) => set('taxId', e.target.value)} /></Field>
              <Field label="Город"><input className="input" value={v.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Field>
            </div>
            <Field label="Telegram"><input className="input" value={v.telegram ?? ''} onChange={(e) => set('telegram', e.target.value)} placeholder="@username" /></Field>
            <Field label="Описание"><textarea className="input" rows={3} value={v.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
          </>
        )}

        {dups.length > 0 && (
          <div className="cl-dups" role="alert">
            <b><Icon name="alert" size={14} /> Возможный дубликат</b>
            {dups.map((d) => (
              <div key={d.id} className="cl-dup">
                <span>{d.name}{d.website ? <span className="dim"> · {d.website}</span> : null}{d.archived ? <span className="dim"> · в архиве</span> : null}</span>
                <span className="dim">совпадает: {d.matched.map((m) => MATCH[m] ?? m).join(', ')}</span>
                <Button variant="outline" size="sm" onClick={() => { onClose(); navigate({ section: 'clients', clientId: d.id }); }}>Открыть существующего</Button>
              </div>
            ))}
          </div>
        )}
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}
