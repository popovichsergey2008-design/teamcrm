import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { AiSettingsSection } from './AiSettingsPanel';
import { PromptsSection } from './PromptsPanel';

/** Интеграции: подключения (Битрикс24) + ключи ИИ + промпты (PromptOps). */
export function IntegrationsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'bitrix' | 'ai' | 'prompts'>('bitrix');
  const [conns, setConns] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ webhookUrl: '', label: '' });
  const [openCid, setOpenCid] = useState<string | null>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };
  const reload = () => api.bitrixConnections().then(setConns).catch(() => setConns([]));
  useEffect(() => { reload(); }, []);

  const connect = async () => {
    if (!form.webhookUrl.trim()) return flash('Вставьте URL вебхука');
    try {
      await api.bitrixConnect(form.webhookUrl.trim(), form.label.trim() || undefined);
      setForm({ webhookUrl: '', label: '' });
      flash('Портал подключён'); reload();
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка подключения'); }
  };

  const disconnect = async (cid: string) => {
    if (!window.confirm('Отключить портал? Импортированные проекты останутся.')) return;
    try { await api.bitrixDisconnect(cid); if (openCid === cid) setOpenCid(null); reload(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>Интеграции</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="tabs">
          <button className={`tab ${tab === 'bitrix' ? 'active' : ''}`} onClick={() => setTab('bitrix')}>Битрикс24</button>
          <button className={`tab ${tab === 'ai' ? 'active' : ''}`} onClick={() => setTab('ai')}>ИИ (ключи и модель)</button>
          <button className={`tab ${tab === 'prompts' ? 'active' : ''}`} onClick={() => setTab('prompts')}>Промпты</button>
        </div>
        {msg && <div className="dim">{msg}</div>}

        {tab === 'ai' && <AiSettingsSection />}
        {tab === 'prompts' && <PromptsSection />}

        {tab === 'bitrix' && (<>
        <div className="drawer-section-title">Подключить портал (входящий вебхук)</div>
        <div className="add-user">
          <input className="input add-user-input" placeholder="URL вебхука (https://portal.bitrix24.ru/rest/…/…/)" value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} />
          <input className="input add-user-input" placeholder="Название (напр. «Основной»)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={connect}>Подключить и проверить</button>
          <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>В Битриксе: Разработчикам → Другое → Входящий вебхук, права <b>task, user, sonet_group</b>; для вложений — <b>disk</b>, для общей ленты — <b>log</b>. Права можно дописать в существующий вебхук (URL не меняется).</div>
        </div>

        <div className="drawer-section-title">Подключённые порталы ({conns.length})</div>
        {conns.length === 0 && <div className="muted">Пока нет подключений</div>}
        {conns.map((c) => (
          <div key={c.id} className="team-row">
            <div className="team-head">
              <span>{c.label || c.portal} <span className="dim" style={{ fontSize: 12 }}>{c.portal}</span></span>
              <span>
                <button className="btn btn-ghost btn-sm" onClick={() => setOpenCid(openCid === c.id ? null : c.id)}>{openCid === c.id ? 'Скрыть' : 'Импорт'}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => disconnect(c.id)}>Отключить</button>
              </span>
            </div>
            <div className="invite-box">
              Живая синхронизация: в Битриксе создайте <b>исходящий вебхук</b> на этот URL (события ONTASKADD / ONTASKUPDATE / ONTASKDELETE / ONTASKCOMMENTADD):
              <input className="input" readOnly value={`${window.location.origin}/api/integrations/bitrix/events/${c.event_token}`} onFocus={(e) => e.currentTarget.select()} />
              {c.last_event_at && <span className="dim" style={{ fontSize: 12 }}>Последнее событие: {new Date(c.last_event_at).toLocaleString('ru-RU')}</span>}
            </div>
            {openCid === c.id && <ImportBlock cid={c.id} />}
          </div>
        ))}
        </>)}
      </aside>
    </div>
  );
}

