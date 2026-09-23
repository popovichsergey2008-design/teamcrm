import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, VoiceJob } from '../lib/api';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { DatePicker } from './DatePicker';
import { VoiceStatus } from './VoiceStatus';
import { overlayProps } from '../lib/overlay';
import { navigate } from '../lib/router';
import { plural } from '../lib/chat-text';

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

export function NlCommandModal({ onClose, initialText, autoRecord, currentProjectId, onCreated }: {
  onClose: () => void;
  /** Текст, набранный в командной строке: переспрашивать уже сформулированное незачем. */
  initialText?: string;
  /** Пришли по кнопке микрофона — сразу слушаем, не заставляя нажимать ещё раз. */
  autoRecord?: boolean;
  /** Доска, открытая у человека: из неё берётся проект, если он не назван вслух. */
  currentProjectId?: string | null;
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

  const parse = async (raw?: string) => {
    const command = (raw ?? text).trim();
    if (command.length < 3) return setMsg('Слишком короткая команда');
    setBusy(true); setMsg(''); setDrafts([]); setDone([]); setCreated([]); setStage('compose'); setJob(null);
    try {
      // Несколько поручений в одной строке — несколько черновиков, как и у надиктовки.
      setDrafts(await api.nlParseMany(command, currentProjectId));
      setHeard(command);
    } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Ошибка распознавания'); }
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
  const sendRecording = async (blob: Blob) => {
    setMsg(''); setDrafts([]); setDone([]);
    try {
      setJob(await api.voiceStart(blob, currentProjectId));
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Не удалось отправить запись');
    }
  };

  const voice = useVoiceInput(() => undefined, { onBlob: (blob) => void sendRecording(blob) });
  const { recording } = voice;

  // Пока запись обрабатывается, спрашиваем сервер, как дела: расшифровка длинного
  // аудио идёт минутами, и человек должен видеть движение, а не замерший экран.
  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'error') return;
    const t = setTimeout(async () => {
      try {
        const next = await api.voiceStatus(job.id);
        setJob(next);
        if (next.status === 'ready') {
          setDrafts(next.tasks ?? []);
          setHeard(next.transcript ?? '');
        }
      } catch { /* следующий заход попробует снова: сеть моргает, запись цела */ }
    }, 2000);
    return () => clearTimeout(t);
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
        // пустые строки в шагах — след правки, а не шаг: до задачи они не доходят
        checklist: (draft.task.checklist ?? []).map((x: string) => x.trim()).filter(Boolean),
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

  const applyOne = async (draft: any, index: number) => {
    setBusy(true); setMsg('');
    if (!draft?.task?.projectId) {
      patchDraft(index, { error: 'Выберите проект — без него задачу не создать' });
      setBusy(false);
      return;
    }
    try {
      const res: any = await api.nlApply(bodyOf(draft));
      patchDraft(index, { error: null });
      const taskId = res?.task ? String(res.task.id) : '';
      const failed = taskId ? await uploadFiles(taskId, draft.files ?? []) : [];
      setDone((d) => [...d, index]);
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
    } catch (e) { patchDraft(index, { error: e instanceof ApiError ? e.message : 'Не удалось создать' }); }
    finally { setBusy(false); }
  };

  /**
   * Создать все проверенные разом: по одной, чтобы упавшая не отменяла созданные.
   *
   * Ничего не пропускаем молча (ТЗ-10, этап 1): задача без проекта остаётся на экране
   * с просьбой выбрать проект, ошибка по конкретной задаче пишется в неё саму, и
   * человек видит, что именно осталось сделать.
   */
  const applyAll = async () => {
    setBusy(true); setMsg('');
    let failed = 0;
    let skipped = 0;
    const lostFiles: string[] = [];
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      if (done.includes(i) || d.intent !== 'create_task') continue;
      if (!d.task?.projectId) { skipped++; patchDraft(i, { error: 'Выберите проект — без него задачу не создать' }); continue; }
      try {
        const res: any = await api.nlApply(bodyOf(d));
        if (res?.task && d.files?.length) lostFiles.push(...await uploadFiles(String(res.task.id), d.files));
        setDone((list) => [...list, i]);
        patchDraft(i, { error: null });
        remember(d, res?.task);
      } catch (e) {
        failed++;
        patchDraft(i, { error: e instanceof ApiError ? e.message : 'Не удалось создать' });
      }
    }
    setBusy(false);
    const notes = [
      failed ? `Не удалось создать: ${failed} — причина написана в самой задаче.` : '',
      skipped ? `Ждут проекта: ${skipped}. Выберите проект и нажмите «Создать» у такой задачи.` : '',
      lostFiles.length ? `Не загрузились файлы: ${lostFiles.join(', ')}. Прикрепите их в карточках, на вкладке «Файлы».` : '',
    ].filter(Boolean);
    if (notes.length) setMsg(notes.join(' '));
    // Всё создано без потерь — сразу на итоговую страницу; осталось нерешённое — остаёмся: его видно здесь.
    if (!failed && !skipped && !lostFiles.length) setStage('done');
  };

  const retry = async () => {
    if (!job) return;
    setMsg('');
    try { setJob(await api.voiceRetry(job.id, currentProjectId)); }
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

  // Создавали по одной и добили последнюю — итог показываем сами, кнопку искать не надо.
  useEffect(() => {
    if (stage === 'compose' && !busy && drafts.length > 1 && created.length > 1 && readyCount === 0) setStage('done');
  }, [stage, busy, drafts.length, created.length, readyCount]);

  /** Открыть одну из созданных: карточка задачи на её доске. */
  const openCreated = (t: CreatedTask) => {
    if (onCreated) onCreated(t.projectId, t.taskId); else navigate({ section: 'projects', projectId: t.projectId, taskId: t.taskId });
    onClose();
  };
  /** Все созданные разом: одна доска — на неё, разные — в реестр «От меня», там они все. */
  const openAllCreated = () => {
    const projects = new Set(created.map((t) => t.projectId));
    if (projects.size === 1) navigate({ section: 'projects', projectId: created[0].projectId });
    else navigate({ section: 'tasks', view: 'delegated' });
    onClose();
  };
  const fmtDeadline = (v: string | null) => {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  };

  if (stage === 'done') {
    const sameProject = new Set(created.map((t) => t.projectId)).size === 1;
    return (
      <div className="drawer-overlay" {...overlayProps(onClose)}>
        <aside className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h3><Icon name="check" size={18} /> Создано: {created.length} {plural(created.length, 'задача', 'задачи', 'задач')}</h3>
            <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
          </div>
          {msg && <div className="error-text">{msg}</div>}
          <div className="dim" style={{ fontSize: 12 }}>
            Задачи уже на досках и у исполнителей. Нажмите на любую, чтобы открыть карточку.
          </div>
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
          <div className="nl-actions">
            <button className="btn btn-primary btn-sm" onClick={openAllCreated}>
              <Icon name={sameProject ? 'board' : 'list'} size={14} /> {sameProject ? 'Открыть доску' : 'Показать в «Задачах»'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setStage('compose'); setDrafts([]); setDone([]); setCreated([]); setText(''); setHeard(''); setMsg(''); }}
            >
              <Icon name="zap" size={14} /> Ещё команда
            </button>
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="zap" size={18} /> Быстрая команда</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>
        <div className="dim" style={{ fontSize: 12 }}>
          Скажите или напишите обычным языком — черновики соберутся сами, вам останется подтвердить.
          В одной записи можно надиктовать сразу несколько задач разным людям.
        </div>
        {msg && <div className="error-text">{msg}</div>}

        <textarea
          className="input"
          rows={3}
          placeholder="Ваша команда…"
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
              <button className="btn btn-sm" onClick={retry}>Повторить обработку</button>
            )}
          </div>
        )}

        <div className="nl-actions">
          <button
            className={`btn btn-sm ${recording ? 'btn-primary' : 'btn-ghost'}`}
            onClick={voice.toggle}
            disabled={busy || working}
          >
            {recording
              ? <><Icon name="stop" size={14} /> Остановить</>
              : <><Icon name="mic" size={14} /> {drafts.length ? 'Сказать заново' : 'Голосом'}</>}
          </button>
          <button className="btn btn-primary btn-sm nl-parse" onClick={() => void parse()} disabled={busy || recording || working}>
            <Icon name="sparkles" size={14} /> {busy ? 'Разбираю команду…' : 'Разобрать'}
          </button>
        </div>

        {heard && drafts.length > 0 && (
          <div className="dim nl-heard" title="Что услышала система из вашей записи">
            <Icon name="mic" size={12} /> {heard}
          </div>
        )}

        {drafts.length > 1 && (
          <div className="drawer-section-title" style={{ marginTop: 10 }}>
            Задачи из этой записи ({drafts.length})
          </div>
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
            onApply={() => applyOne(draft, i)}
          />
        ))}

        {drafts.length > 1 && readyCount > 1 && (
          <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={applyAll} disabled={busy}>
            {busy ? 'Создаю…' : `Создать ${readyCount} ${plural(readyCount, 'задачу', 'задачи', 'задач')}`}
          </button>
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
        {/* Часть создали, часть нет (ошибка или выбросили) — к созданным всё равно можно перейти. */}
        {drafts.length > 1 && created.length > 0 && readyCount > 0 && !busy && (
          <button className="btn btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => setStage('done')}>
            Показать созданные ({created.length})
          </button>
        )}
      </aside>
    </div>
  );
}

