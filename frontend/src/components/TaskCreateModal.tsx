import { useEffect, useRef, useState } from 'react';
import { DatePicker } from './DatePicker';
import { Icon } from './Icon';
import { api, ApiError, TagSettings } from '../lib/api';
import type { TaskTemplate, User } from '../types';
import { TaskTagsField } from './TaskTagsField';
import { confirmTags, EMPTY_TAGS, tagsReady, TagsValue } from '../lib/tags';
import { navigate } from '../lib/router';
import { overlayProps } from '../lib/overlay';
import { newDraftId, openDraft, removeDraft, saveDraft, setDraftEditing, type TaskDraft } from '../lib/task-draft';
import { loadDraftFiles, saveDraftFiles } from '../lib/draft-files';
import { describeFailures, mergeFiles, pastedImages, uploadTaskFiles } from '../lib/task-files';
import { TaskFilesField } from './TaskFilesField';
import { TaskDraftsOffer, useOtherDrafts } from './TaskDraftsOffer';
import { useAuth } from '../state/auth';
import { SuggestAssignee } from './SuggestAssignee';
import { localInput, useWorkloadCheck, workloadOf, WorkloadInfo, WorkloadWarning } from './WorkloadWarning';
import { DirectionsPicker } from './DirectionsPicker';
import { PeopleField, peopleOf } from './PeopleField';
import { NlCommandModal } from './NlCommandModal';
import { useStickyCheck } from '../lib/sticky-checks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { confirmAction } from './ui/dialog';
import { Field, Textarea } from './ui/field';
import { Input } from './ui/input';
import { Select } from './ui/select';
import { feedback } from '../lib/feedback';
import { useVoiceInput } from '../hooks/useVoiceInput';