function ImportBlock({ cid }: { cid: string }) {
  const [projects, setProjects] = useState<{ externalId: string; name: string }[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [feed, setFeed] = useState(false);
  const [run, setRun] = useState<any>(null);
  const [unmatched, setUnmatched] = useState<{ total: number; items: any[] }>({ total: 0, items: [] });
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  const [mapPick, setMapPick] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');

  // Список несопоставленных НЕ грузим автоматически — на больших порталах это тысячи юзеров.
  // Загружаем только по явному клику; матчинг команды по e-mail при импорте идёт независимо.
  const loadUnmatched = () => api.bitrixUnmatched(cid).then(setUnmatched).catch(() => undefined);
  useEffect(() => {
    api.bitrixProjects(cid).then(setProjects).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось получить проекты'));
    api.listUsers().then(setUsers).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  const mapUser = async (externalId: string) => {
    const localUserId = mapPick[externalId];
    if (!localUserId) return;
    try { await api.bitrixMapUser(cid, externalId, localUserId); loadUnmatched(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка привязки'); }
  };

  const startImport = async () => {
    const ids = Object.keys(picked).filter((k) => picked[k]);
    if (!ids.length && !feed) return setErr('Отметьте проекты или общую ленту');
    setErr('');
    try {
      const { runId } = await api.bitrixImport(cid, ids, feed);
      setRun({ status: 'queued' });
      poll(runId);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка запуска'); }
  };

  const poll = (runId: string) => {
    const tick = async () => {
      try {
        const r = await api.bitrixRun(runId);
        setRun(r);
        if (r.status === 'done' || r.status === 'error') {
          if (r.status === 'done') setTimeout(() => window.location.reload(), 1200); // подтянуть новые проекты в сайдбар
          return;
        }
      } catch { /* ignore */ }
      setTimeout(tick, 800);
    };
    tick();
  };

  return (
    <div style={{ marginTop: 8 }}>
      {err && <div className="error-text">{err}</div>}
      <DiagnosticsBar cid={cid} />
      <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Проекты Битрикса:</div>
      {projects.map((p) => (
        <label key={p.externalId} className="notify-row" style={{ padding: '4px 0' }}>
          <input type="checkbox" checked={!!picked[p.externalId]} onChange={(e) => setPicked((s) => ({ ...s, [p.externalId]: e.target.checked }))} />
          {p.name}
        </label>
      ))}
      <label className="notify-row" style={{ padding: '4px 0' }}>
        <input type="checkbox" checked={feed} onChange={(e) => setFeed(e.target.checked)} />
        Общая Живая лента компании → «Входящие из Битрикса»
      </label>
      <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={startImport} disabled={run && run.status === 'running'}>
        Импортировать выбранные
      </button>
      {run && (
        <div className="dim" style={{ marginTop: 6, fontSize: 13 }}>
          {run.status === 'queued' && 'В очереди…'}
          {run.status === 'running' && 'Импорт идёт…'}
          {run.status === 'error' && <span className="error-text">Ошибка: {run.error}</span>}
          {run.status === 'done' && run.stats && `Готово: проектов ${run.stats.projects ?? 0}, задач ${run.stats.tasks ?? 0}, комментариев ${run.stats.comments ?? 0}, постов ленты ${run.stats.messages ?? 0}. Обновляем…`}
          {run.status === 'done' && Array.isArray(run.stats?.warnings) && run.stats.warnings.map((w: string, idx: number) => (
            <div key={idx} className="error-text" style={{ fontSize: 12 }}>⚠ {w}</div>
          ))}
        </div>
      )}

      <UngroupedBlock cid={cid} />

      {!showUnmatched && (
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => { setShowUnmatched(true); loadUnmatched(); }}>
          Сопоставить исполнителей вручную (необязательно)
        </button>
      )}
      {showUnmatched && unmatched.total === 0 && (
        <div className="dim" style={{ marginTop: 10, fontSize: 12 }}>Несопоставленных нет (или список ещё грузится).</div>
      )}
      {showUnmatched && unmatched.total > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
            Не сопоставлены по e-mail: {unmatched.total}. Привязка <b>необязательна</b> — никого в вашу команду не добавляем, несопоставленные задачи просто останутся без исполнителя.
            {unmatched.total > unmatched.items.length ? ` Показаны первые ${unmatched.items.length}.` : ''}
          </div>
          {unmatched.items.map((u) => (
            <div key={u.externalId} className="team-rate" style={{ marginBottom: 4 }}>
              <span style={{ flex: 1, fontSize: 13 }}>{u.name} <span className="dim">{u.email}</span></span>
              <select className="input" value={mapPick[u.externalId] ?? ''} onChange={(e) => setMapPick((m) => ({ ...m, [u.externalId]: e.target.value }))}>
                <option value="">— наш сотрудник —</option>
                {users.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
              </select>
              <button className="btn btn-sm" onClick={() => mapUser(u.externalId)}>Привязать</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Диагностика подключения: права вебхука + что реально отдаёт портал. */
function DiagnosticsBar({ cid }: { cid: string }) {
  const [rep, setRep] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const run = async () => {
    setErr(''); setLoading(true); setRep(null);
    try { setRep(await api.bitrixDiagnostics(cid)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка диагностики'); }
    finally { setLoading(false); }
  };

  const has = (s: string) => Array.isArray(rep?.scopes) && rep.scopes.includes(s);
  const line = (label: string, v: { count: number | null; error: string | null }) =>
    v.error ? `${label}: ошибка — ${v.error}` : `${label}: ${v.count ?? 0}`;

  return (
    <div style={{ marginBottom: 10 }}>
      <button className="btn btn-ghost btn-sm" onClick={run} disabled={loading}>
        {loading ? 'Проверяю…' : '🔍 Диагностика подключения'}
      </button>
      {err && <div className="error-text">{err}</div>}
      {rep && (
        <div className="invite-box" style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>
          <div>
            <b>Права вебхука:</b> {rep.scopesError ? `ошибка — ${rep.scopesError}` : (rep.scopes.join(', ') || '—')}
          </div>
          {!rep.scopesError && (
            <div className="dim" style={{ fontSize: 12 }}>
              {has('task') ? '✓ task' : '✗ task (нужен для задач)'} · {has('log') ? '✓ log' : '✗ log — лента недоступна, добавьте право log'} · {has('sonet_group') ? '✓ sonet_group' : '✗ sonet_group'} · {has('disk') ? '✓ disk' : '✗ disk (вложения)'}
            </div>
          )}
          <div>{line('Группы (проекты)', rep.groups)}</div>
          <div>{line('Задачи без группы', rep.ungrouped)}</div>
          {rep.ungrouped.count === 0 && !rep.ungrouped.error && (
            <div className="dim" style={{ fontSize: 12 }}>0 — либо все задачи в группах, либо вебхук создан не под администратором (Битрикс отдаёт только задачи пользователя вебхука).</div>
          )}
          <div>{line('Посты общей ленты', rep.feed)}</div>
        </div>
      )}
    </div>
  );
}

/** ИИ-раскладка задач вне проектов (GROUP_ID=0): предпросмотр → правка → применение. */
function UngroupedBlock({ cid }: { cid: string }) {
  const [ana, setAna] = useState<{ projects: { id: string; name: string }[]; tasks: { externalId: string; title: string; suggestedProjectId: string | null; confidence: number }[] } | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({}); // externalId → projectId ('' = Входящие)
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState<any>(null);
  const [err, setErr] = useState('');

  const analyze = async () => {
    setErr(''); setLoading(true); setRun(null);
    try {
      const res = await api.bitrixAnalyzeUngrouped(cid);
      setAna(res);
      const init: Record<string, string> = {};
      for (const t of res.tasks) init[t.externalId] = t.suggestedProjectId ?? '';
      setPick(init);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось получить задачи'); }
    finally { setLoading(false); }
  };

  const apply = async () => {
    if (!ana) return;
    setErr('');
    const assignments = ana.tasks.map((t) => ({ externalId: t.externalId, projectId: pick[t.externalId] || null }));
    try {
      const { runId } = await api.bitrixApplyUngrouped(cid, assignments);
      setRun({ status: 'queued' });
      const tick = async () => {
        try {
          const r = await api.bitrixRun(runId);
          setRun(r);
          if (r.status === 'done' || r.status === 'error') {
            if (r.status === 'done') setTimeout(() => window.location.reload(), 1200);
            return;
          }
        } catch { /* ignore */ }
        setTimeout(tick, 800);
      };
      tick();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка применения'); }
  };

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 10 }}>
      <div className="drawer-section-title" style={{ marginBottom: 4 }}>Задачи без проекта (ИИ-раскладка)</div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
        ИИ прочитает задачи вне рабочих групп Битрикса и предложит проект для каждой. Проверьте и примените.
      </div>
      {err && <div className="error-text">{err}</div>}
      <button className="btn btn-sm" style={{ width: '100%' }} onClick={analyze} disabled={loading}>
        {loading ? 'Анализирую…' : '✨ Проанализировать задачи без проекта'}
      </button>

      {ana && (ana.tasks.length === 0
        ? <div className="dim" style={{ marginTop: 8, fontSize: 13 }}>Задач вне проектов не найдено.</div>
        : (
          <div style={{ marginTop: 8 }}>
            <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
              Проектов-кандидатов: <b>{ana.projects.length}</b>. ИИ раскладывает задачи только по импортированным проектам, остальное — во «Входящие».
              {ana.projects.length <= 2 && ' Импортировано мало проектов — импортируйте нужные группы Битрикса выше (чекбоксами), тогда распределение будет точнее.'}
            </div>
            {ana.tasks.map((t) => (
              <div key={t.externalId} className="team-rate" style={{ marginBottom: 4, alignItems: 'center' }}>
                <span style={{ flex: 1, fontSize: 13 }}>
                  {t.title}
                  {t.confidence > 0 && <span className="dim" style={{ fontSize: 11, marginLeft: 6 }}>увер. {Math.round(t.confidence * 100)}%</span>}
                </span>
                <select className="input" value={pick[t.externalId] ?? ''} onChange={(e) => setPick((s) => ({ ...s, [t.externalId]: e.target.value }))}>
                  <option value="">— Входящие из Битрикса —</option>
                  {ana.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            ))}
            <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={apply} disabled={run && run.status === 'running'}>
              Применить раскладку ({ana.tasks.length})
            </button>
            {run && (
              <div className="dim" style={{ marginTop: 6, fontSize: 13 }}>
                {run.status === 'queued' && 'В очереди…'}
                {run.status === 'running' && 'Раскладываю…'}
                {run.status === 'error' && <span className="error-text">Ошибка: {run.error}</span>}
                {run.status === 'done' && run.stats && `Готово: в проекты ${run.stats.routed ?? 0}, во «Входящие» ${run.stats.inbox ?? 0}${run.stats.skipped ? `, пропущено ${run.stats.skipped}` : ''}. Обновляем…`}
                {run.status === 'done' && Array.isArray(run.stats?.warnings) && run.stats.warnings.map((w: string, idx: number) => (
                  <div key={idx} className="error-text" style={{ fontSize: 12 }}>⚠ {w}</div>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