/** Одна задача из записи: правится целиком до создания. */
function DraftCard({ draft, created, busy, onPatchTask, onPatchDeal, onPatchDraft, onDrop, onApply }: {
  draft: any;
  created: boolean;
  busy: boolean;
  onPatchTask: (patch: any) => void;
  onPatchDeal: (patch: any) => void;
  onPatchDraft: (patch: any) => void;
  onDrop: () => void;
  onApply: () => void;
}) {
  const ctx = draft?.context ?? { projects: [], users: [], clients: [] };
  const files: File[] = draft?.files ?? [];
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
        <div className="drawer-section-title">
          Задача{conf}
          <button className="btn btn-ghost btn-sm nl-draft-drop" onClick={onDrop} title="Не создавать эту задачу">
            <Icon name="close" size={13} />
          </button>
        </div>
        {draft.error && (
          <div className="error-text" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {draft.error}</div>
        )}
        {draft.warnings?.map((w: string, i: number) => (
          <div key={i} className="error-text" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {w}</div>
        ))}
        <input className="input" placeholder="Название" value={draft.task.title}
               onChange={(e) => onPatchTask({ title: e.target.value })} />
        <textarea className="input" rows={2} placeholder="Описание (необязательно)" value={draft.task.description ?? ''}
                  onChange={(e) => onPatchTask({ description: e.target.value })} style={{ marginTop: 6 }} />
        <select className="input" style={{ marginTop: 6 }} value={draft.task.projectId ?? ''}
                onChange={(e) => onPatchTask({ projectId: e.target.value || null, projectHint: '' })}>
          <option value="">— проект (обязательно) —</option>
          {ctx.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {/* Откуда взялся проект: подставленный молча, он однажды окажется не тем. */}
        {draft.task.projectHint && <div className="dim nl-hint">{draft.task.projectHint}</div>}
        <select className="input" style={{ marginTop: 6 }} value={draft.task.assigneeId ?? ''}
                onChange={(e) => onPatchTask({ assigneeId: e.target.value || null })}>
          <option value="">— исполнитель —</option>
          {ctx.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {/* Постановщик не выбирается: им становится тот, кто говорит. Сказать об этом
            нужно прямо — иначе человек ищет поле «от кого» и не находит. */}
        <div className="dim nl-hint">Постановщик — вы: задача записывается от вашего имени</div>
        <div className="team-rate" style={{ marginTop: 6 }}>
          <select className="input" value={draft.task.priority} onChange={(e) => onPatchTask({ priority: e.target.value })}>
            <option value="low">Низкий</option><option value="normal">Обычный</option>
            <option value="high">Высокий</option><option value="urgent">Срочный</option>
          </select>
          <DatePicker value={draft.task.deadline ?? ''} onChange={(v) => onPatchTask({ deadline: v || null })} placeholder="срок не задан" />
        </div>

        <label className="notify-row" title="Исполнитель сдаст работу, а завершите её вы">
          <input type="checkbox" checked={draft.task.requiresApproval !== false}
                 onChange={(e) => onPatchTask({ requiresApproval: e.target.checked })} />
          Не завершать без согласования с постановщиком
        </label>

        {/* Чек-лист приходит из разбора и правится здесь же: шаги, придуманные
            моделью, человек читает первым — и половину обычно переписывает. */}
        {/* Подпись — ОТДЕЛЬНОЙ строкой обычными буквами. Внутри заголовка она
            набиралась капслоком и читалась как продолжение названия блока. */}
        <div className="drawer-section-title" style={{ marginTop: 8 }}>Шаги проверки задачи</div>
        <div className="dim nl-hint">как понять, что работа сделана</div>
        {(draft.task.checklist ?? []).map((step: string, i: number) => (
          <div key={i} className="nl-step">
            <input className="input" value={step} aria-label={`Шаг ${i + 1}`}
                   onChange={(e) => {
                     const next = [...(draft.task.checklist ?? [])];
                     next[i] = e.target.value;
                     onPatchTask({ checklist: next });
                   }} />
            <button className="btn btn-ghost btn-sm" title="Убрать шаг"
                    onClick={() => onPatchTask({ checklist: (draft.task.checklist ?? []).filter((_: string, j: number) => j !== i) })}>
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm"
                onClick={() => onPatchTask({ checklist: [...(draft.task.checklist ?? []), ''] })}>
          <Icon name="plus" size={13} /> Добавить шаг
        </button>

        {/*
          Файлы — и здесь тоже.

          Задачу голосом ставят с телефона, где под рукой ровно тот снимок экрана,
          из-за которого её и заводят. Кнопки приложить его в этой форме не было, и
          задача уходила в работу без исходников: «а где макет?» через десять минут
          после постановки. Грузятся они сразу после создания — вложение живёт при
          задаче, а до её создания прикреплять не к чему.
        */}
        <div className="drawer-section-title" style={{ marginTop: 8 }}>Файлы</div>
        <div
          className="file-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
        >
          <label className="btn btn-sm file-pick">
            <Icon name="paperclip" size={14} /> Загрузить файл
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

        <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 8 }}
                onClick={onApply} disabled={busy || !draft.task.projectId}>
          {!draft.task.projectId
            ? 'Выберите проект'
            : (files.length ? `Создать задачу и прикрепить ${files.length}` : 'Создать задачу')}
        </button>
      </div>
    );
  }

  if (draft.intent === 'create_deal' && draft.deal) {
    return (
      <div className="nl-draft">
        <div className="drawer-section-title">Сделка{conf}</div>
        <input className="input" placeholder="Название сделки" value={draft.deal.title}
               onChange={(e) => onPatchDeal({ title: e.target.value })} />
        <div className="team-rate" style={{ marginTop: 6 }}>
          <input className="input" type="number" placeholder="Сумма" value={draft.deal.amount ?? ''}
                 onChange={(e) => onPatchDeal({ amount: e.target.value === '' ? null : Number(e.target.value) })} />
          <input className="input" type="number" placeholder="Маржа %" value={draft.deal.plannedMargin ?? ''}
                 onChange={(e) => onPatchDeal({ plannedMargin: e.target.value === '' ? null : Number(e.target.value) })} />
        </div>
        <select className="input" style={{ marginTop: 6 }} value={draft.deal.clientId ?? ''}
                onChange={(e) => onPatchDeal({ clientId: e.target.value || null })}>
          <option value="">— клиент —</option>
          {ctx.clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={onApply} disabled={busy}>
          Создать сделку
        </button>
      </div>
    );
  }

  return null;
}
