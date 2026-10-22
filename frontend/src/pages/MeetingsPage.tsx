import { useCallback, useEffect, useRef, useState } from 'react';
import './meetings.css';
import { fetchBlob } from '../components/AuthedMedia';
import { EmptyState } from '../components/EmptyState';
import { CareEmpty } from '../components/care/CareEmpty';
import { GuestMeetsPanel } from '../components/GuestMeetsPanel';
import { Icon } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { feedback } from '../lib/feedback';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import type { Project, User } from '../types';
import { DraftRow, type DraftChoice } from '../components/meetings/DraftRow';
import { PostcallQuality } from '../components/meetings/PostcallQuality';
import { useAuth } from '../state/auth';
import { OptionSelect } from '../components/ui/option-select';
import { confirmAction } from '../components/ui/dialog';

const STATUS_LABEL: Record<string, string> = {
  queued: 'В очереди',
  transcribing: 'Расшифровываю…',
  analyzing: 'Разбираю…',
  done: 'Готово',
  // ТЗ-22: распознавания речи нет — запись сохранена, итогов ИИ нет
  recorded: 'Запись без ИИ',
  error: 'Ошибка',
};

const stamp = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/**
 * Встречи: загрузили запись → получили стенограмму, сводку и черновики задач.
 * Задачи создаются только по подтверждению — ИИ ничего не заводит молча.
 */
