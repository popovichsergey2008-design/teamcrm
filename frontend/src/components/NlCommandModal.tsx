import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { TaskCardWindow } from './TaskCardWindow';
import { TaskTagsField } from './TaskTagsField';
import { confirmTags, EMPTY_TAGS, pendingTagCount } from '../lib/tags';
import { api, ApiError, TagSettings, VoiceJob } from '../lib/api';
import { useWorkloadCheck, workloadOf, WorkloadWarning } from './WorkloadWarning';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { DatePicker } from './DatePicker';
import { DirectionsPicker } from './DirectionsPicker';
import { VoiceStatus } from './VoiceStatus';
import { overlayProps } from '../lib/overlay';
import { navigate } from '../lib/router';
import { newChangeId } from '../lib/offline-queue';
import { plural } from '../lib/chat-text';
import { stickyCheck, useStickyCheck } from '../lib/sticky-checks';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Textarea } from './ui/field';
import { Input } from './ui/input';
import { Select } from './ui/select';
import { feedback } from '../lib/feedback';
import { AutoSummary, DeadlineChips } from './NlAutoTask';
import { effectiveDeadline } from '../lib/auto-task';
import { diag } from '../lib/diag';

/** Что создали в этом заходе — для итоговой страницы: куда ушло и как открыть. */
interface CreatedTask {
  taskId: string;
  projectId: string;
  title: string;
  projectName: string | null;
  assigneeName: string | null;
  deadline: string | null;
}

/**
 * NL-команда / Zero-UI: сказал или написал обычным языком → готовые черновики → подтвердил.
 *
 * Длинная надиктовка обрабатывается не в этом запросе. Пять минут речи не проходили
 * ни через ограничение прокси на размер тела, ни через его таймаут: человек говорил,
 * жал «Остановить» и получал красную ошибку вместе с потерянной записью. Теперь запись
 * уходит на сервер целиком, сохраняется там до успешного разбора, а окно показывает,
 * на каком шаге обработка, — и умеет повторить её, не заставляя диктовать заново.
 *
 * Черновиков может быть несколько: в одной записи люди раздают работу пачкой.
 */

/** Что происходит с записью — словами, а не кодами состояний. */
const JOB_LABEL: Record<VoiceJob['status'], string> = {
  queued: 'Запись сохранена, встала в очередь…',
  transcribing: 'Расшифровываем запись…',
  parsing: 'Формируем задачи…',
  ready: 'Готово',
  error: 'Не получилось',
};

