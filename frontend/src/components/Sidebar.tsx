import { ReactNode, useEffect, useRef, useState } from 'react';
import { Icon, IconName } from './Icon';
import { ProjectsNav } from './ProjectsNav';
import { setDoNotDisturb } from '../lib/sound';
import { Avatar } from './Avatar';
import { ThemeSwitch } from './ThemeSwitch';
import { buildPath, navigate, Route, Section } from '../lib/router';
import { roleLabel } from '../lib/labels';
import { NavCounters } from '../hooks/useNavCounters';
import { useEscape } from '../hooks/useEscape';
import { FocusMenu, focusLine } from './FocusMenu';
import { humanMinutes } from './SecretaryPanel';
import { api } from '../lib/api';
import type { Focus } from '../types';

/**
 * Левая панель — единственная навигация приложения.
 *
 * Структура из ТЗ и менять её нельзя: верхний блок (команда, поиск, «Новая задача»),
 * ровно четыре раздела, нижний блок (AI Секретарь, настройки, профиль с фокусом).
 * Разделы, которых в ТЗ нет (Встречи, Клиенты, Входящие), живут подпунктами внутри
 * своего раздела — пятый пункт меню добавлять запрещено.
 *
 * Пункты фильтруются по роли: показать раздел, куда человеку закрыт вход, хуже,
 * чем не показать вовсе — он ткнёт и получит отказ.
 */

const COLLAPSED_KEY = 'teamcrm.nav.collapsed';

type Role = string;

type Item = {
  section: Section;
  label: string;
  icon: IconName;
  hint: string;
  /** роли, которым пункт виден; пусто — виден всем */
  roles?: Role[];
  subs?: { label: string; icon: IconName; route: Route; roles?: Role[] }[];
};

const MENU: Item[] = [
  {
    section: 'focus',
    label: 'Фокус дня',
    icon: 'target',
    hint: 'Что делать сегодня, поручения другим и то, что ждёт вашего решения',
    subs: [
      {
        label: 'Входящие',
        icon: 'inbox',
        route: { section: 'focus', view: 'inbox' },
        roles: ['owner', 'manager'],
      },
    ],
  },
  {
    // Календарь был подпунктом «Фокуса дня» — сразу под ним и остался, но теперь
    // разделом: в него заходят не «из сегодняшнего дня», а планировать неделю,
    // и прятать его внутрь чужого раздела значит прятать половину сценариев.
    section: 'calendar',
    label: 'Календарь',
    icon: 'calendar',
    hint: 'Встречи, приглашения и сроки задач — неделей, днём, месяцем или списком',
  },
  {
    section: 'projects',
    label: 'Проекты и доски',
    icon: 'board',
    hint: 'Пространства задач компании: списки и канбан',
    // «Клиенты и сделки» переехали в личный кабинет и видны только тому, кто завёл
    // компанию: приглашённым сотрудникам этот раздел не нужен, а место в меню занимал
  },
  {
    section: 'chat',
    label: 'Чаты & Миты',
    icon: 'chat',
    hint: 'Личные, групповые и проектные обсуждения, созвоны',
    subs: [
      { label: 'Лента компании', icon: 'list', route: { section: 'chat', view: 'feed' } },
      { label: 'Встречи', icon: 'record', route: { section: 'chat', view: 'meetings' } },
    ],
  },
  {
    section: 'radar',
    label: 'Пульс команды',
    icon: 'chart',
    hint: 'Экран руководителя: прогресс, загрузка, риски срыва сроков',
    roles: ['owner', 'manager'],
  },
];

const visible = (roles: Role[] | undefined, role: Role) => !roles || roles.includes(role);

