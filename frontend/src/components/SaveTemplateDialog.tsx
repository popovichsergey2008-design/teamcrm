import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import type { Task } from '../types';

/**
 * «Сохранить как шаблон» — просьба заказчика.
 *
 * Зачем спрашивать имя. В списке шаблонов «Сверстать лендинг для Ромашки» бесполезно:
 * там нужно «Лендинг под клиента». Поэтому имя отдельное от названия задачи, и
 * подставлено заранее — чаще всего его достаточно поправить, а не придумывать.
 *
 * Тут же сказано, что именно уедет в шаблон и чего в нём не будет. Иначе человек
 * узнаёт об этом, только поставив по шаблону задачу и не найдя в ней вложений.
 */
export function SaveTemplateDialog({ task, checklistCount, onClose, onSaved }: {
  task: Task;
  /** Сколько пунктов чек-листа уедет в шаблон: считает карточка, она их уже загрузила. */
  checklistCount: number;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  useEscape(onClose);
  const [name, setName] = useState(task.title ?? '');
  /*
    Срок шаблона — «через N дней», а не дата.

    Считаем по остатку у задачи: у еженедельного отчёта это как раз и даст неделю.
    Пусто — значит задача по шаблону заводится без срока; так же поступаем, если срок
    уже прошёл, потому что подставлять вчерашний день хуже, чем не подставлять ничего.
  */
  const [days, setDays] = useState(() => {
    if (!task.deadline_at) return '';
    const left = Math.round((new Date(task.deadline_at).getTime() - Date.now()) / 86_400_000);
    return left > 0 ? String(Math.min(left, 365)) : '';
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setName(task.title ?? ''); }, [task.title]);

  const save = async () => {
    const clean = name.trim();
    if (clean.length < 2) { setErr('Назовите шаблон — по имени его будут искать'); return; }
    setBusy(true); setErr('');
    try {
      await api.saveTaskTemplate(String(task.id), {
        name: clean,
        deadlineDays: days.trim() === '' ? null : Number(days),
      });
      onSaved(clean);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Шаблон не сохранился');
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
      <div className="modal-card tpl-card" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="copy" size={16} /> Сохранить как шаблон</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="field">
          <label htmlFor="tpl-name">Название шаблона</label>
          <input
            id="tpl-name"
            className="input"
            value={name}
            autoFocus
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
            placeholder="Например: Подключение домена клиенту"
          />
          <span className="dim tpl-hint">Под этим именем шаблон будет в списке при создании задачи.</span>
        </div>

        <div className="field">
          <label htmlFor="tpl-days">Срок задачи по шаблону</label>
          <div className="tpl-days">
            <span className="dim">через</span>
            <input
              id="tpl-days"
              className="input"
              type="number"
              min={0}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              placeholder="—"
            />
            <span className="dim">дней после постановки</span>
          </div>
          <span className="dim tpl-hint">Пусто — задача по шаблону заводится без срока.</span>
        </div>

        <div className="tpl-what">
          <div className="drawer-section-title">Что уедет в шаблон</div>
          <ul className="tpl-list">
            <li>название и описание</li>
            <li>приоритет, оценка, согласование при завершении</li>
            {!!checklistCount && <li>чек-лист — {checklistCount} {plural(checklistCount)}</li>}
            {!!task.labels?.length && <li>теги — {task.labels.map((l) => l.name).join(', ')}</li>}
            {!!task.assignee_id && <li>привычный исполнитель</li>}
          </ul>
          <div className="dim tpl-hint">
            Не уедут проект, колонка и вложения: задача по шаблону заводится там, где её заводят,
            а файлы всегда про конкретный случай.
          </div>
        </div>

        {err && <div className="error-text">{err}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Сохраняю…' : 'Сохранить шаблон'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** «1 пункт», «2 пункта», «5 пунктов» — иначе строка читается как машинная. */
function plural(n: number): string {
  const ten = n % 100;
  if (ten >= 11 && ten <= 14) return 'пунктов';
  const one = n % 10;
  if (one === 1) return 'пункт';
  if (one >= 2 && one <= 4) return 'пункта';
  return 'пунктов';
}
