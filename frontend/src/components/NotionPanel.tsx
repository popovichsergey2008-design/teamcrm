import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';

/**
 * Импорт из Notion — слой 3 «переезда в один клик».
 *
 * Главная сложность Notion не техническая, а объяснительная: токен сам по себе не
 * даёт доступа НИ К ЧЕМУ, интеграции нужно отдельно открыть каждую базу через
 * «Connections». Поэтому здесь и в ответе сервера про это сказано прямым текстом:
 * пустой список баз — самое частое первое состояние, и без объяснения человек решает,
 * что сломан импорт.
 */
export function NotionPanel() {
  const [conns, setConns] = useState<any[]>([]);
  const [form, setForm] = useState({ token: '', label: '' });
  const [msg, setMsg] = useState('');
  const [openCid, setOpenCid] = useState<string | null>(null);

  const flash = (m: string) => { setMsg(m); window.setTimeout(() => setMsg(''), 5000); };
  const reload = () => api.notionConnections().then(setConns).catch(() => setConns([]));
  useEffect(() => { reload(); }, []);

  const connect = async () => {
    if (!form.token.trim()) return flash('Вставьте токен интеграции');
    try {
      await api.notionConnect(form.token.trim(), form.label.trim() || undefined);
      setForm({ token: '', label: '' });
      flash('Подключено');
      reload();
    } catch (e) {
      flash(e instanceof ApiError ? e.message : 'Не удалось подключиться');
    }
  };

  const disconnect = async (cid: string) => {
    if (!window.confirm('Отключить Notion? Импортированные задачи останутся.')) return;
    try { await api.notionDisconnect(cid); if (openCid === cid) setOpenCid(null); reload(); } catch { /* */ }
  };

  return (
    <>
      <div className="drawer-section-title">Подключить Notion</div>
      <div className="add-user">
        <input
          className="input add-user-input" placeholder="Токен интеграции (ntn_…)"
          value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}
        />
        <input
          className="input add-user-input" placeholder="Название (напр. «Рабочее пространство»)"
          value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
        <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={connect}>
          Подключить и проверить
        </button>
        <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
          <b>Два шага, и второй забывают все.</b> Первый: создайте интеграцию на
          notion.so/my-integrations и скопируйте её токен. Второй: откройте нужную базу в Notion →
          «…» → <b>Connections</b> → добавьте свою интеграцию. Без второго шага Notion не покажет
          ни одной базы — токен сам по себе доступа не даёт.
        </div>
      </div>
      {msg && <div className="dim">{msg}</div>}

      <div className="drawer-section-title">Подключения ({conns.length})</div>
      {conns.length === 0 && (
        <EmptyState
          compact icon="plug" title="Notion не подключён"
          hint="Вставьте токен интеграции — после проверки можно будет выбрать базы для переноса."
        />
      )}
      {conns.map((c) => (
        <div key={c.id} className="team-row">
          <div className="team-head">
            <span>{c.label} <span className="dim" style={{ fontSize: 12 }}>{c.portal}</span></span>
            <span>
              <button className="btn btn-ghost btn-sm" onClick={() => setOpenCid(openCid === c.id ? null : c.id)}>
                {openCid === c.id ? 'Скрыть' : 'Импорт'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => disconnect(c.id)}>Отключить</button>
            </span>
          </div>
          {openCid === c.id && <NotionImportBlock cid={c.id} />}
        </div>
      ))}
    </>
  );
}

