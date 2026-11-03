import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useAuth } from '../state/auth';
import { api, type RecentTask } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { RECENT_LABEL, recentState, TaskStateDot } from './TaskStateDot';
import { favorites, FAVORITES_CHANGED, initFavorites, toggleFavorite, type Favorite } from '../lib/favorites';
import { draftLabel, listDrafts, openDraft, removeDraft, TASK_DRAFT_CHANGED, type TaskDraft } from '../lib/task-draft';
import './sidebar-lists.css';

/**
 * «Избранное» (#4713) и «Черновики» (#4715) в левом сайдбаре — пунктами меню, как
 * разделы: каждый перетаскивается, двигается шестерёнкой и прячется (Sidebar.tsx).
 * 03.11, заказчик: черновики — отдельным пунктом, и только задачи: недописанные
 * сообщения чатов сюда не попадают (они и так ждут в поле ввода своего чата).
 *
 * Отдельный модуль со своими стилями: грузится после первого экрана и не утяжеляет
 * его. #4733: при каждой загрузке страницы свёрнуто — и «Избранное», и «Последние
 * задачи» внутри него (тоже кнопка, раскрывается отдельно); отмеченное — ниже.
 */
export default function SidebarLists({ onGo, part = 'fav' }: { onGo: () => void; part?: 'fav' | 'drafts' }) {
  const { user } = useAuth();
  initFavorites(user?.uiPrefs);
  const [favs, setFavs] = useState<Favorite[]>(favorites);
  const [tasks, setTasks] = useState<TaskDraft[]>(() => listDrafts(user?.id));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [recent, setRecent] = useState<RecentTask[]>([]);
  const route = useRoute();
  const favOpen = part === 'fav' && open.fav === true;
  // «Последние задачи» — при раскрытии и при переходе к другой задаче (её только что открыли)
  useEffect(() => {
    if (!favOpen) return;
    let live = true;
    api.recentTasks().then((r) => { if (live) setRecent(r); }).catch(() => undefined);
    return () => { live = false; };
  }, [favOpen, route.taskId]);

  useEffect(() => {
    const f = () => setFavs([...favorites()]);
    const d = () => setTasks(listDrafts(user?.id));
    window.addEventListener(FAVORITES_CHANGED, f);
    window.addEventListener(TASK_DRAFT_CHANGED, d);
    window.addEventListener('storage', d);
    return () => {
      window.removeEventListener(FAVORITES_CHANGED, f);
      window.removeEventListener(TASK_DRAFT_CHANGED, d);
      window.removeEventListener('storage', d);
    };
  }, [user?.id]);

  // по умолчанию свёрнуто (заказчик, 02.11; #4733 — и после перезагрузки тоже)
  const isOpen = (k: string) => open[k] === true;
  const flip = (k: string) => setOpen((prev) => ({ ...prev, [k]: !prev[k] }));

  const goFav = (f: Favorite) => {
    onGo();
    if (f.kind === 'view') navigate({ section: 'tasks' }); // #4735: «Мои задачи» по всем проектам
    else if (f.kind === 'project') navigate({ section: 'projects', projectId: f.id });
    else if (f.projectId) navigate({ section: 'projects', projectId: f.projectId, taskId: f.id });
  };
  const goRecent = (t: RecentTask) => { onGo(); navigate({ section: 'projects', projectId: t.projectId, taskId: t.id }); };

  if (part === 'drafts') {
    return (
      <div className="sbl">
        <button type="button" className="nav-item" aria-expanded={isOpen('drafts')} onClick={() => flip('drafts')}>
          <Icon name="edit" size={18} />
          <span className="nav-label">Черновики</span>
          {tasks.length > 0 && <span className="sbl-count">{tasks.length}</span>}
          <Icon name={isOpen('drafts') ? 'chevron-down' : 'chevron-right'} size={14} />
        </button>
        {isOpen('drafts') && (!tasks.length
          ? <p className="sbl-empty">Начали задачу, закрыли окно и не поставили — она будет здесь.</p>
          : (
            <div className="sbl-body">
              <ul className="sbl-list">
                {tasks.map((d) => (
                  <li key={d.id} className="sbl-row">
                    <button type="button" className="sbl-item" title="Продолжить задачу" onClick={() => { onGo(); openDraft(d, (projectId) => navigate({ section: 'projects', projectId })); }}>
                      <Icon name="edit" size={15} />
                      <span className="sbl-text">{draftLabel(d)}</span>
                    </button>
                    <button type="button" className="sbl-x" onClick={() => removeDraft(d.id)} title="Удалить черновик" aria-label="Удалить черновик задачи">
                      <Icon name="close" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    );
  }

  const total = favs.length;
  const empty = <p className="sbl-empty">Отметьте звёздочкой проект, задачу или «Мои задачи» — они будут здесь.</p>;

  return (
    <div className="sbl">
      <button type="button" className="nav-item" aria-expanded={isOpen('fav')} onClick={() => flip('fav')}>
        <Icon name="star" size={18} />
        <span className="nav-label">Избранное</span>
        {total > 0 && <span className="sbl-count">{total}</span>}
        <Icon name={isOpen('fav') ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
      {isOpen('fav') && (total === 0 && !recent.length ? empty : (
        <div className="sbl-body">
          {/* #4720: «Последние задачи» — первым пунктом; #4733 — кнопкой, свёрнуты */}
          {recent.length > 0 && (<>
            <button type="button" className="sbl-sub sbl-fold" aria-expanded={isOpen('recent')} onClick={() => flip('recent')}>
              <Icon name={isOpen('recent') ? 'chevron-down' : 'chevron-right'} size={12} />
              {RECENT_LABEL}
              <span className="sbl-count">{recent.length}</span>
            </button>
            {isOpen('recent') && <ul className="sbl-list">
              {recent.map((t) => {
                const st = recentState(t);
                return (
                  <li key={t.id} className="sbl-row">
                    <button type="button" className="sbl-item" onClick={() => goRecent(t)} title={`${t.title}\n${t.projectName} · ${st.hint}`}>
                      <TaskStateDot task={t} />
                      <span className="sbl-num">#{t.id}</span>
                      <span className="sbl-text">{t.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>}
            {favs.length > 0 && <div className="sbl-sub">Отмеченные</div>}
          </>)}
          {favs.length > 0 && (
            <ul className="sbl-list">
              {favs.map((f) => (
                <li key={`${f.kind}:${f.id}`} className="sbl-row">
                  <button type="button" className="sbl-item" onClick={() => goFav(f)} title={f.title}>
                    <Icon name={f.kind === 'project' ? 'folder' : f.kind === 'view' ? 'user' : 'check-circle'} size={15} />
                    <span className="sbl-text">{f.kind === 'task' ? `#${f.id} ` : ''}{f.title}</span>
                  </button>
                  <button type="button" className="sbl-x" onClick={() => toggleFavorite(f)} title="Убрать из избранного" aria-label={`Убрать «${f.title}» из избранного`}>
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
