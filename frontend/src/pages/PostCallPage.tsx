import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import './postcall.css';
import { Icon, type IconName } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { Button } from '../components/ui/button';
import { confirmAction } from '../components/ui/dialog';
import { api, ApiError, PostcallBlockStatus, PostcallView } from '../lib/api';
import { useAuth } from '../state/auth';
import { navigate } from '../lib/router';
import { getSocket } from '../lib/socket';
import { toastSaved } from '../lib/notifications';
import type { Project, User } from '../types';
import { DraftRow, type DraftChoice } from '../components/meetings/DraftRow';
import { feedback } from '../lib/feedback';
// клиентский протокол для гостей встречи (ТЗ-28) — своим куском, только где есть гости
const GuestSummaryPanel = lazy(() => import('../components/meetings/GuestSummaryPanel'));

/** Сколько ждать, пока допишется запись и появится встреча: дольше — записи не было. */
const ROOM_WAIT_MS = 30_000;

/**
 * Итоги встречи после звонка (ТЗ-22).
 *
 * Звонок закончен не тогда, когда отключился звук, а когда договорённости стали
 * действиями. Экран открывается сразу после «Завершить» — встречи в этот момент ещё
 * нет, запись дописывается, — и показывает итоги по мере готовности: один бесконечный
 * спиннер человек закрывает, честный прогресс по шагам — ждёт.
 */
export function PostCallPage({ meetingId, roomId }: { meetingId?: string; roomId?: string }) {
  if (meetingId) return <PostCall meetingId={meetingId} />;
  if (roomId) return <WaitForMeeting roomId={roomId} />;
  return null;
}

/** Встречи ещё нет: спрашиваем по комнате, пока запись не допишется. */
function WaitForMeeting({ roomId }: { roomId: string }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      if (stop) return;
      const r = await api.postcallByRoom(roomId).catch(() => ({ meetingId: null }));
      if (stop) return;
      if (r.meetingId) { navigate({ section: 'chat', view: 'postcall', meetingId: r.meetingId }, { replace: true }); return; }
      if (Date.now() - started > ROOM_WAIT_MS) { setGone(true); return; }
      window.setTimeout(tick, 1000);
    };
    void tick();
    return () => { stop = true; };
  }, [roomId]);

  return (
    <div className="pc-page">
      <div className="pc-shell">
        <header className="pc-head">
          <div>
            <div className="pc-kicker">Встреча завершена</div>
            <h1 className="pc-title">{gone ? 'Итогов нет' : 'Сохраняю запись…'}</h1>
          </div>
        </header>
        {gone ? (
          <section className="pc-block">
            <p>Запись созвона не сохранилась — разбирать нечего. Если ИИ на созвоне был включён, проверьте раздел «Встречи» чуть позже.</p>
            <div className="pc-actions">
              <Button variant="outline" onClick={() => navigate({ section: 'chat', view: 'meetings' }, { replace: true })}>К встречам</Button>
            </div>
          </section>
        ) : (
          <Steps items={[{ label: 'Сохраняю запись', state: 'running' }]} />
        )}
      </div>
    </div>
  );
}

