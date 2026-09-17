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
  PlatformCandidate, PlatformStaff, PlatformTenant, SupportHandbook, SupportQueueItem,
} from '../types';

/** Секунды человеческими словами: «28 сек», «4 мин», «1 ч 10 мин». */
function dur(sec: number | null): string {
  if (!sec) return '—';
  if (sec < 90) return `${Math.round(sec)} сек`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  const h = Math.floor(sec / 3600);
  return `${h} ч ${Math.round((sec - h * 3600) / 60)} мин`;
}

const TABS: { id: string; label: string; icon: string }[] = [
  { id: 'queue', label: 'Обращения', icon: 'support' },
  { id: 'team', label: 'Техотдел', icon: 'users' },
  { id: 'known', label: 'Известные проблемы', icon: 'alert' },
  { id: 'handbook', label: 'Справочник', icon: 'book' },
  { id: 'clients', label: 'Организации', icon: 'building' },
];

/**
 * Консоль техотдела — кабинет разработчика продукта.
 *
 * TeamCRM продаётся наружу, поэтому службу заботы ведёт ВЕНДОР, а не сама компания-
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
  const tab = route.tab && TABS.some((t) => t.id === route.tab) ? route.tab : 'queue';
  const isAdmin = !!user?.platformAdmin;

  const [queue, setQueue] = useState<SupportQueueItem[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.supportDashboard>> | null>(null);
  const [staff, setStaff] = useState<PlatformStaff[]>([]);
  const [people, setPeople] = useState<PlatformCandidate[]>([]);
  const [known, setKnown] = useState<Awaited<ReturnType<typeof api.supportKnownIssues>>>([]);
  const [hb, setHb] = useState<SupportHandbook | null>(null);
  const [clients, setClients] = useState<PlatformTenant[]>([]);
  const [incident, setIncident] = useState({ title: '', message: '' });
  const [issue, setIssue] = useState({ taskId: '', title: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    const [q, d, s, k, h, c] = await Promise.all([
      api.supportQueue().catch(() => []),
      api.supportDashboard().catch(() => null),
      api.platformStaff().catch(() => []),
      api.supportKnownIssues().catch(() => []),
      api.supportHandbook().catch(() => null),
      api.platformTenants().catch(() => []),
    ]);
    setQueue(q); setStats(d); setStaff(s); setKnown(k); setHb(h); setClients(c);
    if (isAdmin) setPeople(await api.platformCandidates().catch(() => []));
    setReady(true);
  }, [isAdmin]);
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
          <span className="dim">{onDuty.length ? `на дежурстве: ${onDuty.length}` : 'дежурных нет'}</span>
        </div>
      </div>

      <nav className="console-tabs" aria-label="Разделы консоли">
        {TABS.map((t) => (
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
          Обращения — очередь ВСЕХ организаций.

          Рядом с именем человека стоит его организация: без неё специалист не
          понимает, у кого сломалось, и первым делом спрашивает об этом сам.
        */}
        {ready && tab === 'queue' && (
          <>
            {stats && (
              <div className="support-stats">
                <div className="support-stat"><b>{dur(stats.firstResponseSeconds)}</b><span className="dim">первый ответ</span></div>
                <div className="support-stat"><b>{dur(stats.resolutionSeconds)}</b><span className="dim">до решения</span></div>
                <div className="support-stat"><b>{stats.active}</b><span className="dim">в работе</span></div>
                <div className="support-stat"><b>{stats.waiting}</b><span className="dim">ждут специалиста</span></div>
                <div className="support-stat">
                  <b>{stats.csatAvg ? `${stats.csatAvg}/4` : '—'}</b>
                  <span className="dim">оценка{stats.csatCount ? ` · ${stats.csatCount}` : ''}</span>
                </div>
                <div className="support-stat"><b>{stats.solvedByAi}</b><span className="dim">решил помощник</span></div>
                <div className="support-stat"><b>{stats.reopened}</b><span className="dim">открывали заново</span></div>
              </div>
            )}

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
                    <span className="dim">{stampLabel(q.waitingSince)}</span>
                  </span>
                  <span className="dim">
                    {q.orgName ? <b className="console-org">{q.orgName}</b> : null} {q.userName} · {q.statusText}
                    {q.agentName ? ` · ведёт ${q.agentName}` : ''}
                  </span>
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
        {ready && tab === 'team' && (
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
                      {s.role === 'admin' && <span className="dim"> · администратор</span>}
                      {!!s.skills.length && <span className="dim"> · {s.skills.join(', ')}</span>}
                    </span>
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
        {ready && tab === 'known' && (
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
        {ready && tab === 'handbook' && (
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
        {ready && tab === 'clients' && (
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
