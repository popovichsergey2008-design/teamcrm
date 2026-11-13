import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { api, ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { showToast } from '../../lib/notifications';

/**
 * Проекты без движения 4+ недели (#4890, пп. 7, 10): «Разобрать» — закрыть (в архив, это
 * обратимо — «Вернуть» тут же) или оживить (открыть проект и назначить следующий шаг).
 * Каждый проект — отдельное решение с подтверждением.
 */
export function StaleDialog({ projects, onClose, onChanged }: {
  projects: { id: string; name: string }[]; onClose: () => void; onChanged: () => void;
}) {
  const [ask, setAsk] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, archive: boolean) => {
    setBusy(id);
    try {
      if (archive) await api.archiveProject(id); else await api.unarchiveProject(id);
      setDone((d) => ({ ...d, [id]: archive })); setAsk(null); onChanged();
    } catch (e) { showToast({ kind: 'info', title: 'Не получилось', body: e instanceof ApiError ? e.message : '' }); }
    finally { setBusy(null); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title="Проекты без движения 4+ недели"
      description="Прогноз по ним не построить: за 4 недели ни одной закрытой задачи и никаких изменений. Закройте лишнее или оживите нужное."
      footer={<Button variant="outline" onClick={onClose}>Готово</Button>}>
      {projects.map((p) => (
        <div key={p.id} className="pulse-row">
          <span className="pulse-link pulse-grow">{p.name}</span>
          {done[p.id] ? (
            <>
              <span className="dim">в архиве</span>
              <Button size="sm" variant="ghost" loading={busy === p.id} onClick={() => void act(p.id, false)}>Вернуть</Button>
            </>
          ) : ask === p.id ? (
            <>
              <span className="dim">Убрать в архив?</span>
              <Button size="sm" variant="primary" loading={busy === p.id} onClick={() => void act(p.id, true)}>Да, закрыть</Button>
              <Button size="sm" variant="ghost" onClick={() => setAsk(null)}>Нет</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setAsk(p.id)}>Закрыть</Button>
              <Button size="sm" variant="secondary" onClick={() => { onClose(); navigate({ section: 'projects', projectId: p.id }); }}>Оживить</Button>
            </>
          )}
        </div>
      ))}
    </Dialog>
  );
}
