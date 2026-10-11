import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Dialog } from '../../components/ui/dialog';
import { Checkbox } from '../../components/ui/checkbox';
import { OptionSelect } from '../../components/ui/option-select';
import { api, ApiError, NewsCandidate, NewsPost, NewsSettings } from '../../lib/api';
import { TYPE_META } from './shared';

/**
 * Очередь одобрения (§27, §16): что система предлагает опубликовать — хайлайт дня
 * (если владелец выбрал одобрение вручную), вехи и релизы-кандидаты. Видна тем, кто
 * одобряет; без решения человека ничего из этого в ленту не уходит.
 */
export function ReviewPanel({ onPublished, onOpenSettings }: { onPublished: (p: NewsPost) => void; onOpenSettings: () => void }) {
  const [data, setData] = useState<{ drafts: NewsPost[]; candidates: NewsCandidate[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(() => { api.feedReview().then(setData).catch(() => setData({ drafts: [], candidates: [] })); }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNote('');
    try { await fn(); if (done) setNote(done); load(); }
    catch (e) { setNote(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };
  const startEdit = (id: string, t: string, b: string) => { setEditing(id); setTitle(t); setBody(b); };

  const items = [
    ...(data?.drafts ?? []).map((d) => ({ kind: 'draft' as const, id: d.id, type: d.type, title: d.title ?? TYPE_META[d.type].label, body: d.body, extra: d.sources.length ? `источников: ${d.sources.length}` : '' })),
    ...(data?.candidates ?? []).map((c) => ({ kind: 'candidate' as const, id: c.id, type: c.type, title: c.title, body: c.body, extra: [c.projectName ? `проект «${c.projectName}»` : '', c.visibility !== 'all' ? 'только участникам проекта' : ''].filter(Boolean).join(' · ') })),
  ];

  return (
    <section className="card feed-review" aria-label="Ждут одобрения">
      <header className="feed-review-head">
        <b><Icon name="sparkles" size={14} /> Предложения к публикации</b>
        <span className="feed-grow" />
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} title="Собрать хайлайт за прошлый рабочий день, не дожидаясь расписания"
          onClick={() => void run(async () => {
            const r = await api.feedGenerateHighlight();
            if (r.status === 'published' && r.postId) onPublished(await api.feedGet(r.postId));
            setNote(r.status === 'published' ? 'Хайлайт опубликован' : r.status === 'draft' ? 'Хайлайт ждёт одобрения ниже' : r.status === 'exists' ? 'Хайлайт за этот день уже есть' : 'Повода для хайлайта нет — пропуск, а не пустой пост');
          })}>
          <Icon name="sparkles" size={13} /> Хайлайт сейчас
        </button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} title="Собрать выводы недели сейчас"
          onClick={() => void run(async () => {
            const r = await api.feedGenerateLearnings();
            if (r.status === 'published' && r.postId) onPublished(await api.feedGet(r.postId));
            setNote(r.status === 'published' ? 'Выводы недели опубликованы' : r.status === 'exists' ? 'Выводы этой недели уже есть' : 'Материала для выводов мало — пропуск');
          })}>
          <Icon name="bulb" size={13} /> Выводы недели
        </button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} title="Поискать завершённые вехи и релизы"
          onClick={() => void run(async () => { const r = await api.feedDetectCandidates(); setNote(r.added ? `Найдено: ${r.added}` : 'Новых вех и релизов нет'); })}>
          <Icon name="refresh" size={13} />
        </button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onOpenSettings} title="Настройки «Новостей»" aria-label="Настройки «Новостей»"><Icon name="settings" size={14} /></button>
      </header>
      {note && <div className="dim feed-review-note" role="status">{note}</div>}
      {data && items.length === 0 && <div className="dim">Сейчас ничего не ждёт решения.</div>}
      {items.map((it) => (
        <div key={`${it.kind}-${it.id}`} className="feed-review-item">
          <div className="feed-review-type"><Icon name={TYPE_META[it.type].icon} size={13} /> {TYPE_META[it.type].label}{it.extra ? <span className="dim"> · {it.extra}</span> : null}</div>
          {editing === `${it.kind}-${it.id}` ? (
            <>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="Заголовок" />
              <textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Текст" />
            </>
          ) : (
            <>
              <b>{it.title}</b>
              <div className="feed-body feed-preview">{it.body}</div>
            </>
          )}
          <div className="feed-row-actions">
            <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy}
              onClick={() => void run(async () => {
                const patch = editing === `${it.kind}-${it.id}` ? { title: title.trim(), body: body.trim() } : {};
                const p = it.kind === 'draft' ? await api.feedPublishDraft(it.id, patch) : await api.feedPublishCandidate(it.id, patch);
                setEditing(null);
                onPublished(p);
              }, 'Опубликовано')}>
              Опубликовать
            </button>
            {editing !== `${it.kind}-${it.id}` && (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => startEdit(`${it.kind}-${it.id}`, it.title, it.body)}><Icon name="edit" size={13} /> Править</button>
            )}
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy}
              onClick={() => void run(() => (it.kind === 'draft' ? api.feedSkipDraft(it.id) : api.feedRejectCandidate(it.id)))}>
              Не публиковать
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

const DOW = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

/** Настройки раздела (§16, §42): хайлайт сам или по одобрению, герой дня, выводы недели. */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [s, setS] = useState<NewsSettings | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { if (open) api.feedSettings().then(setS).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не загрузилось')); }, [open]);
  const save = async (patch: Partial<NewsSettings>) => {
    if (!s) return;
    setS({ ...s, ...patch });
    try { setS(await api.feedSaveSettings(patch)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не сохранилось'); }
  };
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }} title="Настройки «Новостей»"
      footer={<button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={onClose}>Готово</button>}>
      {!s ? <div className="dim">{err || 'Загружаю…'}</div> : (
        <div className="feed-form">
          <Checkbox checked={s.highlightsEnabled} onCheckedChange={(v) => void save({ highlightsEnabled: v })} label="AI-Хайлайты дня — по рабочим дням, только когда есть повод" />
          <label className="feed-inline-field"><span className="dim">Во сколько</span>
            <OptionSelect className="input" value={s.highlightHour} onChange={(e) => void save({ highlightHour: Number(e.target.value) })} aria-label="Час хайлайта">
              {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </OptionSelect>
          </label>
          <Checkbox checked={s.highlightsAuto} onCheckedChange={(v) => void save({ highlightsAuto: v })} label="Публиковать сразу (выключено — ждёт вашего одобрения)" />
          <Checkbox checked={s.heroEnabled} onCheckedChange={(v) => void save({ heroEnabled: v })} label="«Герой дня» — только по благодарностям и критичным задачам, не каждый день" />
          <Checkbox checked={s.learningsEnabled} onCheckedChange={(v) => void save({ learningsEnabled: v })} label="Выводы недели — решения, релизы и итоги встреч со ссылками" />
          <div className="feed-form-grid">
            <OptionSelect className="input" value={s.learningsDow} onChange={(e) => void save({ learningsDow: Number(e.target.value) })} aria-label="День выводов недели">
              {DOW.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
            </OptionSelect>
            <OptionSelect className="input" value={s.learningsHour} onChange={(e) => void save({ learningsHour: Number(e.target.value) })} aria-label="Час выводов недели">
              {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </OptionSelect>
          </div>
          <p className="dim">Время — по часовому поясу организации. Тексты собираются из фактов; если у организации подключён ключ ИИ, модель только делает формулировки живее — цифры не меняет.</p>
          {err && <div className="error-text" role="alert">{err}</div>}
        </div>
      )}
    </Dialog>
  );
}
