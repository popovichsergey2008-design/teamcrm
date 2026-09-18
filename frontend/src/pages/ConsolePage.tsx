import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { openSupport } from '../components/support/SupportDock';
import { api, ApiError } from '../lib/api';
import { stampLabel } from '../lib/chat-text';
import { navigate, Route } from '../lib/router';
import { useAuth } from '../state/auth';
import type {
  PlatformCandidate, PlatformStaff, PlatformTenant,
  SupportEscalation, SupportHandbook, SupportQueueFilter, SupportQueueItem,
} from '../types';

/** Секунды человеческими словами: «28 сек», «4 мин», «1 ч 10 мин». */
function dur(sec: number | null): string {
  if (!sec) return '—';
  if (sec < 90) return `${Math.round(sec)} сек`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  const h = Math.floor(sec / 3600);
  return `${h} ч ${Math.round((sec - h * 3600) / 60)} мин`;
}

const TABS: { id: string; label: string; icon: string; manage?: boolean }[] = [
  { id: 'queue', label: 'Обращения', icon: 'support' },
  { id: 'team', label: 'Техотдел', icon: 'users' },
  { id: 'known', label: 'Известные проблемы', icon: 'alert', manage: true },
  { id: 'handbook', label: 'Справочник', icon: 'book', manage: true },
  { id: 'clients', label: 'Организации', icon: 'building' },
];

/**
 * Консоль техотдела — кабинет разработчика продукта.
 *
 * ANTHILL продаётся наружу, поэтому службу заботы ведёт ВЕНДОР, а не сама компания-
 * клиент. Всё, что раньше лежало в клиентском разделе «Служба заботы» и было видно
 * любому владельцу компании, собрано здесь: очередь обращений всех организаций,
 * состав техотдела, известные проблемы, массовый сбой, сводка и справочник.
 *
 * Раздела не существует для тех, кто не в техотделе: строки в меню нет, а ручки за
 * ней проверяют принадлежность на сервере — адрес, набранный руками, ничего не даст.
 *
 * Сами разговоры ведутся в той же панели поверх CRM, что и у человека: отдельного
 * «интерфейса оператора» намеренно нет — это был бы второй мессенджер с той же лентой.
 */
