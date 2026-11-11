import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { EmptyState } from '../EmptyState';
import { Button } from '../ui/button';
import { Dialog, confirmAction } from '../ui/dialog';
import { Input } from '../ui/input';
import { api, ApiError, request } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import './task-trash.css';

interface TrashItem { id: string; title: string; project_id: string; project_name: string; deleted_at: string; deleted_by_name: string | null; delete_reason: string | null }

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/**
 * Корзина задач. Удалённая задача не стирается: она лежит здесь со всеми комментариями,
 * чек-листом и файлами, пока её не вернут или не удалят навсегда. Сервер давно это умел,
 * а экрана не было — окно удаления писало «отменить будет нельзя», хотя было можно.
 * «Вернуть» — тем, у кого право восстанавливать (по умолчанию все сотрудники);
 * «Удалить навсегда» — отдельное право, по умолчанию только у владельца.
 */
export function TaskTrashDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [canPurge, setCanPurge] = useState(false);

  const load = () => api.taskTrash()
    .then((r) => setItems(r.items as TrashItem[]))
    .catch((e) => { setItems([]); setErr(e instanceof ApiError ? e.message : 'Не удалось открыть корзину'); });
  useEffect(() => {
    void load();
    api.securityMe().then((m) => setCanPurge(!!m.permissions['task.delete_permanently']?.allowed)).catch(() => undefined);
  }, []);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items ?? []).filter((t) => !s || `${t.id} ${t.title} ${t.project_name}`.toLowerCase().includes(s.replace(/^#/, '')));
  }, [items, q]);

  const restore = async (t: TrashItem) => {
    setBusy(t.id); setErr('');
    try {
      await api.restoreTask(t.id);
      setItems((cur) => (cur ?? []).filter((x) => x.id !== t.id));
      toastSaved(`Задача #${t.id} возвращена в проект «${t.project_name}»`);
      onChanged?.();
      window.dispatchEvent(new Event('teamcrm:tasks-changed'));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось вернуть задачу'); } finally { setBusy(null); }
  };

  const purge = async (t: TrashItem) => {
    if (!(await confirmAction({
      title: `Удалить задачу #${t.id} навсегда?`,
      description: 'Комментарии, чек-лист и вложения исчезнут без возможности вернуть. Учтённые часы останутся в себестоимости проекта.',
      confirmLabel: 'Удалить навсегда', danger: true,
    }))) return;
    setBusy(t.id); setErr('');
    try {
      await request('DELETE', `/tasks/${t.id}?permanent=1&confirmTimeLoss=1`);
      setItems((cur) => (cur ?? []).filter((x) => x.id !== t.id));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось удалить'); } finally { setBusy(null); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title={<><Icon name="trash" size={16} /> Корзина задач</>}
      description="Удалённые задачи хранятся здесь вместе с комментариями, чек-листом и файлами. Вернуть — задача встанет на прежнее место в своём проекте."
      footer={<Button variant="ghost" onClick={onClose}>Закрыть</Button>}>
      {items === null ? <div className="dim">Загружаю…</div> : (
        <>
          {items.length > 5 && (
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти: номер, название или проект" aria-label="Поиск в корзине" style={{ marginBottom: 10 }} />
          )}
          {err && <p className="error-text" role="alert">{err}</p>}
          {!items.length && !err && <EmptyState compact icon="trash" title="Корзина пуста" hint="Удалённые задачи появятся здесь — их можно будет вернуть." />}
          {items.length > 0 && !shown.length && <p className="dim">Ничего не нашлось.</p>}
          <ul className="trash-list">
            {shown.map((t) => (
              <li key={t.id} className="trash-row">
                <div className="trash-main">
                  <div className="trash-title"><span className="dim">#{t.id}</span> {t.title}</div>
                  <div className="trash-meta dim">
                    <button type="button" className="bb-link" onClick={() => { onClose(); navigate({ section: 'projects', projectId: t.project_id }); }}>{t.project_name}</button>
                    {' · '}удалена {when(t.deleted_at)}{t.deleted_by_name ? ` · ${t.deleted_by_name}` : ''}
                    {t.delete_reason ? ` · «${t.delete_reason}»` : ''}
                  </div>
                </div>
                <div className="trash-actions">
                  <Button size="sm" variant="outline" loading={busy === t.id} onClick={() => void restore(t)}><Icon name="reply" size={13} /> Вернуть</Button>
                  {canPurge && (
                    <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => void purge(t)} aria-label={`Удалить #${t.id} навсегда`} title="Удалить навсегда">
                      <Icon name="trash" size={13} />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
