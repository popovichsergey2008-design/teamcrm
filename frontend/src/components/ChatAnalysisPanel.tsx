import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { navigate } from '../lib/router';
import { stampLabel } from '../lib/chat-text';
import type { IconName } from './Icon';
import type { ChatAnalysisAction, ChatAnalysisRun, ChatAnalysisSettings } from '../types';

/**
 * «Разбор переписки» в настройках (ТЗ-12, этап 1).
 *
 * Агент читает ЗАТИХШИЕ разговоры в рабочих чатах и показывает, что в них понял.
 * Задач, встреч и решений он пока не создаёт — этот экран существует ровно для того,
 * чтобы посмотреть на своих переписках, попадает ли он, прежде чем давать ему что-то
 * делать. Поэтому главное здесь не настройки, а список с сообщениями-источниками: по
 * ним видно, откуда взялся каждый вывод.
 *
 * Личные переписки и заметки себе не разбираются вовсе — это решение заказчика, и оно
 * стоит в коде сервера, а не переключателем.
 */

const TYPES: Record<string, { label: string; icon: IconName }> = {
  task: { label: 'Задача', icon: 'check' },
  decision: { label: 'Решение', icon: 'flag' },
  meeting: { label: 'Встреча', icon: 'calendar' },
  question: { label: 'Вопрос', icon: 'help' },
  status: { label: 'Статус', icon: 'info' },
  blocker: { label: 'Блокер', icon: 'alert' },
  idea: { label: 'Идея', icon: 'sparkles' },
};

const pct = (v: string | number) => `${Math.round(Number(v ?? 0) * 100)}%`;

/** Что с наблюдением: подпись понятна без расшифровки. */
const STATUS: Record<string, string> = {
  detected: 'замечено',
  ready: 'готово завести',
  needs_clarification: 'не хватает данных',
  confirmed: 'задача заведена',
  rejected: 'отклонено',
};

const chatName = (a: { chat_project_name: string | null; chat_title: string | null }) =>
  a.chat_project_name ?? a.chat_title ?? 'без названия';