function PostCall({ meetingId }: { meetingId: string }) {
  const { user } = useAuth();
  const [data, setData] = useState<PostcallView | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [err, setErr] = useState('');
  const [bulk, setBulk] = useState(false);
  const [closing, setClosing] = useState(false);
  // выбор для «Создать выбранные»: по умолчанию — уверенные и готовые черновики (§14–15)
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  // выбранное в строках, но не сохранённое — пакет создаёт задачи уже с ним
  const [choices, setChoices] = useState<Record<string, DraftChoice>>({});
  const [focused, setFocused] = useState<Record<string, boolean>>({});
  const [followupSent, setFollowupSent] = useState(false);
  const [recapBusy, setRecapBusy] = useState(false);
  const [newsDone, setNewsDone] = useState(false);
  // задачи «уехали» на доску после «Подтвердить всё» — проект, куда вести (§15)
  const [launched, setLaunched] = useState<string | null>(null);

  const load = useCallback(() => api.postcall(meetingId)
    .then((d) => { setData(d); setLoadErr(''); })
    .catch((e) => setLoadErr(e instanceof ApiError ? e.message : 'Не удалось загрузить итоги')), [meetingId]);

  useEffect(() => {
    void load();
    api.listProjects().then(setProjects).catch(() => undefined);
    api.listUsers().then(setUsers).catch(() => undefined);
  }, [load]);

  // блоки приходят по готовности; опрос — подстраховка, если событие потерялось
  const processing = data?.review?.status === 'processing';
  /*
    Итоги собрались, пока человек смотрел на экран, — главный «вау»-момент (ТЗ-23, §11):
    мягкий сигнал и короткая вспышка рамки у «Кратко». Один раз, и только при переходе
    из «обрабатывается»: открыв уже готовые итоги, человек ничего не ждал.
  */
  const wasProcessing = useRef(false);
  const summaryRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (processing) { wasProcessing.current = true; return; }
    if (wasProcessing.current && data?.review?.status === 'review_required') {
      wasProcessing.current = false;
      if (data.review.ai) feedback('postcall.ready', { el: summaryRef.current });
    }
  }, [processing, data?.review?.status, data?.review?.ai]);
  useEffect(() => {
    const socket = getSocket();
    const on = (p: { meetingId: string }) => { if (String(p.meetingId) === String(meetingId)) void load(); };
    socket.on('meeting.postcall', on);
    const timer = processing ? window.setInterval(() => void load(), 5000) : null;
    return () => { socket.off('meeting.postcall', on); if (timer) window.clearInterval(timer); };
  }, [meetingId, load, processing]);

  if (loadErr) {
    return (
      <div className="pc-page"><div className="pc-shell">
        <section className="pc-block"><p className="error-text">{loadErr}</p>
          <Button variant="outline" onClick={() => navigate({ section: 'chat', view: 'meetings' })}>К встречам</Button>
        </section>
      </div></div>
    );
  }
  if (!data) return <div className="pc-page"><div className="pc-shell"><SkeletonList rows={4} /></div></div>;

  const { meeting, summary, drafts, tasks = [], review, decisions = [], followup = null } = data;
  // ТЗ-25: фрагмент записи у черновика, запись для предпросмотра, уже существующие задачи
  const proofs = data.proofs ?? {};
  const dups = data.duplicates ?? {};
  const recordingUrl = data.recording?.url ?? null;
  const questions = summary?.questions ?? [];
  const blocks = review?.blocks;
  const ai = review ? review.ai : true;
  const closed = review?.status === 'reviewed' || review?.status === 'completed';
  const canClose = !!review?.canClose;
  // упавший при создании черновик тоже ждёт решения — с причиной и «Повторить»
  const pending = drafts.filter((d: any) => d.status === 'pending' || d.status === 'failed');
  const projectOf = (d: any) => choices[d.id]?.projectId ?? d.project_id;
  const isPicked = (d: any) => picked[d.id] ?? (!!d.project_id && !!d.assignee_id && Number(d.confidence ?? 0.9) >= 0.6 && d.status !== 'failed' && !dups[d.id]);
  // «Подтвердить всё» (ТЗ-25, §12): готово то, у чего есть проект и исполнитель и что не дубль
  const assigneeOf = (d: any) => choices[d.id]?.assigneeId ?? d.assignee_id;
  const readyAll = pending.filter((d: any) => projectOf(d) && assigneeOf(d) && !dups[d.id]);
  const selected = pending.filter((d: any) => isPicked(d) && projectOf(d));
  const noProject = pending.filter((d: any) => isPicked(d) && !projectOf(d)).length;
  const failedNow = pending.filter((d: any) => d.status === 'failed');
  const minutes = meeting.duration_sec ? Math.max(1, Math.round(Number(meeting.duration_sec) / 60)) : null;
  const people = review?.participants ?? [];
  const blockState = (b: keyof NonNullable<typeof blocks>): PostcallBlockStatus => blocks?.[b] ?? (meeting.status === 'done' ? 'ready' : 'pending');

  /**
   * Фрагмент откроется тем, кто встречу не видит, или в нём говорит гость, — спросить
   * (§28, §41). Молча доступ не расширяем: «нет» — задачи создаются без аудио.
   */
  const askAudio = async (list: any[]): Promise<Record<string, 'allow' | 'none'>> => {
    const need = list.filter((d) => proofs[d.id]?.consent);
    if (!need.length) return {};
    const users = [...new Set(need.flatMap((d) => proofs[d.id]!.consent!.users))];
    const guest = need.some((d) => proofs[d.id]!.consent!.guest);
    const ok = await confirmAction({
      title: 'Поделиться фрагментами записи?',
      description: [
        users.length ? `${users.slice(0, 4).join(', ')}${users.length > 4 ? ' и другие' : ''} не видят эту встречу.` : '',
        guest ? 'Во фрагменте говорит гость встречи.' : '',
        'QEVO покажет только короткие фрагменты, относящиеся к задачам, — не всю встречу.',
      ].filter(Boolean).join(' '),
      confirmLabel: 'Разрешить фрагменты', cancelLabel: 'Создать без аудио',
    });
    return Object.fromEntries(need.map((d) => [d.id, ok ? 'allow' : 'none']));
  };

  const apply = async (d: any, patch: DraftChoice) => {
    setErr('');
    try {
      const audio = (await askAudio([d]))[d.id];
      await api.applyMeetingDraft(d.id, { ...patch, ...(audio ? { audio } : {}) });
      await load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось создать задачу'); }
  };
  const reject = async (d: any) => {
    try { await api.rejectMeetingDraft(d.id); await load(); }
    catch (e) {
      // черновика уже нет — встречу разобрали заново: свежий список вместо молчания
      await load();
      setErr(e instanceof ApiError && e.code === 'NOT_FOUND'
        ? 'Список задач обновился — встречу разобрали заново.'
        : e instanceof ApiError ? e.message : 'Не удалось отклонить');
    }
  };
  /**
   * «Создать выбранные задачи» одним пакетом (§15–17). Упавшая не отменяет остальные
   * и остаётся черновиком с причиной; повтор создаёт только её.
   */
  const createSelected = async (list: any[], confirmAll = false) => {
    if (!list.length) return;
    const audio = await askAudio(list);
    setBulk(true); setErr('');
    try {
      const r = await api.postcallCreateBatch(
        meetingId,
        list.map((d) => ({ draftId: String(d.id), ...clean(choices[d.id]), ...(audio[d.id] ? { audio: audio[d.id] } : {}) })),
        confirmAll,
      );
      if (r.created.length) {
        // «Подтвердить всё» — один мягкий сигнал, касание и вспышка ИИ, а не звук на каждую задачу (§16)
        if (confirmAll) { feedback('ai.completed', { el: document.querySelector('.pc-magic') }); setLaunched(projectOf(list[0]) ? String(projectOf(list[0])) : ''); }
        else feedback('task.created', { count: r.created.length });
      }
      if (r.failed.length) { feedback('warning'); setErr(`Создано ${r.created.length}, не удалось — ${r.failed.length}. Причина — у черновика, его можно поправить и повторить.`); }
      else if (r.created.length) toastSaved(`Готово. Создано задач: ${r.created.length}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать задачи');
    } finally {
      setBulk(false);
      await load();
    }
  };
  // «В мой Фокус» — срочное или на сегодня из того, что поручили мне (§22)
  const toFocus = async (taskId: string) => {
    try {
      await api.setFocusDate(taskId, new Date().toLocaleDateString('sv-SE'));
      setFocused((f) => ({ ...f, [taskId]: true }));
      toastSaved('Добавлено в Фокус дня');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось добавить в Фокус'); }
  };
  const recap = async () => {
    setRecapBusy(true);
    try {
      const r = await api.postcallRecap(meetingId);
      toastSaved(`Итоги отправлены участникам: ${r.sent}`);
      await load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось отправить итоги'); }
    finally { setRecapBusy(false); }
  };
  const toNews = async () => {
    try {
      const r = await api.postcallNews(meetingId);
      setNewsDone(true);
      toastSaved(r.already ? 'Кандидат в «Новости» уже есть' : 'Пост предложен в «Новости» — руководитель опубликует его там');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подготовить пост'); }
  };
  const staffOthers = (review?.participants ?? []).filter((p) => p.userId && String(p.userId) !== String(user?.id ?? '')).length;
  const today = new Date().toLocaleDateString('sv-SE');
  const focusable = (t: any) => !t.closed && String(t.assignee_id ?? '') === String(user?.id ?? '')
    && (t.priority === 'urgent' || (t.deadline_at && new Date(t.deadline_at).toLocaleDateString('sv-SE') <= today))
    && t.focus_date !== today && !focused[t.task_id];

  const later = async () => {
    try { await api.postcallSnooze(meetingId); } catch { /* итоги и так сохранены */ }
    toastSaved('Итоги сохранены — вернуться к ним можно из раздела «Встречи»');
    navigate({ section: 'chat', view: 'meetings' }, { replace: true });
  };
  const complete = async () => {
    setClosing(true);
    try {
      await api.postcallComplete(meetingId, followupSent || followup?.status === 'executed');
      toastSaved(tasks.length ? `Разбор завершён. Задач по встрече: ${tasks.length}` : 'Разбор завершён');
      navigate({ section: 'chat', view: 'meetings', meetingId }, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось завершить разбор');
    } finally { setClosing(false); }
  };
  // уйти, не разобрав, можно — но не по ошибке: итоги останутся в «Встречах»
  const leave = async () => {
    if (canClose && !closed && pending.length > 0) {
      const ok = await confirmAction({
        title: 'Итоги встречи ещё не разобраны',
        description: `Черновиков задач: ${pending.length}. Итоги сохранятся — вернуться к ним можно из раздела «Встречи».`,
        confirmLabel: 'Разобрать позже', cancelLabel: 'Остаться',
      });
      if (!ok) return;
      await later();
      return;
    }
    navigate({ section: 'chat', view: 'meetings', meetingId }, { replace: true });
  };

  const steps = [
    { label: 'Запись сохранена', state: 'ready' as PostcallBlockStatus },
    { label: 'Расшифровка', state: blockState('transcript') },
    { label: 'Кратко', state: blockState('summary') },
    { label: 'Решения', state: blockState('decisions') },
    { label: 'Задачи', state: blockState('tasks') },
  ];
  const transcriptFailed = blockState('transcript') === 'failed';

  return (
    <div className="pc-page">
      <div className="pc-shell">
        <header className="pc-head">
          <div className="pc-head-main">
            <div className="pc-kicker">
              Встреча завершена{minutes ? ` · ${minutes} мин` : ''}
              {closed && <span className="pc-done"><Icon name="check" size={12} /> разобрано</span>}
            </div>
            <h1 className="pc-title">{meeting.title || 'Встреча'}</h1>
            <div className="pc-sub">
              {!ai ? 'Запись сохранена. Итогов ИИ нет — распознавание речи не подключено.'
                : processing ? 'QEVO Bot готовит итоги — блоки появятся по мере готовности'
                  : 'QEVO Bot подготовил итоги'}
            </div>
            {people.length > 0 && (
              <div className="pc-people">
                {people.map((p, i) => <span key={`${p.userId}${i}`} className={`pc-person${p.guest ? ' pc-guest' : ''}`}>{p.name}</span>)}
              </div>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={() => void leave()} aria-label="Закрыть итоги" title="Закрыть">
            <Icon name="close" size={18} />
          </Button>
        </header>

        {ai && processing && <div className="ai-working pc-steps-wrap"><Steps items={steps} /></div>}

        {!ai && (
          <section className="pc-block">
            <h2 className="pc-block-title">Что дальше</h2>
            <p className="pc-text">
              С подключённым ИИ здесь сами появятся краткие итоги, решения и черновики задач с исполнителями и сроками.
              {user?.role === 'owner' ? ' Подключить можно в настройках, во вкладке «Интеграции».' : ' Подключает владелец компании в настройках.'}
            </p>
            <div className="pc-actions">
              <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('teamcrm:quick-task', { detail: { text: '' } }))}>
                <Icon name="plus" size={15} /> Поставить задачу
              </Button>
              {user?.role === 'owner' && (
                <Button variant="outline" onClick={() => navigate({ section: 'settings', tab: 'integrations' })}>Подключить ИИ</Button>
              )}
            </div>
          </section>
        )}

        {ai && transcriptFailed && (
          <section className="pc-block pc-fail">
            <h2 className="pc-block-title">Не удалось завершить расшифровку</h2>
            {meeting.error && <p className="pc-text dim">{meeting.error}</p>}
            <div className="pc-actions">
              <Button variant="outline" onClick={async () => { await api.retryMeeting(meetingId).catch(() => undefined); await load(); }}>Повторить</Button>
              {meeting.file_id && (
                <Button variant="ghost" onClick={() => navigate({ section: 'chat', view: 'meetings', meetingId })}>Открыть запись</Button>
              )}
            </div>
          </section>
        )}

        {ai && !transcriptFailed && (
          <>
            <Block title="Кратко" state={blockState('summary')} innerRef={summaryRef}>
              {summary?.summary
                ? <p className="pc-text pc-summary">{summary.summary}</p>
                : <p className="pc-text dim">Итогов нет.</p>}
              <button className="link-btn pc-more" onClick={() => navigate({ section: 'chat', view: 'meetings', meetingId })}>
                Подробнее: стенограмма и запись
              </button>
              {/* 13.10: разбор сорвался или вышел пустым — заново по готовой стенограмме */}
              {(meeting.status === 'done' || meeting.status === 'error') && (
                <button className="link-btn pc-more" onClick={async () => {
                  if (!(await confirmAction({
                    title: 'Разобрать встречу заново?',
                    description: 'ИИ заново соберёт итоги, решения и задачи по стенограмме. Уже созданные задачи останутся и повторно не предложатся.',
                    confirmLabel: 'Разобрать',
                  }))) return;
                  await api.reanalyzeMeeting(meetingId).catch(() => undefined);
                  await load();
                }}>
                  Разобрать заново
                </button>
              )}
            </Block>

            <Block title={`Решения${decisions.length ? ` — ${decisions.length}` : ''}`} state={blockState('decisions')}>
              {decisions.length
                ? (
                  <ul className="pc-list pc-decisions">
                    {decisions.map((d) => (
                      <li key={d.id}>
                        <Icon name="check" size={14} />
                        <span>
                          {d.text}
                          {d.superseded_by && <span className="dim"> · решение изменили позже</span>}
                          <Source meetingId={meetingId} sec={d.source_sec} speaker={d.speaker} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )
                : <p className="pc-text dim">Решений не прозвучало.</p>}
            </Block>

            {questions.length > 0 && (
              <Block title={`Открытые вопросы — ${questions.length}`} state={blockState('decisions')}>
                <ul className="pc-list pc-questions">
                  {questions.map((q, i) => (
                    <li key={i}>
                      <span>
                        {q.text}
                        <Source meetingId={meetingId} sec={q.sec} speaker={q.speaker} />
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => window.dispatchEvent(new CustomEvent('teamcrm:quick-task', { detail: { text: q.text } }))}>
                        <Icon name="plus" size={14} /> Задача
                      </Button>
                    </li>
                  ))}
                </ul>
              </Block>
            )}

            {blockState('tasks') === 'ready' && (pending.length > 0 || launched !== null) && (
              <section className="pc-block pc-magic">
                {launched !== null && !pending.length ? (
                  <>
                    <h2 className="pc-magic-title"><Icon name="check" size={18} /> Задачи на доске</h2>
                    <p className="pc-text">У каждой задачи со встречи есть фрагмент записи — исполнитель услышит, как поручение прозвучало.</p>
                    {launched && (
                      <div className="pc-actions">
                        <Button variant="primary" onClick={() => navigate({ section: 'projects', projectId: launched })}>Открыть доску</Button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <h2 className="pc-magic-title">
                      <Icon name="sparkles" size={18} /> QEVO Bot услышал {pending.length} {agreements(pending.length)}
                    </h2>
                    <p className="pc-text">Я подготовил задачи, исполнителей и сроки. Проверьте их и запустите работу одним нажатием.</p>
                    {readyAll.length < pending.length && (
                      <p className="pc-text dim">{readyAll.length} готовы к созданию · {pending.length - readyAll.length} требуют уточнения</p>
                    )}
                    <div className="pc-actions">
                      <Button variant="primary" size="lg" loading={bulk} disabled={bulk || !readyAll.length} onClick={() => void createSelected(readyAll, true)}>
                        {readyAll.length === pending.length ? 'Подтвердить всё' : `Создать ${readyAll.length} готовые`}
                      </Button>
                      <Button variant="ghost" onClick={() => document.querySelector('.pc-drafts')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                        Проверить по одной
                      </Button>
                    </div>
                  </>
                )}
              </section>
            )}

            <Block title={`Черновики задач${pending.length ? ` — ${pending.length}` : ''}`} state={blockState('tasks')} className="pc-drafts">
              {pending.length > 0 && (
                <p className="pc-text dim">ИИ услышал поручения так. Поправьте название, исполнителя и проект — задачи появятся только после «Создать».</p>
              )}
              {err && <div className="error-text pc-err">{err}</div>}
              {pending.map((d: any) => (
                <DraftRow
                  key={d.id} draft={d} projects={projects} users={users} onApply={apply} onReject={reject} onSaved={() => void load()}
                  selected={isPicked(d)} onSelect={(on) => setPicked((p) => ({ ...p, [d.id]: on }))}
                  proof={proofs[d.id]} recordingUrl={recordingUrl} duplicate={dups[d.id]}
                  onChoice={(c) => setChoices((m) => ({ ...m, [d.id]: c }))}
                />
              ))}
              {pending.length > 0 && (
                <div className="pc-actions">
                  <Button variant="primary" size="sm" onClick={() => void createSelected(selected)} loading={bulk} disabled={bulk || selected.length === 0}>
                    Создать выбранные ({selected.length})
                  </Button>
                  {failedNow.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => void createSelected(failedNow.filter(projectOf))} disabled={bulk}>
                      Повторить ошибочные ({failedNow.length})
                    </Button>
                  )}
                  {noProject > 0 && <span className="dim pc-note">{noProject} без проекта — выберите проект, иначе пропущу</span>}
                </div>
              )}
              {tasks.length > 0 && (
                <div className="pc-created">
                  <div className="pc-created-title">Создано по итогам — {tasks.length}</div>
                  {tasks.map((t: any) => (
                    <div key={t.draft_id} className="pc-created-row">
                      <Icon name="check" size={14} />
                      {t.title
                        ? <button className="link-btn" onClick={() => navigate({ section: 'projects', projectId: t.project_id, taskId: t.task_id })}>{t.title}</button>
                        : <span className="dim">Задача удалена</span>}
                      {t.assignee_name && <span className="dim"> · {t.assignee_name}</span>}
                      {focusable(t) && (
                        <Button variant="ghost" size="sm" onClick={() => void toFocus(t.task_id)}>
                          <Icon name="target" size={13} /> В мой Фокус
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!pending.length && !tasks.length && <p className="pc-text dim">Поручений не прозвучало.</p>}
            </Block>

            {(followup || blockState('followup') === 'running') && (
              <Block title="Письмо клиенту" state={followup ? 'ready' : blockState('followup')}>
                {followup && (
                  <Followup card={followup} onSent={() => { setFollowupSent(true); void load(); }} />
                )}
              </Block>
            )}

            {(summary?.risks?.length ?? 0) > 0 && (
              <Block title={`Риски — ${summary!.risks.length}`} state="ready">
                <ul className="pc-list">{summary!.risks.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
              </Block>
            )}
          </>
        )}

        {!processing && <Suspense fallback={null}><GuestSummaryPanel meetingId={meetingId} /></Suspense>}

        {ai && canClose && ((staffOthers > 0 && blockState('summary') === 'ready') || review?.newsWorthy) && (
          <div className="pc-actions pc-recap">
            {review?.newsWorthy && (
              newsDone
                ? <span className="dim pc-note"><Icon name="check" size={12} /> Пост предложен в «Новости»</span>
                : <Button variant="outline" size="sm" onClick={() => void toNews()}><Icon name="megaphone" size={14} /> Подготовить пост в Новости</Button>
            )}
            {staffOthers > 0 && blockState('summary') === 'ready' && (review?.recapSentAt
              ? <span className="dim pc-note"><Icon name="check" size={12} /> Итоги отправлены участникам</span>
              : (
                <Button variant="outline" size="sm" onClick={() => void recap()} loading={recapBusy}>
                  <Icon name="send" size={14} /> Отправить итоги участникам ({staffOthers})
                </Button>
              ))}
          </div>
        )}

        <footer className="pc-foot">
          {canClose && !closed ? (
            <>
              <Button variant="ghost" onClick={() => void later()}>Разобрать позже</Button>
              <Button variant="primary" onClick={() => void complete()} loading={closing}>Завершить разбор</Button>
            </>
          ) : (
            <>
              {!canClose && !closed && <span className="dim pc-note">Разбор закрывает организатор встречи</span>}
              <Button variant="outline" onClick={() => navigate({ section: 'chat', view: 'meetings', meetingId }, { replace: true })}>Готово</Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

/**
 * Письмо клиенту (§20, §57): черновик готовит секретарь, человек правит и отправляет.
 * Наружу — только «предпросмотр → подтверждение → отправка»: молча письмо не уходит.
 */
function Followup({ card, onSent }: { card: NonNullable<PostcallView['followup']>; onSent: () => void }) {
  const [body, setBody] = useState(card.payload.body ?? '');
  const [subject, setSubject] = useState(card.payload.subject ?? '');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const done = card.status === 'executed';
  const hasMail = card.actions.some((a) => a.key === 'send_mail');

  const act = async (key: string, label: string) => {
    setErr('');
    if (key === 'copy') {
      try { await navigator.clipboard.writeText(body); } catch { /* не дали доступа к буферу — текст всё равно виден */ }
    } else {
      const where = key === 'send_chat' ? 'во внешний чат клиента' : `письмом на ${card.payload.email ?? 'почту клиента'}`;
      const ok = await confirmAction({
        title: 'Отправить итоги клиенту?',
        description: `Текст уйдёт ${where} от вашего имени — так, как он сейчас в поле.`,
        confirmLabel: label,
      });
      if (!ok) return;
    }
    setBusy(key);
    try {
      const r = await api.proposalAct(card.id, key, { body, subject });
      feedback('action.confirmed');
      toastSaved(r.text);
      onSent();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось отправить');
    } finally { setBusy(''); }
  };

  if (done) return <p className="pc-text"><Icon name="check" size={14} /> {card.result_text || 'Итоги клиенту отправлены'}</p>;
  return (
    <div className="pc-followup">
      {hasMail && (
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Тема письма" placeholder="Тема письма" />
      )}
      <textarea className="input" rows={8} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Текст письма клиенту" />
      {err && <div className="error-text pc-err">{err}</div>}
      <div className="pc-actions">
        {card.actions.map((a) => (
          <Button key={a.key} size="sm" variant={a.primary ? 'primary' : 'outline'} loading={busy === a.key} disabled={!!busy || !body.trim()}
                  onClick={() => void act(a.key, a.label)}>
            {a.key === 'copy' && <Icon name="copy" size={14} />} {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** «договорённость / договорённости / договорённостей» */
function agreements(n: number): string {
  const d = n % 10; const h = n % 100;
  if (d === 1 && h !== 11) return 'договорённость';
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'договорённости';
  return 'договорённостей';
}

/** Только то, что человек поменял в строке: пустой выбор — значит, как услышал ИИ. */
function clean(c: DraftChoice | undefined): DraftChoice {
  const out: DraftChoice = {};
  if (c?.assigneeId !== undefined) out.assigneeId = c.assigneeId;
  if (c?.projectId !== undefined) out.projectId = c.projectId;
  if (c?.deadlineAt !== undefined) out.deadlineAt = c.deadlineAt;
  return out;
}

/** «Источник: 18:42 · Борис» — переход к этому моменту записи (§10). */
function Source({ meetingId, sec, speaker }: { meetingId: string; sec: number | string | null | undefined; speaker?: string | null }) {
  const at = sec == null ? null : Math.round(Number(sec));
  if (at == null && !speaker) return null;
  return (
    <span className="pc-source">
      {speaker && <span>{speaker}</span>}
      {at != null && (
        <button className="link-btn" onClick={() => navigate(`/meetings/${encodeURIComponent(meetingId)}?t=${at}`)} title="Открыть этот момент записи">
          <Icon name="play" size={11} /> {stamp(at)}
        </button>
      )}
    </span>
  );
}

const stamp = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

function Block({ title, state, children, innerRef, className = '' }: {
  title: string; state: PostcallBlockStatus; children: ReactNode; innerRef?: React.Ref<HTMLElement>; className?: string;
}) {
  return (
    <section ref={innerRef} className={`pc-block ${className}`.trim()} aria-busy={state === 'running' || state === 'pending'}>
      <h2 className="pc-block-title">{title}</h2>
      {state === 'pending' || state === 'running'
        ? <SkeletonList rows={2} />
        : state === 'failed'
          ? <p className="pc-text dim">Этот блок не получился — остальное готово.</p>
          : children}
    </section>
  );
}

const STEP_ICON: Record<PostcallBlockStatus, IconName> = { ready: 'check', failed: 'close', skipped: 'minus', running: 'refresh', pending: 'clock' };

/** Прогресс по шагам вместо одного спиннера (§6). */
function Steps({ items }: { items: { label: string; state: PostcallBlockStatus }[] }) {
  return (
    <ol className="pc-steps" aria-label="Готовность итогов">
      {items.map((s) => (
        <li key={s.label} className={`pc-step pc-step-${s.state}`}>
          <Icon name={STEP_ICON[s.state]} size={14} /> {s.label}
        </li>
      ))}
    </ol>
  );
}
