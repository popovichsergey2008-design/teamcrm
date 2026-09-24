import { useEffect, useState } from 'react';
import { DatePicker } from './DatePicker';
import { Icon } from './Icon';
import { api, ApiError, TagSettings } from '../lib/api';
import type { User } from '../types';
import { TaskTagsField } from './TaskTagsField';
import { EMPTY_TAGS, tagsReady, TagsValue } from '../lib/tags';
import { navigate } from '../lib/router';
import { overlayProps } from '../lib/overlay';
import { SuggestAssignee } from './SuggestAssignee';
import { isAnonymousClipboardName, screenshotName } from '../lib/attachments';

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
  /*
    Теги задачи (ТЗ по тегам). Старый выбор меток заменён общим полем: ИИ подбирает,
    человек подтверждает, и до подтверждения задача не создаётся. Одно поле на все
    места, где рождается задача, — иначе правила в форме, в быстрой команде и в чате
    неизбежно разойдутся.
  */
  const [tags, setTags] = useState<TagsValue>(EMPTY_TAGS);
  const [tagSettings, setTagSettings] = useState<TagSettings | null>(null);
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
  /**
   * Возможные дубли по набранному названию.
   *
   * Проверяем ДО создания: дубль дешевле не завести, чем потом объединять. Ничего
   * не запрещаем — предупреждение можно закрыть и создать задачу как ни в чём не бывало.
   */
  const [dupes, setDupes] = useState<Awaited<ReturnType<typeof api.taskDuplicates>>['items']>([]);
  const [dupesHidden, setDupesHidden] = useState(false);

  // Политика компании по тегам: от неё зависит, ждать ли подтверждения перед созданием.
  useEffect(() => { api.tagSettings().then(setTagSettings).catch(() => setTagSettings(null)); }, []);

  // Запрос с задержкой и только на осмысленное название: на каждую букву ходить
  // в базу незачем, а по двум словам похоже вообще всё.
  useEffect(() => {
    const text = title.trim();
    if (text.length < 8) { setDupes([]); return; }
    const t = setTimeout(() => {
      api.taskDuplicates(text, description.trim() || undefined)
        .then((r) => setDupes(r.items))
        .catch(() => setDupes([])); // подсказка — удобство, молчаливый отказ лучше ошибки
    }, 600);
    return () => clearTimeout(t);
  }, [title, description]);

  const addFiles = (list: FileList | File[] | null) => {
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
        labelIds: tags.tagIds.length ? tags.tagIds : undefined,
        suggestedTagIds: tags.suggested.length ? tags.suggested : undefined,
        tagsConfirmed: tags.confirmed,
        confirmedWithoutTags: tags.confirmedWithoutTags,
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
    <div
      className="modal-overlay"
      data-paste-scope
      /*
        Снимок из буфера — прямо в задачу (задача #1367).

        Раньше Ctrl+V здесь не делал ничего, а слушатель открытой позади переписки
        уносил снимок в чат, из которого человек только что вышел. Теперь верхний
        слой забирает вставку себе — и это окно тоже умеет её принимать.
      */
      onPaste={(e) => {
        const images = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!images.length) return;
        e.preventDefault();
        // «image.png» из буфера — это дата и время снимка, иначе в списке десяток одинаковых имён
        addFiles(images.map((f) => (isAnonymousClipboardName(f.name)
          ? new File([f], screenshotName(new Date(), f.type), { type: f.type })
          : f)));
      }}
      {...overlayProps(onClose)}
    >
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

        {/*
          «Возможно, такая задача уже есть».

          Стоит сразу под названием — там, где человек её и породил, — и ничего не
          запрещает: бывает, что похожая задача действительно нужна второй раз.
          Кнопка «Открыть» уводит в существующую, «Создать всё равно» просто убирает
          подсказку, чтобы она не мешала дозаполнять форму.
        */}
        {!dupesHidden && dupes.length > 0 && (
          <div className="dupes-warn">
            <div className="dupes-head">
              <Icon name="alert" size={14} /> Возможно, такая задача уже существует
            </div>
            {dupes.map((d) => (
              <div key={d.id} className="dupes-row">
                <span className="registry-id">#{d.id}</span>
                <span className="dupes-title" title={d.reason}>{d.title}</span>
                <span className="dim">{d.projectName ?? ''}</span>
                <span className="merge-match">{d.match}%</span>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    navigate({ section: 'projects', projectId: String(d.projectId), taskId: String(d.id) });
                    onClose();
                  }}
                >
                  Открыть
                </button>
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={() => setDupesHidden(true)}>
              Создать всё равно
            </button>
          </div>
        )}

        <div className="drawer-grid2">
          <div className="field"><label>Исполнитель</label>
            <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">— не назначен —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
            {/* Совет по названию задачи — по кнопке, а не на каждую букву (ТЗ-10). */}
            <SuggestAssignee title={title} description={description} projectId={projectId} onPick={setAssigneeId} />
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

        <TaskTagsField
          task={{ title, description, projectName: null }}
          value={tags}
          onChange={setTags}
        />

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
          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 6 }}
            /* Теги не подтверждены — создавать нельзя: то же правило проверяет сервер. */
            disabled={busy || !tagsReady(tagSettings, tags)}
            onClick={submit}
            title={tagsReady(tagSettings, tags) ? undefined : 'Подтвердите теги задачи'}
          >
            {busy
              ? (files.length ? 'Создаём и грузим файлы…' : 'Создаём…')
              : (files.length ? `Создать задачу и прикрепить ${files.length}` : 'Создать задачу')}
          </button>
        )}
      </div>
    </div>
  );
}