export function ChatAnalysisPanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [cfg, setCfg] = useState<ChatAnalysisSettings | null>(null);
  const [actions, setActions] = useState<ChatAnalysisAction[]>([]);
  const [runs, setRuns] = useState<ChatAnalysisRun[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  /** Чем дополнить наблюдение перед заведением: проект и исполнитель, если их нет. */
  const [patch, setPatch] = useState<Record<string, { projectId?: string; assigneeId?: string }>>({});
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<{ id: string; full_name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => {
    api.chatAnalysisSettings().then(setCfg).catch(() => setCfg(null));
    api.chatAnalysisActions().then(setActions).catch(() => setActions([]));
    api.chatAnalysisRuns().then(setRuns).catch(() => setRuns([]));
  };
  useEffect(() => {
    // Справочники нужны только там, где агенту чего-то не хватило.
    api.listProjects().then((r: any[]) => setProjects(r.map((p) => ({ id: String(p.id), name: p.name }))))
      .catch(() => setProjects([]));
    api.listUsers().then((r: any[]) => setPeople(r.map((u) => ({ id: String(u.id), full_name: u.full_name ?? u.fullName }))))
      .catch(() => setPeople([]));
  }, []);
  useEffect(() => { void load(); }, []);

  const save = async (patch: { enabled?: boolean; quietMinutes?: number; askInChat?: boolean }) => {
    setBusy(true); setErr(''); setMsg('');
    try { setCfg(await api.saveChatAnalysisSettings(patch)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const runNow = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.runChatAnalysis();
      setMsg(r.analyzed
        ? `Разобрано разговоров: ${r.analyzed}`
        : 'Затихших разговоров не нашлось — агент разбирает переписку не раньше, чем она замолчит');
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(''); setMsg('');
    try { await fn(); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const confirm = (a: ChatAnalysisAction) => act(async () => {
    const p = patch[a.id] ?? {};
    const r = await api.confirmChatAction(a.id, {
      projectId: p.projectId ?? a.project_id ?? undefined,
      assigneeId: p.assigneeId ?? a.assignee_id ?? undefined,
    });
    setMsg(`Задача «${r.task.title}» заведена`);
  });

  const failed = runs.filter((r) => r.status === 'failed').length;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="sparkles" size={18} /> Разбор переписки</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        <p className="dim ca-intro">
          Агент читает разговоры в рабочих чатах, когда они затихают, и показывает, что понял:
          поручения, решения, договорённости о встречах. <b>Ничего не создаёт</b> — пока это
          только наблюдение, чтобы вы посмотрели, попадает ли он.
          Личные переписки и заметки себе не разбираются.
        </p>

        {cfg && (
          <div className="ca-settings">
            <label className={`gate-item${canManage ? '' : ' gate-item-ro'}`}>
              <input
                type="checkbox"
                checked={cfg.enabled}
                disabled={!canManage || busy}
                onChange={(e) => void save({ enabled: e.target.checked })}
              />
              <span>
                <span className="gate-item-title">Разбирать переписку</span>
                <span className="dim gate-item-hint">
                  Выключено по умолчанию: пока не включите, ничего не читается.
                </span>
              </span>
            </label>
            <label className="field ca-quiet">
              <span>Считать разговор законченным после тишины</span>
              <select
                className="input"
                value={cfg.quiet_minutes}
                disabled={!canManage || busy}
                onChange={(e) => void save({ quietMinutes: Number(e.target.value) })}
              >
                {[10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} минут</option>)}
              </select>
            </label>
            {/*
              Вопрос в чате видят все участники — это должно быть решением владельца,
              а не побочным действием включённого разбора.
            */}
            <label className={`gate-item${canManage ? '' : ' gate-item-ro'}`}>
              <input
                type="checkbox"
                checked={cfg.ask_in_chat}
                disabled={!canManage || busy || !cfg.enabled}
                onChange={(e) => void save({ askInChat: e.target.checked })}
              />
              <span>
                <span className="gate-item-title">Спрашивать в чате, когда непонятно</span>
                <span className="dim gate-item-hint">
                  Не хватило проекта или исполнителя — бот спросит автора поручения одним
                  сообщением. Один раз: если не ответят, переспрашивать не станет.
                </span>
              </span>
            </label>
            {canManage && (
              <button className="btn btn-sm" disabled={busy || !cfg.enabled} onClick={() => void runNow()}>
                <Icon name="refresh" size={14} /> Прогнать сейчас
              </button>
            )}
          </div>
        )}

        <div className="error-text">{err}</div>
        {msg && <div className="dim ca-msg">{msg}</div>}
        {failed > 0 && (
          <div className="dim ca-msg">
            Проходов с ошибкой: {failed}. Сообщения при этом не теряются — они попадут в
            следующий проход.
          </div>
        )}

        <div className="drawer-section-title">Что агент понял</div>
        {!actions.length && (
          <p className="dim">
            {cfg?.enabled
              ? 'Пока ничего. Разбор идёт после того, как разговор затих, — поговорите в рабочем чате и вернитесь.'
              : 'Разбор выключен. Включите его выше, и здесь появится то, что агент увидел в переписке.'}
          </p>
        )}

        <div className="ca-list">
          {actions.map((a) => {
            const t = TYPES[a.action_type] ?? { label: a.action_type, icon: 'info' as IconName };
            const opened = open === a.id;
            return (
              <div key={a.id} className="ca-item">
                <div className="ca-item-head">
                  <span className="ca-type"><Icon name={t.icon} size={13} /> {t.label}</span>
                  <span className="ca-title">{a.title}</span>
                  <span className="dim ca-status">
                    {a.asked_at && a.status === 'needs_clarification' ? 'спросили в чате' : (STATUS[a.status] ?? a.status)}
                  </span>
                </div>
                <div className="dim ca-meta">
                  {[
                    chatName(a),
                    a.project_name,
                    a.assigner_name && a.assignee_name
                      ? `${a.assigner_name} → ${a.assignee_name}`
                      : (a.assignee_name ? `кому: ${a.assignee_name}` : null),
                    a.deadline_at ? `срок ${stampLabel(a.deadline_at)}` : null,
                    a.meeting_at ? `встреча ${stampLabel(a.meeting_at)}` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
                {/*
                  Уверенность по каждому полю отдельно: «понял задачу, но не понял чью» —
                  обычный случай, и одним числом его не показать.
                */}
                <div className="dim ca-conf">
                  смысл {pct(a.intent_confidence)} · проект {pct(a.project_confidence)}
                  {' · '}постановщик {pct(a.assigner_confidence)} · исполнитель {pct(a.assignee_confidence)}
                </div>
                {/*
                  Поручению нужен проект и исполнитель. Чего агент не понял, человек
                  дописывает здесь же — уводить его на другой экран ради двух полей
                  значит потерять половину по дороге.
                */}
                {a.action_type === 'task' && !a.created_entity_id && a.status !== 'rejected' && (
                  <div className="ca-fix">
                    {!a.project_id && (
                      <select
                        className="input"
                        aria-label="Проект задачи"
                        value={patch[a.id]?.projectId ?? ''}
                        onChange={(e) => setPatch((p) => ({ ...p, [a.id]: { ...p[a.id], projectId: e.target.value } }))}
                      >
                        <option value="">Проект не выбран</option>
                        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                    {!a.assignee_id && (
                      <select
                        className="input"
                        aria-label="Исполнитель задачи"
                        value={patch[a.id]?.assigneeId ?? ''}
                        onChange={(e) => setPatch((p) => ({ ...p, [a.id]: { ...p[a.id], assigneeId: e.target.value } }))}
                      >
                        <option value="">Исполнитель не выбран</option>
                        {people.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </select>
                    )}
                  </div>
                )}

                <div className="ca-acts">
                  {a.action_type === 'task' && !a.created_entity_id && a.status !== 'rejected' && (
                    <>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={busy || !(patch[a.id]?.projectId ?? a.project_id)}
                        onClick={() => void confirm(a)}
                        title={!(patch[a.id]?.projectId ?? a.project_id) ? 'Сначала выберите проект' : undefined}
                      >
                        <Icon name="check" size={13} /> Завести задачу
                      </button>
                      <button className="btn btn-ghost btn-sm" disabled={busy}
                        onClick={() => void act(() => api.rejectChatAction(a.id))}>
                        <Icon name="close" size={13} /> Это не задача
                      </button>
                    </>
                  )}
                  {a.created_entity_id && (
                    <button
                      className="btn btn-sm"
                      onClick={() => { navigate({ section: 'projects', projectId: String(a.project_id ?? ''), taskId: String(a.created_entity_id) }); onClose(); }}
                    >
                      <Icon name="check" size={13} /> Открыть задачу
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => setOpen(opened ? null : a.id)}>
                    <Icon name={opened ? 'minus' : 'plus'} size={13} />
                    {' '}Откуда это ({a.sources.length})
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => { navigate({ section: 'chat', chatId: a.chat_id }); onClose(); }}
                  >
                    <Icon name="chat" size={13} /> Открыть чат
                  </button>
                </div>
                {opened && (
                  <div className="ca-sources">
                    {a.sources.map((s) => (
                      <div key={s.messageId} className="ca-source">
                        <span className="dim ca-source-who">
                          {s.author ?? 'бот'} · {stampLabel(s.at)}
                          {s.role !== 'context' && <> · {s.role}</>}
                        </span>
                        <span className="ca-source-body">{s.body}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
