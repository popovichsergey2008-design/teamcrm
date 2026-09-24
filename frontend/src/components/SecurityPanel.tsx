import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { EmptyState } from './EmptyState';
import { api, ApiError, SecurityMember, SecurityPolicy } from '../lib/api';
import { PERMISSION_GROUPS, permissionTitle } from '../lib/permissions';
import { useEscape } from '../hooks/useEscape';
import { roleLabel } from '../lib/labels';

type Tab = 'people' | 'policy' | 'audit' | 'reveals';

/**
 * Центр безопасности (ТЗ «Централизованная система безопасности»).
 *
 * Четыре вкладки отвечают на четыре вопроса владельца: кто что может, какие правила
 * действуют в компании, что происходило и кто смотрел контакты клиентов.
 *
 * Здесь нарочно нет ничего, что бы «защищало» само по себе: каждая галочка — это
 * запись в базе, которую сервер проверяет на каждом действии. Интерфейс лишь
 * показывает и меняет правила, а не охраняет данные.
 */
export function SecurityPanel({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const [tab, setTab] = useState<Tab>('people');
  const [members, setMembers] = useState<SecurityMember[]>([]);
  const [policy, setPolicy] = useState<SecurityPolicy | null>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [reveals, setReveals] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [perms, setPerms] = useState<Record<string, { allowed: boolean }>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const loadPeople = () => {
    api.securityRoles()
      .then((r) => setMembers(r.members))
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Список сотрудников не загрузился'));
  };

  useEffect(() => {
    api.securityPolicy().then(setPolicy).catch(() => undefined);
    loadPeople();
  }, []);

  useEffect(() => {
    if (tab === 'audit' && !audit.length) {
      api.securityAudit().then((r) => setAudit(r.items)).catch(() => undefined);
    }
    if (tab === 'reveals' && !reveals.length) {
      api.contactReveals().then((r) => setReveals(r.items)).catch(() => undefined);
    }
  }, [tab, audit.length, reveals.length]);

  /** Открыть карточку человека: показываем его ИТОГОВЫЕ права, а не только поправки. */
  const openMember = async (id: string) => {
    setOpen(id); setErr('');
    try {
      const r = await api.memberPermissions(id);
      setPerms(r.permissions as Record<string, { allowed: boolean }>);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Права не загрузились'); }
  };

  const toggle = async (permission: string, allowed: boolean) => {
    if (!open) return;
    setBusy(true); setErr('');
    setPerms((p) => ({ ...p, [permission]: { allowed } }));
    try {
      const r = await api.setMemberPermissions(open, { [permission]: { allowed } });
      setPerms(r.permissions as Record<string, { allowed: boolean }>);
      loadPeople();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не сохранилось');
      void openMember(open);
    } finally { setBusy(false); }
  };

  const savePolicy = async (patch: Record<string, unknown>) => {
    setErr('');
    try { setPolicy(await api.saveSecurityPolicy(patch)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Политика не сохранилась'); }
  };

  const member = members.find((m) => String(m.id) === String(open));

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="lock" size={18} /> Безопасность</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="tabs">
          {([['people', 'Люди и права'], ['policy', 'Правила компании'], ['audit', 'Журнал'], ['reveals', 'Просмотры контактов']] as [Tab, string][])
            .map(([key, label]) => (
              <button key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</button>
            ))}
        </div>

        {err && <div className="error-text">{err}</div>}

        {tab === 'people' && !open && (
          <div className="sec-list">
            <div className="dim" style={{ fontSize: 12 }}>
              Нажмите на человека, чтобы посмотреть и изменить его права. Ограничение
              действует поверх роли: «руководитель, но без контактов и интеграций».
            </div>
            {members.map((m) => (
              <button key={m.id} className="sec-member" onClick={() => void openMember(String(m.id))}>
                <span className="sec-member-name">{m.full_name}</span>
                <span className="dim">{roleLabel(m.base_role)}{m.role_name ? ` · ${m.role_name}` : ''}</span>
                {m.limited > 0 && <span className="badge badge-warn">ограничений: {m.limited}</span>}
              </button>
            ))}
            {!members.length && <EmptyState compact icon="users" title="Сотрудников нет" hint="Пригласите команду в разделе «Команда»." />}
          </div>
        )}

        {tab === 'people' && open && (
          <div className="sec-perms">
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>
              <Icon name="chevron-left" size={14} /> Ко всем сотрудникам
            </button>
            <div className="drawer-section-title">{member?.full_name ?? 'Сотрудник'}</div>
            <div className="dim" style={{ fontSize: 12 }}>
              Галочка — итоговое право человека. Снимая её, вы ограничиваете именно его,
              роль остаётся прежней. Выдать право, которого нет у вас, нельзя.
            </div>

            {PERMISSION_GROUPS.map((g) => (
              <div key={g.title} className="sec-group">
                <div className="drawer-section-title">{g.title}</div>
                {g.items.map((key) => (
                  <label key={key} className="notify-row" style={{ cursor: busy ? 'default' : 'pointer' }}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={perms[key]?.allowed === true}
                      onChange={(e) => void toggle(key, e.target.checked)}
                    />
                    <span>{permissionTitle(key)}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}

        {tab === 'policy' && policy && (
          <div className="sec-policy">
            <div className="drawer-section">
              <div className="drawer-section-title">Контакты клиентов</div>
              <label className="notify-row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={policy.contacts.defaultAccess === 'masked'}
                  onChange={(e) => void savePolicy({ contacts: { ...policy.contacts, defaultAccess: e.target.checked ? 'masked' : 'full' } })}
                />
                <span>
                  Прятать контакты, показывать по нажатию
                  <span className="dim" style={{ display: 'block', fontSize: 12 }}>
                    Телефон и почта приходят замазанными с сервера — полного значения нет даже в ответе.
                  </span>
                </span>
              </label>
              <label className="notify-row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={policy.contacts.requireReason}
                  onChange={(e) => void savePolicy({ contacts: { ...policy.contacts, requireReason: e.target.checked } })}
                />
                <span>Спрашивать, зачем нужен контакт</span>
              </label>
              <div className="field">
                <label>Через сколько снова прятать</label>
                <select
                  className="input"
                  value={String(policy.contacts.revealTtlSeconds)}
                  onChange={(e) => void savePolicy({ contacts: { ...policy.contacts, revealTtlSeconds: Number(e.target.value) } })}
                >
                  <option value="60">через минуту</option>
                  <option value="300">через 5 минут</option>
                  <option value="900">через 15 минут</option>
                </select>
              </div>
            </div>

            <div className="drawer-section">
              <div className="drawer-section-title">Задачи</div>
              <label className="notify-row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={policy.tasks.deleteMode === 'owner_only'}
                  onChange={(e) => void savePolicy({ tasks: { ...policy.tasks, deleteMode: e.target.checked ? 'owner_only' : 'permission' } })}
                />
                <span>Удалять задачи может только владелец</span>
              </label>
              <label className="notify-row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={policy.tasks.protectClosed}
                  onChange={(e) => void savePolicy({ tasks: { ...policy.tasks, protectClosed: e.target.checked } })}
                />
                <span>
                  Не удалять завершённые
                  <span className="dim" style={{ display: 'block', fontSize: 12 }}>
                    История сделанного остаётся в проекте; такие задачи уходят в архив, а не в корзину.
                  </span>
                </span>
              </label>
            </div>

            <div className="drawer-section">
              <div className="drawer-section-title">Интеграции</div>
              <div className="field">
                <label>Кому открыты внешние системы</label>
                <select
                  className="input"
                  value={policy.integrations.mode}
                  onChange={(e) => void savePolicy({ integrations: { ...policy.integrations, mode: e.target.value } })}
                >
                  <option value="all">Разрешены</option>
                  <option value="allow_list">Только разрешённые владельцем</option>
                  <option value="off">Запрещены</option>
                </select>
              </div>
            </div>

            <div className="drawer-section">
              <div className="drawer-section-title">Вход</div>
              <div className="field">
                <label>Двухфакторная проверка</label>
                <select
                  className="input"
                  value={policy.twoFactor}
                  onChange={(e) => void savePolicy({ twoFactor: e.target.value })}
                >
                  <option value="off">Выключена</option>
                  <option value="optional">По желанию сотрудника</option>
                  <option value="required_for_admins">Обязательна для руководителей</option>
                  <option value="required_for_all">Обязательна для всех</option>
                </select>
                <span className="dim" style={{ fontSize: 12 }}>
                  Само подключение приложения-аутентификатора появится следующим шагом — политика уже сохраняется.
                </span>
              </div>
            </div>
          </div>
        )}

        {tab === 'audit' && (
          <div className="sec-list">
            {!audit.length && <EmptyState compact icon="list" title="Пока пусто" hint="Здесь появятся входы, изменения прав, удаления и раскрытия контактов." />}
            {audit.map((a) => (
              <div key={a.id} className="sec-audit">
                <span className="sec-audit-event">{a.event_type}</span>
                <span className="dim">
                  {a.actor_name ?? 'система'} · {new Date(a.created_at).toLocaleString('ru-RU')}
                  {a.resource_type ? ` · ${a.resource_type} ${a.resource_id ?? ''}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}

        {tab === 'reveals' && (
          <div className="sec-list">
            <div className="dim" style={{ fontSize: 12 }}>
              Кто и когда открывал контакты клиентов. Запись появляется при каждом раскрытии.
            </div>
            {!reveals.length && <EmptyState compact icon="eye" title="Контакты не открывали" hint="Пока никто не запрашивал доступ." />}
            {reveals.map((r) => (
              <div key={r.id} className="sec-audit">
                <span className="sec-audit-event">{r.user_name ?? 'сотрудник'}</span>
                <span className="dim">
                  {r.client_name} · {r.field} · {new Date(r.created_at).toLocaleString('ru-RU')}
                  {r.reason ? ` · ${r.reason}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
