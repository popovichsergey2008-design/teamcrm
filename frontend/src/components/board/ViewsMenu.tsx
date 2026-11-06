import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { confirmAction, promptText } from '../ui/dialog';
import { useDismiss } from '../../hooks/useDismiss';
import { flowApi, type BoardView } from '../../lib/flow-api';
import { ApiError } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import type { BoardQuery } from '../../lib/board-query';

/**
 * Сохранённые виды доски (#4798 §12, #4799 BOARD06): «Задачи Анны на этой неделе»
 * одним нажатием. Личный видит только автор; общий — все, кто видит проект, но задачи
 * в нём всё равно отбираются по правам смотрящего: вид — это условия, а не доступ.
 */
export function ViewsMenu({ projectId, userId, isBoss, query, onApply, activeViewId }: {
  projectId: string;
  userId: string;
  isBoss: boolean;
  query: BoardQuery;
  onApply: (v: BoardView) => void;
  activeViewId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<BoardView[]>([]);
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState('');
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, '.bb-views-btn');
  const load = useCallback(() => { flowApi.views(projectId).then(setViews).catch(() => setViews([])); }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setErr('');
    const name = await promptText({ title: 'Сохранить вид', description: 'Сохранятся режим, роли, быстрые условия, фильтры и поиск.', placeholder: 'Например: Задачи Анны на этой неделе', confirmLabel: 'Сохранить', singleLine: true });
    if (!name?.trim()) return;
    try {
      await flowApi.createView(projectId, { name: name.trim(), query: query as unknown as Record<string, unknown>, shared: isBoss && shared });
      toastSaved('Вид сохранён', name.trim());
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить вид'); }
  };
  const rename = async (v: BoardView) => {
    const name = await promptText({ title: 'Переименовать вид', defaultValue: v.name, confirmLabel: 'Сохранить', singleLine: true });
    if (!name?.trim()) return;
    try { await flowApi.updateView(v.id, { name: name.trim() }); load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось'); }
  };
  const remove = async (v: BoardView) => {
    if (!(await confirmAction({ title: `Удалить вид «${v.name}»?`, description: 'Задачи не изменятся — удаляются только сохранённые условия.', danger: true }))) return;
    try { await flowApi.deleteView(v.id); load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось'); }
  };
  const copy = (v: BoardView) => {
    const url = `${window.location.origin}/projects/${projectId}?view=${v.id}`;
    navigator.clipboard?.writeText(url).then(() => toastSaved('Ссылка на вид скопирована', v.shared ? 'Коллега увидит только задачи, доступные ему' : 'Вид личный — коллеге он не откроется')).catch(() => undefined);
  };
  const mayEdit = (v: BoardView) => String(v.owner_id) === String(userId) || (v.shared && isBoss);
  const active = views.find((v) => v.id === activeViewId);

  return (
    <span className="bb-pop-wrap">
      <Button variant={active ? 'secondary' : 'outline'} size="sm" className="bb-views-btn" aria-label="Сохранённые виды" aria-expanded={open} onClick={() => setOpen((x) => !x)} title="Сохранённые подборки задач">
        <Icon name="star" size={15} /> <span className="bb-lbl">{active ? active.name : 'Виды'}</span>
      </Button>
      {open && (
        <div className="bb-pop bb-pop-right" data-pop role="dialog" aria-label="Сохранённые виды">
          {views.length === 0 && <p className="bb-note">Сохранённых видов пока нет. Настройте условия и сохраните их под понятным именем.</p>}
          {views.map((v) => (
            <div key={v.id} className="bb-views-row">
              <button className="bb-link" onClick={() => { onApply(v); setOpen(false); }} title="Открыть вид — задачи по вашим правам">
                {v.name} <span className="bb-views-scope">{v.shared ? `· общий${v.owner_name ? `, ${v.owner_name}` : ''}` : '· личный'}</span>
              </button>
              <Button variant="ghost" size="icon-sm" onClick={() => copy(v)} aria-label={`Ссылка на вид «${v.name}»`} title="Скопировать ссылку"><Icon name="link" size={14} /></Button>
              {mayEdit(v) && <Button variant="ghost" size="icon-sm" onClick={() => void rename(v)} aria-label={`Переименовать «${v.name}»`} title="Переименовать"><Icon name="edit" size={14} /></Button>}
              {mayEdit(v) && <Button variant="ghost" size="icon-sm" onClick={() => void remove(v)} aria-label={`Удалить «${v.name}»`} title="Удалить"><Icon name="trash" size={14} /></Button>}
            </div>
          ))}
          <div className="bb-pop-sep" />
          {isBoss && <Checkbox checked={shared} onCheckedChange={(c) => setShared(!!c)} label="Общий — виден всем, кто видит проект" />}
          <Button variant="outline" size="sm" onClick={() => void save()}><Icon name="plus" size={14} /> Сохранить текущий вид</Button>
          <p className="bb-note">Вид хранит условия, а не доступ: каждый увидит в нём только свои доступные задачи.</p>
          {err && <p className="bb-note" role="alert">{err}</p>}
        </div>
      )}
    </span>
  );
}
