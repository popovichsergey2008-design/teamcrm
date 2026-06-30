import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Avatar } from './Avatar';

type Tab = 'profile' | 'security' | 'availability' | 'notify';

export function ProfilePanel({ onClose, onAvatar }: { onClose: () => void; onAvatar: (url: string | null) => void }) {
  const [tab, setTab] = useState<Tab>('profile');
  const [me, setMe] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  const loadMe = () => api.me().then((m) => { setMe(m); onAvatar(m.avatarUrl); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadMe(); }, []);

  // profile
  const saveProfile = async () => {
    try {
      await api.updateProfile({ fullName: me.fullName, phone: me.phone ?? '', timezone: me.timezone });
      flash('Профиль сохранён'); loadMe();
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const onAvatarPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { await api.uploadAvatar(f); flash('Аватар обновлён'); loadMe(); }
    catch (err) { flash(err instanceof ApiError ? err.message : 'Ошибка'); }
  };

  // security
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [sessions, setSessions] = useState<any[]>([]);
  const loadSessions = () => api.listSessions().then(setSessions).catch(() => undefined);
  useEffect(() => { if (tab === 'security') loadSessions(); }, [tab]);
  const changePw = async () => {
    if (pw.newPassword.length < 8) return flash('Пароль ≥ 8 символов');
    try { await api.changePassword(pw); setPw({ currentPassword: '', newPassword: '' }); flash('Пароль изменён, прочие сессии завершены'); loadSessions(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  // availability
  const [av, setAv] = useState<any[]>([]);
  const [newAv, setNewAv] = useState({ kind: 'vacation', fromDate: '', toDate: '' });
  const loadAv = () => api.myAvailability().then(setAv).catch(() => undefined);
  useEffect(() => { if (tab === 'availability') loadAv(); }, [tab]);
  const addAv = async () => {
    if (!newAv.fromDate || !newAv.toDate) return flash('Укажите даты');
    try { await api.addMyAvailability(newAv); setNewAv({ kind: 'vacation', fromDate: '', toDate: '' }); loadAv(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  // notify
  const toggleNotify = async (key: string) => {
    const next = { ...(me.notifyPrefs ?? {}), [key]: !me.notifyPrefs?.[key] };
    try { await api.setNotifications(next); setMe({ ...me, notifyPrefs: next }); } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  if (!me) return null;
  const NOTIFY_KEYS: [string, string][] = [
    ['taskAssigned', 'Назначена задача'],
    ['taskBlocked', 'Задача заблокирована'],
    ['mentions', 'Упоминания в комментариях'],
    ['dailyDigest', 'Ежедневная сводка'],
  ];

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>Личный кабинет</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="tabs">
          <button className={`tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>Профиль</button>
          <button className={`tab ${tab === 'security' ? 'active' : ''}`} onClick={() => setTab('security')}>Безопасность</button>
          <button className={`tab ${tab === 'availability' ? 'active' : ''}`} onClick={() => setTab('availability')}>Доступность</button>
          <button className={`tab ${tab === 'notify' ? 'active' : ''}`} onClick={() => setTab('notify')}>Уведомления</button>
        </div>
        {msg && <div className="dim">{msg}</div>}

        {tab === 'profile' && (
          <>
            <div className="avatar-row">
              <Avatar path={me.avatarUrl} fallback={me.fullName?.[0] ?? '?'} className="avatar-lg" />
              <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>Загрузить фото</button>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={onAvatarPick} />
            </div>
            <div className="field"><label>Имя</label><input className="input" value={me.fullName ?? ''} onChange={(e) => setMe({ ...me, fullName: e.target.value })} /></div>
            <div className="field"><label>E-mail</label><input className="input" value={me.email} disabled /></div>
            <div className="field"><label>Должность</label><input className="input" value={me.positionName ?? '—'} disabled /></div>
            <div className="field"><label>Телефон</label><input className="input" value={me.phone ?? ''} onChange={(e) => setMe({ ...me, phone: e.target.value })} /></div>
            <div className="field"><label>Таймзона</label><input className="input" value={me.timezone ?? ''} onChange={(e) => setMe({ ...me, timezone: e.target.value })} /></div>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={saveProfile}>Сохранить</button>
          </>
        )}

        {tab === 'security' && (
          <>
            <div className="drawer-section-title">Смена пароля</div>
            <div className="field"><label>Текущий пароль</label><input className="input" type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></div>
            <div className="field"><label>Новый пароль</label><input className="input" type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></div>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={changePw}>Сменить пароль</button>

            <div className="drawer-section-title" style={{ marginTop: 18 }}>Активные сессии</div>
            <button className="btn btn-ghost btn-sm" onClick={async () => { await api.revokeOtherSessions(); loadSessions(); }}>Выйти на других устройствах</button>
            {sessions.map((s) => (
              <div key={s.id} className="team-row team-head">
                <span className="dim" style={{ fontSize: 13 }}>
                  {s.current && <span className="badge pnl-good">текущая</span>} {(s.userAgent ?? 'устройство').slice(0, 38)} · {s.ip ?? ''}
                </span>
                {!s.current && <button className="btn btn-ghost btn-sm" onClick={async () => { await api.revokeSession(s.id); loadSessions(); }}>Выйти</button>}
              </div>
            ))}
          </>
        )}

        {tab === 'availability' && (
          <>
            <div className="drawer-grid2">
              <select className="input" value={newAv.kind} onChange={(e) => setNewAv({ ...newAv, kind: e.target.value })}>
                <option value="vacation">отпуск</option><option value="sick">больничный</option><option value="other">другое</option>
              </select>
              <div />
              <input className="input" type="date" value={newAv.fromDate} onChange={(e) => setNewAv({ ...newAv, fromDate: e.target.value })} />
              <input className="input" type="date" value={newAv.toDate} onChange={(e) => setNewAv({ ...newAv, toDate: e.target.value })} />
            </div>
            <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={addAv}>Добавить</button>
            {av.map((a) => (
              <div key={a.id} className="team-row team-head">
                <span>{a.kind}: {a.from_date?.slice(0, 10)} — {a.to_date?.slice(0, 10)}</span>
                <button className="btn btn-ghost btn-sm" onClick={async () => { await api.removeMyAvailability(a.id); loadAv(); }}>✕</button>
              </div>
            ))}
            <div className="dim" style={{ marginTop: 10 }}>Недельная ёмкость: {me.weeklyCapacityHours} ч</div>
          </>
        )}

        {tab === 'notify' && (
          <>
            {NOTIFY_KEYS.map(([k, label]) => (
              <label key={k} className="notify-row">
                <input type="checkbox" checked={!!me.notifyPrefs?.[k]} onChange={() => toggleNotify(k)} />
                {label}
              </label>
            ))}
          </>
        )}
      </aside>
    </div>
  );
}
