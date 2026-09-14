import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { api, ApiError } from '../lib/api';
import { stampLabel } from '../lib/chat-text';
import { showToast } from '../lib/notifications';

type Overview = Awaited<ReturnType<typeof api.supportOverview>>;

/**
 * Поддержка.
 *
 * Одна кнопка для человека, у которого что-то не работает: описал, приложил снимок,
 * отправил. Обращение становится обычной задачей владельцу в проекте поддержки —
 * с перепиской, файлами и статусом, — и ниже видно, что с ним происходит.
 * Отдельной «системы заявок» здесь нет намеренно: всё это уже умеет задача.
 */
export function SupportPage({ onOpenTask }: { onOpenTask: (projectId: string, taskId: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => api.supportOverview().then(setData).catch(() => setData({ project: null, tickets: [] })), []);
  useEffect(() => { void load(); }, [load]);

  /** Снимок экрана — самое полезное в обращении: одноимённые не копим. */
  const addFiles = (list: FileList | File[] | null) => {
    if (!list || !('length' in list) || !list.length) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...Array.from(list).filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const image = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (!image) return;
    e.preventDefault();
    const stamp = new Date().toLocaleString('ru-RU').replace(/[:.]/g, '-');
    addFiles([new File([image], `Снимок ${stamp}.png`, { type: image.type || 'image/png' })]);
  };

  const submit = async () => {
    if (!title.trim()) { setErr('Опишите, что случилось, — хотя бы одной строкой'); return; }
    setErr(''); setBusy(true);
    try {
      const created = await api.supportCreate({ title: title.trim(), description: description.trim() || undefined });
      // Файлы — после создания и по одному: вложение живёт при задаче, а её до этого нет.
      const failed: string[] = [];
      for (const f of files) {
        try { await api.uploadAttachment(created.id, f); } catch { failed.push(f.name); }
      }
      setTitle(''); setDescription(''); setFiles([]);
      showToast(failed.length
        ? { title: 'Обращение отправлено', body: `Не загрузились файлы: ${failed.join(', ')}. Приложите их в задаче.`, kind: 'saved' }
        : { title: 'Обращение отправлено', body: 'Ответ и ход работы — в задаче', kind: 'saved' });
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось отправить обращение');
    } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2><Icon name="support" size={18} /> Поддержка</h2>
        <span className="dim">
          {data?.project ? `Обращения попадают в проект «${data.project.name}»` : 'Проблемы, вопросы и предложения по системе'}
        </span>
      </div>

      <div className="support-body">
        <section className="support-form">
          <div className="drawer-section-title">Сообщить о проблеме</div>
          <div className="field">
            <label>Что случилось</label>
            <input
              className="input"
              value={title}
              autoFocus
              placeholder="Коротко: что не работает или чего не хватает"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(); }}
            />
          </div>
          <div className="field">
            <label>Подробности (необязательно)</label>
            <textarea
              className="input"
              rows={5}
              value={description}
              placeholder="Где это было, что нажимали, что ожидали увидеть. Снимок экрана можно вставить из буфера (Ctrl+V)"
              onChange={(e) => setDescription(e.target.value)}
              onPaste={onPaste}
            />
          </div>
          <div className="field">
            <label>Снимки экрана и файлы</label>
            <div
              className="file-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
            >
              <label className="btn btn-sm file-pick">
                <Icon name="paperclip" size={14} /> Выбрать файлы
                <input
                  className="file-pick-input"
                  type="file"
                  multiple
                  aria-label="Выбрать файлы к обращению"
                  onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                />
              </label>
              <span className="dim">или перетащите сюда, или Ctrl+V в подробности</span>
            </div>
            {files.length > 0 && (
              <div className="file-picked">
                {files.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="people-chip">
                    <Icon name="file" size={12} /> {f.name}
                    <button className="people-chip-x" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} title="Убрать файл" aria-label={`Убрать ${f.name}`}>
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          {err && <div className="error-text">{err}</div>}
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            <Icon name="send" size={14} /> {busy ? 'Отправляю…' : 'Отправить'}
          </button>
          <p className="dim support-hint">
            Обращение станет задачей владельцу компании: ответ и ход работы — в её переписке,
            уведомления придут как по обычной задаче.
          </p>
        </section>

        <section className="support-list">
          <div className="drawer-section-title">Мои обращения</div>
          {!data && <SkeletonList rows={4} />}
          {data && data.tickets.length === 0 && <p className="dim">Вы ещё ничего не отправляли.</p>}
          {data && data.tickets.map((t) => (
            <button key={t.id} className="support-ticket" onClick={() => onOpenTask(t.projectId, t.id)} title="Открыть задачу">
              <span className={`badge ${t.closed ? 'badge-muted' : 'badge-info'}`}>{t.closed ? 'решено' : t.status}</span>
              <span className="support-ticket-title">#{t.id} · {t.title}</span>
              <span className="dim support-ticket-when">{stampLabel(t.createdAt)}</span>
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}
