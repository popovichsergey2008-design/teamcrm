import { useEffect, useRef, useMemo, useState } from 'react';
import { EmptyState } from './EmptyState';
import { ClientsPanel } from './ClientsPanel';
import { previewSound, setSoundPref, soundPrefs } from '../lib/sound';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { browserTimezone, listTimezones } from '../lib/timezones';
import { Avatar } from './Avatar';
import { ThemeSwitch } from './ThemeSwitch';
import { DatePicker } from './DatePicker';

type Tab = 'profile' | 'security' | 'availability' | 'notify' | 'prompts' | 'clients';


/** Ключ настройки «дублировать в Telegram» — тот же, что в API уведомлений. */
const TG_MIRROR = 'telegram.mirror';

export function ProfilePanel({ onClose, onAvatar }: { onClose: () => void; onAvatar: (url: string | null) => void }) {
  const [tab, setTab] = useState<Tab>('profile');
  const [sound, setSound] = useState(soundPrefs);
  const toggleSound = (kind: 'messages' | 'calls') => {
    const next = { ...sound, [kind]: !sound[kind] };
    setSoundPref(kind, next[kind]);
    setSound(next);
  };
  const [me, setMe] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [tgCode, setTgCode] = useState<string | null>(null);
  const [mailPrefs, setMailPrefs] = useState<{ eventKey: string; title: string; enabled: boolean }[]>([]);
  const [tgLinked, setTgLinked] = useState<boolean | null>(null);
  const [tgBotUrl, setTgBotUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Список строится один раз: перебор четырёхсот поясов с форматированием заметен,
  // если делать его на каждый ввод символа в соседнем поле.
  const zones = useMemo(() => listTimezones(), []);

  const linkTelegram = async () => {
    try { const r = await api.telegramLinkCode(); setTgCode(r.code); }
    catch (e) { setTgCode(e instanceof ApiError ? e.message : 'ошибка'); }
  };

  const setMailPref = async (eventKey: string, enabled: boolean) => {
    setMailPrefs((prev) => prev.map((x) => (x.eventKey === eventKey ? { ...x, enabled } : x)));
    try { await api.setNotificationPref(eventKey, enabled); }
    catch { setMailPrefs((prev) => prev.map((x) => (x.eventKey === eventKey ? { ...x, enabled: !enabled } : x))); }
  };

  const unlinkTelegram = async () => {
    try { await api.telegramUnlink(); setTgLinked(false); setTgCode(''); flash('Telegram отвязан'); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  const loadMe = () => api.me().then((m) => { setMe(m); onAvatar(m.avatarUrl); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadMe(); }, []);
  useEffect(() => { api.notificationPrefs().then(setMailPrefs).catch(() => undefined); }, []);
  useEffect(() => {
    api.telegramStatus()
      .then((r) => { setTgLinked(r.linked); setTgBotUrl(r.botUrl); })
      .catch(() => undefined);
  }, [tgCode]);

  // profile
  const saveProfile = async () => {
    try {
      await api.updateProfile({
        fullName: me.fullName,
        phone: me.phone ?? '',
        timezone: me.timezone,
        // пустое поле — «как по умолчанию», а не ноль: ноль означал бы «считать зависшим сразу»
        radarStuckHours: me.radarStuckHours === '' || me.radarStuckHours === null || me.radarStuckHours === undefined
          ? null : Number(me.radarStuckHours),
        calendarBlockOverlap: me.calendarBlockOverlap !== false,
        // пустое поле — «убрать дату»: сервер отличает пустую строку от «не менять»
        birthDate: me.birthDate ?? '',
      });
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
    <div className="page profile-page">
      <div className="page-head">
        <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="arrow-left" size={14} /> К доскам</button>
        <h2>Профиль</h2>
      </div>
      <div className="profile-layout">
        <nav className="profile-nav">
          <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>Профиль</button>
          <button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}>Безопасность</button>
          <button className={tab === 'availability' ? 'active' : ''} onClick={() => setTab('availability')}>Доступность</button>
          <button className={tab === 'notify' ? 'active' : ''} onClick={() => setTab('notify')}>Уведомления</button>
          <button className={tab === 'prompts' ? 'active' : ''} onClick={() => setTab('prompts')}><Icon name="robot" size={14} /> Мои промпты</button>
          {/* Клиентская база — дело владельца компании, а не каждого приглашённого */}
          {me.isFounder && (
            <button className={tab === 'clients' ? 'active' : ''} onClick={() => setTab('clients')}>
              <Icon name="handshake" size={14} /> Клиенты и сделки
            </button>
          )}
        </nav>
        <div className="profile-content">
          {msg && <div className="dim">{msg}</div>}

          {tab === 'prompts' && <PromptsLibrary />}
          {tab === 'clients' && me.isFounder && <ClientsPanel embedded />}

        {tab === 'profile' && (
          <>
            <div className="avatar-row">
              <Avatar path={me.avatarUrl} fallback={me.fullName?.[0] ?? '?'} className="avatar-lg" />
              <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>Загрузить фото</button>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={onAvatarPick} />
            </div>
            {/* Тема — настройка внешнего вида, и место ей в кабинете. В меню под
                аватаром она тоже есть, но туда заходят за другим и находят её случайно. */}
            <div className="field">
              <label>Оформление</label>
              <ThemeSwitch labels />
              <span className="dim" style={{ fontSize: 12 }}>
                «Как в системе» — тема меняется вместе с настройкой компьютера: светлая днём,
                тёмная вечером, если так настроено там.
              </span>
            </div>
            <div className="field"><label>Имя</label><input className="input" value={me.fullName ?? ''} onChange={(e) => setMe({ ...me, fullName: e.target.value })} /></div>
            <div className="field"><label>E-mail</label><input className="input" value={me.email} disabled /></div>
            <div className="field"><label>Должность</label><input className="input" value={me.positionName ?? '—'} disabled /></div>
            <div className="field"><label>Телефон</label><input className="input" value={me.phone ?? ''} onChange={(e) => setMe({ ...me, phone: e.target.value })} /></div>
            {/* День рождения. Нужен одному месту — блоку «Дни рождения» в новостях,
                и показывается там только день и месяц: год никого не касается.
                Поле необязательное: не заполнил — в списке тебя нет. */}
            <div className="field">
              <label>День рождения</label>
              <input
                className="input"
                type="date"
                value={me.birthDate ?? ''}
                onChange={(e) => setMe({ ...me, birthDate: e.target.value })}
                title="Показывается коллегам в разделе «Новости» — днём и месяцем, без года"
              />
            </div>
            <div className="field">
              <label>Часовой пояс</label>
              {/* Выбор из списка, а не свободный ввод: опечатка в «Europe/Moskow» тихо
                  ломала бы сроки и напоминания, и человек не понял бы почему. */}
              <select
                className="input"
                value={me.timezone ?? ''}
                onChange={(e) => setMe({ ...me, timezone: e.target.value })}
              >
                <option value="">Не выбран</option>
                {zones.map((tz) => <option key={tz.id} value={tz.id}>{tz.label}</option>)}
                {/* Пояс из профиля может отсутствовать в списке — не теряем его молча */}
                {me.timezone && !zones.some((t) => t.id === me.timezone) && (
                  <option value={me.timezone}>{me.timezone}</option>
                )}
              </select>
              <button
                className="btn btn-ghost btn-sm"
                style={{ alignSelf: 'flex-start', marginTop: 4 }}
                onClick={() => setMe({ ...me, timezone: browserTimezone() })}
                title={`Определить по настройкам компьютера: ${browserTimezone()}`}
              >
                <Icon name="refresh" size={13} /> Как на этом компьютере
              </button>
            </div>
            {/* Порог «зависшего» — настройка того, кто смотрит «Пульс команды».
                Рядовому сотруднику этот экран не показывается, поэтому и поле ему не нужно. */}
            {(me.role === 'owner' || me.role === 'manager') && (
              <div className="field">
                <label>Считать зависшим на проверке через, часов</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={168}
                  placeholder="24 — по умолчанию"
                  value={me.radarStuckHours ?? ''}
                  onChange={(e) => setMe({ ...me, radarStuckHours: e.target.value === '' ? null : Number(e.target.value) })}
                />
                <span className="dim" style={{ fontSize: 12 }}>
                  Столько задача может простоять на проверке, прежде чем попадёт в «Узкие места»
                  на «Пульсе команды». Пусто — сутки.
                </span>
              </div>
            )}

            <label className="notify-row" title="Если время уже занято, коллега не сможет назначить вам встречу на него">
              <input
                type="checkbox"
                checked={me.calendarBlockOverlap !== false}
                onChange={() => setMe({ ...me, calendarBlockOverlap: me.calendarBlockOverlap === false })}
              />
              Не ставить мне встречи на занятое время
            </label>

            <button className="btn btn-primary" style={{ width: '100%' }} onClick={saveProfile}>Сохранить</button>

            <div className="drawer-section">
              <div className="drawer-section-title">Письма на почту</div>
              <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
                Приходят на {me.email ?? 'вашу почту'} — по задачам, где вы исполнитель или постановщик.
                О собственных действиях писем нет.
              </div>
              {mailPrefs.filter((p) => p.eventKey !== TG_MIRROR).map((p) => (
                <label key={p.eventKey} className="notify-row" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => setMailPref(p.eventKey, e.target.checked)}
                  />
                  <span>{p.title}</span>
                </label>
              ))}
            </div>

            <div className="drawer-section">
              <div className="drawer-section-title">
                Telegram {tgLinked === true && <span className="badge pnl-good">привязан</span>}
              </div>
              <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
                {tgLinked
                  ? 'Бот пишет вам в личный чат: те же уведомления, что и на почту, плюс дейлики голосом или текстом. Переписку видите только вы.'
                  : 'Привяжите Telegram, чтобы сдавать дейлики боту (голосом или текстом) и получать уведомления в чат, не дожидаясь письма.'}
              </div>

              {/* Дубль уведомлений — свойство канала, поэтому переключатель стоит здесь,
                  рядом с привязкой, а не в списке поводов для письма. */}
              {tgLinked && mailPrefs.filter((p) => p.eventKey === TG_MIRROR).map((p) => (
                <label key={p.eventKey} className="notify-row" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => setMailPref(p.eventKey, e.target.checked)}
                  />
                  <span>{p.title}</span>
                </label>
              ))}

              <div className="tg-actions">
                {!tgLinked && <button className="btn btn-sm" onClick={linkTelegram}>Получить код привязки</button>}
                {/* Ссылка на сам чат: с кодом на руках человек иначе ищет бота поиском
                    по имени и натыкается на чужих похожих. */}
                {tgBotUrl && (
                  <a className="btn btn-sm" href={tgBotUrl} target="_blank" rel="noreferrer">
                    <Icon name="link" size={14} /> {tgLinked ? 'Открыть чат с ботом' : 'Открыть бота'}
                  </a>
                )}
                {tgLinked && <button className="btn btn-ghost btn-sm" onClick={unlinkTelegram}>Отвязать Telegram</button>}
              </div>
              {tgCode && !tgLinked && (
                <div className="dim" style={{ marginTop: 6 }}>
                  Код: <b>{tgCode}</b> — откройте бота и отправьте ему этот код сообщением.
                </div>
              )}
            </div>
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
              <DatePicker value={newAv.fromDate} onChange={(v) => setNewAv({ ...newAv, fromDate: v })} placeholder="с какого числа" />
              <DatePicker value={newAv.toDate} onChange={(v) => setNewAv({ ...newAv, toDate: v })} placeholder="по какое число" />
            </div>
            <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={addAv}>Добавить</button>
            {av.map((a) => (
              <div key={a.id} className="team-row team-head">
                <span>{a.kind}: {a.from_date?.slice(0, 10)} — {a.to_date?.slice(0, 10)}</span>
                <button className="btn btn-ghost btn-sm" onClick={async () => { await api.removeMyAvailability(a.id); loadAv(); }} title="Убрать"><Icon name="close" size={13} /></button>
              </div>
            ))}
            <div className="dim" style={{ marginTop: 10 }}>Недельная ёмкость: {me.weeklyCapacityHours} ч</div>
          </>
        )}

        {tab === 'notify' && (
          <>
            <div className="drawer-section-title">Письма</div>
            {NOTIFY_KEYS.map(([k, label]) => (
              <label key={k} className="notify-row">
                <input type="checkbox" checked={!!me.notifyPrefs?.[k]} onChange={() => toggleNotify(k)} />
                {label}
              </label>
            ))}

            {/* Звук — свойство места, а не человека: в опенспейсе его выключают,
                дома на том же аккаунте оставляют. Поэтому настройка на устройстве. */}
            <div className="drawer-section-title" style={{ marginTop: 18 }}>Звук на этом устройстве</div>
            <label className="notify-row">
              <input type="checkbox" checked={sound.messages} onChange={() => toggleSound('messages')} />
              Сигнал о новом сообщении
              <button className="btn btn-ghost btn-sm" onClick={(e) => { e.preventDefault(); previewSound('messages'); }}>
                Послушать
              </button>
            </label>
            <label className="notify-row">
              <input type="checkbox" checked={sound.calls} onChange={() => toggleSound('calls')} />
              Звонок при входящем вызове
              <button className="btn btn-ghost btn-sm" onClick={(e) => { e.preventDefault(); previewSound('calls'); }}>
                Послушать
              </button>
            </label>
            <div className="dim" style={{ fontSize: 12 }}>
              Пока включён режим «Не беспокоить», звуков нет вовсе — ни сигналов, ни звонка.
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}

const EMPTY_FORM = { name: '', instruction: '', model: '', isShared: false };

/** Библиотека промптов агента: свои + общие командные; создать/редактировать/удалить; наработка со счётчиком. */
function PromptsLibrary() {
  const [list, setList] = useState<any[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [editId, setEditId] = useState<string | null>(null); // null = не редактируем/создаём новый
  const [open, setOpen] = useState(false); // форма создания раскрыта
  const [form, setForm] = useState<{ name: string; instruction: string; model: string; isShared: boolean }>(EMPTY_FORM);
  const [msg, setMsg] = useState('');
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const reload = () => api.agentPrompts().then(setList).catch(() => undefined);
  useEffect(() => { reload(); api.agentModels().then(setModels).catch(() => undefined); }, []);

  const startNew = () => { setEditId(null); setForm(EMPTY_FORM); setOpen(true); };
  const startEdit = (p: any) => { setEditId(p.id); setForm({ name: p.name, instruction: p.instruction, model: p.model ?? '', isShared: !!p.is_shared }); setOpen(true); };
  const cancel = () => { setOpen(false); setEditId(null); setForm(EMPTY_FORM); };

  const save = async () => {
    if (!form.name.trim() || !form.instruction.trim()) return flash('Заполните название и текст промпта');
    const body = { name: form.name.trim(), instruction: form.instruction.trim(), model: form.model || undefined, isShared: form.isShared };
    try {
      if (editId) await api.agentPromptUpdate(editId, body);
      else await api.agentPromptCreate(body);
      flash(editId ? 'Сохранено' : 'Промпт создан'); cancel(); reload();
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const duplicate = (p: any) => { setEditId(null); setForm({ name: `${p.name} (копия)`, instruction: p.instruction, model: p.model ?? '', isShared: false }); setOpen(true); };
  const del = async (p: any) => {
    if (!window.confirm(`Удалить промпт «${p.name}»?`)) return;
    try { await api.agentPromptDelete(p.id); reload(); } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  return (
    <>
      <div className="dim" style={{ fontSize: 12 }}>
        Свои промпты для ИИ-агента (роль/стиль/структура) под разные задачи. Применяются в карточке задачи при «Выполнить». Личные — только ваши; общие — видны всей команде.
      </div>
      <div className="panel-toolbar">
        <div className="drawer-section-title" style={{ margin: 0 }}>Промпты ({list.length})</div>
        {!open && <button className="btn btn-primary btn-sm" onClick={startNew}>＋ Новый промпт</button>}
      </div>
      {msg && <div className="dim">{msg}</div>}

      {open && (
        <div className="add-area">
          <div className="drawer-section-title" style={{ marginTop: 2 }}>{editId ? 'Редактирование' : 'Новый промпт'}</div>
          <input className="input" placeholder="Название (напр. «Копирайтер: КП»)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <textarea className="input" rows={5} style={{ marginTop: 6 }} placeholder="Инструкция агенту: роль, тон, структура, что учесть…&#10;Напр.: Пиши дружелюбно и по делу. Структура: заголовок → оффер → выгоды → цена → призыв." value={form.instruction} onChange={(e) => setForm({ ...form, instruction: e.target.value })} />
          <div className="drawer-grid2" style={{ marginTop: 6 }}>
            <select className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} title="Модель ИИ">
              <option value="">Модель по умолчанию</option>
              {models.map((m) => <option key={m} value={m}>{m}{m.endsWith(':free') ? ' — бесплатно' : ''}</option>)}
            </select>
            <label className="notify-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={form.isShared} onChange={(e) => setForm({ ...form, isShared: e.target.checked })} />
              <span>Общий (для всей команды)</span>
            </label>
          </div>
          <div className="team-rate" style={{ marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={save}>{editId ? 'Сохранить' : 'Создать'}</button>
            <button className="btn btn-ghost btn-sm" onClick={cancel}>Отмена</button>
          </div>
        </div>
      )}

      {list.length === 0 && !open && (
        <EmptyState compact icon="sparkles" title="Пока нет промптов"
          hint="Промпт — это заготовка задания для ИИ: «напиши коммерческое предложение», «разбери претензию клиента». Создайте первый — и он появится в карточке задачи при запуске агента." />
      )}
      {list.map((p) => (
        <div key={p.id} className="team-row" style={{ marginBottom: 8 }}>
          <div className="team-head">
            <span>
              <b>{p.name}</b>{' '}
              <span className={`badge ${p.is_shared ? 'badge-info' : 'badge-muted'}`}>{p.is_shared ? 'общий' : 'личный'}</span>{' '}
              {p.model && <span className="badge badge-muted" title="Модель">{p.model.length > 22 ? p.model.slice(0, 22) + '…' : p.model}</span>}{' '}
              {p.usage_count > 0 && <span className="badge" title="Использований"><Icon name="refresh" size={11} /> {p.usage_count}</span>}
              {!p.mine && <span className="dim" style={{ fontSize: 11 }}> · автор: {p.author_name}</span>}
            </span>
          </div>
          <div className="dim" style={{ fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'auto', margin: '4px 0', opacity: 0.8 }}>{p.instruction.slice(0, 240)}</div>
          <div className="team-rate">
            {p.mine && <button className="btn btn-ghost btn-sm" onClick={() => startEdit(p)}>Изменить</button>}
            <button className="btn btn-ghost btn-sm" onClick={() => duplicate(p)}>Дублировать</button>
            {p.mine && <button className="btn btn-ghost btn-sm" onClick={() => del(p)}>Удалить</button>}
          </div>
        </div>
      ))}
    </>
  );
}
