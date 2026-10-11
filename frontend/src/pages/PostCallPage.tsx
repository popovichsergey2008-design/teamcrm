import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
import { DraftRow } from './MeetingsPage';

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

  const { meeting, summary, drafts, tasks = [], review } = data;
  const blocks = review?.blocks;
  const ai = review ? review.ai : true;
  const closed = review?.status === 'reviewed' || review?.status === 'completed';
  const canClose = !!review?.canClose;
  const pending = drafts.filter((d: any) => d.status === 'pending');
  const ready = pending.filter((d: any) => d.project_id);
  const minutes = meeting.duration_sec ? Math.max(1, Math.round(Number(meeting.duration_sec) / 60)) : null;
  const people = review?.participants ?? [];
  const blockState = (b: keyof NonNullable<typeof blocks>): PostcallBlockStatus => blocks?.[b] ?? (meeting.status === 'done' ? 'ready' : 'pending');

  const apply = async (d: any, patch: { assigneeId?: string; projectId?: string }) => {
    setErr('');
    try { await api.applyMeetingDraft(d.id, patch); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось создать задачу'); }
  };
  const reject = async (d: any) => { try { await api.rejectMeetingDraft(d.id); await load(); } catch { /* */ } };
  // по одному: упавшая на середине пачка не отменяет созданное; пакет с повтором — на этапе 4
  const applyAll = async () => {
    if (!ready.length) return;
    setBulk(true); setErr('');
    let failed = 0;
    for (const d of ready) { try { await api.applyMeetingDraft(d.id, {}); } catch { failed++; } }
    setBulk(false);
    setErr(failed ? `Создано ${ready.length - failed} из ${ready.length}. Остальные остались черновиками — можно повторить.` : '');
    await load();
  };

  const later = async () => {
    try { await api.postcallSnooze(meetingId); } catch { /* итоги и так сохранены */ }
    toastSaved('Итоги сохранены — вернуться к ним можно из раздела «Встречи»');
    navigate({ section: 'chat', view: 'meetings' }, { replace: true });
  };
  const complete = async () => {
    setClosing(true);
    try {
      await api.postcallComplete(meetingId);
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

        {ai && processing && <Steps items={steps} />}

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
            <Block title="Кратко" state={blockState('summary')}>
              {summary?.summary
                ? <p className="pc-text pc-summary">{summary.summary}</p>
                : <p className="pc-text dim">Итогов нет.</p>}
              <button className="link-btn pc-more" onClick={() => navigate({ section: 'chat', view: 'meetings', meetingId })}>
                Подробнее: стенограмма и запись
              </button>
            </Block>

            <Block title={`Решения${summary?.decisions?.length ? ` — ${summary.decisions.length}` : ''}`} state={blockState('decisions')}>
              {summary?.decisions?.length
                ? <ul className="pc-list pc-decisions">{summary.decisions.map((d: string, i: number) => <li key={i}><Icon name="check" size={14} /> {d}</li>)}</ul>
                : <p className="pc-text dim">Решений не прозвучало.</p>}
            </Block>

            <Block title={`Черновики задач${pending.length ? ` — ${pending.length}` : ''}`} state={blockState('tasks')}>
              {pending.length > 0 && (
                <p className="pc-text dim">ИИ услышал поручения так. Поправьте название, исполнителя и проект — задачи появятся только после «Создать».</p>
              )}
              {err && <div className="error-text pc-err">{err}</div>}
              {pending.map((d: any) => (
                <DraftRow key={d.id} draft={d} projects={projects} users={users} onApply={apply} onReject={reject} onSaved={() => void load()} />
              ))}
              {pending.length > 1 && (
                <div className="pc-actions">
                  <Button variant="primary" size="sm" onClick={applyAll} loading={bulk} disabled={bulk || ready.length === 0}>
                    Создать все ({ready.length})
                  </Button>
                  {ready.length < pending.length && <span className="dim pc-note">{pending.length - ready.length} без проекта — их пропущу</span>}
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
                    </div>
                  ))}
                </div>
              )}
              {!pending.length && !tasks.length && <p className="pc-text dim">Поручений не прозвучало.</p>}
            </Block>

            {summary?.risks?.length > 0 && (
              <Block title={`Риски и открытые вопросы — ${summary.risks.length}`} state="ready">
                <ul className="pc-list">{summary.risks.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
              </Block>
            )}
          </>
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

function Block({ title, state, children }: { title: string; state: PostcallBlockStatus; children: ReactNode }) {
  return (
    <section className="pc-block" aria-busy={state === 'running' || state === 'pending'}>
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
