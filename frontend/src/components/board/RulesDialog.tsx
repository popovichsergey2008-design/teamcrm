import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Select } from '../ui/select';
import { Badge } from '../ui/badge';
import { flowApi, type RulesView } from '../../lib/flow-api';
import { ApiError } from '../../lib/api';
import './rules.css';

const TRIGGERS = [
  { value: 'handed_to_review', label: 'задача передана на проверку' },
  { value: 'returned', label: 'задача возвращена на доработку' },
  { value: 'deadline_soon', label: 'до срока меньше суток' },
  { value: 'dependency_done', label: 'завершена задача, которую ждут другие' },
  { value: 'accepted', label: 'результат принят' },
];
const ACTIONS = [
  { value: 'notify_reviewer', label: 'уведомить проверяющего' },
  { value: 'notify_creator', label: 'уведомить постановщика' },
  { value: 'notify_assignee', label: 'уведомить исполнителя' },
  { value: 'notify_watchers', label: 'уведомить наблюдателей' },
  { value: 'notify_dependents', label: 'сообщить зависимым задачам, что можно продолжать' },
];

/**
 * Правила доски «Когда X — тогда Y» (#4798 §18, #4799 BOARD10).
 *
 * Действие — только сообщение: автоархив, автозакрытие и перенос здесь не предусмотрены
 * вовсе. Перед включением правило показывается на недавних задачах — предпросмотр
 * ничего не меняет. Журнал показывает, что и когда сработало; одно событие — одно
 * сообщение, тишина фокуса соблюдается центром уведомлений.
 */
export function RulesDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [data, setData] = useState<RulesView | null>(null);
  const [trigger, setTrigger] = useState('handed_to_review');
  const [action, setAction] = useState('notify_reviewer');
  const [preview, setPreview] = useState<{ sentence: string; examples: { id: string; title: string; recipients: string[] }[] } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { flowApi.rules(projectId).then(setData).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить правила')); }, [projectId]);
  useEffect(() => { setPreview(null); }, [trigger, action]);

  const run = async (fn: () => Promise<RulesView>) => {
    setBusy(true); setErr('');
    try { setData(await fn()); setPreview(null); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };
  const showPreview = async () => {
    setErr('');
    try { setPreview(await flowApi.previewRule(projectId, trigger, action)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };
  const ruleName = (id: string) => data?.rules.find((r) => r.id === id)?.sentence ?? 'Правило';

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Правила доски" description="Простые правила только уведомляют. Задачи сами не закрываются, не переносятся и не архивируются." size="lg">
      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      <div className="rules-list">
        {data?.rules.length === 0 && <p className="dim">Правил пока нет. Начните с готового или соберите своё ниже.</p>}
        {data?.rules.map((r) => (
          <div key={r.id} className="rules-row">
            <div>
              <div>{r.sentence}</div>
              <div className="dim">{r.author_name ? `Включил ${r.author_name}` : ''}{r.runs ? ` · сработало ${r.runs} раз` : ' · ещё не срабатывало'}</div>
            </div>
            <Badge tone={r.enabled ? 'ok' : 'neutral'}>{r.enabled ? 'работает' : 'на паузе'}</Badge>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => flowApi.toggleRule(projectId, r.id, !r.enabled))}>{r.enabled ? 'Пауза' : 'Включить'}</Button>
            <Button variant="ghost" size="icon-sm" disabled={busy} aria-label="Удалить правило" onClick={() => void run(() => flowApi.deleteRule(projectId, r.id))}><Icon name="trash" size={14} /></Button>
          </div>
        ))}
      </div>

      {!!data?.presets.filter((p) => !data.rules.some((r) => r.trigger === p.trigger && r.action === p.action)).length && (
        <>
          <h4 className="rules-h">Готовые правила</h4>
          {data.presets.filter((p) => !data.rules.some((r) => r.trigger === p.trigger && r.action === p.action)).map((p) => (
            <div key={`${p.trigger}-${p.action}`} className="rules-row">
              <div>{p.sentence}</div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setTrigger(p.trigger); setAction(p.action); }}>Посмотреть</Button>
            </div>
          ))}
        </>
      )}

      <h4 className="rules-h">Своё правило</h4>
      <div className="rules-build">
        <span>Когда</span>
        <Select ariaLabel="Когда" size="sm" value={trigger} onValueChange={setTrigger} options={TRIGGERS} />
        <span>тогда</span>
        <Select ariaLabel="Тогда" size="sm" value={action} onValueChange={setAction} options={ACTIONS} />
      </div>
      <div className="rules-actions">
        <Button variant="outline" size="sm" onClick={() => void showPreview()}>Посмотреть на примерах</Button>
        <Button variant="primary" size="sm" disabled={busy || !preview} onClick={() => void run(() => flowApi.addRule(projectId, trigger, action))} title={preview ? '' : 'Сначала посмотрите, как правило сработает'}>Включить правило</Button>
      </div>
      {preview && (
        <div className="rules-preview">
          <b>{preview.sentence}.</b>
          {preview.examples.length === 0
            ? <p className="dim">За последний месяц подходящих задач не было — правило начнёт работать с новых событий.</p>
            : preview.examples.map((e) => (
              <p key={e.id}>#{e.id} «{e.title}» → {e.recipients.length ? `сообщение получат: ${e.recipients.join(', ')}` : 'получателей нет — сообщение не уйдёт'}</p>
            ))}
          <p className="dim">Это только предпросмотр: задачи не меняются, сообщения не отправляются.</p>
        </div>
      )}

      {!!data?.runs.length && (
        <>
          <h4 className="rules-h">Журнал срабатываний</h4>
          <div className="rules-log">
            {data.runs.map((x) => (
              <div key={x.id} className="dim">
                {new Date(x.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {ruleName(x.rule_id)}
                {x.task_id ? ` · #${x.task_id} ${x.title ?? ''}` : ''} · получателей: {x.recipients}
              </div>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}