function NotionImportBlock({ cid }: { cid: string }) {
  const [dbs, setDbs] = useState<{ id: string; name: string; statusProperty: string | null }[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [run, setRun] = useState<any>(null);
  const [err, setErr] = useState('');
  const [unmatched, setUnmatched] = useState<{ total: number; items: { externalId: string; name: string; email: string }[] } | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [mapPick, setMapPick] = useState<Record<string, string>>({});

  useEffect(() => {
    api.notionDatabases(cid)
      .then((r) => { setDbs(r.items); setHint(r.hint); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось получить базы'));
    api.listUsers().then(setUsers).catch(() => undefined);
  }, [cid]);

  const start = async () => {
    const ids = Object.entries(picked).filter(([, v]) => v).map(([k]) => k);
    if (!ids.length) return setErr('Выберите базы');
    setErr('');
    try {
      const { runId } = await api.notionImport(cid, ids);
      setRun({ status: 'queued' });
      const timer = window.setInterval(async () => {
        try {
          const r = await api.notionRun(runId);
          setRun(r);
          if (r.status === 'done' || r.status === 'error') window.clearInterval(timer);
        } catch { window.clearInterval(timer); }
      }, 2000);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Импорт не запустился');
    }
  };

  const mapUser = async (externalId: string) => {
    const localUserId = mapPick[externalId];
    if (!localUserId) return;
    try {
      await api.notionMapUser(cid, externalId, localUserId);
      setUnmatched((u) => (u ? { total: u.total - 1, items: u.items.filter((i) => i.externalId !== externalId) } : u));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось привязать');
    }
  };

  const stats = run?.stats ?? null;

  return (
    <div className="invite-box">
      {err && <div className="error-text">{err}</div>}
      {hint && <div className="dim">{hint}</div>}

      <div className="drawer-section-title">Базы данных ({dbs.length})</div>
      <div className="import-boards">
        {dbs.map((d) => (
          <label key={d.id} className="notify-row">
            <input
              type="checkbox" checked={!!picked[d.id]}
              onChange={(e) => setPicked({ ...picked, [d.id]: e.target.checked })}
            />
            {d.name}
            {/* Сразу видно, из чего получатся колонки: это главный вопрос к переезду из Notion */}
            <span className="dim">
              {d.statusProperty ? `колонки из «${d.statusProperty}»` : 'без статуса — всё в одну колонку'}
            </span>
          </label>
        ))}
      </div>
      <button className="btn btn-primary btn-sm" onClick={start} disabled={run?.status === 'running'}>
        Импортировать выбранные
      </button>

      {run && (
        <div className="import-run">
          <div>
            {run.status === 'queued' && 'Ставим в очередь…'}
            {run.status === 'running' && 'Импорт идёт…'}
            {run.status === 'done' && 'Импорт завершён'}
            {run.status === 'error' && `Ошибка: ${run.error ?? 'неизвестно'}`}
          </div>
          {stats && (
            <div className="import-nums">
              <span><b>{stats.databases ?? 0}</b> баз</span>
              <span><b>{stats.tasks ?? 0}</b> задач</span>
              <span><b>{stats.updated ?? 0}</b> обновлено</span>
              <span><b>{stats.checklists ?? 0}</b> чек-листов</span>
            </div>
          )}
          {stats?.warnings?.length > 0 && (
            <ul className="import-warnings">
              {stats.warnings.slice(0, 20).map((w: string, i: number) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="drawer-section-title">Люди</div>
      {!unmatched && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => api.notionUnmatched(cid).then(setUnmatched).catch(() => setUnmatched({ total: 0, items: [] }))}
        >
          <Icon name="users" size={14} /> Показать, кого не опознали
        </button>
      )}
      {unmatched && unmatched.items.length === 0 && (
        <div className="dim">Все люди Notion опознаны по почте или имени.</div>
      )}
      {unmatched?.items.map((u) => (
        <div key={u.externalId} className="team-row team-head">
          <span>{u.name} <span className="dim" style={{ fontSize: 12 }}>{u.email}</span></span>
          <span>
            <select
              className="input" value={mapPick[u.externalId] ?? ''}
              onChange={(e) => setMapPick({ ...mapPick, [u.externalId]: e.target.value })}
            >
              <option value="">— выбрать сотрудника —</option>
              {users.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
            </select>
            <button className="btn btn-sm" onClick={() => mapUser(u.externalId)}>Привязать</button>
          </span>
        </div>
      ))}
    </div>
  );
}
