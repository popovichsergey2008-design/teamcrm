import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';
import { useAuth } from '../state/auth';

/** Клиентский портал «маржа-сейф»: прогресс/статусы/сроки своих проектов, без финансов. Read-only. */
export function ClientPortal() {
  const { user, logout } = useAuth();
  const [projects, setProjects] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [board, setBoard] = useState<any>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.portalProjects().then((ps) => {
      setProjects(ps);
      if (ps.length) setSelected(ps[0].id);
    }).catch(() => setErr('Не удалось загрузить проекты'));
  }, []);

  useEffect(() => {
    if (!selected) { setBoard(null); return; }
    api.portalBoard(selected).then(setBoard).catch(() => setBoard(null));
  }, [selected]);

  const done = (c: any) => c.name?.toLowerCase() === 'done' || /готов|заверш|выполн/i.test(c.name || '');
  const progress = board ? (() => {
    const all = board.columns.flatMap((c: any) => c.tasks);
    const doneCount = board.columns.filter(done).flatMap((c: any) => c.tasks).length;
    return all.length ? Math.round((doneCount / all.length) * 100) : 0;
  })() : 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Logo size={28} withWord /> <span className="dim">· Портал клиента</span>
        </div>
        <div className="topbar-right">
          <span className="dim">{user?.fullName}</span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>Выйти</button>
        </div>
      </header>
      <div className="board-layout">
        <aside className="sidebar">
          <div className="sidebar-head">Мои проекты</div>
          <div className="project-list">
            {projects.map((p) => (
              <div key={p.id} className={`project-row ${p.id === selected ? 'active' : ''}`}>
                <button className="project-item" onClick={() => setSelected(p.id)}>{p.name}</button>
              </div>
            ))}
            {projects.length === 0 && <div className="muted sidebar-empty">Проектов пока нет</div>}
          </div>
        </aside>
        <main className="board-main">
          {err && <div className="error-text board-error">{err}</div>}
          {!board && <div className="muted board-placeholder">Выберите проект</div>}
          {board && (
            <>
              <div className="board-header">
                <div className="board-title">
                  {board.project.name}
                  <span className="badge" style={{ marginLeft: 10 }}>прогресс {progress}%</span>
                </div>
              </div>
              <div className="board-columns">
                {board.columns.map((col: any) => (
                  <div key={col.id} className="column">
                    <div className="column-head"><span>{col.name}</span><span className="badge">{col.tasks.length}</span></div>
                    <div className="column-tasks">
                      {col.tasks.map((t: any) => (
                        <div key={t.id} className="task-card" style={{ cursor: 'default' }}>
                          {t.labels?.length > 0 && (
                            <div className="card-labels">{t.labels.map((l: any) => <span key={l.id} className="card-label" style={{ background: l.color }} title={l.name} />)}</div>
                          )}
                          <div className="task-title">
                            {t.risk_level && <span className={`risk-dot risk-${t.risk_level}`} title="Срок" />}
                            {t.title}
                          </div>
                          <div className="task-meta">
                            {t.is_blocked && <span className="badge badge-blocked">В ожидании</span>}
                            {t.deadline_at && <span className="badge" title="Срок">до {new Date(t.deadline_at).toLocaleDateString('ru-RU')}</span>}
                            {!!t.checklistTotal && <span className="badge" title="чеклист"><Icon name="check" size={12} /> {t.checklistDone}/{t.checklistTotal}</span>}
                          </div>
                        </div>
                      ))}
                      {col.tasks.length === 0 && <div className="muted" style={{ padding: 8, fontSize: 13 }}>—</div>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