export function MeetingsPage({ onEnterGuestMeet, openMeetingId }: { onEnterGuestMeet: (roomId: string) => void; openMeetingId?: string }) {
  const { user } = useAuth();
  const [list, setList] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [openId, setOpenId] = useState<string | null>(openMeetingId ?? null);
  /*
    Ссылка `/meetings/:id?t=735` (ТЗ-21): из ответа памяти или карточки обещания —
    сразу в нужную встречу и на нужную секунду записи.
  */
  const [seek, setSeek] = useState<number | null>(() => {
    const t = Number(new URLSearchParams(window.location.search).get('t'));
    return openMeetingId && Number.isFinite(t) && t >= 0 && window.location.search.includes('t=') ? t : null;
  });
  useEffect(() => {
    if (!openMeetingId) return;
    setOpenId(openMeetingId);
    const t = new URLSearchParams(window.location.search).get('t');
    setSeek(t != null && Number.isFinite(Number(t)) ? Number(t) : null);
  }, [openMeetingId]);
  // «Открыть мит» из сайдбара чата: раздел уже открыт, остаётся развернуть разбор
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) setOpenId(String(id));
    };
    window.addEventListener('teamcrm:meeting-open', onOpen);
    return () => window.removeEventListener('teamcrm:meeting-open', onOpen);
  }, []);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: '', projectId: '' });

  const reload = useCallback(
    () => api.listMeetings().then(setList).catch(() => undefined).finally(() => setLoaded(true)),
    [],
  );
  useEffect(() => {
    reload();
    api.listProjects().then(setProjects).catch(() => undefined);
    api.listUsers().then(setUsers).catch(() => undefined);
  }, [reload]);

  // пока встреча обрабатывается — подтягиваем статус: расшифровка часовой записи идёт минуты
  useEffect(() => {
    if (!list.some((m) => ['queued', 'transcribing', 'analyzing'].includes(m.status))) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [list, reload]);

  const submit = async (file: File) => {
    if (!form.title.trim()) return setErr('Назовите встречу');
    setErr(''); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', form.title.trim());
      if (form.projectId) fd.append('projectId', form.projectId);
      const m = await api.uploadMeeting(fd);
      setForm({ title: '', projectId: '' });
      setOpenId(m.id);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить запись');
    } finally { setBusy(false); }
  };

  return (
    <div className="mytasks">
      {/* Гостевые встречи идут первыми: это то, что назначают на будущее,
          тогда как разбор записей — работа с уже прошедшим. */}
      <GuestMeetsPanel onEnter={onEnterGuestMeet} />

      <div className="drawer-section-title"><Icon name="record" size={16} /> Разбор встреч</div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
        Загрузите запись встречи из Meet, Zoom или диктофона — получите стенограмму, сводку и предложенные задачи.
        Файл субтитров <b>.vtt/.srt</b> предпочтительнее: там платформа уже разметила, кто что сказал.
      </div>

      <div className="add-user" style={{ maxWidth: 620 }}>
        <input className="input add-user-input" placeholder="Название встречи" value={form.title}
               onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <OptionSelect className="input" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
          <option value="">— проект для задач (необязательно) —</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </OptionSelect>
        <label className={`ui-btn ui-btn-primary ui-btn-sm ${busy ? 'disabled' : ''}`} style={{ width: '100%', textAlign: 'center', cursor: 'pointer' }}>
          {busy ? 'Загружаю…' : <><Icon name="paperclip" size={15} /> Выбрать файл записи или субтитров</>}
          <input type="file" hidden disabled={busy} accept="audio/*,video/*,.vtt,.srt"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) submit(f); e.currentTarget.value = ''; }} />
        </label>
      </div>
      {err && <div className="error-text">{err}</div>}

      <div className="drawer-section-title" style={{ marginTop: 16 }}>Встречи ({list.length})</div>
      {(user?.role === 'owner' || user?.role === 'manager') && <PostcallQuality />}
      {!loaded && <SkeletonList rows={3} />}
      {loaded && list.length === 0 && (
        <EmptyState
          icon="record"
          title="Разборов пока нет"
          hint="Загрузите первую запись формой выше. Через несколько минут здесь появится стенограмма с именами, краткая сводка и задачи, которые ИИ предложит завести по итогам."
          action={{ label: 'Попробовать AI-созвон за 30 секунд', onClick: () => navigate('/onboarding/ai-call?from=meetings_empty') }}
        />
      )}
      {/* ТЗ-34 «Сегодня» п.3.4: плашка заботы в пустых «Созвонах» */}
      {loaded && list.length === 0 && <CareEmpty k="chats" />}

      <div className="task-list">
        {list.map((m) => (
          <div key={m.id}>
            <div className="list-row" role="button" tabIndex={0}
                 onClick={() => setOpenId(openId === m.id ? null : m.id)}
                 onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(openId === m.id ? null : m.id); } }}>
              <div className="list-main">
                <span className="list-title">{m.title}</span>
                {m.duration_sec > 0 && <span className="ui-badge ui-badge-neutral">{Math.round(m.duration_sec / 60)} мин</span>}
                {m.source === 'transcript' && <span className="ui-badge ui-badge-neutral" title="Загружены готовые субтитры">с именами</span>}
              </div>
              <div className="list-side">
                {/* итоги после звонка (ТЗ-22, §50): не разобраны — ведём на экран итогов */}
                {/*
                  Разбирает итоги только хозяин встречи (postcall canClose). Остальным плашка
                  «не разобраны» выглядела как сбой ИИ, хотя расшифровка и итог готовы — им
                  показываем, у кого итоги (19.10).
                */}
                {m.review_status === 'review_required' && m.review_owner_id && String(m.review_owner_id) !== String(user?.id) && (
                  <span className="ui-badge ui-badge-neutral" title="ИИ разобрал встречу; итоги и задачи подтверждает хозяин встречи">
                    Итоги у {m.review_owner_name ?? 'хозяина встречи'}
                  </span>
                )}
                {m.review_status === 'review_required' && (!m.review_owner_id || String(m.review_owner_id) === String(user?.id)) && (
                  <button
                    type="button" className="ui-badge ui-badge-warn meeting-review"
                    onClick={(e) => { e.stopPropagation(); navigate({ section: 'chat', view: 'postcall', meetingId: String(m.id) }); }}
                    title="Открыть итоги встречи"
                  >
                    Итоги не разобраны
                  </button>
                )}
                {(m.review_status === 'reviewed' || m.review_status === 'completed') && (
                  <span className="ui-badge ui-badge-ok">Итоги обработаны{m.tasks_created ? ` · задач: ${m.tasks_created}` : ''}</span>
                )}
                {m.review_status !== 'review_required' && m.drafts_pending > 0 && <span className="ui-badge ui-badge-warn">задач к подтверждению: {m.drafts_pending}</span>}
                <span className={`ui-badge ${m.status === 'done' ? 'ui-badge-ok' : m.status === 'error' ? 'ui-badge-danger' : 'ui-badge-info'}`}>
                  {STATUS_LABEL[m.status] ?? m.status}
                </span>
              </div>
            </div>
            {openId === m.id && (
              <MeetingDetails id={m.id} projects={projects} users={users} onChanged={reload} seek={openMeetingId === String(m.id) ? seek : null} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function MeetingDetails({ id, projects, users, onChanged, seek = null }: {
  id: string; projects: Project[]; users: User[]; onChanged: () => void; seek?: number | null;
}) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [showAll, setShowAll] = useState(seek != null);
  /** Проигрыватель записи: секунда из ссылки, переход по клику на реплику, подсветка текущей. */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [now, setNow] = useState<number | null>(seek);
  const pendingSeek = useRef<number | null>(seek);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  const loadAudio = async (fileId: string) => {
    if (audioUrl || audioState === 'loading') return;
    setAudioState('loading');
    try { setAudioUrl(URL.createObjectURL(await fetchBlob(fileId))); setAudioState('idle'); }
    catch { setAudioState('failed'); }
  };
  const jump = (sec: number, fileId: string | null) => {
    setNow(sec);
    const a = audioRef.current;
    if (a) { a.currentTime = sec; void a.play().catch(() => undefined); return; }
    pendingSeek.current = sec;
    if (fileId) void loadAudio(fileId);
  };
  const [bulk, setBulk] = useState(false);
  const [reBusy, setReBusy] = useState(false);

  const load = useCallback(() => api.meetingDetails(id).then(setData).catch(() => undefined), [id]);
  useEffect(() => { load(); }, [load]);
  // идёт разбор (в том числе «Разобрать заново») — подтягиваем результат сам
  // вернулись на вкладку — свежие черновики: пока её не было, встречу могли разобрать заново
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);
  const busyStatus = ['queued', 'transcribing', 'analyzing'].includes(String(data?.meeting?.status ?? ''));
  useEffect(() => {
    if (!busyStatus) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [busyStatus, load]);
  /*
    Протокол готов у тебя на глазах — неоновая вспышка и мягкий сигнал (ТЗ-23, #1523).
    Только на переходе «разбирается → готово»: открытие давно готовой встречи молчит.
  */
  const boxRef = useRef<HTMLDivElement | null>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busyStatus) { wasBusy.current = true; return; }
    if (wasBusy.current && data?.meeting?.status === 'done') feedback('ai.completed', { el: boxRef.current });
    wasBusy.current = false;
  }, [busyStatus, data?.meeting?.status]);

  if (!data) return <div style={{ padding: 10 }}><SkeletonList rows={3} /></div>;
  const { meeting, segments, summary, drafts, tasks = [] } = data;
  // играть есть что, если запись — звук (загруженный или сведённый созвон), а не субтитры
  const playable: string | null = meeting.file_id && meeting.source !== 'transcript' ? String(meeting.file_id) : null;
  const activeIdx = now == null ? -1 : segments.reduce((acc: number, s: any, i: number) => (Number(s.start_sec) <= now + 0.5 ? i : acc), -1);
  // упавший при создании черновик тоже ждёт решения — с причиной и «Повторить»
  const pending = drafts.filter((d: any) => d.status === 'pending' || d.status === 'failed');
  // Готовы к созданию только те, у кого есть проект: без него задаче некуда лечь.
  const readyCount = pending.filter((d: any) => d.project_id).length;

  /*
    Черновика уже нет (14.10): встречу разобрали заново, и неподтверждённые черновики
    заменились новыми, а на экране висел старый список — кнопки «Создать» и «Не
    создавать» били в пустоту, ошибка молча глоталась. Теперь — свежий список и слово.
  */
  const stale = async (e: unknown) => {
    if (e instanceof ApiError && e.code === 'NOT_FOUND') {
      await load();
      setErr('Список черновиков обновился — встречу разобрали заново. Проверьте задачи ещё раз.');
      return true;
    }
    return false;
  };
  const apply = async (d: any, patch: DraftChoice) => {
    setErr('');
    try { await api.applyMeetingDraft(d.id, patch); await load(); onChanged(); }
    catch (e) { if (!(await stale(e))) setErr(e instanceof ApiError ? e.message : 'Не удалось создать задачу'); }
  };
  const reject = async (d: any) => {
    setErr('');
    try { await api.rejectMeetingDraft(d.id); await load(); onChanged(); }
    catch (e) { if (!(await stale(e))) setErr(e instanceof ApiError ? e.message : 'Не удалось отклонить черновик'); }
  };

  /**
   * Создать все проверенные разом.
   *
   * По одному запросу на черновик, а не одним пакетом: применение задачи — обычный
   * путь со всеми проверками, и упавшая на середине пачка не должна отменять уже
   * созданное. Что не прошло — остаётся в списке с объяснением.
   */
  const applyAll = async () => {
    const ready = pending.filter((d: any) => d.project_id);
    if (!ready.length) return;
    setBulk(true); setErr('');
    let failed = 0;
    for (const d of ready) {
      try { await api.applyMeetingDraft(d.id, {}); } catch { failed++; }
    }
    setBulk(false);
    if (failed) setErr(`Не удалось создать: ${failed} из ${ready.length}. Остальные на доске.`);
    await load();
    onChanged();
  };

  return (
    <div ref={boxRef} className={`invite-box${busyStatus ? ' ai-working' : ''}`} style={{ marginBottom: 10 }}>
      {meeting.status === 'error' && (
        <div className="error-text" style={{ fontSize: 12 }}>
          {meeting.error}
          <button className="ui-btn ui-btn-ghost ui-btn-sm" style={{ marginLeft: 8 }}
                  onClick={async () => { await api.retryMeeting(id); onChanged(); }}>Повторить обработку</button>
        </div>
      )}
      {/*
        «Разобрать заново» (13.10): разбор сорвался (кончились деньги на API) или вышел
        пустым — итоги и задачи собираются по уже готовой стенограмме, запись заново не
        распознаётся. Созданные задачи не трогаются и второй раз не предлагаются.
      */}
      {(meeting.status === 'done' || meeting.status === 'error') && (
        <div style={{ marginBottom: 8 }}>
          <button
            className="ui-btn ui-btn-outline ui-btn-sm"
            disabled={reBusy}
            onClick={async () => {
              const ok = await confirmAction({
                title: 'Разобрать встречу заново?',
                description: 'ИИ заново соберёт итоги, решения и задачи по стенограмме. Уже созданные задачи останутся и повторно не предложатся.',
                confirmLabel: 'Разобрать',
              });
              if (!ok) return;
              setReBusy(true);
              try { await api.reanalyzeMeeting(id); onChanged(); } finally { setReBusy(false); }
            }}
          >
            <Icon name="sparkles" size={13} /> Разобрать заново
          </button>
        </div>
      )}

      {summary && (
        <>
          <div className="drawer-section-title">Сводка</div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{summary.summary}</div>
          {summary.decisions?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="dim" style={{ fontSize: 12 }}>Решения:</div>
              <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                {summary.decisions.map((d: string, i: number) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          )}
          {summary.risks?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="dim" style={{ fontSize: 12 }}>Риски:</div>
              <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                {summary.risks.map((r: string, i: number) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
        </>
      )}

      {pending.length > 0 && (
        <>
          <div className="drawer-section-title" style={{ marginTop: 10 }}>Предложенные задачи ({pending.length})</div>
          <div className="dim" style={{ fontSize: 12 }}>
            Это черновики: ИИ услышал поручение так, а не иначе. Поправьте формулировку
            и исполнителя — на доске появится уже ваша версия.
          </div>
          {err && <div className="error-text" style={{ fontSize: 12 }}>{err}</div>}
          {pending.map((d: any) => (
            <DraftRow key={d.id} draft={d} projects={projects} users={users}
                      onApply={apply} onReject={reject} onSaved={load} />
          ))}
          {/* «Создать все» — только для готовых строк: без проекта задачу создать нельзя,
              и молча пропустить половину списка хуже, чем сказать об этом заранее. */}
          {pending.length > 1 && (
            <div className="team-rate" style={{ marginTop: 8 }}>
              <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={applyAll} disabled={bulk || readyCount === 0}>
                {bulk ? 'Создаю…' : `Создать все (${readyCount})`}
              </button>
              {readyCount < pending.length && (
                <span className="dim" style={{ fontSize: 12 }}>
                  {pending.length - readyCount} без проекта — их пропущу
                </span>
              )}
            </div>
          )}
        </>
      )}
      {/*
        Задачи по итогам встречи.
        Раньше здесь стояло только «создано задач: 3» — по этой строке нельзя было ни
        понять, что именно поручили, ни дойти до задачи. Теперь список со ссылками:
        через месяц человек открывает старую встречу и видит, чем она закончилась.
      */}
      {tasks.length > 0 && (
        <>
          <div className="drawer-section-title" style={{ marginTop: 10 }}>Задачи по итогам встречи ({tasks.length})</div>
          {tasks.map((t: any) => (
            <div key={t.draft_id} className="meeting-task">
              {t.title ? (
                <>
                  <button
                    className="link-btn meeting-task-title"
                    onClick={() => navigate({ section: 'projects', projectId: t.project_id, taskId: t.task_id })}
                    title="Открыть задачу"
                  >
                    {t.title}
                  </button>
                  <div className="dim meeting-task-meta">
                    {t.assignee_name ? `Исполнитель: ${t.assignee_name}` : 'Исполнитель не назначен'}
                    {t.manager_name ? ` · Поставил: ${t.manager_name}` : ''}
                    {' · '}
                    {t.closed ? 'Завершена' : t.column_name || 'В работе'}
                  </div>
                </>
              ) : (
                // задачу удалили — ведём человека в никуда только через собственную беспечность
                <span className="dim">Задача удалена</span>
              )}
            </div>
          ))}
        </>
      )}

      {playable && (
        <div className="meeting-player">
          {audioUrl ? (
            <audio
              ref={(el) => {
                audioRef.current = el;
                if (el && pendingSeek.current != null) {
                  const t = pendingSeek.current;
                  pendingSeek.current = null;
                  el.addEventListener('loadedmetadata', () => { el.currentTime = t; }, { once: true });
                }
              }}
              src={audioUrl} controls preload="metadata"
              onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
            />
          ) : (
            <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={audioState === 'loading'} onClick={() => void loadAudio(playable)}>
              <Icon name="play" size={14} /> {audioState === 'loading' ? 'Загружаю запись…' : seek != null ? `Слушать с ${stamp(seek)}` : 'Слушать запись'}
            </button>
          )}
          {audioState === 'failed' && <span className="error-text" style={{ fontSize: 12 }}>Запись не загрузилась</span>}
        </div>
      )}
      <div className="drawer-section-title" style={{ marginTop: 10 }}>Стенограмма ({segments.length})</div>
      {segments.length === 0 && (
        <EmptyState
          compact
          icon={meeting.status === 'error' ? 'alert' : 'clock'}
          title={meeting.status === 'error' ? 'Стенограммы не будет' : 'Расшифровка ещё идёт'}
          hint={meeting.status === 'error'
            ? 'Обработка прервалась — причина указана выше. Нажмите «Повторить обработку».'
            : 'Час записи разбирается несколько минут. Страницу обновлять не нужно — текст появится сам.'}
        />
      )}
      <div style={{ maxHeight: showAll ? 'none' : 220, overflow: 'hidden', fontSize: 13, lineHeight: 1.6 }}>
        {segments.map((s: any, i: number) => (
          <div
            key={s.idx}
            className={i === activeIdx ? 'meeting-line meeting-line-active' : 'meeting-line'}
            ref={i === activeIdx && seek != null && now === seek ? (el) => el?.scrollIntoView({ block: 'center' }) : undefined}
          >
            <button className="meeting-stamp" title={playable ? 'Слушать с этого места' : undefined}
                    onClick={() => jump(Number(s.start_sec), playable)}>[{stamp(Number(s.start_sec))}]</button>{' '}
            {s.speaker && <b>{s.speaker}: </b>}{s.text}
          </div>
        ))}
      </div>
      {segments.length > 6 && (
        <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Свернуть' : 'Показать всю стенограмму'}
        </button>
      )}
    </div>
  );
}
