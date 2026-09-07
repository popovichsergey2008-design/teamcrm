import { useEffect, useState } from 'react';
import { DatePicker } from './DatePicker';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import type { User } from '../types';
import { labelTextColor } from '../lib/labels';

interface Props {
  projectId: string;
  columnId: string;
  columnName: string;
  users: User[];
  defaultManagerId?: string;
  onClose: () => void;
  onCreated: () => void;
}

const PRIORITIES = [['low', 'низкий'], ['normal', 'обычный'], ['high', 'высокий'], ['urgent', 'срочно']];

/**
 * Форма создания задачи.
 *
 * Умеет то же, что и открытая карточка: приоритет, срок, оценка, метки —
 * иначе задачу приходится заводить в два захода (создал, открыл, дозаполнил).
 * Всё уходит одним запросом: задача с половиной полей хуже, чем ошибка целиком.
 */
export function TaskCreateModal({ projectId, columnId, columnName, users, defaultManagerId, onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [managerId, setManagerId] = useState(defaultManagerId ?? '');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [deadline, setDeadline] = useState('');
  const [estimate, setEstimate] = useState('');
  const [labels, setLabels] = useState<any[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  /**
   * «Не завершать без согласования» — по умолчанию включено.
   *
   * Это то, что команды и так делают на словах («напиши, когда закончишь»), только
   * теперь договорённость видит система. Снимает галочку тот, кто задачу ставит, —
   * заранее и осознанно, а не в момент, когда работа уже сдана.
   */
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * Файлы, выбранные до создания задачи.
   *
   * Прикрепить их можно только ПОСЛЕ создания — вложение живёт при задаче, а её ещё
   * нет. Поэтому держим файлы у себя и грузим сразу следом. Для человека это одно
   * действие: раньше макет к задаче приходилось доносить вторым заходом, открыв
   * карточку, — и половина задач уходила в работу без исходников.
   */
  const [files, setFiles] = useState<File[]>([]);
  /** Задача уже создана, но файлы не долетели: второй раз её создавать нельзя. */
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => { api.listLabels().then(setLabels).catch(() => undefined); }, []);

  const toggleLabel = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    // одноимённые не копим: человек выбирает файл дважды чаще, чем прикладывает два одинаковых
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...Array.from(list).filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };

  const submit = async () => {
    if (!title.trim()) return setErr('Введите название задачи');
    setErr('');
    setBusy(true);
    try {
      const created = await api.createTask({
        projectId,
        columnId,
        title: title.trim(),
        description: description.trim() || undefined,
        assigneeId: assigneeId || undefined,
        managerId: managerId || undefined,
        priority,
        // поле даёт локальное время без зоны — приводим к ISO, как это делает карточка
        deadlineAt: deadline ? new Date(deadline).toISOString() : undefined,
        estimateHours: estimate ? Number(estimate) : undefined,
        labelIds: picked.length ? picked : undefined,
        requiresApproval,
      });
      setCreatedId(String(created.id));
      // Файлы грузим по одному и по порядку: параллельная отправка десятка вложений
      // с телефона рвётся на середине, и понять, что именно не долетело, нельзя.
      const failed: string[] = [];
      for (const f of files) {
        try { await api.uploadAttachment(String(created.id), f); }
        catch { failed.push(f.name); }
      }
      if (failed.length) {
        // задача уже создана — предлагать «создать» второй раз нельзя, это дубль
        setErr(`Задача создана (#${created.id}), но не загрузились файлы: ${failed.join(', ')}. Прикрепите их в карточке, на вкладке «Файлы».`);
        setBusy(false);
        return;
      }
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать задачу');
      setBusy(false);
    }
  };

  /** Задача создана, файлы — нет: выходим без повторного создания. */
  const finishAfterPartial = () => { onCreated(); onClose(); };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>Новая задача · {columnName}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="field"><label>Название</label>
          <input
            className="input"
            autoFocus
            value={title}
            placeholder="Что нужно сделать"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }}
          />
        </div>

        <div className="drawer-grid2">
          <div className="field"><label>Исполнитель</label>
            <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">— не назначен —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
          </div>
          <div className="field"><label title="Кто ставит задачу и принимает результат">Постановщик</label>
            <select className="input" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">— не задан —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
          </div>
        </div>

        <div className="drawer-grid2">
          <div className="field"><label>Приоритет</label>
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field"><label>Оценка, ч</label>
            <input className="input" type="number" min="0" step="0.5" value={estimate}
                   onChange={(e) => setEstimate(e.target.value)} placeholder="не задана" />
          </div>
        </div>

        <div className="field"><label>Дедлайн</label>
          <DatePicker value={deadline} onChange={setDeadline} withTime warnPast placeholder="срок не задан" />
        </div>

        {labels.length > 0 && (
          <div className="field"><label>Метки</label>
            <div className="label-pick">
              {labels.map((l) => {
                const has = picked.includes(String(l.id));
                return (
                  <button
                    key={l.id}
                    type="button"
                    className={`label-chip ${has ? '' : 'label-off'}`}
                    style={{ background: has ? l.color : 'transparent', borderColor: l.color, color: has ? labelTextColor(l.color) : undefined }}
                    onClick={() => toggleLabel(String(l.id))}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <label className="notify-row" title="Исполнитель сдаст работу, а завершите её вы">
          <input
            type="checkbox"
            checked={requiresApproval}
            onChange={(e) => setRequiresApproval(e.target.checked)}
          />
          Не завершать задачу без согласования с постановщиком
        </label>

        <div className="field"><label>Описание (необязательно)</label>
          <textarea className="input" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        {/* Файлы прямо здесь: задача без исходников — это вопрос «а где макет?»
            через десять минут после постановки. */}
        <div className="field">
          <label>Файлы (необязательно)</label>
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
                aria-label="Выбрать файлы для задачи"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
              />
            </label>
            <span className="dim">или перетащите сюда</span>
          </div>
          {files.length > 0 && (
            <div className="file-picked">
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} className="people-chip">
                  <Icon name="file" size={12} /> {f.name}
                  <button
                    className="people-chip-x"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    title="Убрать файл"
                    aria-label={`Убрать ${f.name}`}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {err && <div className="error-text">{err}</div>}
        {createdId ? (
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 6 }} onClick={finishAfterPartial}>
            Готово — открыть доску
          </button>
        ) : (
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 6 }} disabled={busy} onClick={submit}>
            {busy
              ? (files.length ? 'Создаём и грузим файлы…' : 'Создаём…')
              : (files.length ? `Создать задачу и прикрепить ${files.length}` : 'Создать задачу')}
          </button>
        )}
      </div>
    </div>
  );
}