export function NlCommandModal({ onClose, initialText, autoRecord, currentProjectId, currentKind = 'board', onCreated }: {
  onClose: () => void;
  /** Текст, набранный в командной строке: переспрашивать уже сформулированное незачем. */
  initialText?: string;
  /** Пришли по кнопке микрофона — сразу слушаем, не заставляя нажимать ещё раз. */
  autoRecord?: boolean;
  /** Доска, открытая у человека: из неё берётся проект, если он не назван вслух. */
  currentProjectId?: string | null;
  /**
   * ТЗ-31: board — человек на этой доске (проект подставится); last — просто последняя
   * открытая доска (будет среди вариантов, но не подставится молча).
   */
  currentKind?: 'board' | 'last';
  /** Задача создана — показать её вместо перезагрузки всего приложения. */
  onCreated?: (projectId: string, taskId: string) => void;
}) {
  const [text, setText] = useState(initialText ?? '');
  /**
   * Черновики. Их может быть несколько: в длинной надиктовке человек раздаёт работу
   * пачкой — «Глебу форму, Юрию страницу, Алине тексты», — и делать из этого одну
   * задачу значит потерять две трети сказанного.
   */
  const [drafts, setDrafts] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  /** Фраза, из которой собраны черновики: «услышал не то» иначе не объяснить. */
  const [heard, setHeard] = useState('');
  /** Обработка записи на сервере: аудио уже сохранено, разбор идёт в фоне. */
  const [job, setJob] = useState<VoiceJob | null>(null);
  /** Что уже создано в этом заходе — чтобы не создать дважды и видеть движение. */
  const [done, setDone] = useState<number[]>([]);
  /*
    Итоговая страница (задача #1344).

    Когда задач несколько, после «Создать все» человек оставался на том же экране с
    тремя строчками «Создано: …» и не понимал, куда они делись. Теперь второй шаг:
    список созданных задач — куда, кому, к какому сроку — каждая открывается, и одна
    кнопка ведёт туда, где они все лежат.
  */
  const [created, setCreated] = useState<CreatedTask[]>([]);
  const [stage, setStage] = useState<'compose' | 'done'>('compose');
  /** Задача, открытая карточкой поверх списка созданных. */
  const [cardTask, setCardTask] = useState<{ projectId: string; taskId: string } | null>(null);
  /** Политика компании по тегам: от неё зависит, ждать ли подтверждения. */
  const [tagSettings, setTagSettings] = useState<TagSettings | null>(null);
  useEffect(() => { api.tagSettings().then(setTagSettings).catch(() => setTagSettings(null)); }, []);

  /*
    #4615: автоматическая постановка — режим по умолчанию. Одно поле (текст или голос),
    срок чипами и «Поставить задачу»; проект, исполнителя, теги и приоритет система
    ставит сама, а через 30 секунд просит постановщика проверить. «Править поля» —
    прежний подробный предпросмотр.
  */
  const [manual, setManual] = useState(false);
  /** Срок, выбранный чипом (или услышанный во фразе, пока чип не трогали). */
  const [deadline, setDeadline] = useState<string | null>(null);
  const touched = useRef(false);
  const [thinking, setThinking] = useState(false);
  /** Для какого текста черновики актуальны: изменили фразу — разбор пойдёт заново. */
  const parsedFor = useRef('');
  const seq = useRef(0);
  /** Какой текст сейчас разбирается: расшифровка уже ушла — второй раз не шлём. */
  const pending = useRef('');
  const [autoNote, setAutoNote] = useState(false);

  /** Разбор в фоне: пауза в наборе или готовая расшифровка — без кнопки «Разобрать». */
  const autoParse = async (raw: string): Promise<any[] | null> => {
    const command = raw.trim();
    if (command.length < 3) return null;
    const my = ++seq.current;
    pending.current = command;
    setThinking(true); setMsg('');
    try {
      const list = await api.nlParseMany(command, currentProjectId, currentKind, true);
      if (my !== seq.current) return null;
      parsedFor.current = command;
      setDrafts(list); setDone([]); setHeard(command);
      // срок прозвучал во фразе — чип выбран сам
      if (!touched.current) setDeadline(list.find((d: any) => d.task?.deadline)?.task.deadline ?? null);
      return list;
    } catch (e) {
      if (my === seq.current) setMsg(e instanceof ApiError ? e.message : 'Не получилось разобрать — попробуйте ещё раз');
      return null;
    } finally {
      if (my === seq.current) { setThinking(false); pending.current = ''; }
    }
  };

  useEffect(() => {
    if (manual || stage !== 'compose') return;
    const command = text.trim();
    if (command.length < 3 || command === parsedFor.current) return;
    // команда из строки поиска или «Разложить по специалистам» — разбираем сразу
    const t = setTimeout(() => {
      if (command !== parsedFor.current && command !== pending.current) void autoParse(command);
    }, command === (initialText ?? '').trim() ? 0 : 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, manual, stage]);

  const chooseDeadline = (d: string | null) => {
    touched.current = true;
    setDeadline(d);
    // точный срок из подсказки о перегрузе больше не действует: выбран другой день
    setDrafts((list) => list.map((x) => (x.task?.deadlineAt ? { ...x, task: { ...x.task, deadlineAt: null } } : x)));
  };

  const parse = async (raw?: string) => {
    const command = (raw ?? text).trim();
    if (command.length < 3) return setMsg('Слишком короткая команда');
    setBusy(true); setMsg(''); setDrafts([]); setDone([]); setCreated([]); setStage('compose'); setJob(null);
    try {
      // Несколько поручений в одной строке — несколько черновиков, как и у надиктовки.
      setDrafts(await api.nlParseMany(command, currentProjectId, currentKind));
      setHeard(command);
      feedback('ai.completed');
    } catch (e) { feedback('error'); setMsg(e instanceof ApiError ? e.message : 'Ошибка распознавания'); }
    finally { setBusy(false); }
  };

  /** Запомнить созданную задачу для итоговой страницы: имена берём из обстановки черновика. */
  const remember = (draft: any, task: any) => {
    if (!task) return;
    const ctx = draft?.context ?? { projects: [], users: [] };
    const projectId = String(task.project_id ?? task.projectId ?? draft.task?.projectId ?? '');
    const assigneeId = task.assignee_id ?? task.assigneeId ?? draft.task?.assigneeId;
    setCreated((list) => [...list, {
      taskId: String(task.id),
      projectId,
      title: String(task.title ?? draft.task?.title ?? 'Задача'),
      projectName: ctx.projects?.find((p: any) => String(p.id) === projectId)?.name ?? null,
      assigneeName: assigneeId ? (ctx.users?.find((u: any) => String(u.id) === String(assigneeId))?.name ?? null) : null,
      deadline: task.deadline_at ?? task.deadlineAt ?? draft.task?.deadline ?? null,
    }]);
  };

  /**
   * Запись уходит на сервер целиком.
   *
   * Пятиминутная надиктовка не должна зависеть от того, успеет ли расшифровка
   * уложиться в таймаут: сервер сохраняет аудио и отвечает сразу, а мы следим
   * за обработкой и показываем, на каком она шаге.
   */
  /**
   * Замер голосовой постановки (#4666): от «Остановить» до черновика и до задачи.
   * Серверная часть — `voice.timing` в журнале, эта — что увидел человек.
   */
  const voiceT = useRef<{ stop: number; sent?: number; ready?: number; polls: number; sync?: boolean; id?: string; bytes?: number } | null>(null);

  const sendRecording = async (blob: Blob) => {
    setMsg(''); setDrafts([]); setDone([]);
    voiceT.current = { stop: performance.now(), polls: 0, bytes: blob.size };
    try {
      // #4666: в авто-режиме сервер сразу собирает черновик с автозаполнением, а короткую
      // запись разбирает, пока открыт этот запрос, — ответ приходит уже с задачей
      const first = await api.voiceStart(blob, currentKind === 'board' ? currentProjectId : null, !manual);
      if (voiceT.current) Object.assign(voiceT.current, { sent: performance.now(), id: first.id, sync: first.status === 'ready' });
      if (first.status === 'ready') onJobReady(first);
      else if (first.status === 'error') feedback('error');
      setJob(first);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Не удалось отправить запись');
    }
  };

  /** Запись разобрана: черновики показываем сразу, второй разбор — только если сервер старый. */
  const onJobReady = (next: VoiceJob) => {
    const list = next.tasks ?? [];
    if (!manual && next.transcript) {
      if (list.some((d: any) => d?.task?.auto)) {
        // #4666: черновики уже с автозаполнением — разбирать заново нечего
        parsedFor.current = next.transcript.trim();
        setText(next.transcript);
        setDrafts(list); setDone([]); setHeard(next.transcript);
        if (!touched.current) setDeadline(list.find((d: any) => d.task?.deadline)?.task.deadline ?? null);
      } else {
        // #4615: расшифровка готова — разбор с автозаполнением идёт сам
        setText(next.transcript);
        void autoParse(next.transcript);
      }
    } else {
      setDrafts(list);
      setHeard(next.transcript ?? '');
    }
    const t = voiceT.current;
    if (t && !t.ready) {
      t.ready = performance.now();
      diag('app', 'voice.client', t.id ? `voice:${t.id}` : undefined, {
        bytes: t.bytes, uploadMs: Math.round((t.sent ?? t.ready) - t.stop), readyMs: Math.round(t.ready - t.stop),
        polls: t.polls, sync: !!t.sync, drafts: list.length, auto: !manual,
      });
    }
    feedback('ai.completed');
  };

  const voice = useVoiceInput(() => undefined, { onBlob: (blob) => void sendRecording(blob) });
  const { recording } = voice;

  // Пока запись обрабатывается, спрашиваем сервер, как дела: расшифровка длинного
  // аудио идёт минутами, и человек должен видеть движение, а не замерший экран.
  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'error') return;
    // #4666: первые секунды спрашиваем часто — короткая фраза готова за пару секунд,
    // и пауза опроса сама по себе была заметной частью ожидания
    const age = voiceT.current ? performance.now() - voiceT.current.stop : Infinity;
    const t = setTimeout(async () => {
      try {
        if (voiceT.current) voiceT.current.polls += 1;
        const next = await api.voiceStatus(job.id);
        setJob(next);
        if (next.status === 'ready') onJobReady(next);
        if (next.status === 'error') feedback('error');
      } catch { /* следующий заход попробует снова: сеть моргает, запись цела */ }
    }, age < 20_000 ? 600 : 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  // Автозапуск ровно один раз: в режиме разработки эффекты вызываются дважды,
  // и без флага открывались бы два микрофонных потока подряд.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoRecord || autoStarted.current) return;
    autoStarted.current = true;
    voice.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRecord]);

  const patchTask = (i: number, patch: any) => setDrafts((list) => list.map((d, j) => (
    j === i ? { ...d, task: { ...d.task, ...patch } } : d
  )));
  const patchDeal = (i: number, patch: any) => setDrafts((list) => list.map((d, j) => (
    j === i ? { ...d, deal: { ...d.deal, ...patch } } : d
  )));
  /**
   * Правка самого черновика, а не его задачи: сюда ложатся файлы.
   *
   * Файлы храним В ЧЕРНОВИКЕ, а не отдельным списком по номерам: черновик можно
   * выбросить крестиком, и остальные сдвинутся — приложенный к третьей задаче
   * макет уехал бы ко второй.
   */
  const patchDraft = (i: number, patch: any) => setDrafts((list) => list.map((d, j) => (
    j === i ? { ...d, ...patch } : d
  )));
  const dropDraft = (i: number) => setDrafts((list) => list.filter((_, j) => j !== i));

  const bodyOf = (draft: any) => (draft.intent === 'create_task'
    ? {
      intent: 'create_task',
      task: {
        ...draft.task,
        // подробный предпросмотр — теги подтверждает человек, как раньше
        auto: false,
        // не трогал галочку — берём его привычное значение, а не заводское
        requiresApproval: draft.task.requiresApproval ?? stickyCheck('task.requiresApproval', true),
        // пустые строки в шагах — след правки, а не шаг: до задачи они не доходят
        checklist: (draft.task.checklist ?? []).map((x: string) => x.trim()).filter(Boolean),
        // Теги и подтверждение постановщика: без них сервер задачу не создаст.
        tagIds: (draft.tags ?? EMPTY_TAGS).tagIds,
        suggestedTagIds: (draft.tags ?? EMPTY_TAGS).suggested,
        tagsConfirmed: (draft.tags ?? EMPTY_TAGS).confirmed,
        confirmedWithoutTags: (draft.tags ?? EMPTY_TAGS).confirmedWithoutTags,
      },
    }
    : { intent: 'create_deal', deal: draft.deal });

  /**
   * Файлы к уже созданной задаче.
   *
   * Вложение живёт ПРИ задаче, а до создания её ещё нет — поэтому файлы ждут в
   * черновике и уходят сразу следом. По одному и по порядку: десяток вложений,
   * отправленных разом с телефона, рвётся на середине, и потом не понять, что
   * именно не долетело.
   */
  const uploadFiles = async (taskId: string, list: File[]): Promise<string[]> => {
    const failed: string[] = [];
    for (const f of list) {
      try { await api.uploadAttachment(taskId, f); }
      catch { failed.push(f.name); }
    }
    return failed;
  };

  const applyOne = async (draft: any, index: number, over: Record<string, unknown> = {}) => {
    if (Object.keys(over).length) draft = { ...draft, task: { ...draft.task, ...over } };
    setBusy(true); setMsg('');
    if (!draft?.task?.projectId) {
      patchDraft(index, { error: 'Выберите проект — без проекта задачу создать нельзя' });
      setBusy(false);
      return;
    }
    try {
      const res: any = await api.nlApply(bodyOf(draft));
      patchDraft(index, { error: null, workload: null });
      const taskId = res?.task ? String(res.task.id) : '';
      const failed = taskId ? await uploadFiles(taskId, draft.files ?? []) : [];
      setDone((d) => [...d, index]);
      if (res?.task) feedback('task.created');
      remember(draft, res?.task);
      if (failed.length) {
        // Задача создана — предлагать создать её второй раз нельзя, это дубль.
        setMsg(`Задача создана, но не загрузились файлы: ${failed.join(', ')}. Прикрепите их в карточке, на вкладке «Файлы».`);
        return;
      }
      // Одна задача — сразу открываем её. Когда задач несколько, человек ещё работает
      // со списком, и уводить его с экрана нельзя.
      if (drafts.length === 1 && res?.task && onCreated) {
        onCreated(String(res.task.project_id ?? res.task.projectId), String(res.task.id));
        onClose();
      }
    } catch (e) {
      // страж нагрузки (ТЗ-21): предупреждение с вариантами, а не ошибка
      const w = workloadOf(e);
      if (w) patchDraft(index, { error: null, workload: w, task: draft.task });
      else patchDraft(index, { error: e instanceof ApiError ? e.message : 'Не удалось создать' });
    }
    finally { setBusy(false); }
  };

  /*
    Ключ этой отправки. Один на попытку: нажали «создать» второй раз после обрыва
    связи — сервер узнает ключ и вернёт ТОТ ЖЕ пакет, а не создаст дубли (ТЗ-10).
    Меняется, только когда человек начинает новую команду.
  */
  const requestId = useRef(newChangeId());
  const batchMsgRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (msg && drafts.length > 1) batchMsgRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [msg, drafts.length]);

  /**
   * Создать все проверенные — одной пакетной операцией (ТЗ-10, этап 2).
   *
   * Раньше окно слало N отдельных запросов и держало результат в памяти: перезагрузка
   * теряла его, а повтор после обрыва плодил дубли. Теперь сервер заводит пакет с
   * номером, сам создаёт задачи и возвращает, что получилось, а что нет; человек
   * уходит на страницу результата, которая живёт по адресу.
   *
   * Ничего не пропускаем молча: задача без проекта остаётся на экране с просьбой
   * выбрать проект — в пакет уходят только готовые.
   */
  const applyAll = async () => {
    setBusy(true); setMsg('');
    const ready: { index: number; draft: any }[] = [];
    let skipped = 0;
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      if (done.includes(i) || d.intent !== 'create_task') continue;
      if (!d.task?.projectId) { skipped++; patchDraft(i, { error: 'Выберите проект — без проекта задачу создать нельзя' }); continue; }
      ready.push({ index: i, draft: d });
    }
    if (!ready.length) {
      setBusy(false);
      setMsg(skipped ? `Ждут проекта: ${skipped}. Выберите проект в каждой задаче.` : 'Нечего создавать.');
      return;
    }
    try {
      const batch = await api.createTaskBatch({
        drafts: ready.map((r) => bodyOf(r.draft)),
        sourceType: job ? 'voice' : 'text',
        sourceText: (heard || text).slice(0, 4000) || undefined,
        clientRequestId: requestId.current,
      });
      // Файлы к задачам грузим после: они идут по одному и не должны задерживать пакет.
      const lostFiles: string[] = [];
      for (let k = 0; k < ready.length && k < batch.tasks.length; k++) {
        const files = ready[k].draft.files ?? [];
        if (files.length) lostFiles.push(...await uploadFiles(batch.tasks[k].taskId, files));
      }
      setDone((list) => [...list, ...ready.map((r) => r.index)]);
      // пачка — одно подтверждение, а не по звуку на задачу (§43)
      if (batch.created) feedback('task.created', { count: batch.created });
      if (batch.failedCount) {
        setMsg(`Создано ${batch.created} из ${batch.requested}. Что не получилось — видно на странице результата.`);
      }
      if (lostFiles.length) setMsg((m) => `${m} Не загрузились файлы: ${lostFiles.join(', ')}.`.trim());

      /*
        Часть задач человек мог создать из карточек ДО того, как нажал «создать
        остальные»: их в пакете нет, и уход на страницу пакета показал бы половину
        сделанного. В этом случае собираем итог этого захода целиком и показываем его
        здесь. Когда пакетом создано всё — уходим на страницу пакета: она переживает
        перезагрузку и ссылку.
      */
      if (created.length) {
        setCreated((list) => [...list, ...batch.tasks.map((t) => ({
          taskId: String(t.taskId), projectId: String(t.projectId), title: t.title,
          projectName: t.projectName, assigneeName: t.assigneeName, deadline: t.deadlineAt,
        }))]);
        setStage('done');
        return;
      }
      onClose();
      navigate({ section: 'tasks', view: 'batch', batchId: batch.batchId });
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Не удалось создать задачи');
    } finally {
      setBusy(false);
    }
  };

  /** Срок, с которым уйдёт черновик: чип главнее; не трогали — услышанный во фразе. */
  const dueOf = (d: any) => effectiveDeadline(d.task?.deadline, deadline, touched.current);

  const autoBody = (d: any) => {
    const tagIds = (d.task.autoTags ?? []).map((x: { id: string }) => String(x.id));
    return {
      intent: 'create_task',
      task: {
        ...d.task,
        auto: true,
        deadline: dueOf(d),
        requiresApproval: d.task.requiresApproval ?? stickyCheck('task.requiresApproval', true),
        checklist: (d.task.checklist ?? []).map((x: string) => x.trim()).filter(Boolean),
        tagIds, suggestedTagIds: tagIds,
      },
    };
  };

  /**
   * «Поставить задачу» (#4615). Фразу успели поменять после разбора — сначала разбор.
   * Одна задача — с радаром перегрузки (409 — подсказка в сводке), несколько — пакетом.
   */
  const submitAuto = async () => {
    if (busy) return;
    let list = drafts;
    if (text.trim() !== parsedFor.current || thinking) {
      const fresh = await autoParse(text);
      if (!fresh) return;
      list = fresh;
    }
    const tasks = list.map((d, i) => ({ d, i })).filter(({ d, i }) => d.intent === 'create_task' && d.task && !done.includes(i));
    if (!tasks.length) { setMsg(list.length ? 'Не понял, какую задачу поставить — уточните фразу' : 'Напишите, что нужно сделать'); return; }
    if (tasks.some(({ d }) => !d.task.deadlineAt && !effectiveDeadline(d.task.deadline, deadline, touched.current))) {
      setMsg('Выберите срок'); return;
    }
    const noProject = tasks.filter(({ d }) => !d.task.projectId);
    if (noProject.length) {
      for (const { i } of noProject) patchDraft(i, { error: 'Выберите проект — без проекта задачу создать нельзя' });
      return;
    }
    setBusy(true); setMsg('');
    try {
      if (tasks.length === 1) {
        const { d, i } = tasks[0];
        try {
          const res: any = await api.nlApply(autoBody(d));
          setDone((x) => [...x, i]);
          if (res?.task) { feedback('task.created'); remember(d, res.task); }
          const vt = voiceT.current;
          if (vt?.ready) diag('app', 'voice.created', vt.id ? `voice:${vt.id}` : undefined, { createdMs: Math.round(performance.now() - vt.stop) });
        } catch (e) {
          const w = workloadOf(e);
          if (w) patchDraft(i, { error: null, workload: w });
          else patchDraft(i, { error: e instanceof ApiError ? e.message : 'Не удалось поставить задачу' });
          return;
        }
      } else {
        const batch = await api.createTaskBatch({
          drafts: tasks.map(({ d }) => autoBody(d)),
          sourceType: job ? 'voice' : 'text',
          sourceText: text.slice(0, 4000) || undefined,
          clientRequestId: requestId.current,
        });
        setDone((x) => [...x, ...tasks.map(({ i }) => i)]);
        if (batch.created) feedback('task.created', { count: batch.created });
        if (batch.failedCount) setMsg(`Поставлено ${batch.created} из ${batch.requested}. Что не получилось — на странице пакета.`);
        setCreated((x) => [...x, ...batch.tasks.map((t) => ({
          taskId: String(t.taskId), projectId: String(t.projectId), title: t.title,
          projectName: t.projectName, assigneeName: t.assigneeName, deadline: t.deadlineAt,
        }))]);
      }
      setAutoNote(true);
      setStage('done');
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Не удалось поставить задачи');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!job) return;
    setMsg('');
    try { setJob(await api.voiceRetry(job.id, currentKind === 'board' ? currentProjectId : null)); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : 'Не удалось повторить обработку'); }
  };

  const working = !!job && job.status !== 'ready' && job.status !== 'error';
  const readyCount = drafts
    .filter((d, i) => !done.includes(i) && d.intent === 'create_task' && d.task?.projectId).length;
  /*
    Задачи, которым не хватает проекта (ТЗ-10, этап 1).

    Раньше такие молча пропускались при создании: `continue` без счётчика и без слова
    человеку. Команда из трёх поручений превращалась в «Создано: 0», и было непонятно,
    сломалось ли что-то. Теперь их видно числом, и кнопка создания честно говорит,
    сколько уйдёт, а сколько ждёт проекта.
  */
  const needProject = drafts
    .filter((d, i) => !done.includes(i) && d.intent === 'create_task' && d.task && !d.task.projectId).length;
  /*
    Теги, которые ещё не подтвердил постановщик (ТЗ по тегам, п. 34).

    Пакет не создаётся, пока хотя бы у одной задачи теги «ожидают»: иначе половина
    уедет с подтверждёнными тегами, половина — без, и разобрать это потом нельзя.
    Кнопка честно говорит, сколько задач ждёт.
  */
  const pendingTags = pendingTagCount(
    tagSettings,
    drafts.filter((d, i) => !done.includes(i) && d.intent === 'create_task' && d.task?.projectId)
      .map((d) => d.tags ?? EMPTY_TAGS),
  );

  // Создавали по одной и добили последнюю — итог показываем сами, кнопку искать не надо.
  useEffect(() => {
    if (stage === 'compose' && !busy && drafts.length > 1 && created.length > 1 && readyCount === 0) setStage('done');
  }, [stage, busy, drafts.length, created.length, readyCount]);

  /** Открыть одну из созданных: карточка задачи на её доске. */
  /*
    Открыть созданную задачу.

    Карточкой ПОВЕРХ списка, а не уходом на доску: человек только что создал три
    задачи и хочет пройти по ним — поправить формулировку, приложить файл. Уход на
    доску закрывал список, и к следующей задаче приходилось возвращаться «назад».
  */
  const openCreated = (t: CreatedTask) => setCardTask({ projectId: t.projectId, taskId: t.taskId });
  /*
    Куда вести с итогового экрана (просьба заказчика в #1344).

    Раньше единственной кнопкой была «Открыть доску» — и человек, создавший три
    задачи, попадал на доску, где их ещё надо найти глазами среди всех остальных.
    Теперь главное действие — «Посмотреть задачи»: список ИМЕННО созданных задач, а не
    весь раздел «Задачи» (там их приходилось искать среди остальных — жалоба
    заказчика). Доска осталась второй кнопкой и только когда проект у всех один: вести
    на доску, когда задачи разъехались по трём проектам, бессмысленно.
  */
  const openTaskList = () => {
    navigate({ section: 'tasks', view: 'created', taskIds: created.map((t) => t.taskId).join(',') });
    onClose();
  };
  const openBoard = () => { navigate({ section: 'projects', projectId: created[0].projectId }); onClose(); };
  const fmtDeadline = (v: string | null) => {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  };

  if (stage === 'done') {
    const sameProject = new Set(created.map((t) => t.projectId)).size === 1;
    return (
      <div className="drawer-overlay" {...overlayProps(onClose)}>
        <aside className="drawer nl-v2" onClick={(e) => e.stopPropagation()}>
          <div className="nl-v2-head">
            <h2 className="ui-modal-title"><Icon name="check-circle" size={20} /> {autoNote ? 'Поставлено' : 'Создано'}: {created.length} {plural(created.length, 'задача', 'задачи', 'задач')}</h2>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={16} /></Button>
          </div>
          {msg && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {msg}</div>}
          <div className="nl-v2-sub">
            Задачи уже на досках и у исполнителей. Нажмите на любую, чтобы открыть карточку.
          </div>
          {autoNote && (
            <div className="nla-done-note" role="status">
              <Icon name="bell" size={14} /> Через полминуты пришлю сообщение: проверьте и нажмите «Ок» или «Править».
            </div>
          )}
          {cardTask && (
            <TaskCardWindow
              projectId={cardTask.projectId}
              taskId={cardTask.taskId}
              onClose={() => setCardTask(null)}
            />
          )}
          <div className="nl-created-list">
            {created.map((t) => (
              <button key={t.taskId} className="nl-created" onClick={() => openCreated(t)} title="Открыть задачу">
                <span className="nl-created-title"><Icon name="check" size={14} /> {t.title}</span>
                <span className="dim nl-created-sub">
                  {[t.projectName, t.assigneeName ?? 'без исполнителя', t.deadline ? `до ${fmtDeadline(t.deadline)}` : 'без срока']
                    .filter(Boolean).join(' · ')}
                </span>
              </button>
            ))}
          </div>
          <div className="nl-actions nla-actions">
            <Button variant="primary" size="sm" onClick={openTaskList}>
              <Icon name="list" size={15} /> Посмотреть задачи
            </Button>
            {sameProject && (
              <Button variant="outline" size="sm" onClick={openBoard}>
                <Icon name="board" size={15} /> Открыть доску
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
              requestId.current = newChangeId();
              setStage('compose'); setDrafts([]); setDone([]); setCreated([]); setText(''); setHeard(''); setMsg('');
              parsedFor.current = ''; touched.current = false; setDeadline(null); setAutoNote(false);
            }}
            >
              <Icon name="zap" size={15} /> Ещё команда
            </Button>
          </div>
        </aside>
      </div>
    );
  }

  if (!manual) {
    const taskDrafts = drafts.map((d, i) => ({ d, i })).filter(({ d, i }) => d.intent === 'create_task' && d.task && !done.includes(i));
    const other = drafts.map((d, i) => ({ d, i })).filter(({ d }) => d.intent !== 'create_task' || !d.task);
    const needDue = taskDrafts.some(({ d }) => !d.task.deadlineAt && !dueOf(d));
    return (
      <div className="drawer-overlay" {...overlayProps(onClose)}>
        <aside className="drawer nl-v2" onClick={(e) => e.stopPropagation()}>
          <div className="nl-v2-head">
            <h2 className="ui-modal-title"><Icon name="zap" size={20} /> Новая задача</h2>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={16} /></Button>
          </div>
          <div className="nl-v2-sub">
            Напишите или скажите, что сделать. Проект, исполнителя, теги и приоритет система подставит сама — вам остаётся срок.
          </div>
          <textarea
            className="ui-textarea"
            rows={3}
            aria-label="Что нужно сделать"
            placeholder="Например: поправить форму входа на сайте — после ввода пароля не пускает"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitAuto(); }}
          />
          <VoiceStatus recording={recording} transcribing={false} error={voice.error} hint="нажмите «Остановить», когда закончите" className="nl-voice" />
          {job && job.status !== 'ready' && (
            <div className={`nl-job${job.status === 'error' ? ' error' : ''}`} role="status">
              {working && <span className="voice-wave" aria-hidden="true"><i /><i /><i /><i /></span>}
              <span>{job.status === 'error' ? job.error || JOB_LABEL.error : JOB_LABEL[job.status]}</span>
              {job.status === 'error' && <Button variant="outline" size="sm" onClick={retry}>Повторить обработку</Button>}
            </div>
          )}
          <div className="nla-label" id="nla-due">Срок</div>
          <DeadlineChips value={deadline} onChange={chooseDeadline} />
          {thinking && (
            <div className="nla-thinking" role="status"><span className="voice-wave" aria-hidden="true"><i /><i /><i /><i /></span> Разбираю…</div>
          )}
          {taskDrafts.map(({ d, i }) => (
            <AutoSummary
              key={i}
              draft={d}
              index={taskDrafts.findIndex((x) => x.i === i)}
              many={taskDrafts.length > 1}
              deadline={dueOf(d)}
              busy={busy}
              onPatchTask={(patch) => patchTask(i, patch)}
              onPatchDraft={(patch) => patchDraft(i, patch)}
              onDrop={() => dropDraft(i)}
            />
          ))}
          {other.map(({ d, i }) => (
            <DraftCard
              key={i}
              draft={d}
              created={done.includes(i)}
              busy={busy}
              onPatchTask={(patch) => patchTask(i, patch)}
              onPatchDeal={(patch) => patchDeal(i, patch)}
              onPatchDraft={(patch) => patchDraft(i, patch)}
              onDrop={() => dropDraft(i)}
              onApply={(over?: Record<string, unknown>) => applyOne(d, i, over)}
            />
          ))}
          {msg && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {msg}</div>}
          <div className="nl-actions nla-actions">
            <Button variant={recording ? 'destructive' : 'outline'} onClick={voice.toggle} disabled={busy || working}>
              {recording ? <><Icon name="stop" size={15} /> Остановить</> : <><Icon name="mic" size={15} /> Голосом</>}
            </Button>
            <Button
              variant="primary"
              className="nl-parse"
              onClick={() => void submitAuto()}
              disabled={recording || working || text.trim().length < 3 || (taskDrafts.length > 0 && needDue)}
              loading={busy}
              title={needDue ? 'Выберите срок' : undefined}
            >
              {!busy && <Icon name="check" size={15} />} {taskDrafts.length > 1 ? `Поставить ${taskDrafts.length} ${plural(taskDrafts.length, 'задачу', 'задачи', 'задач')}` : 'Поставить задачу'}
            </Button>
            {taskDrafts.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setManual(true)} title="Подробный предпросмотр: все поля задачи">
                <Icon name="edit" size={14} /> Править поля
              </Button>
            )}
          </div>
          {taskDrafts.length > 0 && needDue && <div className="nl-need-project"><Icon name="alert" size={13} /> Выберите срок — остальное уже заполнено.</div>}
        </aside>
      </div>
    );
  }

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer nl-v2" onClick={(e) => e.stopPropagation()}>
        <div className="nl-v2-head">
          <h2 className="ui-modal-title"><Icon name="zap" size={20} /> Новая задача</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={16} /></Button>
        </div>
        <div className="nl-v2-sub">
          Скажите или напишите обычным языком — черновики соберутся сами, вам останется подтвердить.
          В одной записи можно надиктовать сразу несколько задач разным людям.
        </div>
        {/* #1571: когда черновики уже есть, сообщение — внизу, у кнопки «Создать» */}
        {msg && drafts.length <= 1 && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {msg}</div>}

        <textarea
          className="ui-textarea"
          rows={3}
          placeholder="Например: Ольге до пятницы подготовить отчёт по продажам, срочно"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void parse(); }}
          style={{ marginTop: 6 }}
        />
        <VoiceStatus
          recording={recording}
          transcribing={false}
          error={voice.error}
          hint="нажмите «Остановить», когда закончите"
          className="nl-voice"
        />

        {/* Обработка записи: шаг называется словами, потому что ждать приходится минуты. */}
        {job && job.status !== 'ready' && (
          <div className={`nl-job${job.status === 'error' ? ' error' : ''}`} role="status">
            {working && <span className="voice-wave" aria-hidden="true"><i /><i /><i /><i /></span>}
            <span>{job.status === 'error' ? job.error || JOB_LABEL.error : JOB_LABEL[job.status]}</span>
            {job.status === 'error' && (
              // Аудио сохранено — переспрашивать человека, который говорил десять минут,
              // мы не станем ни при какой ошибке.
              <Button variant="outline" size="sm" onClick={retry}>Повторить обработку</Button>
            )}
          </div>
        )}

        <div className="nl-actions">
          <Button
            variant={recording ? 'destructive' : 'outline'}
            onClick={voice.toggle}
            disabled={busy || working}
          >
            {recording
              ? <><Icon name="stop" size={15} /> Остановить</>
              : <><Icon name="mic" size={15} /> {drafts.length ? 'Сказать заново' : 'Голосом'}</>}
          </Button>
          <Button variant="primary" className="nl-parse" onClick={() => void parse()} disabled={recording || working} loading={busy}>
            {!busy && <Icon name="sparkles" size={15} />} {busy ? 'Разбираю…' : 'Разобрать'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { parsedFor.current = ''; setManual(false); }} title="Поставить автоматически: вы выбираете только срок">
            <Icon name="zap" size={14} /> Автоматически
          </Button>
        </div>

        {heard && drafts.length > 0 && (
          <div className="dim nl-heard" title="Что услышала система из вашей записи">
            <Icon name="mic" size={12} /> {heard}
          </div>
        )}

        {drafts.length > 1 && (
          <h3 className="tv2-section-title nl-v2-count">Задачи из этой записи · {drafts.length}</h3>
        )}

        {drafts.map((draft, i) => (
          <DraftCard
            key={i}
            draft={draft}
            created={done.includes(i)}
            busy={busy}
            onPatchTask={(patch) => patchTask(i, patch)}
            onPatchDeal={(patch) => patchDeal(i, patch)}
            onPatchDraft={(patch) => patchDraft(i, patch)}
            onDrop={() => dropDraft(i)}
            onApply={(over?: Record<string, unknown>) => applyOne(draft, i, over)}
          />
        ))}

        {/* Большой пакет: подтвердить подсказки разом, увидев их все (ТЗ, п. 35). */}
        {drafts.length > 1 && pendingTags > 0 && !busy && (
          <Button
            variant="outline"
            className="tv2-wide"
            onClick={() => setDrafts((prev) => prev.map((d) => (d.intent === 'create_task'
              ? { ...d, tags: confirmTags(d.tags ?? EMPTY_TAGS) } : d)))}
          >
            <Icon name="check" size={15} /> Подтвердить теги у всех ({pendingTags})
          </Button>
        )}
        {/*
          Кнопка живёт, пока есть что создавать (жалоба в #1344).

          Раньше условие было `readyCount > 1`: стоило создать одну задачу из карточки —
          и общая кнопка исчезала, а остальные приходилось нажимать по одной. Человек
          видел это как «пакетное создание не работает».
        */}
        {drafts.length > 1 && readyCount > 0 && (
          <Button
            variant="primary"
            className="tv2-wide"
            onClick={applyAll}
            disabled={pendingTags > 0}
            loading={busy}
            title={pendingTags > 0 ? `Подтвердите теги у ${pendingTags} задач` : undefined}
          >
            {busy ? 'Создаю…'
              : created.length
                ? `Создать остальные (${readyCount})`
                : `Создать ${readyCount} ${plural(readyCount, 'задачу', 'задачи', 'задач')}`}
          </Button>
        )}
        {pendingTags > 0 && !busy && (
          <div className="nl-need-project">
            <Icon name="alert" size={13} />
            {pendingTags === 1
              ? 'У одной задачи не подтверждены теги — подтвердите их в карточке ниже.'
              : `Задач с неподтверждёнными тегами: ${pendingTags}.`}
          </div>
        )}
        {/* Сколько задач ждёт проекта — видно до нажатия, а не после (ТЗ-10, этап 1). */}
        {needProject > 0 && !busy && (
          <div className="nl-need-project">
            <Icon name="alert" size={13} />
            {needProject === 1
              ? 'Одной задаче не хватает проекта — выберите его в карточке ниже.'
              : `Задачам без проекта: ${needProject}. Выберите проект в каждой — иначе они не создадутся.`}
          </div>
        )}
        {/* #1571: почему не создалось — у кнопки, а не вверху окна за прокруткой */}
        {msg && drafts.length > 1 && (
          <div ref={batchMsgRef} className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {msg}</div>
        )}
        {/* Часть создали, часть нет (ошибка или выбросили) — к созданным всё равно можно перейти. */}
        {drafts.length > 1 && created.length > 0 && readyCount > 0 && !busy && (
          <Button variant="ghost" className="tv2-wide" onClick={() => setStage('done')}>
            Показать созданные ({created.length})
          </Button>
        )}
      </aside>
    </div>
  );
}