export function Sidebar({
  route, user, organizations, avatarPath, unread, counters, activeCall,
  onSwitchOrg, onNewTask, onVoiceTask, onSearch, onJoinCall, onOpenSecretary, onHoverSection, onLogout,
}: {
  route: Route;
  user: { role: string; fullName: string; tenantId: string };
  organizations: { tenantId: string; name: string; role: string }[];
  avatarPath: string | null;
  unread: number;
  counters: NavCounters;
  activeCall: { participants: number } | null;
  onSwitchOrg: (tenantId: string) => void;
  onNewTask: () => void;
  onVoiceTask: () => void;
  onSearch: () => void;
  onJoinCall: () => void;
  onOpenSecretary: () => void;
  /** наведение на пункт меню — повод прогреть данные раздела заранее */
  onHoverSection: (section: Section) => void;
  onLogout: () => void;
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  // на узком экране панель выезжает поверх содержимого, а не сжимает его
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [secretary, setSecretary] = useState<{ actions: number; savedMinutes: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Фокус и сводка ассистента живут ровно здесь: больше их никто не показывает.
  // Обе выборки дешёвые, поэтому обновляем их вместе со счётчиками разделов.
  useEffect(() => {
    const loadFocus = () => api.getFocus().then(setFocus).catch(() => undefined);
    const loadSummary = () => api.secretarySummary().then(setSecretary).catch(() => undefined);
    loadFocus();
    loadSummary();
    // фокус можно поставить и из командной строки — строка под именем обязана это показать
    window.addEventListener('teamcrm:focus-changed', loadFocus);
    window.addEventListener('teamcrm:tasks-changed', loadSummary);
    return () => {
      window.removeEventListener('teamcrm:focus-changed', loadFocus);
      window.removeEventListener('teamcrm:tasks-changed', loadSummary);
    };
  }, []);

  // «Не беспокоить» — это в том числе тишина: глубокий фокус глушит и сигналы, и звонок
  useEffect(() => { setDoNotDisturb(focus?.kind === 'deep'); }, [focus]);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSED_KEY, v ? '0' : '1');
      return !v;
    });
  };

  // на узком экране панель выезжает поверх — Esc обязан её убирать, как любое окно
  useEscape(() => setOpen(false), open);

  // сворачивание панели живёт здесь, а горячая клавиша — в общем обработчике
  useEffect(() => {
    const toggle = () => setCollapsed((v) => {
      localStorage.setItem(COLLAPSED_KEY, v ? '0' : '1');
      return !v;
    });
    window.addEventListener('teamcrm:toggle-sidebar', toggle);
    return () => window.removeEventListener('teamcrm:toggle-sidebar', toggle);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menuOpen]);

  // переход по разделу закрывает выехавшую панель — иначе она перекрывает то, куда шли
  const go = (to: Route) => { navigate(to); setOpen(false); };

  const link = (to: Route, active: boolean, cls: string, title: string, children: ReactNode) => (
    <a
      className={`${cls}${active ? ' active' : ''}`}
      href={buildPath(to)}
      title={collapsed ? title : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        // Ctrl/Cmd-клик и средняя кнопка должны открывать в новой вкладке как обычная ссылка
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );

  const orgName = organizations.find((o) => o.tenantId === user.tenantId)?.name ?? 'Моя организация';

  return (
    <>
      <button
        className="nav-open-btn"
        onClick={() => setOpen(true)}
        title="Меню"
        aria-label="Открыть меню"
      >
        <Icon name="list" size={18} />
      </button>
      {open && <div className="nav-backdrop" onClick={() => setOpen(false)} />}

      <aside
        className={`nav-sidebar${collapsed ? ' nav-collapsed' : ''}${open ? ' nav-open' : ''}`}
        aria-label="Главное меню"
      >
        {/* ── верхний блок ── */}
        <div className="nav-top">
          <div className="nav-org">
            <span className="nav-org-mark" aria-hidden="true">{orgName.slice(0, 1).toUpperCase()}</span>
            <select
              className="nav-org-select"
              value={user.tenantId}
              onChange={(e) => onSwitchOrg(e.target.value)}
              title={`Организация: ${orgName}`}
              aria-label="Организация"
            >
              {organizations.map((o) => (
                <option key={o.tenantId} value={o.tenantId}>{o.name} · {roleLabel(o.role)}</option>
              ))}
              {organizations.length === 0 && <option value={user.tenantId}>Моя организация</option>}
              <option value="__new__">+ Создать организацию…</option>
            </select>
            <button
              className="nav-collapse"
              onClick={toggleCollapsed}
              title={collapsed ? 'Развернуть панель' : 'Свернуть панель'}
              aria-label={collapsed ? 'Развернуть панель' : 'Свернуть панель'}
            >
              <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
            </button>
          </div>

          <button className="nav-search" onClick={onSearch} title="Поиск и команды (Ctrl+K)">
            <Icon name="search" size={16} />
            <span className="nav-label">Найти или сказать…</span>
            <kbd className="nav-kbd">Ctrl K</kbd>
          </button>

          {/* Голос — отдельной кнопкой, а не режимом внутри окна: по ТЗ надиктовать
              задачу нужно одним движением, а не «открыть, найти микрофон, нажать». */}
          <div className="nav-new-row">
            <button className="btn btn-primary nav-new" onClick={onNewTask} title="Новая задача — текстом (клавиша C)">
              <Icon name="plus" size={16} />
              <span className="nav-label">Новая задача</span>
            </button>
            <button className="btn btn-primary nav-new-mic" onClick={onVoiceTask} title="Продиктовать задачу голосом" aria-label="Продиктовать задачу голосом">
              <Icon name="mic" size={16} />
            </button>
          </div>
        </div>

        {/* ── основное меню: ровно 4 раздела ── */}
        <nav className="nav-main" aria-label="Разделы">
          {MENU.filter((i) => visible(i.roles, user.role)).map((item) => {
            const active = route.section === item.section;
            // Ноль не показываем вовсе — по ТЗ панель молчит, пока от человека
            // ничего не требуется. Пустой кружок читался бы как «что-то есть».
            const badge = item.section === 'chat' ? unread
              : item.section === 'focus' ? counters.focus.decide
              : item.section === 'calendar' ? counters.calendar?.pending ?? 0
              : item.section === 'radar' ? counters.radar?.risks ?? 0
              : 0;
            const badgeTitle = item.section === 'focus' ? 'ждут вашего решения'
              : item.section === 'calendar' ? 'приглашений без ответа'
              : item.section === 'radar' ? 'задач просрочено' : undefined;
            return (
              <div key={item.section} className="nav-group" onMouseEnter={() => onHoverSection(item.section)}>
                {link({ section: item.section }, active, 'nav-item', item.label, (
                  <>
                    <Icon name={item.icon} size={18} />
                    <span className="nav-label">{item.label}</span>
                    {badge > 0 && (
                      <span
                        className={`nav-count${item.section === 'radar' ? ' nav-count-warn' : ''}`}
                        title={badgeTitle}
                        aria-label={badgeTitle ? `${badge} ${badgeTitle}` : `${badge} непрочитанных`}
                      >
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                  </>
                ))}
                {/* Проекты раскрываются прямо под своим разделом, как в привычных
                    таск-менеджерах: отдельная колонка слева отъедала место у доски
                    и висела перед глазами даже тогда, когда переключать нечего. */}
                {item.section === 'projects' && active && !collapsed && (
                  <ProjectsNav
                    currentId={route.projectId ?? null}
                    canManage={user.role === 'owner' || user.role === 'manager'}
                  />
                )}
                {/* подпункты — только у открытого раздела: панель должна оставаться короткой */}
                {active && !collapsed && item.subs?.filter((s) => visible(s.roles, user.role)).map((sub) => (
                  <span key={sub.label}>
                    {link(sub.route, route.view === sub.route.view, 'nav-sub', sub.label, (
                      <>
                        <Icon name={sub.icon} size={15} />
                        <span className="nav-label">{sub.label}</span>
                      </>
                    ))}
                  </span>
                ))}
              </div>
            );
          })}

          {/* Созвон уже идёт — вход в него, иначе к разговору не присоединиться тому, кого не позвали */}
          {activeCall && (
            <button className="nav-item nav-call" onClick={onJoinCall} title="Идёт созвон — присоединиться">
              <Icon name="phone" size={18} />
              <span className="nav-label">Идёт созвон · {activeCall.participants}</span>
            </button>
          )}
        </nav>

        {/* ── нижний блок ── */}
        <div className="nav-bottom">
          {/* AI Секретарь: показываем ровно то, что записано в журнале действий.
              Ноль тоже показываем — это честнее, чем прятать виджет, обещавший пользу. */}
          <button className="nav-secretary" onClick={onOpenSecretary} title="Что система сделала за вас сама">
            <Icon name="sparkles" size={18} />
            <span className="nav-label nav-secretary-text">
              <span>AI Секретарь · {secretary?.actions ?? 0}</span>
              <span className="nav-secretary-saved">
                {secretary && secretary.savedMinutes > 0 ? `сэкономлено ${humanMinutes(secretary.savedMinutes)}` : 'действий сегодня'}
              </span>
            </span>
          </button>

          {link({ section: 'settings' }, route.section === 'settings', 'nav-item', 'Настройки и интеграции', (
            <>
              <Icon name="settings" size={18} />
              <span className="nav-label">Настройки</span>
            </>
          ))}

          <div className="nav-profile" ref={menuRef}>
            <button
              className={`nav-user${route.section === 'profile' ? ' active' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              title={`${user.fullName} — профиль и тема`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <Avatar path={avatarPath} fallback={user.fullName?.[0] ?? '?'} className="avatar-sm" />
              <span className={`nav-dot nav-dot-${focus?.kind ?? 'free'}`} aria-hidden="true" />
              <span className="nav-user-text">
                <span className="nav-user-name">{user.fullName}</span>
                <span className="nav-user-role" title={focusLine(focus)}>{focusLine(focus)}</span>
              </span>
            </button>
            {menuOpen && (
              <div className="menu-pop nav-menu-pop" role="menu">
                <FocusMenu focus={focus} onChange={(f) => { setFocus(f); setMenuOpen(false); }} />
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); go({ section: 'profile' }); }}
                >
                  <Icon name="user" size={15} /> Личный кабинет
                </button>
                <div className="menu-theme">
                  <span className="dim">Тема</span>
                  <ThemeSwitch />
                </div>
                <button className="menu-item menu-danger" role="menuitem" onClick={() => { setMenuOpen(false); onLogout(); }}>
                  <Icon name="logout" size={15} /> Выйти
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
