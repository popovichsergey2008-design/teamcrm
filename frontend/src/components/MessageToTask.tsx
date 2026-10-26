import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, TagSettings } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import { humanSize } from '../lib/attachments';
import { TaskTagsField } from './TaskTagsField';
import { EMPTY_TAGS, tagsReady, TagsValue } from '../lib/tags';
import { OptionSelect } from './ui/option-select';
import { confirmAction } from './ui/dialog';
import { workloadOf, WorkloadInfo, WorkloadWarning } from './WorkloadWarning';
import { feedback } from '../lib/feedback';
import { overServer, settleEdits } from '../lib/local-edits';
import './message-to-task.css';

/** Черновик задачи из сообщения — то, что отдаёт сервер и правит человек. */
export interface MessageTaskDraft {
  draftId: string;
  chatId: string;
  messageId: string;
  status: 'transcribing' | 'analyzing' | 'needs_clarification' | 'ready' | 'created' | 'cancelled' | 'failed';
  title: string;
  description: string;
  projectId: string | null;
  assigneeId: string | null;
  assigneeReason: string | null;
  deadline: string | null;
  priority: string;
  checklist: string[];
  files: { fileId: string; name: string | null; mime: string | null; include: boolean; size?: number }[];
  analysis: Record<string, unknown>;
  /** Для строки под сообщением (#1554); у закрытого проекта — null. */
  projectName?: string | null;
  assigneeName?: string | null;
  authorId: string | null;
  initiatorId: string;
  taskId: string | null;
  createdTaskIds?: string[];
  /** несколько поручений в одном сообщении (ТЗ-26, §9) */
  split?: { title: string; assigneeId: string | null; deadline: string | null; checklist: string[] }[];
}

/** Одна из задач, на которые ИИ разложил сообщение (§9). */
type SplitItem = NonNullable<MessageTaskDraft['split']>[number];

/** Голосовое у черновика: расшифровка и кому фрагмент откроется без доступа к чату. */
interface VoiceInfo { fileId: string; transcript: string | null; transcriptStatus: string | null; error: 'no_stt' | 'stt' | null; gap: string[] }

/**
 * Задача из сообщения — то, ради чего чат живёт внутри CRM, а не рядом с ней.
 *
 * Самый частый способ появления задачи — фраза в переписке: «на мобильной версии блок
 * съезжает и кнопка закрывает текст». Раньше её переписывали руками в форму создания,
 * теряя половину смысла и весь контекст. Теперь ИИ раскладывает фразу на постановку,
 * шаги и срок, подбирает проект и исполнителя, а человек правит и подтверждает.
 *
 * Чего в переписке чаще всего не хватает — проекта: «поправь фильтр» сказано в общем
 * чате, а проектов семь. Тогда черновик ждёт: бот спрашивает автора прямо в чате, и
 * как только тот отвечает названием, окно дозаполняется само. Поэтому черновик живёт
 * на сервере и переживает перезагрузку страницы.
 *
 * ИИ здесь не ставит задачи за человека: он готовит черновик. Разница принципиальная —
 * ответственность за формулировку остаётся на том, кто нажал «Создать».
 */
