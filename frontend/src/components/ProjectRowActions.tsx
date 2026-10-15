import { Icon } from './Icon';
import { Button } from './ui/button';
import { confirmAction } from './ui/dialog';
import { api, ApiError } from '../lib/api';
import { PROJECTS_CHANGED } from './ProjectsNav';

/**
 * Кнопки у строки в таблице «Проекты»: в архив / вернуть, удалить.
 *
 * Раньше эти кнопки жили в списке досок левой панели; панель убрали (16.09), а в
 * таблицу их не перенесли — архивировать и удалять стало негде. Права те же, что
 * на сервере: архив обратим и доступен сотруднику, удаление — по решению заказчика
 * тоже, но только после подтверждения с названием проекта.
 */
export default function ProjectRowActions({ project, onError }: {
  project: { id: string | number; name: string; status?: string; is_default?: boolean };
  onError: (message: string) => void;
}) {
  const id = String(project.id);
  const archived = project.status === 'archived';
  const done = () => window.dispatchEvent(new Event(PROJECTS_CHANGED));

  const toggleArchive = async () => {
    if (!archived && !(await confirmAction({
      title: `Убрать проект «${project.name}» в архив?`,
      description: 'Он уйдёт на вкладку «Архив», задачи и данные сохранятся. Вернуть можно в любой момент.',
      confirmLabel: 'В архив',
    }))) return;
    try {
      if (archived) await api.unarchiveProject(id); else await api.archiveProject(id);
      done();
    } catch (e) { onError(e instanceof ApiError ? e.message : 'Не удалось изменить архив'); }
  };

  const remove = async () => {
    if (!(await confirmAction({
      title: `Удалить проект «${project.name}» со всеми задачами?`,
      description: 'Задачи, обсуждения и вложения проекта удалятся безвозвратно. Если проект просто закончился — уберите его в архив.',
      confirmLabel: 'Удалить навсегда',
      danger: true,
    }))) return;
    try {
      await api.deleteProject(id);
      done();
    } catch (e) { onError(e instanceof ApiError ? e.message : 'Не удалось удалить проект'); }
  };

  return (
    // строка таблицы открывает проект по щелчку — меню не должно его открывать
    <span className="projects-acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Button variant="ghost" size="icon-sm" onClick={() => void toggleArchive()}
        aria-label={archived ? `Вернуть проект «${project.name}» из архива` : `Убрать проект «${project.name}» в архив`}
        title={archived ? 'Вернуть из архива' : 'В архив'}>
        <Icon name={archived ? 'refresh' : 'archive'} size={15} />
      </Button>
      <Button variant="ghost" size="icon-sm" className="projects-del" onClick={() => void remove()}
        aria-label={`Удалить проект «${project.name}»`} title="Удалить проект">
        <Icon name="trash" size={15} />
      </Button>
    </span>
  );
}
