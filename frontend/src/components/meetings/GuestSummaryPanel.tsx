import { useCallback, useEffect, useRef, useState } from 'react';
import '../guest/guest-host.css';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { confirmAction } from '../ui/dialog';
import { api, ApiError, GuestAgreement, GuestSummaryHost } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';

const SIDE_LABEL: Record<string, string> = { ours: 'Мы', client: 'Клиент', both: 'Вместе', unassigned: 'Не указано' };
const KIND_LABEL: Record<string, string> = { confirmed: 'подтвердил(а)', question: 'вопрос', correction: 'уточнение', comment: 'комментарий' };

type Draft = { language: string; text: string; agreements: GuestAgreement[]; next: { title: string; at: string; url: string | null } | null };

const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

/**
 * «Клиентский протокол» на экране итогов встречи (ТЗ-28, п. 31–33): черновик для
 * внешнего клиента — текст пишет модель, договорённости из решений и поручений встречи.
 * Хозяин правит, смотрит глазами клиента и публикует. Молча клиенту ничего не уходит.
 */
export default function GuestSummaryPanel({ meetingId }: { meetingId: string }) {
  const [data, setData] = useState<GuestSummaryHost | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<'' | 'draft' | 'save' | 'publish' | 'file'>('');
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(false);
  const [changed, setChanged] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const autoDrafted = useRef(false);

  const apply = (r: GuestSummaryHost) => {
    setData(r);
    if (r.summary) {
      setDraft({ language: r.summary.language, text: r.summary.text, agreements: r.summary.agreements.map((a) => ({ text: a.text, side: a.side, deadlineAt: a.deadlineAt })), next: r.summary.nextMeeting ? { ...r.summary.nextMeeting, at: new Date(r.summary.nextMeeting.at).toISOString() } : null });
      setChanged(false);
    }
  };

  const run = useCallback(async (kind: typeof busy, fn: () => Promise<GuestSummaryHost>) => {
    setBusy(kind); setErr('');
    try { apply(await fn()); return true; } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось');
      return false;
    } finally { setBusy(''); }
  }, []);

  useEffect(() => {
    api.guestSummary(meetingId).then((r) => {
      apply(r);
      // черновик готовим сами, как только есть кому его показать
      if (r.eligible && !r.summary && !autoDrafted.current) {
        autoDrafted.current = true;
        void run('draft', () => api.guestSummaryDraft(meetingId));
      }
    }).catch((e) => setErr(e instanceof ApiError && e.code === 'FORBIDDEN' ? '' : (e instanceof ApiError ? e.message : 'Не удалось загрузить')));
  }, [meetingId, run]);

  if (!data || !data.eligible) return null;
  const s = data.summary;

  const edit = (patch: Partial<Draft>) => { setDraft((d) => (d ? { ...d, ...patch } : d)); setChanged(true); };
  const setAgreement = (i: number, patch: Partial<GuestAgreement>) =>
    edit({ agreements: draft!.agreements.map((a, k) => (k === i ? { ...a, ...patch } : a)) });

  const save = () => run('save', () => api.guestSummarySave(meetingId, {
    language: draft!.language, text: draft!.text,
    agreements: draft!.agreements.filter((a) => a.text.trim()),
    nextMeeting: draft!.next && draft!.next.at ? { title: draft!.next.title || 'Встреча', at: draft!.next.at, url: draft!.next.url } : null,
  }));

  const publish = async () => {
    if (changed && !(await save())) return;
    const again = (s?.version ?? 0) > 0;
    if (!(await confirmAction({
      title: again ? 'Опубликовать обновлённые итоги?' : 'Опубликовать итоги клиенту?',
      description: `Гости встречи увидят этот текст по своей ссылке${data.canPublishTo ? `, ${data.canPublishTo} получат письмо` : ''}. Внутренний разбор останется внутри.`,
      confirmLabel: 'Опубликовать',
    }))) return;
    setBusy('publish'); setErr('');
    try {
      const r = await api.guestSummaryPublish(meetingId);
      apply(r);
      toastSaved(r.mailed ? `Итоги опубликованы, писем: ${r.mailed}` : 'Итоги опубликованы');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось опубликовать');
    } finally { setBusy(''); }
  };

  const redraft = async () => {
    if (s && !(await confirmAction({ title: 'Собрать черновик заново?', description: 'Текст и договорённости заменятся новым черновиком. Материалы останутся.', confirmLabel: 'Собрать заново' }))) return;
    await run('draft', () => api.guestSummaryDraft(meetingId, draft?.language));
  };

  const upload = async (f: File) => {
    setBusy('file'); setErr('');
    try {
      const up = await api.uploadFile(f, 'guest_summary', s?.id);
      apply(await api.guestSummaryAddFile(meetingId, String(up.id)));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Файл не загрузился');
    } finally { setBusy(''); }
  };

  const unhandled = s?.feedback.filter((f) => f.kind !== 'confirmed' && !f.handledAt) ?? [];
  const acks = s?.feedback.filter((f) => f.kind === 'confirmed' && f.version === s.version) ?? [];

  return (
    <section className="pc-block gsp" aria-label="Клиентский протокол">
      <div className="gsp-head">
        <h3><Icon name="users" size={15} /> Клиентский протокол</h3>
        {s && (
          <span className={`gsp-status gsp-status-${s.status}`}>
            {s.status === 'published' ? `Опубликован · версия ${s.version}${s.dirty || changed ? ' · есть неопубликованные правки' : ''}` : 'Черновик'}
          </span>
        )}
      </div>
      <p className="dim gsp-hint">
        Что увидят гости встречи по своей ссылке: только этот текст, договорённости и выбранные материалы.
        {data.guests.length > 0 && ` Гостей: ${data.guests.length}.`}
      </p>

      {busy === 'draft' && <p className="dim"><Icon name="sparkles" size={13} /> Готовлю черновик для клиента…</p>}

      {s && draft && busy !== 'draft' && !preview && (
        <div className="gsp-form">
          <label className="gsp-field">
            <span>Кратко</span>
            <textarea className="input" rows={4} maxLength={3000} value={draft.text} onChange={(e) => edit({ text: e.target.value })} />
          </label>
          <div className="gsp-field">
            <span>Договорились</span>
            {draft.agreements.map((a, i) => (
              <div key={i} className="gsp-agreement">
                <input className="input" value={a.text} maxLength={500} aria-label={`Договорённость ${i + 1}`} onChange={(e) => setAgreement(i, { text: e.target.value })} />
                <select className="input" value={a.side} aria-label="Чья сторона" onChange={(e) => setAgreement(i, { side: e.target.value })}>
                  {Object.entries(SIDE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input className="input" type="date" aria-label="Срок" value={a.deadlineAt ? toLocal(a.deadlineAt).slice(0, 10) : ''}
                  onChange={(e) => setAgreement(i, { deadlineAt: e.target.value ? new Date(`${e.target.value}T12:00:00`).toISOString() : null })} />
                <Button variant="ghost" size="icon-sm" aria-label="Убрать" onClick={() => edit({ agreements: draft.agreements.filter((_, k) => k !== i) })}><Icon name="close" size={13} /></Button>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={() => edit({ agreements: [...draft.agreements, { text: '', side: 'ours', deadlineAt: null }] })}><Icon name="plus" size={13} /> Добавить</Button>
          </div>
          <div className="gsp-field">
            <span>Следующая встреча</span>
            <div className="gsp-agreement">
              <input className="input" placeholder="Название" value={draft.next?.title ?? ''} onChange={(e) => edit({ next: { title: e.target.value, at: draft.next?.at ?? '', url: draft.next?.url ?? null } })} aria-label="Название следующей встречи" />
              <input className="input" type="datetime-local" value={toLocal(draft.next?.at || null)} aria-label="Когда"
                onChange={(e) => edit({ next: { title: draft.next?.title ?? '', at: fromLocal(e.target.value) ?? '', url: draft.next?.url ?? null } })} />
              {draft.next && <Button variant="ghost" size="icon-sm" aria-label="Без следующей встречи" onClick={() => edit({ next: null })}><Icon name="close" size={13} /></Button>}
            </div>
          </div>
          <label className="gsp-field gsp-inline">
            <span>Язык клиента</span>
            <select className="input" value={draft.language} onChange={(e) => edit({ language: e.target.value })}>
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </select>
          </label>
          <div className="gsp-field">
            <span>Материалы <span className="dim">— только то, что вы добавите сюда</span></span>
            {s.files.map((f) => (
              <div key={f.id} className="gsp-file">
                <Icon name="file" size={13} /> {f.name}
                <Button variant="ghost" size="icon-sm" aria-label={`Убрать ${f.name}`} disabled={!!busy} onClick={() => void run('file', () => api.guestSummaryRemoveFile(meetingId, f.id))}><Icon name="close" size={13} /></Button>
              </div>
            ))}
            <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => fileRef.current?.click()}><Icon name="paperclip" size={13} /> Приложить файл</Button>
          </div>
        </div>
      )}

      {s && draft && preview && (
        <div className="gsp-preview" aria-label="Глазами клиента">
          <div className="gp-fixed"><Icon name="check-circle" size={16} /> Договорённости зафиксированы</div>
          {draft.text && <p>{draft.text}</p>}
          <ul className="gp-agreements">
            {draft.agreements.filter((a) => a.text.trim()).map((a, i) => (
              <li key={i}>{a.side !== 'unassigned' && <span className="gp-side">{a.side === 'client' ? 'Вы' : SIDE_LABEL[a.side]}</span>}<span>{a.text}</span></li>
            ))}
          </ul>
          {draft.next?.at && <p className="dim">Следующая встреча: {draft.next.title} · {new Date(draft.next.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>}
        </div>
      )}

      {err && <div className="error-text">{err}</div>}

      <div className="pc-actions">
        {!s && busy !== 'draft' && <Button variant="primary" onClick={() => void run('draft', () => api.guestSummaryDraft(meetingId))}><Icon name="sparkles" size={14} /> Подготовить черновик</Button>}
        {s && (
          <>
            <Button variant="primary" disabled={!!busy || (s.status === 'published' && !s.dirty && !changed)} onClick={() => void publish()}>
              <Icon name="send" size={14} /> {s.status === 'published' ? 'Опубликовать правки' : 'Опубликовать клиенту'}
            </Button>
            <Button variant="outline" aria-pressed={preview} onClick={() => setPreview((v) => !v)}><Icon name="eye" size={14} /> {preview ? 'Редактировать' : 'Предпросмотр'}</Button>
            {changed && <Button variant="outline" disabled={!!busy} onClick={() => void save()}>Сохранить</Button>}
            <Button variant="ghost" disabled={!!busy} onClick={() => void redraft()}><Icon name="refresh" size={14} /> Собрать заново</Button>
          </>
        )}
        {data.meetingUrl && (
          <Button variant="ghost" onClick={() => { void navigator.clipboard?.writeText(data.meetingUrl!); toastSaved('Ссылка встречи скопирована'); }}><Icon name="link" size={14} /> Клиентская ссылка</Button>
        )}
      </div>

      {s && (acks.length > 0 || unhandled.length > 0) && (
        <div className="gsp-feedback">
          {acks.length > 0 && <p className="gsp-acks"><Icon name="check" size={13} /> Подтвердили: {acks.map((a) => a.name).join(', ')}</p>}
          {unhandled.map((f) => (
            <div key={f.id} className="gsp-fb">
              <b>{f.name}</b> · {KIND_LABEL[f.kind] ?? f.kind}
              <div>{f.body}</div>
              <Button variant="ghost" size="sm" onClick={() => void run('save', () => api.guestFeedbackHandled(meetingId, f.id))}><Icon name="check" size={13} /> Учтено</Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
