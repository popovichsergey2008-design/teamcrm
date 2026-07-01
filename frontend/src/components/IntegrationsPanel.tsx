import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/** Интеграции → Битрикс24: подключение порталов и импорт досок (E1). */
export function IntegrationsPanel({ onClose }: { onClose: () => void }) {
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
        <div className="drawer-head"><h3>Интеграции · Битрикс24</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        {msg && <div className="dim">{msg}</div>}

        <div className="drawer-section-title">Подключить портал (входящий вебхук)</div>
        <div className="add-user">
          <input className="input add-user-input" placeholder="URL вебхука (https://portal.bitrix24.ru/rest/…/…/)" value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} />
          <input className="input add-user-input" placeholder="Название (напр. «Основной»)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={connect}>Подключить и проверить</button>
          <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>В Битриксе: Разработчикам → Другое → Входящий вебхук, права task, user, sonet_group.</div>
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
            {openCid === c.id && <ImportBlock cid={c.id} />}
          </div>
        ))}
      </aside>
    </div>
  );
}

function ImportBlock({ cid }: { cid: string }) {
  const [projects, setProjects] = useState<{ externalId: string; name: string }[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [run, setRun] = useState<any>(null);
  const [unmatched, setUnmatched] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [mapPick, setMapPick] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');

  const loadUnmatched = () => api.bitrixUnmatched(cid).then(setUnmatched).catch(() => undefined);
  useEffect(() => {
    api.bitrixProjects(cid).then(setProjects).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось получить проекты'));
    api.listUsers().then(setUsers).catch(() => undefined);
    loadUnmatched();
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
    if (!ids.length) return setErr('Отметьте проекты');
    setErr('');
    try {
      const { runId } = await api.bitrixImport(cid, ids);
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
      <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Проекты Битрикса:</div>
      {projects.map((p) => (
        <label key={p.externalId} className="notify-row" style={{ padding: '4px 0' }}>
          <input type="checkbox" checked={!!picked[p.externalId]} onChange={(e) => setPicked((s) => ({ ...s, [p.externalId]: e.target.checked }))} />
          {p.name}
        </label>
      ))}
      <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={startImport} disabled={run && run.status === 'running'}>
        Импортировать выбранные
      </button>
      {run && (
        <div className="dim" style={{ marginTop: 6, fontSize: 13 }}>
          {run.status === 'queued' && 'В очереди…'}
          {run.status === 'running' && 'Импорт идёт…'}
          {run.status === 'error' && <span className="error-text">Ошибка: {run.error}</span>}
          {run.status === 'done' && run.stats && `Готово: проектов ${run.stats.projects}, задач ${run.stats.tasks}, комментариев ${run.stats.comments}. Обновляем…`}
        </div>
      )}
      {unmatched.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Не сопоставлены по e-mail ({unmatched.length}) — привяжите вручную:</div>
          {unmatched.map((u) => (
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
