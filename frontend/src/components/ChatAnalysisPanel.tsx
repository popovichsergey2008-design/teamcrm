import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { navigate } from '../lib/router';
import { stampLabel } from '../lib/chat-text';
import type { IconName } from './Icon';
import type { ChatAnalysisAction, ChatAnalysisRun, ChatAnalysisSettings, ChatAnalysisStats } from '../types';

/**
 * «Разбор переписки» в настройках (ТЗ-12, этапы 1–4).
 *
 * Агент читает ЗАТИХШИЕ разговоры в рабочих чатах и показывает, что в них понял. По
 * умолчанию он только предлагает — задачу заводит человек. Автосоздание владелец
 * включает сам, и рядом с переключателем стоят счётчики попадания на ЕГО переписках:
 * решение должно опираться на цифры, а не на наше обещание. Главное на экране — список
 * с сообщениями-источниками: по ним видно, откуда взялся каждый вывод.
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
  auto_created: 'агент завёл сам',
  cancelled: 'отменено',
  rejected: 'отклонено',
};

const share = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

const chatName = (a: { chat_project_name: string | null; chat_title: string | null }) =>
  a.chat_project_name ?? a.chat_title ?? 'без названия';

export function ChatAnalysisPanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [cfg, setCfg] = useState<ChatAnalysisSettings | null>(null);
  const [actions, setActions] = useState<ChatAnalysisAction[]>([]);
  const [runs, setRuns] = useState<ChatAnalysisRun[]>([]);
  const [stats, setStats] = useState<ChatAnalysisStats | null>(null);
  /** Потолок расхода, как его набирают: пустая строка — без потолка. */
  const [limit, setLimit] = useState('');
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
    api.chatAnalysisStats().then(setStats).catch(() => setStats(null));
  };
  useEffect(() => {
    setLimit(cfg?.monthly_limit_usd != null ? String(Number(cfg.monthly_limit_usd)) : '');
  }, [cfg?.monthly_limit_usd]);
  useEffect(() => {
    // Справочники нужны только там, где агенту чего-то не хватило.
    api.listProjects().then((r: any[]) => setProjects(r.map((p) => ({ id: String(p.id), name: p.name }))))
      .catch(() => setProjects([]));
    api.listUsers().then((r: any[]) => setPeople(r.map((u) => ({ id: String(u.id), full_name: u.full_name ?? u.fullName }))))
      .catch(() => setPeople([]));
  }, []);
  useEffect(() => { void load(); }, []);

  const save = async (patch: {
    enabled?: boolean; quietMinutes?: number; askInChat?: boolean; mode?: string; monthlyLimitUsd?: number | null;
  }) => {
    setBusy(true); setErr(''); setMsg('');
    try {
      setCfg(await api.saveChatAnalysisSettings(patch));
      api.chatAnalysisStats().then(setStats).catch(() => undefined);
    }
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

  const undo = (a: ChatAnalysisAction) => act(async () => {
    await api.undoChatAction(a.id);
    setMsg(`Задача «${a.title}» отменена и убрана в корзину`);
  });

  const saveLimit = () => {
    const v = limit.trim().replace(',', '.');
    if (!v) return void save({ monthlyLimitUsd: null });
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { setErr('Потолок — число долларов, например 20'); return; }
    void save({ monthlyLimitUsd: Math.round(n * 100) / 100 });
  };

  const failed = runs.filter((r) => r.status === 'failed').length;
  const q = stats?.quality;

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
          поручения, решения, договорённости о встречах. {cfg?.mode === 'auto_high'
            ? <>Готовые поручения <b>заводит сам</b> и пишет об этом в чат; ошибку можно отменить в течение суток.</>
            : <><b>Сам ничего не создаёт</b> — задачу заводите вы, одним нажатием.</>}
          {' '}Личные переписки и заметки себе не разбираются.
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
            {/*
              Автосоздание — решение заказчика: по умолчанию выключено. Рядом стоят цифры
              с переписок этой компании: включать его стоит, когда агент попадает, а не
              когда поверили на слово.
            */}
            <div className="ca-mode">
              <span className="gate-item-title">Что делать с понятым поручением</span>
              {[
                { v: 'suggest', t: 'Только предлагать', h: 'Задачу заводит человек в этом окне. Так по умолчанию.' },
                {
                  v: 'auto_high',
                  t: 'Заводить самому, когда понятно всё',
                  h: 'Только если ясно, что это поручение, в каком проекте, от кого и кому. Исполнитель и постановщик получат письмо с пометкой «по итогам переписки», в чате появится сообщение. Отменить можно в течение суток.',
                },
              ].map((o) => (
                <label key={o.v} className={`gate-item${canManage ? '' : ' gate-item-ro'}`}>
                  <input
                    type="radio"
                    name="ca-mode"
                    checked={cfg.mode === o.v}
                    disabled={!canManage || busy || !cfg.enabled}
                    onChange={() => void save({ mode: o.v })}
                  />
                  <span>
                    <span className="gate-item-title">{o.t}</span>
                    <span className="dim gate-item-hint">{o.h}</span>
                  </span>
                </label>
              ))}
            </div>

            {q && (
              <div className="ca-quality">
                <div className="gate-item-title">Как агент попадает — за 30 дней</div>
                <div className="dim ca-quality-row">
                  Нашёл поручений: {q.tasksDetected} · заведено: {q.confirmed + q.autoCreated}
                  {' '}· отклонено и отменено: {q.rejected + q.undone} · ждут: {q.ready + q.needsClarification}
                </div>
                <div className="dim ca-quality-row">
                  Промахи: {share(q.rejectRate)} поручений оказались не задачей или отменены;
                  {' '}{share(q.correctionRate)} заведённых пришлось поправить (проект или исполнитель).
                  {q.duplicates > 0 && <> Повторов отсечено: {q.duplicates}.</>}
                </div>
                {!q.enoughData && (
                  <div className="dim ca-quality-row">
                    Рассмотрено {q.reviewed} из {20} нужных, чтобы этим цифрам верить.
                    {cfg.mode !== 'auto_high' && ' Автосоздание разумно включать после.'}
                  </div>
                )}
              </div>
            )}

            {canManage && (
              <label className="field ca-limit">
                <span>Потолок расхода на разбор в месяц, $</span>
                <span className="ca-limit-row">
                  <input
                    className="input"
                    inputMode="decimal"
                    placeholder="без потолка"
                    value={limit}
                    disabled={busy}
                    onChange={(e) => setLimit(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveLimit(); }}
                  />
                  <button className="btn btn-sm" disabled={busy} onClick={saveLimit}>Сохранить</button>
                </span>
                {stats && (
                  <span className={stats.limitReached ? 'error-text' : 'dim'}>
                    Потрачено в этом месяце: ${stats.spentUsd.toFixed(2)}
                    {stats.limitReached && ' — потолок достигнут, разбор стоит до следующего месяца. Переписка не теряется: её разберут, когда поднимете потолок.'}
                  </span>
                )}
              </label>
            )}

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
                {a.action_type === 'task' && !a.created_entity_id && !['rejected', 'cancelled'].includes(a.status) && (
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
                  {a.action_type === 'task' && !a.created_entity_id && !['rejected', 'cancelled'].includes(a.status) && (
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
                  {/* Отмена — только у заведённого агентом и только сутки; остальное сервер проверит сам. */}
                  {a.status === 'auto_created'
                    && Date.now() - new Date(a.updated_at).getTime() < 24 * 3600_000 && (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void undo(a)}>
                      <Icon name="close" size={13} /> Отменить задачу
                    </button>
                  )}
                  {a.created_entity_id && a.status !== 'cancelled' && (
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
