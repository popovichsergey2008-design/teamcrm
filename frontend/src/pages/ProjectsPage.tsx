import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { useAuth } from '../state/auth';
import { PROJECTS_CHANGED } from '../components/ProjectsNav';

type Row = Awaited<ReturnType<typeof api.projectsStats>>[number];

/** Срез списка: по нему же считаются цифры на вкладках. */
type Slice = 'active' | 'mine' | 'archived';

/**
 * «Проекты и доски» — все проекты одной таблицей.
 *
 * Раньше проекты жили выпадающим списком в левой панели: на трёх досках это удобно,
 * на тридцати — стена ссылок, по которой ничего не найти и в которой не видно, где
 * что происходит. Заказчик попросил убрать список и сделать нормальный раздел.
 *
 * Что должно быть видно из таблицы, не открывая доски: сколько задач всего и сколько
 * открыто, есть ли просрочка, когда ближайший срок, кто отвечает и закрыт ли проект
 * от посторонних. Просрочка выделена цветом — ради неё сюда и заходят.
 */
export function ProjectsPage({ onOpen }: { onOpen: (projectId: string) => void }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [slice, setSlice] = useState<Slice>('active');
  /** Новый проект заводят прямо отсюда: это и есть место, где проекты живут. */
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.projectsStats(true)
      .then(setRows)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить проекты'));
  };
  useEffect(() => {
    load();
    // Проект создали, переименовали или заархивировали в другом месте — список обязан знать.
    window.addEventListener(PROJECTS_CHANGED, load);
    return () => window.removeEventListener(PROJECTS_CHANGED, load);
  }, []);

  const mineId = String(user?.id ?? '');
  const shown = useMemo(() => {
    const text = q.trim().toLowerCase();
    return (rows ?? []).filter((p) => {
      if (slice === 'archived' ? p.status !== 'archived' : p.status === 'archived') return false;
      if (slice === 'mine' && String(p.owner_user_id ?? '') !== mineId) return false;
      if (text && !p.name.toLowerCase().includes(text)) return false;
      return true;
    });
  }, [rows, q, slice, mineId]);

  const counts = useMemo(() => ({
    active: (rows ?? []).filter((p) => p.status !== 'archived').length,
    mine: (rows ?? []).filter((p) => p.status !== 'archived' && String(p.owner_user_id ?? '') === mineId).length,
    archived: (rows ?? []).filter((p) => p.status === 'archived').length,
  }), [rows, mineId]);

  const create = async () => {
    const title = name.trim();
    if (!title) return;
    setBusy(true); setErr('');
    try {
      const created = await api.createProject({ name: title });
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      setName(''); setAdding(false);
      onOpen(String(created.id));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать проект');
    } finally { setBusy(false); }
  };

  /** Срок человеческой строкой: в таблице важен день, а не минуты. */
  const deadline = (at: string | null) => (at
    ? new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
    : '—');

  return (
    <div className="page projects-page">
      <div className="page-head">
        <h2 className="page-title"><Icon name="board" size={18} /> Проекты и доски</h2>
        <div className="projects-tools">
          <input
            className="input projects-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по названию"
            aria-label="Поиск проекта"
          />
          <span className="view-switch" role="tablist" aria-label="Какие проекты показывать">
            <button className={`view-btn ${slice === 'active' ? 'active' : ''}`} onClick={() => setSlice('active')}>
              Все <span className="dim">{counts.active}</span>
            </button>
            <button className={`view-btn ${slice === 'mine' ? 'active' : ''}`} onClick={() => setSlice('mine')} title="Проекты, за которые отвечаю я">
              Мои <span className="dim">{counts.mine}</span>
            </button>
            <button className={`view-btn ${slice === 'archived' ? 'active' : ''}`} onClick={() => setSlice('archived')}>
              Архив <span className="dim">{counts.archived}</span>
            </button>
          </span>
          {user?.role !== 'client' && (
            adding ? (
              <span className="projects-new">
                <input
                  className="input"
                  value={name}
                  autoFocus
                  placeholder="Название проекта"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setAdding(false); }}
                />
                <button className="btn btn-primary btn-sm" disabled={busy || !name.trim()} onClick={() => void create()}>Создать</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setAdding(false); setName(''); }}>Отмена</button>
              </span>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
                <Icon name="plus" size={15} /> Новый проект
              </button>
            )
          )}
        </div>
      </div>

      {err && <div className="error-text">{err}</div>}

      {rows && shown.length === 0 && (
        <EmptyState
          icon="board"
          title={q ? 'Ничего не нашлось' : slice === 'archived' ? 'Архив пуст' : 'Проектов пока нет'}
          hint={q ? 'Проверьте название.' : 'Проект — это доска с колонками и задачами. Создайте первый.'}
        />
      )}

      {shown.length > 0 && (
        <div className="table-wrap">
          <table className="table projects-table">
            <thead>
              <tr>
                <th>Проект</th>
                <th className="num">Задач</th>
                <th className="num">Открыто</th>
                <th className="num">Просрочено</th>
                <th>Ближайший срок</th>
                <th>Ответственный</th>
                <th>Доступ</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className="projects-row" onClick={() => onOpen(String(p.id))}>
                  <td>
                    {/* Название — ссылка: строку целиком тоже можно нажать, но ссылку
                        видно глазами и её можно открыть в новой вкладке. */}
                    <a
                      className="link-btn"
                      href={`/projects/${p.id}`}
                      onClick={(e) => { e.preventDefault(); onOpen(String(p.id)); }}
                    >
                      {p.name}
                    </a>
                    {p.is_default && <span className="badge badge-muted" title="Основная доска компании">основная</span>}
                    {p.origin_label && <span className="dim projects-origin" title="Импортированный проект">· {p.origin_label}</span>}
                    {!!p.unread && <span className="badge badge-info" title="Новое в ваших задачах">{p.unread}</span>}
                  </td>
                  <td className="num" data-label="Задач">{p.tasks_total}</td>
                  <td className="num" data-label="Открыто">{p.tasks_open}</td>
                  <td className={`num${p.tasks_overdue ? ' projects-overdue' : ''}`} data-label="Просрочено">{p.tasks_overdue || '—'}</td>
                  <td data-label="Ближайший срок">{deadline(p.next_deadline)}</td>
                  <td data-label="Ответственный">{p.owner_name ?? <span className="dim">не назначен</span>}</td>
                  <td data-label="Доступ">
                    {p.visibility === 'members'
                      ? (
                        <span className="badge badge-muted" title={`Видят только участники: ${p.members_count}`}>
                          <Icon name="lock" size={11} /> только свои
                        </span>
                      )
                      : <span className="dim">вся команда</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
