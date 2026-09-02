import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { SkeletonList } from './Skeleton';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import type { Project } from '../types';

const EXPANDED_KEY = 'teamcrm.expandedBitrix';
const providerLabel = (origin?: string) => (origin === 'yougile' ? 'YouGile' : 'Битрикс24');

/** Проекты изменились — доска должна перечитать список, не дожидаясь перезагрузки страницы. */
export const PROJECTS_CHANGED = 'teamcrm:projects-changed';
/** «Создать проект» нажали с пустой доски — курсор должен оказаться в поле ввода здесь. */
export const NEW_PROJECT_FOCUS = 'teamcrm:new-project-focus';

/**
 * Проекты — выпадающим списком под пунктом меню, как в привычных таск-менеджерах.
 *
 * Раньше это была вторая колонка слева, всегда развёрнутая: она отъедала место у доски
 * на любом экране и висела перед глазами даже там, где проект уже выбран и переключать
 * его не надо. Теперь список открывается под разделом, а закрывается вместе с ним.
 *
 * Данные компонент держит сам: доске они нужны для своих целей, и связывать два экрана
 * общим состоянием ради одного списка — дороже, чем прочитать его дважды.
 */
export function ProjectsNav({ currentId, canManage, canDelete = false }: {
  currentId: string | null;
  /** Архив и создание проекта: обратимые действия — работа всех, кто ведёт проекты. */
  canManage: boolean;
  /** Удаление проекта: открыто сотрудникам по решению заказчика, удерживает подтверждение. */
  canDelete?: boolean;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [creating, setCreating] = useState('');
  const [err, setErr] = useState('');
  const newRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')); } catch { return new Set(); }
  });

  const reload = useCallback(
    () => api.listProjects(true)
      .then(setProjects)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить проекты'))
      .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void reload();
    // проект могли создать не отсюда — из командной строки или импортом
    window.addEventListener(PROJECTS_CHANGED, reload);
    const focusNew = () => newRef.current?.focus();
    window.addEventListener(NEW_PROJECT_FOCUS, focusNew);
    return () => {
      window.removeEventListener(PROJECTS_CHANGED, reload);
      window.removeEventListener(NEW_PROJECT_FOCUS, focusNew);
    };
  }, [reload]);

  // Открытый проект может лежать в архиве: показываем ту вкладку, где он виден,
  // иначе человек смотрит на список, в котором его проекта нет.
  useEffect(() => {
    if (!currentId) return;
    const p = projects.find((x) => String(x.id) === String(currentId));
    if (p?.status === 'archived') setTab('archived');
  }, [currentId, projects]);

  const changed = () => window.dispatchEvent(new Event(PROJECTS_CHANGED));

  const toggleConn = (cid: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(cid)) n.delete(cid); else n.add(cid);
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...n]));
    return n;
  });

  const open = (id: string) => navigate({ section: 'projects', projectId: id });

  const create = async () => {
    const name = creating.trim();
    if (!name) return;
    try {
      const p = await api.createProject({ name });
      setCreating('');
      await reload();
      changed();
      open(p.id); // созданный проект открываем сразу — иначе его надо искать в списке
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать проект');
    }
  };

  const toggleArchive = async (p: Project) => {
    const archived = p.status === 'archived';
    if (!archived && !window.confirm(`Убрать проект «${p.name}» в архив? Он уйдёт на вкладку «Архив», данные сохранятся.`)) return;
    try {
      if (archived) await api.unarchiveProject(p.id); else await api.archiveProject(p.id);
      await reload();
      changed();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось изменить архив');
    }
  };

  const remove = async (p: Project) => {
    if (!window.confirm(`Удалить проект «${p.name}» со всеми задачами? Действие необратимо.`)) return;
    try {
      await api.deleteProject(p.id);
      const rest = projects.filter((x) => x.id !== p.id);
      setProjects(rest);
      changed();
      if (String(currentId) === String(p.id)) {
        const next = rest.find((x) => x.status !== 'archived');
        if (next) open(next.id); else navigate({ section: 'projects' });
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось удалить проект');
    }
  };

  const archivedCount = projects.filter((p) => p.status === 'archived').length;
  const shown = projects.filter((p) => (tab === 'archived' ? p.status === 'archived' : p.status !== 'archived'));
  const local = shown.filter((p) => !p.origin_connection_id);

  // импортированные доски — свёрнутыми под узлом-источником: их бывает несколько десятков
  const groups: [string, { label: string; origin: string; items: Project[] }][] = [];
  const byConn = new Map<string, { label: string; origin: string; items: Project[] }>();
  for (const p of shown) {
    const cid = p.origin_connection_id;
    if (!cid) continue;
    let g = byConn.get(cid);
    if (!g) {
      g = { label: p.origin_label || p.origin_portal || providerLabel(p.origin), origin: p.origin ?? 'bitrix', items: [] };
      byConn.set(cid, g);
      groups.push([cid, g]);
    }
    g.items.push(p);
  }

  const row = (p: Project, nested = false) => (
    <div
      key={p.id}
      className={`project-row ${String(p.id) === String(currentId) ? 'active' : ''} ${p.status === 'archived' ? 'project-archived' : ''}`}
      style={nested ? { paddingLeft: 18 } : undefined}
    >
      <button className="project-item" onClick={() => open(p.id)}>
        {p.name}
        {(p.origin === 'bitrix' || p.origin === 'yougile') && !nested && (
          <span className="project-src" title={`Импортировано из ${providerLabel(p.origin)}`}>⤓</span>
        )}
        {/* Сколько нового в МОИХ задачах этого проекта — ответ на вопрос «где искать»,
            не открывая доску. Чужие задачи не считаем: иначе на большом проекте цифра
            горит всегда и смотреть на неё перестают. */}
        {!!p.unread && (
          <span className="project-unread" title={`${p.unread} новых изменений в ваших задачах`}>
            {p.unread > 99 ? '99+' : p.unread}
          </span>
        )}
      </button>
      {canManage && (
        <>
          <button
            className="project-del"
            title={p.status === 'archived' ? 'Вернуть из архива' : 'Убрать в архив (данные сохранятся)'}
            onClick={() => toggleArchive(p)}
          >
            <Icon name={p.status === 'archived' ? 'arrow-up' : 'archive'} size={13} />
          </button>
          {canDelete && (
            <button className="project-del" title="Удалить проект" onClick={() => remove(p)}>
              <Icon name="close" size={13} />
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="nav-projects">
      {archivedCount > 0 && (
        <div className="nav-projects-tabs">
          <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>Проекты</button>
          <button className={tab === 'archived' ? 'active' : ''} onClick={() => setTab('archived')} title="Проекты в архиве — данные сохранены">
            Архив <span className="sidebar-tab-count">{archivedCount}</span>
          </button>
        </div>
      )}

      {loading && <div className="nav-projects-empty"><SkeletonList rows={3} /></div>}
      {err && <div className="error-text nav-projects-empty">{err}</div>}

      <div className="nav-projects-list">
        {local.map((p) => row(p))}
        {groups.map(([cid, g]) => (
          <div key={cid} className="project-group">
            <button className="project-group-head" onClick={() => toggleConn(cid)} title={`Импортировано из ${providerLabel(g.origin)}: ${g.label}`}>
              <span className="project-group-caret">{expanded.has(cid) ? '▾' : '▸'}</span>
              <span className="project-src">⤓</span>
              <span className="project-group-name">{g.label}</span>
              <span className="project-group-count">{g.items.length}</span>
            </button>
            {expanded.has(cid) && g.items.map((p) => row(p, true))}
          </div>
        ))}
      </div>

      {!loading && shown.length === 0 && (
        <div className="nav-projects-empty dim">
          {tab === 'archived' ? 'Архив пуст.' : canManage
            ? 'Проектов пока нет — создайте первый ниже.'
            : 'Вас пока не добавили ни в один проект.'}
        </div>
      )}

      {canManage && tab === 'active' && (
        <div className="nav-projects-new">
          <input
            ref={newRef}
            className="input"
            placeholder="Новый проект"
            value={creating}
            onChange={(e) => setCreating(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button className="btn btn-primary btn-sm" onClick={create} title="Создать проект">
            <Icon name="plus" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