interface Props {
  projectId: string;
  columnId: string;
  columnName: string;
  users: User[];
  defaultManagerId?: string;
  onClose: () => void;
  onCreated: () => void;
  /** Черновик, с которого продолжаем (#1534): поля заполняются им. */
  draft?: TaskDraft | null;
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
export function TaskCreateModal({ projectId, columnId, columnName, users, defaultManagerId, onClose, onCreated, draft }: Props) {
  const { user } = useAuth();
  // разбор голоса сорвался в прошлый раз — сказанное возвращается в название (#4668)
  const [title, setTitle] = useState(draft?.title || draft?.speech || '');
  const [assigneeId, setAssigneeId] = useState(draft?.assigneeId ?? '');
  /*
    Автоподбор (задачи #1295, #1363): по словам в названии и описании отмечаем
    направления и ставим исполнителя из людей этого направления с учётом загрузки.
    Правилами, без модели — бесплатно, поэтому на лету. Как только человек сам тронул
    поле, автоматика его больше не трогает: его выбор главнее.
  */
  const [directions, setDirections] = useState<string[]>(draft?.directions ?? []);
  const [dirsTouched, setDirsTouched] = useState(!!draft?.directions.length);
  // исполнителя из черновика выбрал человек — подбор его не перебивает
  const [assigneeTouched, setAssigneeTouched] = useState(!!draft?.assigneeId);
  const [autoNote, setAutoNote] = useState('');
  /** Пунктов в описании: два и больше — это ТЗ, его можно разложить по специалистам. */
  const [items, setItems] = useState(0);
  const [splitOpen, setSplitOpen] = useState(false);
  const [managerId, setManagerId] = useState(draft?.managerId || defaultManagerId || '');
  const [description, setDescription] = useState(draft?.description ?? '');
  const [priority, setPriority] = useState(draft?.priority ?? 'normal');
  const [deadline, setDeadline] = useState(draft?.deadline ?? '');
  const [estimate, setEstimate] = useState(draft?.estimate ?? '');
  /** Соисполнители и наблюдатели (#4661): уходят тем же запросом, что и задача. */
  const [coIds, setCoIds] = useState<string[]>([]);
  const [watcherIds, setWatcherIds] = useState<string[]>([]);
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
  // теги из черновика возвращаются выбранными, но подтверждает их постановщик заново
  const [tags, setTags] = useState<TagsValue>(draft?.tagIds?.length ? { ...EMPTY_TAGS, tagIds: draft.tagIds } : EMPTY_TAGS);
  const [tagSettings, setTagSettings] = useState<TagSettings | null>(null);
  /** После голоса теги подтверждаются сами: человек наговорил задачу и не должен ничего дожимать (#4618). */
  const autoTags = useRef(false);
  const onTags = (next: TagsValue) => {
    if (autoTags.current && next.suggested.length) { autoTags.current = false; setTags(confirmTags(next)); }
    else setTags(next);
  };
  /**
   * «Не завершать без согласования» — по умолчанию включено.
   *
   * Это то, что команды и так делают на словах («напиши, когда закончишь»), только
   * теперь договорённость видит система. Снимает галочку тот, кто задачу ставит, —
   * заранее и осознанно, а не в момент, когда работа уже сдана.
   */
  // Снял или поставил сам — это его привычка, запоминаем. Шаблон значение меняет, но не запоминает.
  const [approvalHabit, rememberApproval] = useStickyCheck('task.requiresApproval', true);
  const [requiresApproval, setRequiresApproval] = useState(draft ? draft.requiresApproval : approvalHabit);
  /*
    Шаблоны задач (просьба заказчика: «кнопка сохранить как шаблон»).

    Шаблон заполняет форму — и на этом его участие кончается: человек волен поправить
    что угодно перед созданием. Чек-лист заводится уже ПОСЛЕ задачи, как и файлы: до
    неё пунктам не к чему прикрепиться.
  */
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [tplId, setTplId] = useState(draft?.tplId ?? '');
  const [tplChecklist, setTplChecklist] = useState<string[]>(draft?.checklist ?? []);
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
  /** Какой файл сейчас уходит: «2 из 3 — макет.png». */
  const [uploadNote, setUploadNote] = useState('');

  /*
    Черновик (#1534, #4668): набранное сохраняется по мере ввода — все поля, теги,
    чек-лист и выбранные файлы. Окно закрыли не той кнопкой, обновили страницу,
    приложение вылетело — при следующем открытии окно предложит продолжить. Пока окно
    открыто, плавающую кнопку «Черновик» прячем: она дублировала бы само окно.
  */
  useEffect(() => {
    setDraftEditing(true);
    return () => setDraftEditing(false);
  }, []);
  const draftId = useRef(draft?.id || newDraftId());
  /** Последняя распознанная фраза: сорвётся разбор или вкладка — сказанное останется в черновике. */
  const [speech, setSpeech] = useState(draft?.speech ?? '');
  /** Файлы черновика, которые не удалось вернуть: их называем и просим выбрать заново. */
  const [lostDraftFiles, setLostDraftFiles] = useState<string[]>([]);
  const filesReady = useRef(!draft?.fileNames?.length);
  useEffect(() => {
    if (!draft?.fileNames?.length) return;
    const names = draft.fileNames;
    void loadDraftFiles(draft.id).then((back) => {
      setFiles((cur) => (cur.length ? cur : back));
      const have = new Set(back.map((f) => f.name));
      setLostDraftFiles(names.filter((n) => !have.has(n)));
      filesReady.current = true;
    });
  }, [draft]);
  useEffect(() => {
    if (createdId || !user?.id) return; // задача уже есть — черновик больше не нужен
    const t = window.setTimeout(() => saveDraft({
      id: draftId.current, kind: 'form',
      userId: String(user.id), projectId: String(projectId), columnId: String(columnId), columnName,
      title, description, assigneeId, managerId, priority, deadline, estimate, directions, requiresApproval,
      tagIds: tags.tagIds, checklist: tplChecklist, tplId, speech,
      fileNames: files.map((f) => f.name),
      savedAt: new Date().toISOString(),
    }), 400);
    return () => window.clearTimeout(t);
  }, [user?.id, projectId, columnId, columnName, title, description, assigneeId, managerId, priority, deadline, estimate, directions, requiresApproval, tags.tagIds, tplChecklist, tplId, speech, files, createdId]);
  // файлы — отдельно и только когда их набор сменился: класть их в базу на каждую букву незачем
  useEffect(() => {
    if (createdId || !filesReady.current) return;
    void saveDraftFiles(draftId.current, files);
  }, [files, createdId]);
  /** Другие черновики — предложение «Продолжить» в начале пустого окна. */
  const otherDrafts = useOtherDrafts(user?.id, draftId.current);
  const pickDraft = (d: TaskDraft) => {
    onClose();
    openDraft(d, (pid) => navigate({ section: 'projects', projectId: pid }));
  };
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

  /*
    Задача голосом прямо в форме (#4618). Человек открыл «Новую задачу» и наговорил её
    одной фразой — поля заполняются сами: название, описание, исполнитель, срок,
    срочность, оценка, согласование, чек-лист, направления; теги подтверждаются сами.
    Разбор тот же, что у быстрой команды, — одни правила на все места постановки.
  */
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const fillFromSpeech = async (text: string) => {
    setVoiceBusy(true);
    setVoiceNote('');
    try {
      const d = await api.nlParse(text, projectId, 'board');
      const t = d?.intent === 'create_task' ? d.task : null;
      if (!t) {
        setTitle(text.slice(0, 255));
        setVoiceNote('Не разобрал задачу целиком — записал сказанное в название. Поправьте или наговорите ещё раз.');
        return;
      }
      setTitle(t.title);
      setDescription(t.description ?? '');
      // #4615, 23.10: исполнитель по общему правилу — с причиной; названный голосом — без подписи
      if (t.assigneeId) {
        setAssigneeId(String(t.assigneeId)); setAssigneeTouched(!!t.assigneeNamed || t.assigneeSource === 'role');
        setAutoNote(t.assigneeNamed || !t.assigneeWhy ? '' : `Подобран автоматически: ${t.assigneeName} — ${t.assigneeWhy}. Можно сменить.`);
      }
      if (t.deadline) setDeadline(/^\d{4}-\d{2}-\d{2}$/.test(t.deadline) ? `${t.deadline}T18:00` : localInput(t.deadline));
      setPriority(t.priority || 'normal');
      if (t.estimateHours) setEstimate(String(t.estimateHours));
      setRequiresApproval(!!t.requiresApproval);
      if (t.directions?.length) { setDirections(t.directions); setDirsTouched(true); }
      if (!tplId) setTplChecklist(Array.isArray(t.checklist) ? t.checklist : []);
      // теги подбираются по новому названию: первую подборку принимаем сами, не нашлось — «без тегов»
      autoTags.current = true;
      setTags(EMPTY_TAGS);
      window.setTimeout(() => {
        if (!autoTags.current) return;
        autoTags.current = false;
        setTags((v) => (v.confirmed || v.confirmedWithoutTags ? v : confirmTags(v)));
      }, 6000);
      setVoiceNote(`Заполнено по голосу: «${text}». Проверьте и нажмите «Создать задачу».`);
      feedback('ai.completed');
    } catch (e) {
      setTitle((cur) => cur || text.slice(0, 255));
      setVoiceNote(e instanceof ApiError ? e.message : 'Не получилось разобрать фразу — записал её в название');
    } finally {
      setVoiceBusy(false);
    }
  };
  const voice = useVoiceInput((text) => { setSpeech(text); void fillFromSpeech(text); });
  const voiceState = voice.recording ? 'rec' : voice.transcribing || voiceBusy ? 'busy' : 'idle';

  /** Страж нагрузки (ТЗ-21): сервер предупредил о перегрузе — человек выбирает вариант. */
  const [workload, setWorkload] = useState<WorkloadInfo | null>(null);
  /*
    #1525: подсказка — сразу, как только известны исполнитель и срок, до «Создать».
    Голос заполняет те же поля — проверка срабатывает и после него.
  */
  const early = useWorkloadCheck({
    assigneeId, projectId, priority, directions,
    deadlineAt: deadline && !Number.isNaN(Date.parse(deadline)) ? new Date(deadline).toISOString() : null,
  });
  const shownWorkload = workload ?? early.info;

  const submit = async (o: { assigneeId?: string; deadline?: string; confirmWorkload?: boolean } = {}) => {
    if (!title.trim()) return setErr('Введите название задачи');
    setErr('');
    setWorkload(null);
    setBusy(true);
    const who = o.assigneeId ?? assigneeId;
    const when = o.deadline ?? deadline;
    try {
      const created = await api.createTask({
        projectId,
        columnId,
        title: title.trim(),
        description: description.trim() || undefined,
        assigneeId: who || undefined,
        managerId: managerId || undefined,
        priority,
        // поле даёт локальное время без зоны — приводим к ISO, как это делает карточка
        deadlineAt: when ? new Date(when).toISOString() : undefined,
        estimateHours: estimate ? Number(estimate) : undefined,
        labelIds: tags.tagIds.length ? tags.tagIds : undefined,
        suggestedTagIds: tags.suggested.length ? tags.suggested : undefined,
        tagsConfirmed: tags.confirmed,
        confirmedWithoutTags: tags.confirmedWithoutTags,
        requiresApproval,
        directions: directions.length ? directions : undefined,
        // исполнитель соисполнителем не бывает: его могли выбрать уже после
        coAssigneeIds: coIds.filter((id) => id !== who).length ? coIds.filter((id) => id !== who) : undefined,
        watcherIds: watcherIds.filter((id) => id !== who).length ? watcherIds.filter((id) => id !== who) : undefined,
        // #4615, 23.10: радар перегрузки — подсказка над кнопкой, а не стоп: «Создать» создаёт
        confirmWorkload: true,
      });
      setCreatedId(String(created.id));
      feedback('task.created');
      removeDraft(draftId.current); // задача создана — черновик своё отслужил
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
      const failed = await uploadTaskFiles(String(created.id), files, (i, n, name) => setUploadNote(
        i < n ? `Загружаю файлы: ${i + 1} из ${n} — ${name}` : '',
      ));
      if (lostItems.length) {
        setErr(`Задача создана (#${created.id}), но не добавились пункты чек-листа: ${lostItems.join('; ')}. Допишите их в карточке, на вкладке «Чек-лист».`);
        setBusy(false);
        return;
      }
      if (failed.length) {
        // задача уже создана — предлагать «создать» второй раз нельзя, это дубль
        setErr(`Задача создана (#${created.id}), но не загрузились файлы: ${describeFailures(failed)}. Прикрепите их в карточке, на вкладке «Файлы».`);
        setBusy(false);
        return;
      }
      onCreated();
      onClose();
    } catch (e) {
      const w = workloadOf(e);
      if (w) setWorkload(w);
      else setErr(e instanceof ApiError ? e.message : 'Не удалось создать задачу');
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

  const people = users.map((u) => ({ id: String(u.id), name: u.fullName }));
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
        // «image.png» из буфера — это дата и время снимка, иначе в списке десяток одинаковых имён
        const images = pastedImages(e.clipboardData);
        if (!images.length || createdId) return;
        e.preventDefault();
        setFiles((prev) => mergeFiles(prev, images));
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
          {!draft && !title && !description && <TaskDraftsOffer drafts={otherDrafts} onPick={pickDraft} />}
          <div className={`tc-voice tc-voice-${voiceState}`}>
            <button
              type="button"
              className="tc-voice-btn"
              onClick={voice.toggle}
              disabled={busy || voiceState === 'busy'}
              aria-pressed={voice.recording}
              aria-label={voice.recording ? 'Закончить и заполнить поля' : 'Наговорить задачу голосом'}
            >
              <Icon name={voiceState === 'busy' ? 'sparkles' : 'mic'} size={20} />
            </button>
            <div className="tc-voice-text">
              <b>{voiceState === 'rec' ? 'Слушаю… нажмите ещё раз, когда закончите' : voiceState === 'busy' ? 'Заполняю поля…' : 'Наговорите задачу голосом'}</b>
              <span>
                {voice.error || voiceNote || 'Одной фразой: что сделать, кому, к какому сроку, насколько срочно и сколько займёт — все поля заполнятся сами.'}
              </span>
            </div>
          </div>

          {/*
            Шаблон — ПЕРВЫМ полем: выбирать его после того, как форма заполнена руками,
            поздно — он всё перезапишет. Список появляется, только когда шаблоны есть.
          */}
          {templates.length > 0 && (
            <Field
              label="Из шаблона"
              hint={chosenTpl ? (
                <>
                  Поля заполнены по шаблону — поправьте, что нужно.
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

          {/* #4661: соисполнители и наблюдатели — сразу при постановке, а не вторым заходом в карточке */}
          <div className="tv2-grid2">
            <PeopleField
              label="Соисполнители"
              hint="Делают работу вместе с исполнителем и видят задачу в своих"
              people={peopleOf(coIds, people)}
              users={people}
              exclude={assigneeId ? [assigneeId] : []}
              onAdd={(id) => { setCoIds((l) => [...l, id]); setWatcherIds((l) => l.filter((x) => x !== id)); }}
              onRemove={(id) => setCoIds((l) => l.filter((x) => x !== id))}
            />
            <PeopleField
              label="Наблюдатели"
              hint="Следят за ходом и получают уведомления, выполнять не обязаны"
              people={peopleOf(watcherIds, people)}
              users={people}
              exclude={assigneeId ? [assigneeId] : []}
              onAdd={(id) => { setWatcherIds((l) => [...l, id]); setCoIds((l) => l.filter((x) => x !== id)); }}
              onRemove={(id) => setWatcherIds((l) => l.filter((x) => x !== id))}
            />
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
            onChange={onTags}
          />

          {!chosenTpl && tplChecklist.length > 0 && (
            <Field label={`Чек-лист (${tplChecklist.length})`} hint="Добавится после создания. Лишний пункт уберите крестиком">
              <ul className="tc-checklist">
                {tplChecklist.map((item, i) => (
                  <li key={`${i}-${item}`}>
                    <Icon name="check" size={13} />
                    <span>{item}</span>
                    <Button variant="ghost" size="icon-sm" aria-label={`Убрать пункт «${item}»`} onClick={() => setTplChecklist((l) => l.filter((_, j) => j !== i))}>
                      <Icon name="close" size={13} />
                    </Button>
                  </li>
                ))}
              </ul>
            </Field>
          )}

          <Checkbox
            checked={requiresApproval}
            onCheckedChange={(on) => { setRequiresApproval(on); rememberApproval(on); }}
            label={<span title="Исполнитель сдаст работу, а завершите её вы">Не завершать задачу без согласования с постановщиком</span>}
          />

          {/* Файлы прямо здесь: задача без исходников — это вопрос «а где макет?»
              через десять минут после постановки. */}
          <Field label="Файлы" hint="Необязательно. Прикрепятся сразу после создания задачи">
            <TaskFilesField
              files={files}
              onChange={setFiles}
              disabled={busy || !!createdId}
              progress={uploadNote}
              restored={lostDraftFiles.filter((n) => !files.some((f) => f.name === n))}
            />
          </Field>

        </div>

        {/*
          #1576: почему задача не создалась — прямо над кнопкой «Создать», вне прокрутки.
          В конце длинной формы предупреждение о перегрузе оставалось за краем окна:
          нажал «Создать» — ничего не произошло, а ответ надо искать прокруткой.
        */}
        {(shownWorkload || err) && (
          <div className="ui-modal-alerts">
            {shownWorkload && (
              <WorkloadWarning
                info={shownWorkload}
                busy={busy}
                /*
                  Подсказка пришла ДО «Создать» — кнопки только правят форму, задачу ставит
                  сам человек. Пришла ответом на «Создать» (409) — ставим сразу, как раньше.
                  Принятый вариант — это решение: повторно о том же человеке не спрашиваем.
                */
                onMove={shownWorkload.alternativeDeadline ? () => {
                  const v = localInput(shownWorkload.alternativeDeadline!);
                  setDeadline(v);
                  early.accept(String(shownWorkload.assigneeId));
                  if (workload) void submit({ deadline: v, confirmWorkload: true });
                } : undefined}
                onReassign={(id) => {
                  setAssigneeId(id); setAssigneeTouched(true);
                  if (workload) void submit({ assigneeId: id });
                }}
                onKeep={() => {
                  early.accept(String(shownWorkload.assigneeId));
                  if (workload) void submit({ confirmWorkload: true });
                }}
              />
            )}
            {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
          </div>
        )}

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
                onClick={() => void submit()}
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
