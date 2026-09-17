import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { openSupport } from '../components/support/SupportDock';
import { api } from '../lib/api';
import { stampLabel } from '../lib/chat-text';
import type { SupportDesk, SupportQueueItem } from '../types';

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
  const [desk, setDesk] = useState<SupportDesk | null>(null);
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
  }, []);
  useEffect(() => { void load(); }, [load]);

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