/** Названия отделов и направлений — те же, что у сервера (backend/src/modules/team/skills.ts). */
const DEPARTMENTS: Record<string, string> = {
  development: 'Программирование', content: 'Контент', unknown: 'Отдел не определён',
};
const SKILL_LABELS: Record<string, string> = {
  backend: 'Бэкенд', frontend: 'Фронтенд', fullstack: 'Фулстек', content: 'Контент',
  design: 'Дизайн', qa: 'Тестирование', analytics: 'Аналитика', other: 'Другое',
};

/** Одна задача из записи: правится целиком до создания. */
function DraftCard({ draft, created, busy, onPatchTask, onPatchDeal, onPatchDraft, onDrop, onApply }: {
  draft: any;
  created: boolean;
  busy: boolean;
  onPatchTask: (patch: any) => void;
  onPatchDeal: (patch: any) => void;
  onPatchDraft: (patch: any) => void;
  onDrop: () => void;
  onApply: (over?: Record<string, unknown>) => void;
}) {
  const [approvalHabit, setApprovalHabit] = useStickyCheck('task.requiresApproval', true);
  const ctx = draft?.context ?? { projects: [], users: [], clients: [] };
  const files: File[] = draft?.files ?? [];
  // #1576: появилась причина отказа — показываем её, даже если карточка прокручена
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (draft?.error || draft?.workload) alertRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [draft?.error, draft?.workload]);
  /*
    #1525: подсказка о перегрузе — в предпросмотре, сразу как известны исполнитель и срок
    (команда текстом и голосом), а не после «Создать».
  */
  const t = draft?.intent === 'create_task' && !created ? draft.task : null;
  const early = useWorkloadCheck(t ? {
    assigneeId: t.assigneeId, projectId: t.projectId, priority: t.priority, directions: t.directions,
    deadlineAt: t.deadlineAt ?? null, deadline: t.deadlineAt ? null : t.deadline,
  } : {});
  const wl = draft?.workload ?? early.info;
  /** Одноимённые не копим: файл выбирают дважды чаще, чем прикладывают два одинаковых. */
  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const seen = new Set(files.map((f) => `${f.name}:${f.size}`));
    onPatchDraft({ files: [...files, ...Array.from(list).filter((f) => !seen.has(`${f.name}:${f.size}`))] });
  };
  const conf = draft?.confidence
    ? <span className="dim" style={{ fontSize: 11, marginLeft: 6 }}>увер. {Math.round(draft.confidence * 100)}%</span>
    : null;

  if (created) {
    return (
      <div className="nl-draft created">
        <Icon name="check" size={14} /> Создано: {draft.task?.title ?? draft.deal?.title ?? 'задача'}
      </div>
    );
  }

  if (draft.intent === 'none') {
    return (
      <div className="muted" style={{ marginTop: 12 }}>
        Не понял команду{draft.note ? `: ${draft.note}` : ''}. Уточните формулировку.
      </div>
    );
  }

  if (draft.intent === 'create_task' && draft.task) {
    return (
      <div className="nl-draft">
        <div className="nl-draft-head">
          <span className="tv2-section-title">Задача{conf}</span>
          <Button variant="ghost" size="icon-sm" className="nl-draft-drop" onClick={onDrop} title="Не создавать эту задачу" aria-label="Не создавать эту задачу">
            <Icon name="close" size={14} />
          </Button>
        </div>
        {draft.warnings?.map((w: string, i: number) => (
          <div key={i} className="error-text" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {w}</div>
        ))}
        <Input placeholder="Название" aria-label="Название задачи" value={draft.task.title}
               onChange={(e) => onPatchTask({ title: e.target.value })} />
        <Textarea rows={2} placeholder="Описание (необязательно)" aria-label="Описание задачи" value={draft.task.description ?? ''}
                  onChange={(e) => onPatchTask({ description: e.target.value })} />
        <div className="tv2-grid2">
          <Select
            ariaLabel="Проект"
            className="tv2-wide"
            value={String(draft.task.projectId ?? '')}
            onValueChange={(v) => onPatchTask({ projectId: v || null, projectHint: '' })}
            invalid={!draft.task.projectId && !!draft.error}
            options={[{ value: '', label: 'Проект (обязательно)' }, ...ctx.projects.map((p: any) => ({ value: String(p.id), label: p.name }))]}
          />
          <Select
            ariaLabel="Исполнитель"
            className="tv2-wide"
            value={String(draft.task.assigneeId ?? '')}
            onValueChange={(v) => onPatchTask({ assigneeId: v || null })}
            options={[{ value: '', label: 'Без исполнителя' }, ...ctx.users.map((u: any) => ({ value: String(u.id), label: u.name }))]}
          />
        </div>
        {/* Откуда взялся проект: подставленный молча, он однажды окажется не тем. */}
        {draft.task.projectHint && draft.task.projectId && draft.task.projectId === draft.task.projectResolution?.predictedProjectId && (
          <div className="dim nl-hint"><Icon name="sparkles" size={11} /> Определено: {draft.task.projectHint}</div>
        )}
        {/* ТЗ-31: не уверен — «К какому проекту относится задача?» и 2–3 варианта кнопками */}
        {!draft.task.projectId && (draft.task.projectResolution?.candidates?.length ?? 0) > 0 && (
          <div className="nl-project-pick" role="group" aria-label="К какому проекту относится задача">
            <span className="nl-hint">К какому проекту относится задача?</span>
            {draft.task.projectResolution.candidates.map((c: { id: string; name: string }) => (
              <button key={c.id} type="button" className="nl-pchip" onClick={() => onPatchTask({ projectId: String(c.id) })}>{c.name}</button>
            ))}
          </div>
        )}
        {/*
          Кого и почему предложил ИИ (ТЗ-10, этап 4).

          Это рекомендация, а не решение: строка объясняет выбор — «Программирование ·
          Бэкенд · по направлению работы», — и её видно рядом с полем, которое можно
          поменять. Не уверен в направлении или некого предложить — так и написано;
          молча оставить задачу ничьей, не объяснив почему, было бы хуже всего.
        */}
        {draft.routing && (
          <div className={`nl-routing${draft.routing.sure ? '' : ' nl-routing-guess'}`}>
            <Icon name={draft.routing.suggestedAssigneeId ? 'sparkles' : 'alert'} size={12} />
            <span>
              {[
                DEPARTMENTS[draft.routing.department] ?? null,
                draft.routing.skill ? SKILL_LABELS[draft.routing.skill] : null,
                draft.routing.reason,
              ].filter(Boolean).join(' · ')}
              {!draft.routing.sure && draft.routing.suggestedAssigneeId ? ' (ИИ предполагает)' : ''}
            </span>
          </div>
        )}
        {/* Направления пункта (задача #1363): отмечены по словам, уходят в задачу отметками. */}
        <DirectionsPicker
          value={draft.task.directions ?? []}
          auto
          onChange={(next) => onPatchTask({ directions: next })}
        />
        {/* Постановщик не выбирается: им становится тот, кто говорит. Сказать об этом
            нужно прямо — иначе человек ищет поле «от кого» и не находит. */}
        <div className="dim nl-hint">Постановщик — вы: задача записывается от вашего имени</div>
        <div className="tv2-grid2">
          <Select ariaLabel="Приоритет" className="tv2-wide" value={String(draft.task.priority ?? 'normal')} onValueChange={(v) => onPatchTask({ priority: v })} options={[{ value: 'low', label: 'Низкий' }, { value: 'normal', label: 'Обычный' }, { value: 'high', label: 'Высокий' }, { value: 'urgent', label: 'Срочный' }]} />
          <DatePicker value={draft.task.deadline ?? ''} onChange={(v) => onPatchTask({ deadline: v || null, deadlineAt: null })} placeholder="срок не задан" />
        </div>

        <TaskTagsField
          compact
          task={{
            title: String(draft.task.title ?? ''),
            description: String(draft.task.description ?? ''),
            checklist: draft.task.checklist ?? [],
          }}
          value={draft.tags ?? EMPTY_TAGS}
          onChange={(tags) => onPatchDraft({ tags })}
        />

        <Checkbox
          checked={draft.task.requiresApproval ?? approvalHabit}
          onCheckedChange={(on) => { onPatchTask({ requiresApproval: on }); setApprovalHabit(on); }}
          label={<span title="Исполнитель сдаст работу, а завершите её вы">Не завершать без согласования с постановщиком</span>}
        />

        {/* Чек-лист приходит из разбора и правится здесь же: шаги, придуманные
            моделью, человек читает первым — и половину обычно переписывает. */}
        {/* Подпись — ОТДЕЛЬНОЙ строкой обычными буквами. Внутри заголовка она
            набиралась капслоком и читалась как продолжение названия блока. */}
        <div className="nl-v2-block">
          <span className="ui-field-label">Шаги проверки</span>
          <span className="ui-field-hint">как понять, что работа сделана</span>
        </div>
        {(draft.task.checklist ?? []).map((step: string, i: number) => (
          <div key={i} className="nl-step">
            <Input value={step} aria-label={`Шаг ${i + 1}`}
                   onChange={(e) => {
                     const next = [...(draft.task.checklist ?? [])];
                     next[i] = e.target.value;
                     onPatchTask({ checklist: next });
                   }} />
            <Button variant="ghost" size="icon-sm" title="Убрать шаг" aria-label={`Убрать шаг ${i + 1}`}
                    onClick={() => onPatchTask({ checklist: (draft.task.checklist ?? []).filter((_: string, j: number) => j !== i) })}>
              <Icon name="close" size={14} />
            </Button>
          </div>
        ))}
        <div>
          <Button variant="ghost" size="sm"
                  onClick={() => onPatchTask({ checklist: [...(draft.task.checklist ?? []), ''] })}>
            <Icon name="plus" size={14} /> Добавить шаг
          </Button>
        </div>

        {/*
          Файлы — и здесь тоже.

          Задачу голосом ставят с телефона, где под рукой ровно тот снимок экрана,
          из-за которого её и заводят. Кнопки приложить его в этой форме не было, и
          задача уходила в работу без исходников: «а где макет?» через десять минут
          после постановки. Грузятся они сразу после создания — вложение живёт при
          задаче, а до её создания прикреплять не к чему.
        */}
        <span className="ui-field-label">Файлы</span>
        <div
          className="file-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
        >
          <label className="ui-btn ui-btn-outline ui-btn-sm file-pick">
            <Icon name="paperclip" size={15} /> Загрузить файл
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
                  onClick={() => onPatchDraft({ files: files.filter((_, j) => j !== i) })}
                  title="Убрать файл"
                  aria-label={`Убрать ${f.name}`}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* #1576: почему не создалось — рядом с кнопкой, а не вверху карточки за краем экрана */}
        <div ref={alertRef} className="nl-draft-alerts">
          {draft.error && (
            <div className="error-text" role="alert" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {draft.error}</div>
          )}
          {wl && (
            <WorkloadWarning
              info={wl}
              busy={busy}
              /*
                До «Создать» кнопки только правят черновик; после 409 — ставят сразу.
                Срок — точным моментом 15:00 (#1525), а не днём: день стал бы 18:00.
              */
              onMove={wl.alternativeDate ? () => {
                const move = { deadline: wl.alternativeDate, deadlineAt: wl.alternativeDeadline };
                early.accept(String(wl.assigneeId));
                if (draft.workload) onApply({ ...move, confirmWorkload: true }); else onPatchTask(move);
              } : undefined}
              onReassign={(id) => (draft.workload ? onApply({ assigneeId: id }) : onPatchTask({ assigneeId: id }))}
              onKeep={() => { early.accept(String(wl.assigneeId)); if (draft.workload) onApply({ confirmWorkload: true }); }}
            />
          )}
        </div>
        {/* #1549: без проекта кнопка не прячется — нажатие объясняет, что проект обязателен, и подсвечивает поле */}
        <Button variant="primary" className="tv2-wide" onClick={() => onApply(early.confirmed ? { confirmWorkload: true } : undefined)} loading={busy}>
          {files.length ? `Создать задачу и прикрепить ${files.length}` : 'Создать задачу'}
        </Button>
      </div>
    );
  }

  if (draft.intent === 'create_deal' && draft.deal) {
    return (
      <div className="nl-draft">
        <span className="tv2-section-title">Сделка{conf}</span>
        <Input placeholder="Название сделки" aria-label="Название сделки" value={draft.deal.title}
               onChange={(e) => onPatchDeal({ title: e.target.value })} />
        <div className="tv2-grid2">
          <Input type="number" placeholder="Сумма" aria-label="Сумма" value={draft.deal.amount ?? ''}
                 onChange={(e) => onPatchDeal({ amount: e.target.value === '' ? null : Number(e.target.value) })} />
          <Input type="number" placeholder="Маржа %" aria-label="Маржа" value={draft.deal.plannedMargin ?? ''}
                 onChange={(e) => onPatchDeal({ plannedMargin: e.target.value === '' ? null : Number(e.target.value) })} />
        </div>
        <Select
          ariaLabel="Клиент"
          className="tv2-wide"
          value={String(draft.deal.clientId ?? '')}
          onValueChange={(v) => onPatchDeal({ clientId: v || null })}
          options={[{ value: '', label: 'Клиент не выбран' }, ...ctx.clients.map((c: any) => ({ value: String(c.id), label: c.name }))]}
        />
        <Button variant="primary" className="tv2-wide" onClick={() => onApply()} loading={busy}>
          Создать сделку
        </Button>
      </div>
    );
  }

  return null;
}