export function ConsolePage({ route }: { route: Route }) {
  const { user } = useAuth();
  const isAdmin = !!user?.platformAdmin;
  /*
    Инженер — не первая линия (01_ARCHITECTURE §3, 03_RBAC §3).

    Общей очереди у него нет, состав отдела и известные проблемы — не его дело.
    Консоль для него сворачивается в один экран: обращения, куда его позвали, и до
    какого времени они ему открыты.
  */
  const isEngineer = user?.platformRole === 'engineer';
  const tabs = isEngineer ? [] : TABS.filter((t) => !t.manage || isAdmin);
  const tab = isEngineer
    ? 'escalations'
    : (route.tab && tabs.some((t) => t.id === route.tab) ? route.tab : 'queue');

  const [queue, setQueue] = useState<SupportQueueItem[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.supportDashboard>> | null>(null);
  const [staff, setStaff] = useState<PlatformStaff[]>([]);
  const [people, setPeople] = useState<PlatformCandidate[]>([]);
  const [known, setKnown] = useState<Awaited<ReturnType<typeof api.supportKnownIssues>>>([]);
  const [hb, setHb] = useState<SupportHandbook | null>(null);
  const [clients, setClients] = useState<PlatformTenant[]>([]);
  const [escalations, setEscalations] = useState<SupportEscalation[]>([]);
  /** Отбор очереди: пустой означает «вся очередь», как было до этапа 3. */
  const [filter, setFilter] = useState<SupportQueueFilter>({});
  const [roles, setRoles] = useState<{ id: string; title: string }[]>([]);
  const [incident, setIncident] = useState({ title: '', message: '' });
  const [issue, setIssue] = useState({ taskId: '', title: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    // Инженеру не за чем ходить в очередь и настройки — там для него отказ.
    if (isEngineer) {
      setEscalations(await api.supportEscalations().catch(() => []));
      setReady(true);
      return;
    }
    const [q, d, s, k, h, c] = await Promise.all([
      api.supportQueue(filter).catch(() => []),
      api.supportDashboard().catch(() => null),
      api.platformStaff().catch(() => []),
      api.supportKnownIssues().catch(() => []),
      api.supportHandbook().catch(() => null),
      api.platformTenants().catch(() => []),
    ]);
    setQueue(q); setStats(d); setStaff(s); setKnown(k); setHb(h); setClients(c);
    if (isAdmin) {
      setPeople(await api.platformCandidates().catch(() => []));
      setRoles(await api.platformRoles().catch(() => []));
    }
    setReady(true);
  }, [isAdmin, isEngineer, filter]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const onDuty = staff.filter((s) => s.onDuty);

  return (
    <div className="page">
      <div className="page-head">
        <h2 className="page-title"><Icon name="lock" size={18} /> Консоль техподдержки</h2>
        <div className="page-head-actions">
          <span className="dim">
            {isEngineer
              ? `открыто обращений: ${escalations.length}`
              : (onDuty.length ? `на дежурстве: ${onDuty.length}` : 'дежурных нет')}
          </span>
        </div>
      </div>

      <nav className="console-tabs" aria-label="Разделы консоли">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`console-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => navigate({ section: 'console', tab: t.id === 'queue' ? undefined : t.id })}
          >
            <Icon name={t.icon as never} size={14} /> {t.label}
            {t.id === 'queue' && queue.length > 0 && <span className="console-badge">{queue.length}</span>}
          </button>
        ))}
      </nav>

      <div className="support-page">
        {err && <div className="error-text">{err}</div>}
        {!ready && <SkeletonList rows={4} />}

        {/*
          Экран инженера: только то, куда его позвали.

          Вместо очереди — список эскалаций со сроком доступа: инженер должен видеть,
          что право читать это обращение кончится, и не удивляться, когда оно кончится.
        */}
        {ready && isEngineer && (
          <div className="support-block">
            <div className="drawer-section-title">Мои эскалации</div>
            {!escalations.length && (
              <EmptyState
                compact
                icon="check"
                title="Эскалаций нет"
                hint="Обращение появится здесь, когда специалист поддержки позовёт вас в разговор."
              />
            )}
            {escalations.map((e) => (
              <button key={e.id} className="support-queue-row" onClick={openSupport}>
                <span className="support-queue-head">
                  <b>{e.subject || 'Обращение'}</b>
                  <span className="dim">{stampLabel(e.waitingSince)}</span>
                </span>
                <span className="dim">
                  {e.orgName ? <b className="console-org">{e.orgName}</b> : null} {e.userName} · {e.statusText}
                  {e.agentName ? ` · ведёт ${e.agentName}` : ''}
                  {` · доступ до ${new Date(e.accessUntil).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}
                </span>
              </button>
            ))}
          </div>
        )}

        {/*
          Обращения — очередь ВСЕХ организаций.

          Рядом с именем человека стоит его организация: без неё специалист не
          понимает, у кого сломалось, и первым делом спрашивает об этом сам.
        */}
        {ready && !isEngineer && tab === 'queue' && (
          <>
            {stats && (
              <div className="support-stats">
                <div className="support-stat"><b>{dur(stats.firstResponseSeconds)}</b><span className="dim">первый ответ человека</span></div>
                <div className="support-stat"><b>{dur(stats.aiResponseSeconds)}</b><span className="dim">ответ помощника</span></div>
                <div className="support-stat"><b>{dur(stats.queueWaitSeconds)}</b><span className="dim">ждут в очереди</span></div>
                <div className="support-stat"><b>{dur(stats.resolutionSeconds)}</b><span className="dim">до решения</span></div>
                <div className="support-stat"><b>{stats.active}</b><span className="dim">в работе</span></div>
                <div className="support-stat"><b>{stats.waiting}</b><span className="dim">ждут специалиста</span></div>
                <div className="support-stat">
                  <b>{stats.csatAvg ? `${stats.csatAvg}/4` : '—'}</b>
                  <span className="dim">оценка{stats.csatCount ? ` · ${stats.csatCount}` : ''}</span>
                </div>
                <div className="support-stat"><b>{stats.solvedByAi}</b><span className="dim">решил помощник</span></div>
                <div className="support-stat"><b>{stats.reopened}</b><span className="dim">открывали заново</span></div>
                <div className="support-stat">
                  <b>{stats.escalated}</b>
                  <span className="dim">
                    передал человеку{stats.escalatedUnsure ? ` · не был уверен: ${stats.escalatedUnsure}` : ''}
                  </span>
                </div>
              </div>
            )}

            {/*
              Отборы очереди (06_STATE_MACHINE §6).

              «Мои» и «ничьи» — то, что дежурный спрашивает у очереди чаще всего:
              первое отвечает «чем я занят», второе — «что никто не взял». Навык
              собираем из самой очереди, а не из справочника: показывать пустые
              варианты, которых сейчас нет, — заставлять человека проверять их руками.
            */}
            <div className="console-filters">
              <button
                className={`console-chip${!filter.assigned ? ' active' : ''}`}
                onClick={() => setFilter({ ...filter, assigned: undefined })}
              >
                Все
              </button>
              <button
                className={`console-chip${filter.assigned === 'me' ? ' active' : ''}`}
                onClick={() => setFilter({ ...filter, assigned: 'me' })}
              >
                Мои
              </button>
              <button
                className={`console-chip${filter.assigned === 'none' ? ' active' : ''}`}
                onClick={() => setFilter({ ...filter, assigned: 'none' })}
              >
                Ничьи
              </button>
              <select
                className="input console-role"
                value={filter.skill ?? ''}
                aria-label="Навык"
                onChange={(e) => setFilter({ ...filter, skill: e.target.value || undefined })}
              >
                <option value="">Любой навык</option>
                {[...new Set(queue.map((q) => q.requiredSkill).filter(Boolean))].map((sk) => (
                  <option key={String(sk)} value={String(sk)}>{sk}</option>
                ))}
              </select>
              <select
                className="input console-role"
                value={filter.priority ?? ''}
                aria-label="Срочность"
                onChange={(e) => setFilter({ ...filter, priority: e.target.value || undefined })}
              >
                <option value="">Любая срочность</option>
                <option value="critical">Критично</option>
                <option value="high">Срочно</option>
                <option value="normal">Обычные</option>
              </select>
              <button
                className={`console-chip${filter.waiting ? ' active' : ''}`}
                onClick={() => setFilter({ ...filter, waiting: filter.waiting ? undefined : 30 })}
                title="Ждут дольше получаса"
              >
                Ждут &gt; 30 мин
              </button>
            </div>

            <div className="support-block">
              <div className="drawer-section-title">Ждут ответа</div>
              {!queue.length && (
                <EmptyState
                  compact
                  icon="check"
                  title="Очередь пуста"
                  hint="Все обращения разобраны. Новые появятся здесь сами — перезагружать не нужно."
                />
              )}
              {queue.map((q) => (
                <button key={q.id} className="support-queue-row" onClick={openSupport}>
                  <span className="support-queue-head">
                    <b>{q.subject || 'Обращение'}</b>
                    <span className="console-row-acts">
                      {/*
                        Взять и вернуть — прямо из очереди.

                        Маршрутизатор ошибается, и поправить его человек должен одним
                        нажатием, не открывая разговор: иначе он просто не станет.
                      */}
                      {!q.agentId && (
                        <span
                          className="btn btn-sm"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); void act(() => api.supportAssign(q.id)); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void act(() => api.supportAssign(q.id)); } }}
                        >
                          Взять
                        </span>
                      )}
                      {q.agentId === user?.id && (
                        <span
                          className="btn btn-ghost btn-sm"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); void act(() => api.supportUnassign(q.id)); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void act(() => api.supportUnassign(q.id)); } }}
                        >
                          Вернуть в очередь
                        </span>
                      )}
                      <span className="dim">{stampLabel(q.waitingSince)}</span>
                    </span>
                  </span>
                  <span className="dim">
                    {q.orgName ? <b className="console-org">{q.orgName}</b> : null} {q.userName} · {q.statusText}
                    {q.agentName ? ` · ведёт ${q.agentName}` : ''}
                    {q.requiredSkill ? ` · ${q.requiredSkill}` : ''}
                    {q.priority && q.priority !== 'normal' ? ` · ${q.priority === 'critical' ? 'критично' : 'срочно'}` : ''}
                  </span>
                  {q.aiSummary && <span className="dim console-sum">{q.aiSummary}</span>}
                </button>
              ))}
            </div>

            {/*
              Массовый сбой — одно честное сообщение вместо двадцати разговоров.

              Уходит во ВСЕ организации сразу: авария у нас касается всех клиентов, а
              не той компании, из которой её первой заметили.
            */}
            <div className="support-block">
              <div className="drawer-section-title">Массовый сбой</div>
              <p className="dim">
                Сообщение увидят все, у кого сейчас открыт разговор, и все, кто откроет
                панель поддержки — в каждой организации. Когда починим, нажмите «Исправлено»:
                людям уйдёт весть, что можно проверять.
              </p>
              <div className="console-form">
                <input
                  className="input"
                  placeholder="Что сломалось (коротко)"
                  value={incident.title}
                  onChange={(e) => setIncident({ ...incident, title: e.target.value })}
                />
                <input
                  className="input"
                  placeholder="Что мы делаем и когда ждать"
                  value={incident.message}
                  onChange={(e) => setIncident({ ...incident, message: e.target.value })}
                />
                <button
                  className="btn btn-sm"
                  disabled={busy || !incident.title.trim() || !incident.message.trim()}
                  onClick={() => void act(async () => {
                    await api.supportDeclareIncident(incident.title.trim(), incident.message.trim());
                    setIncident({ title: '', message: '' });
                  })}
                >
                  Объявить сбой
                </button>
              </div>
            </div>
          </>
        )}

        {/*
          Техотдел: кто отвечает клиентам.

          Галочка «дежурит» — то, что меняется каждую неделю; состав — то, что меняется
          раз в полгода. Поэтому галочка видна всем в отделе, а состав правит админ.
        */}
        {ready && !isEngineer && tab === 'team' && (
          <>
            <div className="support-block">
              <div className="drawer-section-title">Кто дежурит</div>
              <p className="dim">
                Дежурным приходят обращения клиентов и светится очередь. Пока не отмечен
                никто, обращения идут владельцу организации, в которой они появились —
                продукт не может остаться без поддержки.
              </p>
              <div className="support-duty">
                {staff.map((s) => (
                  <label key={s.userId} className={`support-duty-row${s.onDuty ? ' on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={s.onDuty}
                      disabled={busy || !isAdmin}
                      onChange={() => void act(() => api.platformSetStaff(s.userId, { active: !s.onDuty }))}
                    />
                    <span className="support-duty-name">
                      {s.name}
                      <span className="dim"> · {s.roleTitle}</span>
                      {!!s.skills.length && <span className="dim"> · {s.skills.join(', ')}</span>}
                    </span>
                    {/*
                      Роль решает, что человек увидит: первая линия — очередь, инженер —
                      только свои эскалации. Поэтому меняется здесь же, где дежурство, а
                      не в отдельном экране настроек.
                    */}
                    {isAdmin && (
                      <select
                        className="input console-role"
                        value={s.role}
                        disabled={busy}
                        aria-label={`Роль: ${s.name}`}
                        onClick={(e) => e.preventDefault()}
                        onChange={(e) => void act(() => api.platformSetStaff(s.userId, { role: e.target.value }))}
                      >
                        {roles.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                      </select>
                    )}
                    {/*
                      Навыки и предел загрузки — там же, где роль.

                      По ним маршрутизатор и выбирает: без навыков обращение уйдёт
                      «свободнее всех», а без предела один человек наберёт двадцать
                      разговоров и ни одному не ответит вовремя.
                    */}
                    {isAdmin && (
                      <input
                        className="input console-skills"
                        defaultValue={s.skills.join(', ')}
                        placeholder="навыки через запятую"
                        aria-label={`Навыки: ${s.name}`}
                        onClick={(e) => e.preventDefault()}
                        onBlur={(e) => {
                          const next = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
                          if (next.join(',') !== s.skills.join(',')) {
                            void act(() => api.platformSetStaff(s.userId, { skills: next }));
                          }
                        }}
                      />
                    )}
                    {isAdmin && (
                      <input
                        className="input console-limit"
                        type="number"
                        min={1}
                        max={50}
                        defaultValue={s.maxConversations}
                        title="Сколько разговоров тянет одновременно"
                        aria-label={`Предел разговоров: ${s.name}`}
                        onClick={(e) => e.preventDefault()}
                        onBlur={(e) => {
                          const n = Number(e.target.value);
                          if (n > 0 && n !== s.maxConversations) {
                            void act(() => api.platformSetStaff(s.userId, { maxConversations: n }));
                          }
                        }}
                      />
                    )}
                    {isAdmin && s.userId !== user?.id && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={(e) => { e.preventDefault(); void act(() => api.platformSetStaff(s.userId, { remove: true })); }}
                      >
                        Убрать
                      </button>
                    )}
                  </label>
                ))}
                {!staff.length && <p className="dim">В техотделе пока никого.</p>}
              </div>
            </div>

            {isAdmin && (
              <div className="support-block">
                <div className="drawer-section-title">Взять в техотдел</div>
                <p className="dim">
                  Только сотрудники организации-платформы: право читать обращения всех
                  клиентов нельзя выдать человеку из клиентской компании.
                </p>
                <div className="support-duty">
                  {people.filter((p) => !p.inStaff).map((p) => (
                    <div key={p.userId} className="support-duty-row">
                      <span className="support-duty-name">
                        {p.name}
                        {p.position && <span className="dim"> · {p.position}</span>}
                      </span>
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void act(() => api.platformSetStaff(p.userId, { active: true }))}
                      >
                        Взять
                      </button>
                    </div>
                  ))}
                  {!people.filter((p) => !p.inStaff).length && <p className="dim">Все уже в отделе.</p>}
                </div>
              </div>
            )}
          </>
        )}

        {/*
          Известные проблемы: пометка на задаче, а не второй список багов.

          Слова-приметы сравниваются с текстом обращения — совпало, и человек узнаёт о
          поломке в первую же минуту, вместо того чтобы доказывать её специалисту.
        */}
        {ready && !isEngineer && tab === 'known' && (
          <div className="support-block">
            <div className="drawer-section-title">Известные проблемы</div>
            <p className="dim">
              Номер задачи из нашего проекта поддержки и слова, по которым проблему
              узнают в чужом обращении (через запятую; по умолчанию — слова названия).
            </p>
            <div className="console-form">
              <input
                className="input console-num"
                placeholder="№ задачи"
                value={issue.taskId}
                onChange={(e) => setIssue({ ...issue, taskId: e.target.value.replace(/\D/g, '') })}
              />
              <input
                className="input"
                placeholder="Как называем проблему"
                value={issue.title}
                onChange={(e) => setIssue({ ...issue, title: e.target.value })}
              />
              <button
                className="btn btn-sm"
                disabled={busy || !issue.taskId || !issue.title.trim()}
                onClick={() => void act(async () => {
                  await api.supportAddKnownIssue(issue.taskId, issue.title.trim());
                  setIssue({ taskId: '', title: '' });
                })}
              >
                Добавить
              </button>
            </div>
            {!known.length && <p className="dim">Пока ни одной.</p>}
            {known.map((k) => (
              <div key={k.id} className="support-duty-row">
                <span className="support-duty-name">
                  {k.title}
                  <span className="dim"> · задача #{k.taskId} · {k.fixed ? 'исправлено' : 'чиним'}</span>
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void act(() => api.supportSetKnownIssue(k.id, !k.active))}
                >
                  {k.active ? 'Не подсказывать' : 'Подсказывать'}
                </button>
              </div>
            ))}
          </div>
        )}

        {/*
          Справочник — то, из чего отвечает помощник первой линии.

          Лежит в репозитории рядом с кодом и грузится в базу знаний каждой организации:
          иначе помощник клиента не найдёт его своим же поиском.
        */}
        {ready && !isEngineer && tab === 'handbook' && (
          <div className="support-block">
            <div className="drawer-section-title">Справочник по системе</div>
            <p className="dim">
              Документация по всем разделам продукта. Правится в репозитории
              (<code>backend/handbook</code>) вместе с кодом и после выкладки сама
              обновляется во всех организациях — кнопка нужна, только если ждать не хочется.
              В базе знаний клиента разделы помечены системными: править и удалять их нельзя.
            </p>
            {hb && (
              <>
                <div className="support-hb">
                  {hb.sections.map((sec) => (
                    <span key={sec.title} className={`support-person${sec.loadedAt ? ' on' : ''}`}>
                      {sec.title}
                      {sec.stale && <span className="dim"> · обновился</span>}
                    </span>
                  ))}
                </div>
                <div className="support-history-acts">
                  <span className="dim">
                    {hb.loadedAt
                      ? `Загружено ${new Date(hb.loadedAt).toLocaleDateString('ru-RU')}${hb.stale ? ' · на диске новее' : ''}`
                      : 'Ещё не загружен.'}
                  </span>
                  <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => api.supportLoadHandbook())}>
                    <Icon name="refresh" size={13} /> Обновить у всех
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/*
          Организации-клиенты: счётчики и активность.

          Содержимого чужих досок и переписок здесь нет и не будет, сколько бы это ни
          было удобно поддержке: доступ к данным клиента даёт только его обращение.
        */}
        {ready && !isEngineer && tab === 'clients' && (
          <div className="support-block">
            <div className="drawer-section-title">Организации</div>
            <p className="dim">
              Кто пользуется продуктом: люди, открытые обращения и когда в последний раз
              заходили. Содержимого досок и переписок отсюда не видно.
            </p>
            <div className="console-table" role="table">
              <div className="console-row console-row-head" role="row">
                <span>Организация</span><span>Людей</span><span>Обращений</span><span>Были</span>
              </div>
              {clients.map((c) => (
                <div key={c.id} className="console-row" role="row">
                  <span>{c.name}</span>
                  <span>{c.people}</span>
                  <span>{c.openConversations || '—'}</span>
                  <span className="dim">{c.lastSeenAt ? stampLabel(c.lastSeenAt) : 'ни разу'}</span>
                </div>
              ))}
              {!clients.length && <p className="dim">Клиентов пока нет.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
