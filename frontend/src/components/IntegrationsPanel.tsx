import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { FileImportPanel } from './FileImportPanel';
import { TrelloPanel } from './TrelloPanel';
import { NotionPanel } from './NotionPanel';
import { SkeletonList } from './Skeleton';
import { api, ApiError } from '../lib/api';
import { AiSettingsSection } from './AiSettingsPanel';
import { PromptsSection } from './PromptsPanel';
import { useEscape } from '../hooks/useEscape';

/** Интеграции: подключения (Битрикс24) + ключи ИИ + промпты (PromptOps). */
export function IntegrationsPanel({ onClose }: { onClose: () => void }) {
  useEscape(onClose); // закрытие с клавиатуры, а не только крестиком
  const [tab, setTab] = useState<'file' | 'trello' | 'notion' | 'bitrix' | 'yougile' | 'ai' | 'prompts'>('file');
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
        <div className="drawer-head"><h3><Icon name="plug" size={18} /> Интеграции</h3><button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button></div>
        <div className="tabs">
          {/* Файл — первым: он работает всегда и без ключей, а остальные источники
              требуют доступа к чужой системе. */}
          <button className={`tab ${tab === 'file' ? 'active' : ''}`} onClick={() => setTab('file')}>Из файла</button>
          <button className={`tab ${tab === 'trello' ? 'active' : ''}`} onClick={() => setTab('trello')}>Trello</button>
          <button className={`tab ${tab === 'notion' ? 'active' : ''}`} onClick={() => setTab('notion')}>Notion</button>
          <button className={`tab ${tab === 'bitrix' ? 'active' : ''}`} onClick={() => setTab('bitrix')}>Битрикс24</button>
          <button className={`tab ${tab === 'yougile' ? 'active' : ''}`} onClick={() => setTab('yougile')}>YouGile</button>
          <button className={`tab ${tab === 'ai' ? 'active' : ''}`} onClick={() => setTab('ai')}>ИИ (ключи и модель)</button>
          <button className={`tab ${tab === 'prompts' ? 'active' : ''}`} onClick={() => setTab('prompts')}>Промпты</button>
        </div>
        {msg && <div className="dim">{msg}</div>}

        {tab === 'ai' && <AiSettingsSection />}
        {tab === 'prompts' && <PromptsSection />}
        {tab === 'file' && <FileImportPanel />}
        {tab === 'trello' && <TrelloPanel />}
        {tab === 'notion' && <NotionPanel />}
        {tab === 'yougile' && <YougileSection />}

        {tab === 'bitrix' && (<>
        <div className="drawer-section-title">Подключить портал (входящий вебхук)</div>
        <div className="add-user">
          <input className="input add-user-input" placeholder="URL вебхука (https://portal.bitrix24.ru/rest/…/…/)" value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} />
          <input className="input add-user-input" placeholder="Название (напр. «Основной»)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={connect}>Подключить и проверить</button>
          <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>В Битриксе: Разработчикам → Другое → Входящий вебхук, права <b>task, user, sonet_group</b>; для вложений — <b>disk</b>, для общей ленты — <b>log</b>. Права можно дописать в существующий вебхук (URL не меняется).</div>
        </div>

        <div className="drawer-section-title">Подключённые порталы ({conns.length})</div>
        {conns.length === 0 && (
          <EmptyState compact icon="plug" title="Порталы не подключены"
            hint="Вставьте URL входящего вебхука в форму выше — после проверки прав можно будет выбрать доски для импорта." />
        )}
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
            <div key={idx} className="error-text" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {w}</div>
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
        {loading ? 'Проверяю…' : <><Icon name="search" size={14} /> Диагностика подключения</>}
      </button>
      {err && <div className="error-text">{err}</div>}
      {rep && (
        <div className="invite-box" style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>
          <div>
            <b>Права вебхука:</b> {rep.scopesError ? `ошибка — ${rep.scopesError}` : (rep.scopes.join(', ') || '—')}
          </div>
          {!rep.scopesError && (
            <div className="dim" style={{ fontSize: 12 }}>
              {[['task','нужен для задач'],['log','лента недоступна'],['sonet_group',''],['disk','вложения']].map(([code, hint]) => (
                <span key={code} style={{ marginRight: 10 }}>
                  <Icon name={has(code) ? 'check' : 'close'} size={12} /> {code}{!has(code) && hint ? ` — ${hint}` : ''}
                </span>
              ))}
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
        {loading ? 'Анализирую…' : <><Icon name="sparkles" size={14} /> Проанализировать задачи без проекта</>}
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
                  <div key={idx} className="error-text" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {w}</div>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

/**
 * YouGile E4 — обратная выгрузка: изменения в CRM уезжают в YouGile.
 * Отправка идёт очередью в фоне, поэтому показываем сколько ждёт и последнюю ошибку.
 */
function TwoWayBlock({ cid }: { cid: string }) {
  const [st, setSt] = useState<{ pushEnabled: boolean; pending: number; errors: number; lastError: { kind: string; message: string } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.yougilePushStatus(cid).then(setSt).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [cid]);

  const toggle = async (enabled: boolean) => {
    setErr(''); setBusy(true);
    try { await api.yougileSetPush(cid, enabled); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="drawer-section-title" style={{ marginTop: 10 }}>Двусторонняя синхронизация</div>
      <div className="dim" style={{ fontSize: 12 }}>
        Перенос карточек, правка названия/описания/исполнителя/срока, комментарии и файлы из CRM будут уходить в YouGile.
        Комментарии и файлы отправляются от имени владельца API-ключа — автор подписывается в тексте.
      </div>
      <label className="notify-row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" disabled={busy || !st} checked={!!st?.pushEnabled} onChange={(e) => toggle(e.target.checked)} />
        <span>Отправлять изменения из CRM в YouGile</span>
      </label>
      {err && <div className="error-text" style={{ fontSize: 12 }}>{err}</div>}
      {st?.pushEnabled && (
        <div className="dim" style={{ fontSize: 12 }}>
          В очереди: {st.pending}{st.errors > 0 && <span className="error-text"> · не отправлено: {st.errors}</span>}
          {st.lastError && <div className="error-text" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {st.lastError.kind}: {st.lastError.message}</div>}
        </div>
      )}
    </>
  );
}

/** YouGile E1: подключение по API-ключу + импорт досок/колонок/задач. */
function YougileSection() {
  const [conns, setConns] = useState<any[]>([]);
  const [form, setForm] = useState({ apiKey: '', label: '' });
  const [msg, setMsg] = useState('');
  const [openCid, setOpenCid] = useState<string | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };
  const reload = () => api.yougileConnections().then(setConns).catch(() => setConns([]));
  useEffect(() => { reload(); }, []);

  const connect = async () => {
    if (!form.apiKey.trim()) return flash('Вставьте API-ключ YouGile');
    try { await api.yougileConnect(form.apiKey.trim(), form.label.trim() || undefined); setForm({ apiKey: '', label: '' }); flash('Подключено'); reload(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const disconnect = async (cid: string) => {
    if (!window.confirm('Удалить подключение YouGile? Импортированные проекты останутся.')) return;
    try { await api.yougileDisconnect(cid); if (openCid === cid) setOpenCid(null); reload(); } catch { /* */ }
  };

  return (
    <>
      <div className="dim" style={{ fontSize: 12 }}>
        Создайте API-ключ в YouGile (Настройки → API) и вставьте сюда. Импорт тянет доски → проекты, колонки, задачи (с исполнителями и сроками), идемпотентно.
        Обратная выгрузка (изменения из CRM в YouGile) включается отдельно — в блоке «Импорт» у подключения.
      </div>
      <div className="drawer-section-title">Подключить YouGile</div>
      <div className="add-user">
        <input className="input add-user-input" placeholder="API-ключ YouGile" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
        <input className="input add-user-input" placeholder="Название (напр. «Основной»)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={connect}>Подключить</button>
      </div>
      {msg && <div className="dim">{msg}</div>}

      <div className="drawer-section-title">Подключения ({conns.length})</div>
      {conns.length === 0 && (
        <EmptyState compact icon="plug" title="YouGile не подключён"
          hint="Ключ берётся в YouGile: аватар → Настройки компании → API-ключи. После подключения появится список досок для импорта." />
      )}
      {conns.map((c) => (
        <div key={c.id} className="team-row">
          <div className="team-head">
            <span>{c.label || 'YouGile'}</span>
            <span className="team-rate">
              <button className="btn btn-ghost btn-sm" onClick={() => setOpenCid(openCid === c.id ? null : c.id)}>{openCid === c.id ? 'Скрыть' : 'Импорт'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => disconnect(c.id)}>Удалить</button>
            </span>
          </div>
          {openCid === c.id && <YougileImportBlock cid={c.id} />}
        </div>
      ))}
    </>
  );
}

function YougileImportBlock({ cid }: { cid: string }) {
  const [boards, setBoards] = useState<{ externalId: string; title: string; projectTitle: string | null }[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [run, setRun] = useState<any>(null);
  const [err, setErr] = useState('');
  const [unmatched, setUnmatched] = useState<{ total: number; items: { externalId: string; name: string; email: string }[] } | null>(null);
  const [locals, setLocals] = useState<any[]>([]);
  const [mapPick, setMapPick] = useState<Record<string, string>>({});

  useEffect(() => { api.yougileBoards(cid).then(setBoards).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось получить доски')); }, [cid]);

  const loadUsers = () => {
    api.yougileUnmatched(cid).then(setUnmatched).catch(() => undefined);
    if (!locals.length) api.listUsers().then(setLocals).catch(() => undefined);
  };
  const [mapHint, setMapHint] = useState('');
  const mapUser = async (extId: string) => {
    const local = mapPick[extId];
    if (!local) return;
    try {
      const r = await api.yougileMapUser(cid, extId, local);
      // привязка сама по себе ничего не меняет в уже импортированных задачах — нужен прогон импорта
      setMapHint(r.tasksToRefresh > 0
        ? `Привязано. Запустите импорт ещё раз — исполнители и постановщики применятся к ${r.tasksToRefresh} задачам.`
        : 'Привязано. Применится при следующем импорте.');
      loadUsers();
    } catch { /* */ }
  };
  const [live, setLive] = useState<{ url: string; events: string[]; created: string[] } | null>(null);
  const [liveErr, setLiveErr] = useState('');
  const enableLive = async () => {
    setLiveErr('');
    try { setLive(await api.yougileEnableLive(cid)); } catch (e) { setLiveErr(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  const startImport = async () => {
    const ids = Object.keys(picked).filter((k) => picked[k]);
    if (!ids.length) return setErr('Выберите доски');
    setErr('');
    try {
      const { runId } = await api.yougileImport(cid, ids);
      const poll = setInterval(async () => {
        const r = await api.yougileRun(runId).catch(() => null);
        if (r) { setRun(r); if (r.status === 'done' || r.status === 'error') { clearInterval(poll); if (r.status === 'done') setTimeout(() => window.location.reload(), 1200); } }
      }, 1000);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка импорта'); }
  };

  return (
    <div className="invite-box">
      {err && <div className="error-text" style={{ fontSize: 12 }}>{err}</div>}
      {!boards && !err && <SkeletonList rows={3} />}
      {boards && boards.length === 0 && (
        <EmptyState compact icon="board" title="Досок не найдено"
          hint="Ключ рабочий, но доски не видны. Проверьте, что у владельца ключа есть доступ хотя бы к одному проекту в YouGile." />
      )}
      {boards && boards.map((b) => (
        <label key={b.externalId} className="notify-row" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={!!picked[b.externalId]} onChange={(e) => setPicked({ ...picked, [b.externalId]: e.target.checked })} />
          <span>{b.title}{b.projectTitle && <span className="dim" style={{ fontSize: 11 }}> · {b.projectTitle}</span>}</span>
        </label>
      ))}
      {boards && boards.length > 0 && (
        <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={startImport} disabled={run && (run.status === 'running' || run.status === 'queued')}>
          Импортировать выбранные
        </button>
      )}
      {run && (
        <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
          {(run.status === 'queued' || run.status === 'running') && 'Импорт идёт…'}
          {run.status === 'error' && <span className="error-text">Ошибка: {run.error}</span>}
          {run.status === 'done' && run.stats && `Готово: досок ${run.stats.boards ?? 0}, колонок ${run.stats.columns ?? 0}, задач ${run.stats.tasks ?? 0}, комментариев ${run.stats.comments ?? 0}, файлов ${run.stats.attachments ?? 0}. Обновляем…`}
        </div>
      )}

      <div className="drawer-section-title" style={{ marginTop: 10 }}>Живая синхронизация</div>
      <div className="dim" style={{ fontSize: 12 }}>После включения YouGile будет присылать изменения задач (создание/перенос/правка/удаление) в реальном времени.</div>
      {!live && <button className="btn btn-ghost btn-sm" onClick={enableLive}>Включить живую синхронизацию</button>}
      {liveErr && <div className="error-text" style={{ fontSize: 12 }}>{liveErr}</div>}
      {live && (
        <div className="dim" style={{ fontSize: 12 }}>
          <Icon name="check" size={13} /> Включена (события: {live.events.join(', ')}). Вебхуки зарегистрированы в YouGile на наш адрес.
        </div>
      )}

      <TwoWayBlock cid={cid} />

      <div className="drawer-section-title" style={{ marginTop: 10 }}>Сопоставление пользователей</div>
      {!unmatched && <button className="btn btn-ghost btn-sm" onClick={loadUsers}>Показать несопоставленных</button>}
      {unmatched && (
        <>
          <div className="dim" style={{ fontSize: 12 }}>
            Юзеры YouGile без совпадения по e-mail. Пока человек не привязан, задачи, которые он ставил или делает,
            приезжают без руководителя и исполнителя — и не попадают во вкладки «Мои задачи» и «Порученные».
            Привяжите вручную и запустите импорт ещё раз.
          </div>
          {mapHint && <div className="pnl-good" style={{ fontSize: 12 }}>{mapHint}</div>}
          {unmatched.items.length === 0 && <div className="muted">Все сопоставлены <Icon name="check" size={12} /></div>}
          {unmatched.items.map((u) => (
            <div key={u.externalId} className="team-rate" style={{ marginTop: 4 }}>
              <span style={{ flex: 1, fontSize: 13 }}>{u.name}{u.email && <span className="dim" style={{ fontSize: 11 }}> · {u.email}</span>}</span>
              <select className="input" value={mapPick[u.externalId] ?? ''} onChange={(e) => setMapPick({ ...mapPick, [u.externalId]: e.target.value })}>
                <option value="">— выбрать —</option>
                {locals.map((l) => <option key={l.id} value={l.id}>{l.fullName}</option>)}
              </select>
              <button className="btn btn-sm" onClick={() => mapUser(u.externalId)}>Привязать</button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
