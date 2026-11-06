import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { api, ApiError } from '../../lib/api';
import { flowApi, type QueueItem, type ReviewItem } from '../../lib/flow-api';
import { daysWord, workDays } from '../../lib/board-card';
import { feedback } from '../../lib/feedback';
import { toastSaved } from '../../lib/notifications';
import { useEscape } from '../../hooks/useEscape';
import '../task-flow/task-flow.css';

const when = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');
const plain = (html: string | null) => (html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const draftKey = (id: string) => `qevo.review.draft:${id}`;

/**
 * Очередь решений «Ждут моего решения» (#4798 §4, #4799 BOARD02, макет 05).
 *
 * Слева — что ждёт меня, справа — одна сданная работа целиком: что просили, что
 * сделано, где смотреть, что осталось проверить и что проверил ИИ. Три действия:
 * принять, вернуть с обязательным комментарием, задать вопрос без смены статуса.
 * После решения сразу следующая — проверка идёт подряд, без возврата к доске.
 *
 * ИИ объясняет, но не принимает. Пришла новая версия, пока читал старую, — просим
 * перечитать. Решение не прошло (права, сеть) — комментарий остаётся черновиком.
 */
export function ReviewQueue({ onClose, onOpenTask }: {
  onClose: () => void;
  onOpenTask: (t: { id: string; project_id: string }) => void;
}) {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [item, setItem] = useState<ReviewItem | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState<'' | 'accept' | 'return' | 'ask' | 'ai'>('');
  useEscape(onClose, !busy);

  const loadQueue = useCallback(async (keep?: string | null) => {
    try {
      const q = await flowApi.queue();
      setQueue(q);
      setPick((cur) => {
        const want = keep === undefined ? cur : keep;
        return want && q.some((x) => x.id === want) ? want : q[0]?.id ?? null;
      });
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить очередь'); setQueue([]); }
  }, []);
  useEffect(() => { void loadQueue(); }, [loadQueue]);

  const loadItem = useCallback(async (id: string) => {
    setItem(null); setErr('');
    try { setItem(await flowApi.reviewItem(id)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть результат'); }
  }, []);
  useEffect(() => {
    if (!pick) { setItem(null); return; }
    setInfo('');
    try { setNote(localStorage.getItem(draftKey(pick)) ?? ''); } catch { setNote(''); }
    void loadItem(pick);
  }, [pick, loadItem]);

  const keepDraft = (v: string) => {
    setNote(v);
    if (!pick) return;
    try { if (v.trim()) localStorage.setItem(draftKey(pick), v); else localStorage.removeItem(draftKey(pick)); } catch { /* без хранилища */ }
  };

  const latest = item?.handoffs[0] ?? null;
  const decide = async (action: 'accept' | 'return' | 'ask') => {
    if (!item || busy) return;
    if ((action === 'return' || action === 'ask') && !note.trim()) {
      setErr(action === 'return' ? 'Чтобы вернуть, напишите, что доработать' : 'Напишите вопрос исполнителю');
      return;
    }
    setBusy(action); setErr('');
    try {
      await flowApi.decide(item.task.id, { action, note: note.trim() || undefined, handoffVersion: latest?.version ?? 0 });
      try { localStorage.removeItem(draftKey(item.task.id)); } catch { /* без хранилища */ }
      setNote('');
      if (action === 'ask') { toastSaved('Вопрос отправлен', 'Исполнитель увидит его в обсуждении задачи'); return; }
      feedback(action === 'accept' ? 'task.approved' : 'task.moved');
      toastSaved(action === 'accept' ? 'Результат принят' : 'Возвращено на доработку', `#${item.task.id}`);
      // следующая по очереди — сразу, без возврата к доске
      const rest = (queue ?? []).filter((x) => x.id !== item.task.id);
      setQueue(rest);
      setPick(rest[0]?.id ?? null);
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { reason?: string } | undefined) : undefined;
      if (d?.reason === 'new_version') {
        setInfo('Исполнитель прислал новую версию результата — посмотрите её перед решением.');
        await loadItem(item.task.id);
      } else if (d?.reason === 'decided') {
        setInfo('Решение по этой задаче уже принято.');
        void loadQueue(null);
      } else {
        // права, сеть — решение не сохранено, комментарий остаётся черновиком
        setErr(`${e instanceof ApiError ? e.message : 'Решение не сохранено'}. Комментарий сохранён как черновик.`);
      }
    } finally { setBusy(''); }
  };

  const runAi = async () => {
    if (!item) return;
    setBusy('ai'); setErr('');
    try { await api.reviewTask(item.task.id); await loadItem(item.task.id); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'ИИ сейчас недоступен'); }
    finally { setBusy(''); }
  };

  const openFile = async (f: { id: string; name: string }) => {
    try {
      const blob = await api.authedBlob(`/api/files/${f.id}`);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { setErr(`Не удалось открыть «${f.name}»`); }
  };

  const t = item?.task;
  const waiting = t?.submitted_at ? workDays(new Date(t.submitted_at), new Date()) : 0;
  const undone = item?.checklist.filter((c) => !c.is_done) ?? [];
  const checkSum = item?.check?.summary as { total?: number; fixed?: number; notFixed?: number; check?: number } | undefined;

  return (
    <div className="rq-overlay" role="dialog" aria-modal="true" aria-label="Ждут моего решения">
      <div className="rq">
        <header className="rq-head">
          <div>
            <div className="dim">Проекты и задачи / Решения</div>
            <h2>Проверка результата</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={18} /></Button>
        </header>
        <div className="rq-body">
          <aside className="rq-list" aria-label="Решения ждут от вас">
            <div className="rq-list-head">Решения ждут от вас <Badge tone="info">{queue?.length ?? '…'}</Badge></div>
            {queue?.length === 0 && <p className="dim">Сейчас ничего не ждёт вашего решения.</p>}
            {queue?.map((q) => (
              <button key={q.id} className={`rq-row${q.id === pick ? ' is-on' : ''}`} onClick={() => setPick(q.id)} aria-current={q.id === pick}>
                <span className="dim">{when(q.handoff?.at ?? q.submitted_at)}</span>
                <b>#{q.id} · {q.title}</b>
                <span className="dim">{q.handoff ? `Версия ${q.handoff.version} · ${q.handoff.author ?? q.assignee_name ?? ''}` : q.assignee_name ?? ''} · {q.project_name}</span>
              </button>
            ))}
          </aside>

          <section className="rq-main">
            {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
            {info && <div className="tv2-callout tv2-callout-warn" role="status"><Icon name="info" size={15} /> {info}</div>}
            {!pick && queue && <p className="dim">Выберите задачу слева.</p>}
            {pick && !item && !err && <p className="dim">Загружаю результат…</p>}
            {t && item && (
              <>
                <div className="rq-meta">
                  <span>Задача #{t.id}{latest ? ` · Результат версии ${latest.version}` : ''}</span>
                  {item.canDecide && <Badge tone="info">Решение ждут от вас</Badge>}
                  <Button variant="ghost" size="sm" onClick={() => onOpenTask({ id: t.id, project_id: t.project_id })}>Открыть задачу <Icon name="arrow-right" size={13} /></Button>
                </div>
                <h3 className="rq-title">{t.title}</h3>
                <p className="rq-people">
                  Исполнитель: <b>{t.assignee_name ?? '—'}</b> · Постановщик: <b>{t.creator_name ?? '—'}</b> · Проверяет: <b>{t.reviewer_name ?? '—'}</b>
                </p>
                <p className="rq-people dim">
                  Передано на проверку: {when(t.submitted_at)}{waiting ? ` · Ожидает решения: ${daysWord(waiting)}` : ''}
                  {t.deadline_at ? ` · Срок задачи: ${when(t.deadline_at)}` : ''}
                  {t.first_submitted_at && t.deadline_at && new Date(t.first_submitted_at) <= new Date(t.deadline_at) ? ' · сдано в срок' : ''}
                </p>

                <div className="rq-grid">
                  <div>
                    <h4>Что просили</h4>
                    <p className="rq-text">{plain(t.description).slice(0, 700) || 'Описания нет — только название.'}</p>
                    <h4>Кратко что сделано</h4>
                    {latest?.done_text ? <p className="rq-text">{latest.done_text}</p> : <p className="dim">Исполнитель не описал результат при сдаче.</p>}
                    {latest?.where_text && <p className="rq-text"><b>Где посмотреть:</b> {latest.where_text}</p>}
                    {latest?.limits_text && <p className="rq-text"><b>Ограничения:</b> {latest.limits_text}</p>}
                    {item.files.length > 0 ? (
                      <div className="rq-files">
                        {item.files.slice(0, 8).map((f) => (
                          <button key={f.id} className="bb-link" onClick={() => void openFile(f)}><Icon name="paperclip" size={13} /> {f.name}</button>
                        ))}
                      </div>
                    ) : <p className="dim">Скриншот или файл результата не приложен{latest?.where_text ? ' — исполнитель предложил проверить по инструкции.' : '.'}</p>}
                    <h4>Что проверить</h4>
                    <ul className="rq-ul">
                      {undone.map((c, i) => <li key={`u${i}`}>{c.text} <span className="dim">— не отмечено в чек-листе</span></li>)}
                      {(item.ai?.askHuman ?? []).slice(0, 5).map((a, i) => <li key={`a${i}`}>{a}</li>)}
                      {!undone.length && !(item.ai?.askHuman ?? []).length && <li className="dim">{item.checklist.length ? `Чек-лист выполнен: ${item.checklist.length} из ${item.checklist.length}` : 'Отдельных пунктов нет — проверьте результат по описанию'}</li>}
                    </ul>
                  </div>
                  <div>
                    <h4>Проверка с ИИ</h4>
                    {item.ai ? (
                      <div className="rq-ai">
                        {item.ai.conclusion && <p><b>{item.ai.conclusion}</b></p>}
                        {item.ai.summary && <p>{item.ai.summary}</p>}
                        {(item.ai.checked ?? []).slice(0, 6).map((c, i) => (
                          <p key={i} className="dim">{c.status === 'ok' ? '✓' : c.status === 'no' ? '✗' : '?'} {c.what}{c.how === 'reported' ? ' (со слов исполнителя)' : c.how === 'seen' ? ' (видел сам)' : ''}</p>
                        ))}
                        <p className="dim">Это мнение ИИ по материалам, а не приёмка. {item.ai.at ? `Проверено ${when(item.ai.at)}.` : ''}</p>
                      </div>
                    ) : <p className="dim">ИИ эту версию ещё не проверял.</p>}
                    <Button variant="outline" size="sm" onClick={() => void runAi()} loading={busy === 'ai'}><Icon name="sparkles" size={14} /> {item.ai ? 'Проверить ещё раз' : 'Проверить ИИ'}</Button>
                    {item.check && (
                      <>
                        <h4>Было/стало</h4>
                        <p className="dim">
                          {item.check.status !== 'ready' ? 'Отчёт ещё готовится.'
                            : `Пунктов: ${checkSum?.total ?? 0} · исправлено: ${checkSum?.fixed ?? 0} · не исправлено: ${checkSum?.notFixed ?? 0} · проверить глазами: ${checkSum?.check ?? 0}`}
                          {item.check.mode === 'eyes' ? ' Снимки сравнить автоматически нельзя — посмотрите сами.' : ''}
                        </p>
                      </>
                    )}
                    <h4>Комментарий к решению</h4>
                    <textarea className="ui-input" rows={3} value={note} onChange={(e) => keepDraft(e.target.value)}
                      placeholder="Замечание обязательно, если возвращаете результат" aria-label="Комментарий к решению" />
                    <p className="dim">Для возврата комментарий обязателен. «Задать вопрос» пишет исполнителю и не меняет статус.</p>
                  </div>
                </div>

                {item.canDecide ? (
                  <div className="rq-actions">
                    <Button variant="primary" onClick={() => void decide('accept')} loading={busy === 'accept'} disabled={!!busy}>Принять результат</Button>
                    <Button variant="outline" onClick={() => void decide('return')} loading={busy === 'return'} disabled={!!busy}>Вернуть с замечаниями</Button>
                    <Button variant="ghost" onClick={() => void decide('ask')} loading={busy === 'ask'} disabled={!!busy}>Задать вопрос</Button>
                  </div>
                ) : <p className="dim">Решение по этой задаче принимает {t.reviewer_name ?? 'проверяющий'}.</p>}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
