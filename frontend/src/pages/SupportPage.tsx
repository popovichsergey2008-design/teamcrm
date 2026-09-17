import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { openSupport } from '../components/support/SupportDock';
import { api } from '../lib/api';
import { stampLabel } from '../lib/chat-text';
import { useAuth } from '../state/auth';
import type { SupportDesk, SupportHandbook, SupportQueueItem, SupportTeamMember } from '../types';

/** Секунды человеческими словами: «28 сек», «4 мин», «1 ч 10 мин». */
function dur(sec: number | null): string {
  if (!sec) return '—';
  if (sec < 90) return `${Math.round(sec)} сек`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  const h = Math.floor(sec / 3600);
  return `${h} ч ${Math.round((sec - h * 3600) / 60)} мин`;
}

/**
 * Раздел «Служба заботы» (ТЗ-8, разд. 3.3 и 22).
 *
 * Сам разговор живёт в панели поверх CRM — здесь то, что в панель не помещается:
 * состояние службы (кто дежурит, за сколько отвечаем), история своих обращений и,
 * для дежурного, очередь ожидающих.
 *
 * Тяжёлой helpdesk-таблицы здесь нет намеренно (разд. 22): человеку нужны две вещи —
 * «что было» и «открыть заново», а не колонки со статусами и приоритетами.
 */
