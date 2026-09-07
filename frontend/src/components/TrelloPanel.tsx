import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';

/**
 * Импорт из Trello — слой 2 «переезда в один клик».
 *
 * Доступ по паре «ключ + токен»: их человек получает сам за минуту и не ждёт
 * администратора рабочего пространства. Поэтому здесь же, прямо в форме, написано,
 * где эти две строки взять: без подсказки половина людей закрывает экран.
 */
export function TrelloPanel() {
  const [conns, setConns] = useState<any[]>([]);
  const [form, setForm] = useState({ apiKey: '', token: '', label: '' });
  const [msg, setMsg] = useState('');
  const [openCid, setOpenCid] = useState<string | null>(null);

  const flash = (m: string) => { setMsg(m); window.setTimeout(() => setMsg(''), 5000); };
  const reload = () => api.trelloConnections().then(setConns).catch(() => setConns([]));
  useEffect(() => { reload(); }, []);

  const connect = async () => {
    if (!form.apiKey.trim() || !form.token.trim()) return flash('Нужны и ключ, и токен');
    try {
      await api.trelloConnect(form.apiKey.trim(), form.token.trim(), form.label.trim() || undefined);
      setForm({ apiKey: '', token: '', label: '' });
      flash('Подключено');
      reload();
    } catch (e) {
      flash(e instanceof ApiError ? e.message : 'Не удалось подключиться');
    }
  };

  const disconnect = async (cid: string) => {
    if (!window.confirm('Отключить Trello? Импортированные доски и задачи останутся.')) return;
    try { await api.trelloDisconnect(cid); if (openCid === cid) setOpenCid(null); reload(); } catch { /* */ }
  };

  return (
    <>
      <div className="drawer-section-title">Подключить Trello</div>
      <div className="add-user">
        <input
          className="input add-user-input" placeholder="API-ключ"
          value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
        />
        <input
          className="input add-user-input" placeholder="Токен"
          value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}
        />
        <input
          className="input add-user-input" placeholder="Название (напр. «Личный аккаунт»)"
          value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
        <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={connect}>
          Подключить и проверить
        </button>
        <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
          Ключ — на <b>trello.com/power-ups/admin</b> (создайте Power-Up и откройте «API key»).
          Токен — по ссылке «Token» рядом с ключом: Trello спросит разрешение и покажет строку.
          Обе строки видит только сервер, в базе они лежат зашифрованными.
        </div>
      </div>
      {msg && <div className="dim">{msg}</div>}

      <div className="drawer-section-title">Подключения ({conns.length})</div>
      {conns.length === 0 && (
        <EmptyState
          compact icon="plug" title="Trello не подключён"
          hint="Вставьте ключ и токен — после проверки можно будет выбрать доски для переноса."
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
          {openCid === c.id && <TrelloImportBlock cid={c.id} />}
        </div>
      ))}
    </>
  );
}

function TrelloImportBlock({ cid }: { cid: string }) {
  const [boards, setBoards] = useState<{ id: string; name: string; closed: boolean }[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [run, setRun] = useState<any>(null);
  const [err, setErr] = useState('');
  const [unmatched, setUnmatched] = useState<{ total: number; items: { externalId: string; name: string }[] } | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [mapPick, setMapPick] = useState<Record<string, string>>({});

  useEffect(() => {
    api.trelloBoards(cid)
      .then(setBoards)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось получить доски'));
    api.listUsers().then(setUsers).catch(() => undefined);
  }, [cid]);

  const start = async () => {
    const ids = Object.entries(picked).filter(([, v]) => v).map(([k]) => k);
    if (!ids.length) return setErr('Выберите доски');
    setErr('');
    try {
      const { runId } = await api.trelloImport(cid, ids);
      setRun({ status: 'queued' });
      // Прогресс спрашиваем сами: импорт идёт в фоне, и молчащий экран читается как
      // «ничего не происходит» — люди начинают жать кнопку второй раз.
      const timer = window.setInterval(async () => {
        try {
          const r = await api.trelloRun(runId);
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
      await api.trelloMapUser(cid, externalId, localUserId);
      setUnmatched((u) => (u ? { total: u.total - 1, items: u.items.filter((i) => i.externalId !== externalId) } : u));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось привязать');
    }
  };

  const stats = run?.stats ?? null;

  return (
    <div className="invite-box">
      {err && <div className="error-text">{err}</div>}

      <div className="drawer-section-title">Доски ({boards.length})</div>
      <div className="import-boards">
        {boards.map((b) => (
          <label key={b.id} className="notify-row">
            <input
              type="checkbox" checked={!!picked[b.id]}
              onChange={(e) => setPicked({ ...picked, [b.id]: e.target.checked })}
            />
            {b.name}
            {b.closed && <span className="badge badge-muted">архив</span>}
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
              <span><b>{stats.boards ?? 0}</b> досок</span>
              <span><b>{stats.tasks ?? 0}</b> задач</span>
              <span><b>{stats.updated ?? 0}</b> обновлено</span>
              <span><b>{stats.comments ?? 0}</b> комментариев</span>
              <span><b>{stats.attachments ?? 0}</b> файлов</span>
            </div>
          )}
          {stats?.warnings?.length > 0 && (
            <ul className="import-warnings">
              {stats.warnings.slice(0, 20).map((w: string, i: number) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Список несопоставленных грузим по кнопке: на большом аккаунте это сотни людей,
          а привязка нужна не всем и не всегда. */}
      <div className="drawer-section-title">Люди</div>
      {!unmatched && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => api.trelloUnmatched(cid).then(setUnmatched).catch(() => setUnmatched({ total: 0, items: [] }))}
        >
          <Icon name="users" size={14} /> Показать, кого не опознали
        </button>
      )}
      {unmatched && unmatched.items.length === 0 && (
        <div className="dim">Все участники досок опознаны по имени или почте.</div>
      )}
      {unmatched?.items.map((u) => (
        <div key={u.externalId} className="team-row team-head">
          <span>{u.name}</span>
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
