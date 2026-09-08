import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, MergeSide } from '../lib/api';
import { useEscape } from '../hooks/useEscape';

type Candidate = Awaited<ReturnType<typeof api.taskMergeCandidates>>['items'][number];
type Preview = Awaited<ReturnType<typeof api.taskMergePreview>>;

/**
 * Объединение похожих задач.
 *
 * Сценарий один и короткий: открыл задачу → нажал «Объединить» → увидел похожие →
 * выбрал → посмотрел, что получится → подтвердил. Всё остальное — подсказки, и
 * ни одна из них ничего не делает без нажатия.
 *
 * Два шага, а не одно окно с кнопкой: объединение необратимо для переписки и
 * файлов, и человек обязан увидеть, что именно переедет, до того как это случится.
 */
export function TaskMergeModal({ taskId, taskTitle, onClose, onMerged }: {
  taskId: string;
  taskTitle: string;
  onClose: () => void;
  /** Куда идти после объединения: основная задача может оказаться в другом проекте. */
  onMerged: (r: { taskId: string; projectId: string; mergedId: string }) => void;
}) {
  useEscape(onClose);
  const [items, setItems] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [searched, setSearched] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  /** Выбранная вторая задача: с этого места окно переходит ко второму шагу. */
  const [preview, setPreview] = useState<Preview | null>(null);
  /** Какая из двух остаётся основной. По умолчанию — та, из которой пришли. */
  const [keepCurrent, setKeepCurrent] = useState(true);
  const [useSuggestion, setUseSuggestion] = useState(false);
  const [dedupe, setDedupe] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback((query: string) => {
    setLoading(true);
    setErr('');
    api.taskMergeCandidates(taskId, query || undefined)
      .then((r) => { setItems(r.items); setSearched(r.searched); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось найти похожие задачи'))
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => { load(''); }, [load]);

  // Поиск с задержкой: запрос на каждую букву кладёт базу и мигает списком.
  useEffect(() => {
    const t = setTimeout(() => load(q.trim()), q.trim() ? 350 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  const choose = async (id: string) => {
    setErr('');
    setBusy(true);
    try {
      const p = await api.taskMergePreview(taskId, id);
      setPreview(p);
      setKeepCurrent(true);
      setUseSuggestion(false);
      setTitle(p.suggestion.title);
      setDescription(p.suggestion.description);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось собрать предпросмотр');
    } finally { setBusy(false); }
  };

  const doMerge = async () => {
    if (!preview) return;
    setBusy(true);
    setErr('');
    const primary = keepCurrent ? preview.primary : preview.secondary;
    const secondary = keepCurrent ? preview.secondary : preview.primary;
    try {
      const r = await api.mergeTasks(taskId, {
        primaryId: primary.id,
        secondaryId: secondary.id,
        // Название и описание меняем ТОЛЬКО если человек принял предложение:
        // молча переписать чужую постановку нельзя.
        title: useSuggestion ? title.trim() || undefined : undefined,
        description: useSuggestion ? description : undefined,
        checklist: dedupe ? preview.suggestion.checklist : undefined,
      });
      onMerged(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось объединить задачи');
      setBusy(false);
    }
  };

  const side = (s: MergeSide, main: boolean) => (
    <div className={`merge-side${main ? ' main' : ''}`}>
      <div className="merge-side-head">
        <span className="registry-id">#{s.id}</span>
        {main ? <span className="badge badge-info">останется</span> : <span className="badge">будет объединена</span>}
      </div>
      <div className="merge-side-title">{s.title}</div>
      <div className="dim">{s.projectName ?? '—'} · {s.assigneeName ?? 'не назначен'}</div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card merge-modal" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="refresh" size={16} /> {preview ? 'Объединить задачи?' : 'Найти похожую задачу'}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={16} />
          </button>
        </div>

        {!preview && (
          <>
            <p className="dim">Текущая задача: <b>#{taskId}</b> {taskTitle}</p>
            <input
              className="input"
              placeholder="Найти задачу: название, номер, проект, исполнитель, постановщик"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="dim merge-hint">
              {searched ? 'Результаты поиска' : 'Похожие задачи — сначала самые вероятные дубли'}
            </div>

            {loading && <div className="dim">Ищу…</div>}
            {!loading && items.length === 0 && (
              <div className="dim">
                {searched ? 'Ничего не нашлось — попробуйте другие слова или номер задачи'
                  : 'Похожих задач не видно. Найдите нужную поиском выше.'}
              </div>
            )}

            <div className="merge-list">
              {items.map((c) => (
                <button key={c.id} className="merge-item" onClick={() => choose(c.id)} disabled={busy}>
                  <span className="merge-item-main">
                    <span className="registry-id">#{c.id}</span>
                    <span className="merge-item-title">{c.title}</span>
                  </span>
                  <span className="dim merge-item-meta">
                    {c.projectName ?? '—'} · {c.assigneeName ?? 'не назначен'}
                    {c.managerName ? ` · от ${c.managerName}` : ''}
                  </span>
                  {/* Процент без объяснения — гадание. Показываем и то, и другое. */}
                  <span className="merge-match" title={c.reason}>{c.match}%</span>
                </button>
              ))}
            </div>
          </>
        )}

        {preview && (
          <>
            <div className="merge-sides">
              {side(preview.primary, keepCurrent)}
              <Icon name="arrow-right" size={16} />
              {side(preview.secondary, !keepCurrent)}
            </div>

            <div className="field">
              <label>Какая задача остаётся основной</label>
              <div className="merge-keep">
                <label className="feed-flag">
                  <input type="radio" checked={keepCurrent} onChange={() => setKeepCurrent(true)} />
                  Текущая — #{preview.primary.id}
                </label>
                <label className="feed-flag">
                  <input type="radio" checked={!keepCurrent} onChange={() => setKeepCurrent(false)} />
                  Выбранная — #{preview.secondary.id}
                </label>
              </div>
            </div>

            {preview.differentProjects && (
              <div className="merge-warn">
                <Icon name="alert" size={14} /> Задачи из разных проектов: «{preview.primary.projectName}» и
                «{preview.secondary.projectName}». После объединения работа продолжится в проекте основной задачи.
              </div>
            )}

            <div className="merge-moves dim">
              Переедет в основную: комментариев — {preview.moves.comments}, файлов — {preview.moves.files},
              пунктов чек-листа — {preview.moves.checklist}, участников — {preview.moves.participants},
              сообщений из чатов — {preview.moves.messages}
              {preview.moves.meetings > 0 ? `, связей со встречами — ${preview.moves.meetings}` : ''}.
              Учтённое время остаётся у своей задачи, история сохраняется у обеих.
            </div>

            <label className="feed-flag">
              <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} />
              Собрать общий чек-лист без повторов ({preview.suggestion.checklist.length} пунктов)
            </label>
            <label className="feed-flag">
              <input type="checkbox" checked={useSuggestion} onChange={(e) => setUseSuggestion(e.target.checked)} />
              Взять объединённое название и описание
              {preview.suggestion.byAi ? ' (предложил ИИ)' : ' (склеены по правилам)'}
            </label>

            {/* Предложение можно править прямо здесь: принимать чужой текст не глядя
                человек не обязан, а уходить ради правки в карточку — лишний круг. */}
            {useSuggestion && (
              <>
                <div className="field">
                  <label>Название основной задачи</label>
                  <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} />
                </div>
                <div className="field">
                  <label>Описание</label>
                  <textarea className="input" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
              </>
            )}

            {err && <div className="error-text">{err}</div>}

            <div className="merge-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setPreview(null)} disabled={busy}>
                <Icon name="chevron-left" size={14} /> К списку
              </button>
              <button className="btn btn-primary" onClick={doMerge} disabled={busy}>
                {busy ? 'Объединяю…' : 'Объединить'}
              </button>
            </div>
          </>
        )}

        {!preview && err && <div className="error-text">{err}</div>}
      </div>
    </div>
  );
}
