import { useEffect, useState } from 'react';
import { DatePicker } from './DatePicker';
import { Icon } from './Icon';
import { api, ApiError, TagSettings } from '../lib/api';
import type { TaskTemplate, User } from '../types';
import { TaskTagsField } from './TaskTagsField';
import { EMPTY_TAGS, tagsReady, TagsValue } from '../lib/tags';
import { navigate } from '../lib/router';
import { overlayProps } from '../lib/overlay';
import { SuggestAssignee } from './SuggestAssignee';
import { DirectionsPicker } from './DirectionsPicker';
import { NlCommandModal } from './NlCommandModal';
import { isAnonymousClipboardName, screenshotName } from '../lib/attachments';
import { useStickyCheck } from '../lib/sticky-checks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { confirmAction } from './ui/dialog';
import { Field, Textarea } from './ui/field';
import { Input } from './ui/input';
import { Select } from './ui/select';

interface Props {
  projectId: string;
  columnId: string;
  columnName: string;
  users: User[];
  defaultManagerId?: string;
  onClose: () => void;
  onCreated: () => void;
}

/** «Через N дней» в значение поля срока: к 18:00, как и при ручной постановке. */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(18, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Низкий' },
  { value: 'normal', label: 'Обычный' },
  { value: 'high', label: 'Высокий' },
  { value: 'urgent', label: 'Срочно' },
];

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
  /*
    Автоподбор (задачи #1295, #1363): по словам в названии и описании отмечаем
    направления и ставим исполнителя из людей этого направления с учётом загрузки.
    Правилами, без модели — бесплатно, поэтому на лету. Как только человек сам тронул
    поле, автоматика его больше не трогает: его выбор главнее.
  */
  const [directions, setDirections] = useState<string[]>([]);
  const [dirsTouched, setDirsTouched] = useState(false);
  const [assigneeTouched, setAssigneeTouched] = useState(false);
  const [autoNote, setAutoNote] = useState('');
  /** Пунктов в описании: два и больше — это ТЗ, его можно разложить по специалистам. */
  const [items, setItems] = useState(0);
  const [splitOpen, setSplitOpen] = useState(false);
  const [managerId, setManagerId] = useState(defaultManagerId ?? '');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [deadline, setDeadline] = useState('');
  const [estimate, setEstimate] = useState('');
  useEffect(() => {
    const t = title.trim();
    if (t.length < 3 && !description.trim()) return;
    const timer = window.setTimeout(() => {
      api.autoAssign({
        title: t || description.trim().slice(0, 255), description: description || undefined,
        projectId: projectId || undefined, directions: dirsTouched ? directions : undefined,
      }).then((r) => {
        setItems(r.items);
        if (!dirsTouched) setDirections(r.directions);
        if (!assigneeTouched && r.assigneeId) {
          setAssigneeId(String(r.assigneeId));
          setAutoNote(`Подобран автоматически: ${r.assigneeName} — ${r.reason}. Можно сменить.`);
        }
      }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, projectId, dirsTouched, dirsTouched ? directions.join(',') : '']);
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
  // Снял или поставил сам — это его привычка, запоминаем. Шаблон значение меняет, но не запоминает.
  const [approvalHabit, rememberApproval] = useStickyCheck('task.requiresApproval', true);
  const [requiresApproval, setRequiresApproval] = useState(approvalHabit);
  /*
    Шаблоны задач (просьба заказчика: «кнопка сохранить как шаблон»).

    Шаблон заполняет форму — и на этом его участие кончается: человек волен поправить
    что угодно перед созданием. Чек-лист заводится уже ПОСЛЕ задачи, как и файлы: до
    неё пунктам не к чему прикрепиться.
  */
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [tplId, setTplId] = useState('');
  const [tplChecklist, setTplChecklist] = useState<string[]>([]);
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
  useEffect(() => { api.taskTemplates().then(setTemplates).catch(() => setTemplates([])); }, []);

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

  /**
   * Применить шаблон к форме.
   *
   * Теги подставляем, но НЕ считаем подтверждёнными: подтверждает тот, кто ставит
   * задачу сейчас, — так решила компания в настройках тегов, и шаблон это правило
   * не отменяет.
   */
  const applyTemplate = (id: string) => {
    setTplId(id);
    const t = templates.find((x) => String(x.id) === id);
    if (!t) { setTplChecklist([]); return; }
    setTitle(t.title);
    setDescription(t.description ?? '');
    setPriority(t.priority || 'normal');
    setAssigneeId(t.assignee_id ? String(t.assignee_id) : '');
    // Исполнитель из шаблона — выбор человека: автоподбор его не перебивает.
    if (t.assignee_id) setAssigneeTouched(true);
    setEstimate(t.estimate_hours ? String(Number(t.estimate_hours)) : '');
    setRequiresApproval(t.requires_approval);
    setTags({ ...EMPTY_TAGS, tagIds: (t.label_ids ?? []).map(String) });
    setTplChecklist(t.checklist ?? []);
    setDeadline(t.deadline_days ? inDays(t.deadline_days) : '');
  };

  /** Шаблон больше не нужен: убирает тот, кто его завёл, или владелец — решает сервер. */
  const dropTemplate = async (t: TaskTemplate) => {
    if (!(await confirmAction({
      title: `Удалить шаблон «${t.name}»?`,
      description: 'Уже созданные по нему задачи останутся.',
      danger: true,
    }))) return;
    try {
      await api.deleteTaskTemplate(String(t.id));
      setTemplates((prev) => prev.filter((x) => String(x.id) !== String(t.id)));
      if (String(t.id) === tplId) { setTplId(''); setTplChecklist([]); }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Шаблон не удалился');
    }
  };

  const chosenTpl = templates.find((t) => String(t.id) === tplId) ?? null;

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
        directions: directions.length ? directions : undefined,
      });
      setCreatedId(String(created.id));
      /*
        Пункты чек-листа из шаблона — по порядку и по одному: отдельной ручки «создать
        чек-лист целиком» нет, а параллельная отправка перемешала бы порядок.
        Сорвался пункт — задача уже создана, и второй раз её заводить нельзя; молча
        пропускаем и говорим об этом ниже, вместе с файлами.
      */
      const lostItems: string[] = [];
      for (const text of tplChecklist) {
        try { await api.addChecklist(String(created.id), text); }
        catch { lostItems.push(text); }
      }
      if (tplId) void api.useTaskTemplate(tplId).catch(() => undefined);
      // Файлы грузим по одному и по порядку: параллельная отправка десятка вложений
      // с телефона рвётся на середине, и понять, что именно не долетело, нельзя.
      const failed: string[] = [];
      for (const f of files) {
        try { await api.uploadAttachment(String(created.id), f); }
        catch { failed.push(f.name); }
      }
      if (lostItems.length) {
        setErr(`Задача создана (#${created.id}), но не добавились пункты чек-листа: ${lostItems.join('; ')}. Допишите их в карточке, на вкладке «Чеклист».`);
        setBusy(false);
        return;
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

  /*
    «Разложить по специалистам» (задача #1363): ТЗ из нескольких пунктов уходит в быструю
    команду — она уже умеет делить текст на задачи и каждой подбирать исполнителя по
    направлению. Создали пакет — это окно больше не нужно.
  */
  if (splitOpen) {
    return (
      <NlCommandModal
        initialText={[title.trim(), description.trim()].filter(Boolean).join('\n')}
        currentProjectId={projectId}
        onClose={() => { setSplitOpen(false); onClose(); onCreated(); }}
      />
    );
  }

  const userOptions = (empty: string) => [
    { value: '', label: empty },
    ...users.map((u) => ({ value: String(u.id), label: u.fullName })),
  ];
  const canCreate = tagsReady(tagSettings, tags);

  return (
    <div
      className="modal-overlay ui-modal-overlay"
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
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}
      {...overlayProps(onClose)}
    >
      <div className="ui-modal" role="dialog" aria-modal="true" aria-labelledby="task-create-title" onClick={(e) => e.stopPropagation()}>
        <header className="ui-modal-head">
          <div className="ui-modal-title-wrap">
            <h2 id="task-create-title" className="ui-modal-title">Новая задача</h2>
            <span className="ui-modal-sub">в колонку «{columnName}»</span>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={16} /></Button>
        </header>

        <div className="ui-modal-body">
          {/*
            Шаблон — ПЕРВЫМ полем: выбирать его после того, как форма заполнена руками,
            поздно — он всё перезапишет. Список появляется, только когда шаблоны есть.
          */}
          {templates.length > 0 && (
            <Field
              label="Из шаблона"
              hint={chosenTpl ? (
                <>
                  Поля заполнены по шаблону — поправьте что нужно.
                  {chosenTpl.checklist.length > 0 && ` Чек-лист (${chosenTpl.checklist.length}) добавится после создания.`}
                  {chosenTpl.created_by_name ? ` Шаблон завёл ${chosenTpl.created_by_name}.` : ''}
                </>
              ) : undefined}
            >
              <div className="tc-row">
                <Select
                  ariaLabel="Шаблон задачи"
                  className="tv2-wide"
                  value={tplId}
                  onValueChange={applyTemplate}
                  options={[
                    { value: '', label: 'Без шаблона' },
                    ...templates.map((t) => ({ value: String(t.id), label: `${t.name}${t.used_count ? ` · ${t.used_count}` : ''}` })),
                  ]}
                />
                {!!chosenTpl && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => dropTemplate(chosenTpl)}
                    title={`Удалить шаблон «${chosenTpl.name}»`}
                    aria-label="Удалить шаблон"
                  >
                    <Icon name="trash" size={15} />
                  </Button>
                )}
              </div>
            </Field>
          )}

          <Field label="Название" htmlFor="task-create-name">
            <Input
              id="task-create-name"
              autoFocus
              value={title}
              placeholder="Что нужно сделать"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }}
            />
          </Field>

          {/*
            «Возможно, такая задача уже есть» — сразу под названием, там, где человек
            её и породил. Ничего не запрещает: похожая задача бывает нужна второй раз.
          */}
          {!dupesHidden && dupes.length > 0 && (
            <div className="tv2-callout tv2-callout-warn tv2-callout-block">
              <div className="tv2-callout-head"><Icon name="alert" size={15} /> Возможно, такая задача уже существует</div>
              {dupes.map((d) => (
                <div key={d.id} className="tc-dupe">
                  <span className="tasks-v2-id">#{d.id}</span>
                  <span className="tc-dupe-title" title={d.reason}>{d.title}</span>
                  <span className="ui-cell-dim">{d.projectName ?? ''}</span>
                  <Badge tone="warn">{d.match}%</Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      navigate({ section: 'projects', projectId: String(d.projectId), taskId: String(d.id) });
                      onClose();
                    }}
                  >
                    Открыть
                  </Button>
                </div>
              ))}
              <div><Button variant="ghost" size="sm" onClick={() => setDupesHidden(true)}>Создать всё равно</Button></div>
            </div>
          )}

          <Field label="Описание" hint="Необязательно. Пункты списком — можно будет раздать разным специалистам">
            <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Подробности, ссылки, критерии готовности" />
          </Field>

          <DirectionsPicker
            value={directions}
            auto={!dirsTouched}
            onChange={(next) => { setDirsTouched(true); setDirections(next); }}
          />
          {/* ТЗ из нескольких пунктов — разные специалисты: предлагаем разложить на задачи. */}
          {items >= 2 && (
            <div className="tv2-callout tv2-callout-info">
              <Icon name="users" size={15} />
              <span>В описании {items} пунктов — их можно раздать разным специалистам.</span>
              <Button size="sm" variant="outline" onClick={() => setSplitOpen(true)}>Разложить по специалистам</Button>
            </div>
          )}

          <div className="tv2-grid2">
            <Field
              label="Исполнитель"
              hint={autoNote || undefined}
              action={(
                /* Совет модели — по кнопке, для случаев, где слов не хватило (ТЗ-10). */
                <SuggestAssignee title={title} description={description} projectId={projectId}
                  onPick={(id) => { setAssigneeTouched(true); setAutoNote(''); setAssigneeId(id); }} />
              )}
            >
              <Select
                ariaLabel="Исполнитель"
                className="tv2-wide"
                value={assigneeId}
                onValueChange={(v) => { setAssigneeTouched(true); setAutoNote(''); setAssigneeId(v); }}
                options={userOptions('Не назначен')}
              />
            </Field>
            <Field label={<span title="Кто ставит задачу и принимает результат">Постановщик</span>}>
              <Select ariaLabel="Постановщик" className="tv2-wide" value={managerId} onValueChange={setManagerId} options={userOptions('Не задан')} />
            </Field>
          </div>

          <div className="tc-grid3">
            <Field label="Срок">
              <DatePicker value={deadline} onChange={setDeadline} withTime warnPast placeholder="срок не задан" />
            </Field>
            <Field label="Приоритет">
              <Select ariaLabel="Приоритет" className="tv2-wide" value={priority} onValueChange={setPriority} options={PRIORITY_OPTIONS} />
            </Field>
            <Field label="Оценка, ч">
              <Input type="number" min="0" step="0.5" value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="не задана" />
            </Field>
          </div>

          <TaskTagsField
            task={{ title, description, projectName: null }}
            value={tags}
            onChange={setTags}
          />

          <Checkbox
            checked={requiresApproval}
            onCheckedChange={(on) => { setRequiresApproval(on); rememberApproval(on); }}
            label={<span title="Исполнитель сдаст работу, а завершите её вы">Не завершать задачу без согласования с постановщиком</span>}
          />

          {/* Файлы прямо здесь: задача без исходников — это вопрос «а где макет?»
              через десять минут после постановки. */}
          <Field label="Файлы" hint="Необязательно. Снимок экрана можно вставить сюда по Ctrl+V">
            <div
              className="file-drop tc-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
            >
              <label className="ui-btn ui-btn-outline ui-btn-sm file-pick">
                <Icon name="paperclip" size={15} /> Выбрать файлы
                <input
                  className="file-pick-input"
                  type="file"
                  multiple
                  aria-label="Выбрать файлы для задачи"
                  onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                />
              </label>
              <span className="ui-cell-dim">или перетащите сюда</span>
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
          </Field>

          {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
        </div>

        <footer className="ui-modal-foot">
          <span className="ui-modal-hint">Ctrl+Enter — создать</span>
          {createdId ? (
            <Button variant="primary" onClick={finishAfterPartial}>Готово — открыть доску</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy}>Отмена</Button>
              <Button
                variant="primary"
                /* Теги не подтверждены — создавать нельзя: то же правило проверяет сервер. */
                disabled={!canCreate}
                loading={busy}
                onClick={submit}
                title={canCreate ? undefined : 'Подтвердите теги задачи'}
              >
                {busy
                  ? (files.length ? 'Создаём и грузим файлы…' : 'Создаём…')
                  : (files.length ? `Создать и прикрепить ${files.length}` : 'Создать задачу')}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
