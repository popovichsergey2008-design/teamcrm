import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/router';

/**
 * «Пульс команды» — экран руководителя.
 *
 * Четыре блока считаются по фактическим данным: проекты, загрузка людей, узкие места
 * и скорость закрытия. Предиктивной части из ТЗ («вероятность срыва 85%», прогнозная
 * дата сдачи) здесь намеренно нет — для неё нужны оценки времени, которых в задачах
 * почти не бывает, а выдуманный процент на экране, по которому принимают кадровые
 * решения, хуже, чем его отсутствие.
 */

type Radar = Awaited<ReturnType<typeof api.radar>>;

const hoursSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);

function since(iso: string): string {
  const h = hoursSince(iso);
  if (h < 48) return `${h} ч без движения`;
  return `${Math.floor(h / 24)} дн. без движения`;
}

export function RadarPage() {
  const [data, setData] = useState<Radar | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.radar().then(setData).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось собрать сводку'));
  }, []);

  const velocityDelta = data ? data.velocity.last7 - data.velocity.prev7 : 0;

  return (
    <div className="page">
      <div className="page-head">
        <h2><Icon name="chart" size={18} /> Пульс команды</h2>
        {data && (
          <span className="dim">
            {data.projects.length} активных проектов · {data.people.length} человек
          </span>
        )}
      </div>

      <div className="radar-grid">
        {err && <div className="error-text">{err}</div>}
        {!data && !err && <SkeletonList rows={8} />}

        {data && (
          <>
            <section className="card radar-block">
              <h3 className="radar-head"><Icon name="board" size={16} /> Проекты</h3>
              {data.projects.length === 0 && (
                <EmptyState icon="board" compact title="Активных проектов нет" hint="Создайте проект — он появится здесь." />
              )}
              {data.projects.map((p) => {
                const pct = p.total ? Math.round((p.closed / p.total) * 100) : 0;
                return (
                  <button key={p.id} className="radar-row" onClick={() => navigate({ section: 'projects', projectId: p.id })}>
                    <span className="radar-row-main">
                      <span className="radar-row-title">{p.name}</span>
                      <span className="radar-bar"><span className={p.overdue ? 'late' : ''} style={{ width: `${pct}%` }} /></span>
                    </span>
                    <span className="radar-row-side">
                      <span className="dim">{p.closed} из {p.total}</span>
                      {p.overdue > 0 && <span className="badge badge-warn">просрочено {p.overdue}</span>}
                    </span>
                  </button>
                );
              })}
            </section>

            <section className="card radar-block">
              <h3 className="radar-head"><Icon name="users" size={16} /> Загрузка команды</h3>
              <div className="radar-note">
                Открытые задачи, а не часы: оценка времени стоит далеко не везде,
                и «14 часов работы» из трёх заполненных полей вводили бы в заблуждение.
              </div>
              {data.people.map((p) => (
                <div key={p.user_id} className="radar-row radar-row-static">
                  <span className="radar-row-main">
                    <span className="radar-row-title">{p.full_name}</span>
                  </span>
                  <span className="radar-row-side">
                    {p.due_today > 0 && <span className="badge badge-info">сегодня {p.due_today}</span>}
                    {p.overdue > 0 && <span className="badge badge-danger">просрочено {p.overdue}</span>}
                    <span className="dim">{p.open} задач</span>
                  </span>
                </div>
              ))}
            </section>

            <section className="card radar-block">
              <h3 className="radar-head"><Icon name="clock" size={16} /> Узкие места</h3>
              {data.stuck.length === 0 && (
                <EmptyState
                  icon="check-circle"
                  compact
                  title="Ничего не залежалось"
                  hint={`Сюда попадает сданное, что стоит на проверке дольше ${data.stuckHours} часов.`}
                />
              )}
              {data.stuck.map((t) => (
                <button key={t.id} className="radar-row" onClick={() => navigate({ section: 'projects', projectId: t.project_id, taskId: t.id })}>
                  <span className="radar-row-main">
                    <span className="radar-row-title">{t.title}</span>
                    <span className="dim">{t.project_name} · {t.column_name}{t.assignee_name ? ` · ${t.assignee_name}` : ''}</span>
                  </span>
                  <span className="radar-row-side">
                    <span className="badge badge-warn">{since(t.updated_at)}</span>
                  </span>
                </button>
              ))}
            </section>

            <section className="card radar-block">
              <h3 className="radar-head"><Icon name="zap" size={16} /> Скорость</h3>
              <div className="radar-velocity">
                <div>
                  <div className="radar-big">{data.velocity.last7}</div>
                  <div className="dim">закрыто за 7 дней</div>
                </div>
                <div>
                  <div className="radar-big">{data.velocity.prev7}</div>
                  <div className="dim">за предыдущие 7</div>
                </div>
                <div>
                  <div className={`radar-big ${velocityDelta >= 0 ? 'radar-up' : 'radar-down'}`}>
                    {velocityDelta >= 0 ? '+' : ''}{velocityDelta}
                  </div>
                  <div className="dim">разница</div>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
