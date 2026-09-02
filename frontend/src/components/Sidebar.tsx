import { ReactNode, useEffect, useRef, useState } from 'react';
import { Icon, IconName } from './Icon';
import { ProjectsNav } from './ProjectsNav';
import { CallStarter } from './CallStarter';
import { applyHidden, applyOrder, isHidden, MenuPrefs, moveItem, PROTECTED, toggleHidden } from '../lib/menu-order';
import { GuestLinkButton } from './GuestLinkButton';
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
    // «Входящие» из меню убраны: письмо в задачу невозможно, пока у домена нет входящей
    // почты, а голосовая постановка и так стоит кнопкой выше и в командной строке.
    // Экран и приёмные вебхуки живы — пункт возвращается одной строкой здесь.
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

/**
 * Какие разделы человек свернул.
 *
 * Список проектов у активного раздела раскрывался всегда, и при трёх десятках досок
 * панель превращалась в прокрутку внутри прокрутки. Теперь список можно убрать,
 * оставаясь в разделе, и выбор запоминается: свернул однажды — больше не мешает.
 */
const FOLDED_KEY = 'teamcrm.navFolded';

function readFolded(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) || '[]')); } catch { return new Set(); }
}

export function Sidebar({
  route, user, organizations, avatarPath, unread, counters, activeCall, inCall,
  onSwitchOrg, onNewTask, onVoiceTask, onSearch, onJoinCall, onStartCall, onOpenSecretary, onHoverSection, onLogout,
}: {
  route: Route;
  user: { role: string; fullName: string; tenantId: string; uiPrefs?: MenuPrefs };
  organizations: { tenantId: string; name: string; role: string }[];
  avatarPath: string | null;
  unread: number;
  counters: NavCounters;
  /** Идёт созвон в компании — можно присоединиться. Не повод запрещать свой звонок. */
  activeCall: { participants: number } | null;
  /** Я сам сейчас в разговоре: только это мешает начать новый. */
  inCall: boolean;
  onSwitchOrg: (tenantId: string) => void;
  onNewTask: () => void;
  onVoiceTask: () => void;
  /** voice — открыть окно поиска сразу со включённым микрофоном. */
  onSearch: (voice?: boolean) => void;
  onJoinCall: () => void;
  /** Начать созвон из любого раздела — панель видна везде. */
  onStartCall: (opts: { memberIds: string[]; withAi: boolean }) => void;
  onOpenSecretary: () => void;
  /** наведение на пункт меню — повод прогреть данные раздела заранее */
  onHoverSection: (section: Section) => void;
  onLogout: () => void;
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  // на узком экране панель выезжает поверх содержимого, а не сжимает его
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(readFolded);

  const toggleFold = (section: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(section)) next.delete(section); else next.add(section);
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
    return next;
  });
  const [focus, setFocus] = useState<Focus | null>(null);
  const [secretary, setSecretary] = useState<{ actions: number; savedMinutes: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * Личное меню: порядок пунктов и скрытые разделы.
   *
   * Настройка приходит с сервера вместе с профилем — человек садится за другой
   * компьютер и видит то же меню, которое себе собрал. В браузере такое «сбрасывалось
   * само» при первой же смене устройства.
   */
  const [prefs, setPrefs] = useState<MenuPrefs>(user.uiPrefs ?? {});
  const [tuning, setTuning] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  useEffect(() => { setPrefs(user.uiPrefs ?? {}); }, [user.uiPrefs]);

  const allowed = MENU.filter((i) => visible(i.roles, user.role));
  const ordered = applyOrder(allowed, prefs);
  // В режиме настройки показываем и спрятанное — иначе вернуть его будет неоткуда.
  const menuItems = tuning ? ordered : applyHidden(ordered, prefs);

  const savePrefs = (next: MenuPrefs) => {
    setPrefs(next);
    // Не ждём ответа: перестановка должна ощущаться мгновенно, а неудача сохранения
    // хуже всего лечится замиранием интерфейса.
    void api.saveUiPrefs(next).catch(() => undefined);
  };

  const dropOn = (section: string) => {
    if (!dragged || dragged === section) return;
    const current = ordered.map((i) => String(i.section));
    const to = current.indexOf(section);
    savePrefs({ ...prefs, order: moveItem(current, dragged, to) });
    setDragged(null);
  };


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

  const link = (
    to: Route, active: boolean, cls: string, title: string, children: ReactNode,
    /** Повторный клик по уже открытому разделу — сворачивает его содержимое. */
    onRepeat?: () => void,
  ) => (
    <a
      className={`${cls}${active ? ' active' : ''}`}
      href={buildPath(to)}
      title={collapsed ? title : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        // Ctrl/Cmd-клик и средняя кнопка должны открывать в новой вкладке как обычная ссылка
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        // Мы уже в этом разделе — переходить некуда, и клик работает переключателем
        if (active && onRepeat) return onRepeat();
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
              {/* Роль дописываем, только когда организаций несколько: тогда она и различает
                  строки. В единственной организации это лишнее слово, которое к тому же
                  съедает название — в закрытом виде видно именно текст выбранной строки. */}
              {organizations.map((o) => (
                <option key={o.tenantId} value={o.tenantId}>
                  {organizations.length > 1 ? `${o.name} · ${roleLabel(o.role)}` : o.name}
                </option>
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

          <div className="nav-search-row">
            <button className="nav-search" onClick={() => onSearch()} title="Поиск и команды (Ctrl+K)">
              <Icon name="search" size={16} />
              <span className="nav-label">Поиск…</span>
              <kbd className="nav-kbd">Ctrl K</kbd>
            </button>
            <button
              className="nav-search-mic"
              onClick={() => onSearch(true)}
              title="Сказать, что найти или что сделать"
              aria-label="Голосовой поиск"
            >
              <Icon name="mic" size={16} />
            </button>
          </div>

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
          {/*
            Позвать людей — одна строка, а не две.

            Созвон и ссылка для гостя отвечают на один вопрос: «как сейчас поговорить».
            Раздельными строками они занимали треть панели и читались как разные темы,
            хотя выбор между ними — только «свой или со стороны».

            Созвон нужен из любого места, а не только из переписки: разговор начинают,
            когда упёрлись в вопрос, а не когда открыли чат. Кнопка гаснет лишь от
            СОБСТВЕННОГО разговора — чужой созвон в компании звонить не мешает.
          */}
          {user.role !== 'client' && !collapsed && (
            <div className="nav-call-row">
              <CallStarter disabled={inCall} onStart={onStartCall} />
              <GuestLinkButton label="Гость" />
            </div>
          )}
        </div>

        {/* ── основное меню: порядок и состав человек настраивает под себя ── */}
        <nav className="nav-main" aria-label="Разделы">
          {menuItems.map((item) => {
            const active = route.section === item.section;
            // Ноль не показываем вовсе — по ТЗ панель молчит, пока от человека
            // ничего не требуется. Пустой кружок читался бы как «что-то есть».
            const badge = item.section === 'chat' ? unread
              : item.section === 'focus' ? counters.focus.decide
              : item.section === 'calendar' ? counters.calendar?.pending ?? 0
              : item.section === 'radar' ? counters.radar?.risks ?? 0
              // «В проектах что-то произошло»: чужие изменения в моих задачах, до
              // которых я ещё не дошёл. То же самое, что непрочитанное в чатах.
              : item.section === 'projects' ? counters.tasks?.unread ?? 0
              : 0;
            const badgeTitle = item.section === 'focus' ? 'ждут вашего решения'
              : item.section === 'calendar' ? 'приглашений без ответа'
              : item.section === 'projects' ? 'новых изменений в ваших задачах'
              : item.section === 'radar' ? 'задач просрочено' : undefined;
            // Разворачивать нечего, если у раздела нет ни проектов, ни подпунктов —
            // шеврон в таком месте обещает содержимое, которого не существует.
            const subs = item.subs?.filter((sub) => visible(sub.roles, user.role)) ?? [];
            const hasChildren = item.section === 'projects' || subs.length > 0;
            const unfolded = active && !collapsed && !folded.has(item.section);
            const hiddenNow = isHidden(item.section, prefs);
            return (
              <div
                key={item.section}
                className={`nav-group${tuning ? ' nav-group-tuning' : ''}${hiddenNow ? ' nav-group-hidden' : ''}`}
                onMouseEnter={() => onHoverSection(item.section)}
                draggable={tuning}
                onDragStart={() => setDragged(item.section)}
                onDragOver={(e) => { if (tuning) e.preventDefault(); }}
                onDrop={() => dropOn(item.section)}
              >
                {/* В режиме настройки пункт не открывается, а переставляется:
                    случайный переход посреди перетаскивания сбивает всю затею. */}
                {tuning && (
                  <span className="nav-tune-row">
                    <Icon name="list" size={14} />
                    <span className="nav-label">{item.label}</span>
                    <button
                      className="nav-tune-eye"
                      title={PROTECTED.includes(item.section)
                        ? 'Этот раздел скрыть нельзя — из него настраивается всё остальное'
                        : hiddenNow ? 'Вернуть в меню' : 'Убрать из меню'}
                      disabled={PROTECTED.includes(item.section)}
                      onClick={() => savePrefs({ ...prefs, hidden: toggleHidden(prefs.hidden ?? [], item.section) })}
                    >
                      <Icon name={hiddenNow ? 'eye-off' : 'eye'} size={15} />
                    </button>
                  </span>
                )}
                {!tuning && (<>
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
                    {/* Стрелка — часть самого пункта и только показывает состояние:
                        сворачивает повторное нажатие на пункт, отдельной кнопки нет. */}
                    {hasChildren && active && !collapsed && (
                      <Icon name={unfolded ? 'chevron-down' : 'chevron-right'} size={14} />
                    )}
                  </>
                ), hasChildren ? () => toggleFold(item.section) : undefined)}
                {/* Проекты раскрываются прямо под своим разделом, как в привычных
                    таск-менеджерах: отдельная колонка слева отъедала место у доски
                    и висела перед глазами даже тогда, когда переключать нечего. */}
                {item.section === 'projects' && unfolded && (
                  <ProjectsNav
                    currentId={route.projectId ?? null}
                    canManage={user.role !== 'client'}
                    canDelete={user.role === 'owner' || user.role === 'manager'}
                  />
                )}
                {/* подпункты — только у открытого раздела: панель должна оставаться короткой */}
                {unfolded && subs.map((sub) => (
                  <span key={sub.label}>
                    {link(sub.route, route.view === sub.route.view, 'nav-sub', sub.label, (
                      <>
                        <Icon name={sub.icon} size={15} />
                        <span className="nav-label">{sub.label}</span>
                      </>
                    ))}
                  </span>
                ))}
                </>
                )}
              </div>
            );
          })}

          {/* Настройка меню — внизу списка и мелко: ею пользуются один раз,
              а место в панели занимают каждый день. */}
          {!collapsed && (
            <div className="nav-tune-bar">
              <button className="nav-tune-btn" onClick={() => { setTuning((v) => !v); setDragged(null); }}>
                <Icon name={tuning ? 'check' : 'settings'} size={13} />
                {tuning ? 'Готово' : 'Настроить меню'}
              </button>
              {tuning && (prefs.order?.length || prefs.hidden?.length) && (
                <button className="nav-tune-btn" onClick={() => savePrefs({})} title="Вернуть порядок и состав по умолчанию">
                  Сбросить
                </button>
              )}
            </div>
          )}

          {/* Созвон уже идёт — вход в него, иначе к разговору не присоединиться тому, кого не позвали */}
          {activeCall && !inCall && (
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