export function SupportPage() {
  const { user } = useAuth();
  const canManage = user?.role === 'owner' || user?.role === 'manager';
  const [desk, setDesk] = useState<SupportDesk | null>(null);
  /** Кого можно поставить дежурным — вся команда с отметкой. */
  const [staff, setStaff] = useState<SupportTeamMember[]>([]);
  /** Справочник: то, из чего помощник отвечает на первой линии. */
  const [hb, setHb] = useState<SupportHandbook | null>(null);
  const [queue, setQueue] = useState<SupportQueueItem[]>([]);
  /** Сводка — только руководству: цифры управленческие, остальным они ничего не говорят. */
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.supportDashboard>> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const d = await api.supportDesk().catch(() => null);
    if (d) {
      setDesk(d);
      if (d.isAgent) setQueue(await api.supportQueue().catch(() => []));
      setStats(await api.supportDashboard().catch(() => null));
    }
    setHb(await api.supportHandbook().catch(() => null));
    if (user?.role === 'owner' || user?.role === 'manager') {
      setStaff(await api.supportTeamPicker().catch(() => []));
    }
  }, [user?.role]);
  useEffect(() => { void load(); }, [load]);

  /** Назначить или снять дежурного: одна галочка, без отдельного экрана настроек. */
  const toggleDuty = async (m: SupportTeamMember) => {
    setBusy(true);
    // Показываем сразу: галочка не должна ждать ответа сервера.
    setStaff((prev) => prev.map((p) => (p.userId === m.userId ? { ...p, onDuty: !p.onDuty } : p)));
    try { await api.supportSetAgent(m.userId, !m.onDuty, m.skills); void load(); }
    catch { setStaff((prev) => prev.map((p) => (p.userId === m.userId ? { ...p, onDuty: m.onDuty } : p))); }
    finally { setBusy(false); }
  };

  /** Загрузить справочник в базу знаний — после правки документации. */
  const loadHandbook = async () => {
    setBusy(true);
    try { setHb(await api.supportLoadHandbook()); }
    finally { setBusy(false); }
  };

  const reopen = async (id: string) => {
    setBusy(true);
    try { await api.supportReopen(id); openSupport(); void load(); }
    finally { setBusy(false); }
  };

  const online = desk?.team.filter((t) => t.online) ?? [];
  const eta = desk?.etaSeconds;

  return (
    <div className="page">
      <div className="page-head">
        <h2 className="page-title"><Icon name="support" size={18} /> Служба заботы</h2>
        <div className="page-head-actions">
          <button className="btn btn-primary btn-sm" onClick={openSupport}>
            <Icon name="chat" size={15} /> Написать
          </button>
        </div>
      </div>

      <div className="support-page">
        {/*
          Состояние службы — первым делом и честными словами.

          «Среднее время ответа» показываем, только если есть по чему считать: цифра
          из воздуха здесь хуже её отсутствия (разд. 6).
        */}
        <div className="support-state">
          <div className="support-state-row">
            <span className={`support-state-dot${online.length ? ' on' : ''}`} aria-hidden="true" />
            <b>{online.length ? 'Специалисты на связи' : 'Дежурные сейчас офлайн'}</b>
            <span className="dim">
              {eta ? `обычно отвечаем за ${eta < 90 ? `${Math.round(eta / 10) * 10} сек` : `${Math.round(eta / 60)} мин`}` : 'ответим, как только освободимся'}
            </span>
          </div>
          {desk && desk.team.length > 0 && (
            <div className="support-team">
              {desk.team.map((t) => (
                <span key={t.userId} className={`support-person${t.online ? ' on' : ''}`} title={t.online ? 'на связи' : 'офлайн'}>
                  {t.name}
                  {!!t.skills.length && <span className="dim"> · {t.skills.join(', ')}</span>}
                </span>
              ))}
            </div>
          )}
          <p className="dim">
            Поддержка — живой разговор внутри CRM: сначала отвечает AnthillBot, он видит,
            на каком вы экране. Не помог — одна кнопка, и подключится человек. Контекст
            при этом не теряется, повторять ничего не придётся.
          </p>
        </div>

        {/*
          Сводка службы заботы (разд. 30).

          Шесть цифр вместо дашборда на двадцать графиков: за сколько отвечаем, за
          сколько решаем, как оценивают, сколько возвращается и сколько разобрал
          помощник. Медианы, а не средние: один ночной разговор не должен рисовать
          несуществующую картину.
        */}
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

        {/*
          Кто дежурит (разд. 7).

          Дежурство — это галочка напротив человека, а не отдельный экран настроек:
          в маленькой команде состав меняется каждую неделю. Пока не отмечен никто,
          обращения идут владельцу компании — служба заботы не может молчать.
        */}
        {canManage && (
          <div className="support-block">
            <div className="drawer-section-title"><Icon name="users" size={14} /> Кто дежурит</div>
            <p className="dim">
              Дежурным приходят обращения, которые не закрыл помощник: они видят очередь и
              кнопку «Позвать человека». Пока никто не отмечен, всё идёт владельцу компании.
            </p>
            <div className="support-duty">
              {staff.map((m) => (
                <label key={m.userId} className={`support-duty-row${m.onDuty ? ' on' : ''}`}>
                  <input type="checkbox" checked={m.onDuty} disabled={busy} onChange={() => void toggleDuty(m)} />
                  <span className="support-duty-name">
                    {m.name}
                    {m.position && <span className="dim"> · {m.position}</span>}
                  </span>
                  <span className="dim">{m.online ? 'на связи' : 'офлайн'}</span>
                </label>
              ))}
              {!staff.length && <p className="dim">Сотрудников пока нет.</p>}
            </div>
          </div>
        )}

        {/*
          Чем отвечает помощник (разд. 5).

          Вопрос «по какой базе знаний он работает» должен иметь ответ прямо здесь, а
          не в голове у того, кто это настраивал. Справочник по системе лежит рядом с
          кодом и правится вместе с ним; здесь видно, что загружено и не отстало ли.
        */}
        <div className="support-block">
          <div className="drawer-section-title"><Icon name="book" size={14} /> Чем отвечает помощник</div>
          <p className="dim">
            Первая линия — AnthillBot. Он отвечает по справочнику TeamCRM: это документация
            по всем разделам системы, она лежит в базе знаний обычными регламентами — рядом
            с вашими правилами работы. Плюс к ней он видит ваши задачи, переписку и встречи
            в пределах ваших прав и говорит, из какого раздела взят ответ.
          </p>
          {hb && (
            <>
              <div className="support-hb">
                {hb.sections.map((sec) => (
                  <span key={sec.title} className={`support-person${sec.loadedAt ? ' on' : ''}`} title={sec.stale ? 'на диске новее — стоит загрузить' : 'загружено'}>
                    {sec.title}
                    {sec.stale && <span className="dim"> · обновился</span>}
                  </span>
                ))}
              </div>
              <div className="support-history-acts">
                <span className="dim">
                  {hb.loadedAt
                    ? `Загружено ${new Date(hb.loadedAt).toLocaleDateString('ru-RU')}${hb.stale ? ' · документация с тех пор менялась' : ''}`
                    : 'Справочник ещё не загружен — помощник отвечает только по вашим данным.'}
                </span>
                {canManage && (
                  <button className="btn btn-sm" disabled={busy} onClick={() => void loadHandbook()}>
                    <Icon name="refresh" size={13} /> {hb.loadedAt ? 'Обновить справочник' : 'Загрузить справочник'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Очередь — только дежурному: остальным она ничего не говорит. */}
        {desk?.isAgent && (
          <div className="support-block">
            <div className="drawer-section-title">Ждут ответа</div>
            {!queue.length && <p className="dim">Сейчас никто не ждёт.</p>}
            {queue.map((q) => (
              <button key={q.id} className="support-queue-row" onClick={openSupport}>
                <span className="support-queue-head">
                  <b>{q.subject || 'Обращение'}</b>
                  <span className="dim">{stampLabel(q.waitingSince)}</span>
                </span>
                <span className="dim">{q.userName} · {q.statusText}{q.agentName ? ` · ведёт ${q.agentName}` : ''}</span>
              </button>
            ))}
          </div>
        )}

        <div className="support-block">
          <div className="drawer-section-title">Мои обращения</div>
          {!desk && <SkeletonList rows={3} />}
          {desk && !desk.history.length && (
            <EmptyState
              compact
              icon="support"
              title="Обращений пока не было"
              hint="Если что-то не работает или непонятно — напишите. Ответим в разговоре, без заявок и номеров."
            />
          )}
          {desk?.history.map((h) => (
            <div key={h.id} className="support-history-row">
              <div className="support-history-head">
                <b>{h.subject || 'Обращение'}</b>
                <span className="dim">{new Date(h.createdAt).toLocaleDateString('ru-RU')}</span>
              </div>
              <div className="dim support-history-sub">
                {h.statusText}
                {h.agentName ? ` · ${h.agentName}` : ''}
                {h.messages ? ` · сообщений: ${h.messages}` : ''}
                {h.csat ? ` · оценка ${h.csat}/4` : ''}
              </div>
              <div className="support-history-acts">
                <button className="btn btn-ghost btn-sm" onClick={openSupport}>Открыть разговор</button>
                {h.closedAt && (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reopen(h.id)}>
                    Проблема снова появилась
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
