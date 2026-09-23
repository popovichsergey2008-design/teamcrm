import { useCallback, useEffect, useState } from 'react';
import { TaskDrawer } from './TaskDrawer';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../state/auth';
import type { Board, Task, User } from '../types';

/**
 * Карточка задачи поверх любого экрана — по её номеру.
 *
 * Жалоба: «создал две-три задачи сразу и не могу открыть их, чтобы поправить или
 * приложить файлы». Открыть их было можно — но только уходом на доску: список
 * созданного при этом пропадал с глаз, и к следующей задаче человек возвращался
 * кнопкой «назад». Список из трёх задач превращался в три путешествия.
 *
 * Здесь карточка открывается ПОВЕРХ списка и закрывается обратно в него: правки,
 * файлы, обсуждение — и сразу следующая задача. Экрану-хозяину знать о задачах
 * ничего не нужно, достаточно проекта и номера.
 *
 * Данные берём с доски проекта: карточке нужны не только поля задачи, но и колонки
 * (перенос) и люди (исполнитель). Отдельной ручки «задача со всем окружением» у нас
 * нет, а заводить её ради одного экрана — лишняя сущность.
 */
export function TaskCardWindow({ projectId, taskId, onClose }: {
  projectId: string;
  taskId: string;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [board, setBoard] = useState<Board | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [err, setErr] = useState('');
  const [timerOn, setTimerOn] = useState(false);

  const load = useCallback(() => {
    api.getBoard(projectId)
      .then(setBoard)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось открыть задачу'));
  }, [projectId]);

  useEffect(() => {
    load();
    api.listUsers().then(setUsers).catch(() => undefined);
  }, [load]);

  const toggleTimer = async () => {
    try {
      if (timerOn) { await api.stopTimer(taskId); setTimerOn(false); } else { await api.startTimer(taskId); setTimerOn(true); }
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка таймера'); }
  };

  const task: Task | null = board?.columns.flatMap((c) => c.tasks).find((t) => String(t.id) === String(taskId)) ?? null;

  // Пока доска едет — пустая панель с признаком загрузки: без неё нажатие выглядит
  // так, будто ничего не произошло.
  if (!task) {
    return (
      <div className="drawer-overlay" onClick={onClose}>
        <aside className="drawer" onClick={(e) => e.stopPropagation()}>
          {err ? <div className="error-text">{err}</div> : <div className="spinner" />}
        </aside>
      </div>
    );
  }

  return (
    <TaskDrawer
      key={String(task.id)}
      task={task}
      users={users}
      columns={board?.columns.map((c) => ({ id: c.id, name: c.name })) ?? []}
      canDelete={user?.role !== 'client'}
      timerActive={timerOn}
      onToggleTimer={() => void toggleTimer()}
      onClose={onClose}
      onRefresh={load}
    />
  );
}