export function MessageToTask({ chatId, messageId, messageText, draft: outside, onClose, onCreated }: {
  chatId: string;
  messageId: string;
  /** Исходная фраза: она же запасной вариант, если разбор не удался. */
  messageText: string;
  /** Черновик, приехавший событием, — окно открыто и показывает свежее состояние. */
  draft?: MessageTaskDraft | null;
  onClose: () => void;
  onCreated: (taskId: string, title: string, projectId: string) => void;
}) {
  useEscape(onClose);
  const [draft, setDraft] = useState<MessageTaskDraft | null>(null);
  const [ctx, setCtx] = useState<{ projects: { id: string; name: string }[]; users: { id: string; name: string }[]; suggested?: string[] }>({
    projects: [], users: [],
  });
  const [voice, setVoice] = useState<VoiceInfo | null>(null);
  const [mode, setMode] = useState<'single' | 'split'>('single');
  const [wish, setWish] = useState('');
  const [workload, setWorkload] = useState<WorkloadInfo | null>(null);
  /*
    Правки человека, которые сервер ещё не сохранил (#4645).

    Черновик живёт на сервере и приезжает событием после каждой записи — своей, ИИ,
    ответа автора о проекте. Раньше любое событие целиком заменяло черновик на экране,
    и набранное в «Описании» исчезало на следующей же букве: окно выглядело так, будто
    править текст ИИ нельзя. Теперь всё, что приходит с сервера, ложится ПОД эти правки.
  */
  const edits = useRef<Partial<MessageTaskDraft>>({});
  /** любой ответ сервера по черновику: сам черновик, списки, голосовое */
  const take = (r: any) => {
    setDraft(r.draft ? overServer(r.draft as MessageTaskDraft, edits.current) : r.draft);
    if (r.context) setCtx(r.context);
    if (r.voice !== undefined) setVoice(r.voice);
  };
  /** Правка на экране: сразу в поле и в список несохранённого. */
  const edit = (fields: Partial<MessageTaskDraft>) => {
    edits.current = { ...edits.current, ...fields };
    setDraft((cur) => (cur ? { ...cur, ...fields } : cur));
  };
  const [already, setAlready] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [asked, setAsked] = useState(false);
  /** Теги задачи: тем же полем, что в форме и в быстрой команде. */
  const [tags, setTags] = useState<TagsValue>(EMPTY_TAGS);
  const [tagSettings, setTagSettings] = useState<TagSettings | null>(null);
  useEffect(() => { api.tagSettings().then(setTagSettings).catch(() => setTagSettings(null)); }, []);

  useEffect(() => {
    let dead = false;
    api.startMessageTaskDraft(chatId, messageId)
      .then((r) => {
        if (dead) return;
        take(r); setAlready(r.already ?? null);
        // ИИ разобрал сообщение в черновик — вспышка и сигнал (ТЗ-23); старый черновик молчит
        if (!r.already && r.draft?.status !== 'transcribing') feedback('ai.completed', { el: document.querySelector('.mtt-drawer') });
      })
      .catch((e) => { if (!dead) setErr(e instanceof ApiError ? e.message : 'Не удалось разобрать сообщение'); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [chatId, messageId]);

  /*
    Ответ автора о проекте приходит событием. Подхватываем его прямо в открытом окне:
    человек, который ждёт ответа, не должен закрывать и открывать окно, чтобы узнать,
    что ответ уже был.
  */
  useEffect(() => {
    if (!outside || !draft || outside.draftId !== draft.draftId) return;
    // голосовое расшифровалось и разобрано — перечитать вместе с расшифровкой; черновик готов — вспышка ИИ
    if (draft.status === 'transcribing' && outside.status !== 'transcribing') {
      void api.messageTaskDraftById(draft.draftId).then(take).catch(() => setDraft(outside));
      if (outside.status !== 'failed') feedback('ai.started', { el: document.querySelector('.mtt-drawer') });
      return;
    }
    setDraft(overServer(outside, edits.current));
    // Только на новое событие: при зависимости от draft эффект срабатывал на каждую
    // набранную букву и возвращал в поле то, что было в последнем событии.
  }, [outside]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Правку отправляем сразу: черновик на сервере, и вкладка может закрыться в любой момент. */
  const patch = async (body: Partial<MessageTaskDraft>) => {
    if (!draft) return;
    edit(body);
    try {
      const r = await api.patchMessageTaskDraft(draft.draftId, body);
      edits.current = settleEdits(edits.current, body);
      take(r);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Правка не сохранилась'); }
  };
  /*
    Перед «Создать» — дописать на сервер всё несохранённое. Задачу собирает сервер из
    своего черновика, а поле сохраняется по уходу фокуса: нажатие «Создать» прямо из
    поля отправляло правку и подтверждение наперегонки.
  */
  const flush = async () => {
    if (!draft || !Object.keys(edits.current).length) return;
    const body = edits.current;
    take(await api.patchMessageTaskDraft(draft.draftId, body));
    edits.current = settleEdits(edits.current, body);
  };

  const ask = async () => {
    if (!draft) return;
    setBusy(true); setErr('');
    try {
      const r = await api.askMessageTaskDraft(draft.draftId);
      take(r); setAsked(true);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Вопрос не отправился'); }
    finally { setBusy(false); }
  };

  const create = async (extra: { confirmWorkload?: boolean } = {}) => {
    if (!draft) return;
    if (!draft.projectId) {
      document.getElementById('mtt-project')?.focus();
      return setErr('Выберите проект — без проекта задачу создать нельзя');
    }
    if (!draft.title.trim()) return setErr('Назовите задачу');
    /*
      Голосовое из переписки, а задачу увидят те, кто её не видел (ТЗ-26, §17): молча
      доступ не расширяем — спрашиваем. «Нет» — задача без аудио, расшифровка в описании.
    */
    let audio: 'allow' | 'none' | undefined;
    if (voice?.gap?.length && !extra.confirmWorkload) {
      const ok = await confirmAction({
        title: 'Поделиться голосовым?',
        description: `${voice.gap.slice(0, 4).join(', ')}${voice.gap.length > 4 ? ' и другие' : ''} не видят эту переписку. QEVO может приложить к задаче только это голосовое — не весь чат.`,
        confirmLabel: 'Разрешить голосовое', cancelLabel: 'Без аудио',
      });
      audio = ok ? 'allow' : 'none';
    }
    setBusy(true); setErr('');
    try {
      await flush();
      const res = await api.confirmMessageTaskDraft(draft.draftId, {
        tagIds: tags.tagIds,
        suggestedTagIds: tags.suggested,
        tagsConfirmed: tags.confirmed,
        confirmedWithoutTags: tags.confirmedWithoutTags,
        ...(mode === 'split' && (draft.split?.length ?? 0) >= 2 ? { mode: 'split' as const } : {}),
        ...(extra.confirmWorkload ? { confirmWorkload: true } : {}),
        ...(audio ? { audio } : {}),
      });
      setWorkload(null);
      // один сигнал на всё — и на одну задачу, и на три (§33)
      feedback('task.created', { count: res.taskIds?.length ?? 1 });
      onCreated(String(res.taskId), res.title, String(res.projectId ?? draft.projectId));
    } catch (e) {
      // страж нагрузки (§24): не запрет, а вопрос — «Оставить / Перенести / Другого»
      const w = workloadOf(e);
      if (w) { setWorkload(w); return; }
      setErr(e instanceof ApiError ? e.message : 'Задача не создалась');
    } finally { setBusy(false); }
  };

  /** Правка словами (§23): «сделай короче», «разбей на 3», «поставь Сергея», «срок пятница». */
  const instruct = async () => {
    if (!draft || !wish.trim()) return;
    setBusy(true); setErr('');
    try {
      const r = await api.instructMessageTaskDraft(draft.draftId, wish.trim());
      // попросил переписать словами — теперь главнее то, что переписал ИИ
      edits.current = {};
      take(r); setWish('');
      feedback('ai.completed', { el: document.querySelector('.mtt-drawer') });
      if ((r.draft?.split?.length ?? 0) >= 2) setMode('split');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось поправить'); }
    finally { setBusy(false); }
  };

  const retry = async () => {
    if (!draft) return;
    setBusy(true); setErr('');
    try { const r = await api.retryMessageTaskDraft(draft.draftId); edits.current = {}; take(r); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось повторить'); }
    finally { setBusy(false); }
  };

  /*
    Закрыть окно — не то же самое, что отказаться от задачи.

    Черновик может ждать ответа автора о проекте; человек закрывает окно и идёт
    работать дальше — отменять начатое за него нельзя. Отказ — отдельная кнопка, после
    неё строка под сообщением исчезает.
  */
  const cancel = async () => {
    if (!draft) return onClose();
    setBusy(true);
    try { await api.cancelMessageTaskDraft(draft.draftId); } catch { /* нет сети — закроем окно */ }
    setBusy(false);
    onClose();
  };

  const toggleFile = (fileId: string, include: boolean) => {
    if (!draft) return;
    void patch({ files: draft.files.map((f) => (f.fileId === fileId ? { ...f, include } : f)) });
  };

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer mtt-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="wand" size={16} /> {voice ? 'Задача из голосового' : 'Задача из сообщения'}</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        {/* Исходная фраза перед глазами: правя формулировку, легко уехать от того,
            о чём вообще была речь. */}
        {/* У голосового «исходная фраза» — его расшифровка */}
        {(voice ? voice.transcript : messageText.trim()) && (
          <div className="msg-quote-src">«{(voice ? voice.transcript ?? '' : messageText).slice(0, 400)}»</div>
        )}

        {/* Голосовое расшифровывается (§5): прогресс по шагам, а не пустое окно */}
        {draft?.status === 'transcribing' && (
          <ol className="mtt-steps" aria-label="Готовность">
            <li className="now"><Icon name="refresh" size={13} /> Расшифровка голосового</li>
            <li><Icon name="clock" size={13} /> Формируем задачу</li>
          </ol>
        )}
        {/* Разбор ещё идёт или оборвался (выкладка посреди запроса к модели): не пустые поля молча, а понятное состояние */}
        {draft?.status === 'analyzing' && (
          <div className="task-draft-ask">
            <Icon name="refresh" size={14} />
            <div><b>ИИ ещё разбирает сообщение</b>
              <div className="dim">Обычно это несколько секунд. Если поля так и не заполнились — повторите или заполните задачу вручную.</div>
            </div>
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void retry()} disabled={busy}>Повторить</button>
          </div>
        )}
        {draft?.status === 'failed' && voice?.error === 'no_stt' && (
          <div className="task-draft-ask">
            <Icon name="mic" size={14} />
            <div>
              <b>Голосовые расшифровывает ИИ компании</b>
              <div className="dim">Подключите ключ ИИ в настройках — и любое голосовое станет задачей одним нажатием. Пока можно заполнить задачу вручную.</div>
            </div>
          </div>
        )}
        {draft?.status === 'failed' && voice?.error !== 'no_stt' && (
          <div className="task-draft-ask">
            <Icon name="alert" size={14} />
            <div><b>{voice ? 'Не удалось расшифровать голосовое' : 'Не получилось разобрать сообщение'}</b>
              <div className="dim">Голос цел — можно повторить или заполнить задачу вручную.</div>
            </div>
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void retry()} disabled={busy}>Повторить</button>
          </div>
        )}

        {/* По этому сообщению задача уже была: молча заводить вторую нельзя. */}
        {already && (
          <div className="dim msg-quote-file">
            <Icon name="alert" size={12} /> По этому сообщению уже создана задача #{already} — эта будет второй.
          </div>
        )}

        {loading && <div className="dim">ИИ раскладывает фразу на постановку и шаги…</div>}

        {!loading && draft && (
          <>
            {/*
              Проект не определился — это и есть тот случай, ради которого черновик
              живёт на сервере: бот спрашивает автора в чате, а окно ждёт ответа.
            */}
            {draft.status === 'needs_clarification' && (
              <div className="task-draft-ask">
                <Icon name="alert" size={14} />
                <div>
                  <b>Не понял, к какому проекту это относится.</b>
                  <div className="dim">
                    {asked
                      ? 'Спросил автора в чате — как ответит, черновик дозаполнится сам. Можно и выбрать проект руками.'
                      : 'Выберите проект ниже или попросите автора уточнить — вопрос уйдёт в тот же чат.'}
                  </div>
                </div>
                {!asked && (
                  <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void ask()} disabled={busy}>
                    <Icon name="chat" size={13} /> Спросить автора
                  </button>
                )}
              </div>
            )}

            <div className="field">
              <label>Название</label>
              <input
                className="input"
                value={draft.title}
                onChange={(e) => edit({ title: e.target.value })}
                onBlur={(e) => void patch({ title: e.target.value })}
                maxLength={255}
              />
            </div>
            <div className="field">
              <label>Описание</label>
              <textarea
                className="input"
                rows={3}
                value={draft.description}
                onChange={(e) => edit({ description: e.target.value })}
                onBlur={(e) => void patch({ description: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="mtt-project">Проект <span aria-hidden="true">*</span></label>
              <ProjectHint draft={draft} />
              {/* вероятные — в один клик (§10, ТЗ-31): когда не выбран или определитель сомневается */}
              {(ctx.suggested?.length ?? 0) > 0 && (
                <div className="mtt-chips" aria-label="Вероятные проекты">
                  {draft.projectId && <span className="dim nl-hint">Или:</span>}
                  {ctx.suggested!.map((id) => {
                    const p = ctx.projects.find((x) => x.id === id);
                    return p ? <button key={id} type="button" className="mtt-chip" onClick={() => void patch({ projectId: id })}>{p.name}</button> : null;
                  })}
                </div>
              )}
              <OptionSelect
                id="mtt-project"
                className="input"
                aria-required="true"
                aria-invalid={!!err && !draft.projectId}
                value={draft.projectId ?? ''}
                onChange={(e) => void patch({ projectId: e.target.value || null })}
              >
                <option value="">— выберите —</option>
                {ctx.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </OptionSelect>
            </div>
            <div className="drawer-row">
              <div className="field" style={{ flex: '1 1 200px', minWidth: 0 }}>
                <label>Исполнитель</label>
                <OptionSelect className="input" value={draft.assigneeId ?? ''} onChange={(e) => void patch({ assigneeId: e.target.value || null })}>
                  <option value="">— не назначен —</option>
                  {ctx.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </OptionSelect>
                {/* Почему предложен именно он — строкой под полем: в подписи длинное
                    объяснение рвало ряд на три строки и сплющивало сам выбор. */}
                {draft.assigneeReason && <span className="dim nl-hint">{draft.assigneeReason}</span>}
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Срок</label>
                <input
                  className="input"
                  type="date"
                  value={draft.deadline ?? ''}
                  onChange={(e) => void patch({ deadline: e.target.value || null })}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Приоритет</label>
                <OptionSelect className="input" value={draft.priority} onChange={(e) => void patch({ priority: e.target.value })}>
                  <option value="low">Низкий</option>
                  <option value="normal">Обычный</option>
                  <option value="high">Высокий</option>
                  <option value="urgent">Срочный</option>
                </OptionSelect>
              </div>
            </div>

            {/*
              Вложения сообщения. Скриншоты и видео отмечены сразу: обычно они и есть
              половина постановки. Файл не копируется — в задаче он тот же самый.
            */}
            {draft.files.length > 0 && (
              <div className="field">
                <label>Вложения сообщения</label>
                {draft.files.map((f) => (
                  <label key={f.fileId} className="notify-row" style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={f.include !== false}
                      onChange={(e) => toggleFile(f.fileId, e.target.checked)}
                    />
                    <span>
                      {f.name ?? 'вложение'}
                      {f.size ? <span className="dim"> · {humanSize(f.size)}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {/* Шаги правятся здесь же: чек-лист, который нельзя поправить до создания,
                приходится переделывать в карточке — то же время, только позже. */}
            <div className="field">
              <label>Шаги</label>
              {draft.checklist.map((step, i) => (
                <div key={i} className="task-step-row">
                  <input
                    className="input"
                    value={step}
                    onChange={(e) => edit({
                      checklist: draft.checklist.map((x, k) => (k === i ? e.target.value : x)),
                    })}
                    onBlur={() => void patch({ checklist: draft.checklist })}
                  />
                  <button
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    onClick={() => void patch({ checklist: draft.checklist.filter((_, k) => k !== i) })}
                    title="Убрать шаг"
                    aria-label="Убрать шаг"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => edit({ checklist: [...draft.checklist, ''] })}>
                <Icon name="plus" size={13} /> Шаг
              </button>
            </div>

            {/* Несколько поручений (§9): разные исполнители и сроки — отдельные задачи */}
            {(draft.split?.length ?? 0) >= 2 && (
              <div className="field mtt-split">
                <label>В сообщении {draft.split!.length} {draft.split!.length < 5 ? 'поручения' : 'поручений'}</label>
                <label className="notify-row"><input type="radio" checked={mode === 'split'} onChange={() => setMode('split')} /> Создать {draft.split!.length} {draft.split!.length < 5 ? 'отдельные задачи' : 'отдельных задач'}</label>
                <label className="notify-row"><input type="radio" checked={mode === 'single'} onChange={() => setMode('single')} /> Создать одну задачу с чек-листом</label>
                {/* #4645: каждую из задач, разложенных ИИ, можно поправить до «Создать» */}
                {mode === 'split' && (
                  <ol className="mtt-split-list">
                    {draft.split!.map((x, i) => {
                      const put = (part: Partial<SplitItem>) => draft.split!.map((y, k) => (k === i ? { ...y, ...part } : y));
                      return (
                        <li key={i} className="mtt-split-item">
                          <input
                            className="input"
                            value={x.title}
                            aria-label={`Название задачи ${i + 1}`}
                            maxLength={255}
                            onChange={(e) => edit({ split: put({ title: e.target.value }) })}
                            onBlur={() => void patch({ split: draft.split })}
                          />
                          <div className="mtt-split-meta">
                            <OptionSelect
                              className="input"
                              aria-label={`Исполнитель задачи ${i + 1}`}
                              value={x.assigneeId ?? ''}
                              onChange={(e) => void patch({ split: put({ assigneeId: e.target.value || null }) })}
                            >
                              <option value="">— не назначен —</option>
                              {ctx.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                            </OptionSelect>
                            <input
                              className="input"
                              type="date"
                              aria-label={`Срок задачи ${i + 1}`}
                              value={x.deadline ?? ''}
                              onChange={(e) => void patch({ split: put({ deadline: e.target.value || null }) })}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            )}

            {/* Правка словами (§23) — QEVO меняет черновик, задачу без «Создать» не заводит */}
            <div className="field mtt-ask">
              <label>Попросить QEVO</label>
              <div className="mtt-ask-row">
                <input
                  className="input" value={wish} onChange={(e) => setWish(e.target.value)} maxLength={500}
                  placeholder="«срок пятница», «поставь Глеба», «разбей на 2», «короче»"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void instruct(); } }}
                  aria-label="Что поменять в черновике"
                />
                <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void instruct()} disabled={busy || !wish.trim()}>Поправить</button>
              </div>
            </div>

            <TaskTagsField
              task={{ title: draft.title, description: draft.description, checklist: draft.checklist }}
              value={tags}
              onChange={setTags}
            />

            {/* #1576: перегруз — рядом с кнопкой «Создать задачу» */}
            {workload && (
              <WorkloadWarning
                info={workload}
                busy={busy}
                onMove={workload.alternativeDate ? () => { void patch({ deadline: workload.alternativeDate }).then(() => create({ confirmWorkload: true })); } : undefined}
                onReassign={(id) => { void patch({ assigneeId: id }).then(() => create()); }}
                onKeep={() => void create({ confirmWorkload: true })}
              />
            )}
            {err && <div className="error-text">{err}</div>}
            <div className="drawer-row">
              <button
                className="ui-btn ui-btn-primary ui-btn-md"
                style={{ flex: 1 }}
                onClick={() => void create()}
                disabled={busy || !tagsReady(tagSettings, tags)}
                title={tagsReady(tagSettings, tags) ? undefined : 'Подтвердите теги задачи'}
              >
                {busy ? 'Создаю…' : mode === 'split' && (draft.split?.length ?? 0) >= 2 ? `Создать ${draft.split!.length} ${draft.split!.length < 5 ? 'задачи' : 'задач'}` : 'Создать задачу'}
              </button>
              {/* Отказ — явным действием: закрытое окно черновик не отменяет, он может ждать ответа. */}
              <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => void cancel()} disabled={busy} title="Не создавать задачу по этому сообщению">
                Отказаться
              </button>
            </div>
          </>
        )}
        {loading && err && <div className="error-text">{err}</div>}
      </aside>
    </div>
  );
}

/**
 * Откуда взят проект (ТЗ-31, #1554): уверенно — подпись «✨ чат этого проекта»;
 * «скорее всего» — просим проверить; названный проект не найден — говорим прямо.
 * Человек выбрал другой — подпись пропадает: она про предложение, а не про выбор.
 */
function ProjectHint({ draft }: { draft: { projectId: string | null; analysis: Record<string, unknown> } }) {
  const r = draft.analysis?.projectResolution as {
    projectId: string | null; level: 'HIGH' | 'MEDIUM' | 'LOW'; hint: string; notFoundName: string | null;
  } | null | undefined;
  if (!r) return null;
  if (r.notFoundName && !draft.projectId) {
    return <span className="dim nl-hint mtt-project-warn">Проект «{r.notFoundName}» не найден среди доступных — выберите существующий.</span>;
  }
  if (!r.projectId || String(r.projectId) !== String(draft.projectId ?? '')) return null;
  return r.level === 'HIGH'
    ? <span className="dim nl-hint"><Icon name="sparkles" size={11} /> Определено: {r.hint}</span>
    : <span className="nl-hint mtt-project-warn"><Icon name="sparkles" size={11} /> Скорее всего, этот — {r.hint}. Проверьте проект.</span>;
}
