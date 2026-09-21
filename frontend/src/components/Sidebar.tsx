import { ReactNode, useEffect, useRef, useState } from 'react';
import { Icon, IconName } from './Icon';
import { applyHidden, applyOrder, isHidden, MenuPrefs, moveItem, PROTECTED, toggleHidden } from '../lib/menu-order';
import { TASK_VIEWS } from '../lib/task-views';
import { setDoNotDisturb } from '../lib/sound';
import { Avatar } from './Avatar';
import { ThemeSwitch } from './ThemeSwitch';
import { Logo } from './Logo';
import { buildPath, isConsoleHost, navigate, Route, Section } from '../lib/router';
import { openSupport } from './support/SupportDock';
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
 * Структура из ТЗ и менять её нельзя: верхний блок (команда, поиск),
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
  /**
   * Пункт только для техотдела вендора И только на его собственном адресе.
   *
   * На основном домене консоли в меню нет вовсе: сотрудник вендора работает в CRM
   * как все, а поддержкой занимается по своему адресу. Так строка не мелькает на
   * общих экранах и не наводит на мысль, что у соседа «есть что-то ещё».
   */
  platformOnly?: boolean;
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
    /*
      Реестр задач отдельным разделом, а не колонкой в «Фокусе дня».

      «Фокус» отвечает на вопрос «что делать сегодня» и потому показывает только
      открытое и только со сроком — фильтры и история туда не помещаются, не сломав
      сам смысл экрана. Вопрос «покажи ВСЁ, что я поставил по всем проектам» до этого
      ответа не имел: задачи искали, обходя доски по одной.
    */
    section: 'tasks',
    label: 'Задачи',
    icon: 'check-circle',
    hint: 'Вся ваша работа по всем проектам: делаю, поручил, помогаю, наблюдаю',
    /*
      Подпункты берутся из общего словаря видов задач.

      Раньше они назывались здесь по-своему («Мне», «От меня») и расходились с
      самим разделом, где те же срезы называются «Делаю» и «Поручил». Человек
      читал в меню одно, попадал в другое. Теперь список один на всю систему:
      переименовать в двух местах по-разному стало нельзя.

      Без хвоста в адресе открываются ВСЕ задачи компании — так решил заказчик;
      у каждой роли хвост свой.
    */
    subs: TASK_VIEWS.map((v) => ({
      label: v.label,
      icon: v.icon,
      route: { section: 'tasks' as Section, view: v.key },
    })),
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
      { label: 'Встречи', icon: 'record', route: { section: 'chat', view: 'meetings' } },
    ],
  },
  {
    /*
      Новости компании — свой раздел, а не вкладка внутри чатов.

      В чатах она была не на месте: переписка живёт минутами, а объявление обязано
      лежать там, где его найдут через неделю. Отдельная строка в панели того стоит —
      так же устроены «Новости» в Битриксе, и искать их люди идут именно в меню.
      Строку оправдывает и счётчик: непрочитанное объявление видно, не заходя внутрь.
    */
    section: 'news',
    label: 'Новости',
    icon: 'bell',
    hint: 'Объявления и новости компании',
  },
  {
    section: 'radar',
    label: 'Пульс команды',
    icon: 'chart',
    hint: 'Экран руководителя: прогресс, загрузка, риски срыва сроков',
    roles: ['owner', 'manager'],
  },
  {
    /*
      Поддержка — последней строкой, под «Пульсом команды»: так попросил заказчик.

      У сотрудника, у которого что-то не работает, должна быть одна кнопка, а не
      вопрос «в какой проект и кому ставить задачу». Обращение становится обычной
      задачей владельцу в проекте поддержки — с перепиской, файлами и статусом.
      У тех, кто уже настроил порядок меню, новая строка встаёт в конец сама.
    */
    section: 'support',
    label: 'Служба заботы',
    icon: 'support',
    hint: 'Живой разговор: ответит помощник, при необходимости позовём специалиста',
  },
  {
    /*
      Консоль техподдержки продукта — только техотделу вендора.

      Строка появляется по признаку `platformStaff`, а не по роли: «owner» — это
      хозяин компании-клиента, а не разработчик CRM, и настройки нашей службы
      заботы ему не принадлежат. Клиенту раздела не существует: ни строки в меню,
      ни доступа к ручкам за ней.
    */
    section: 'console',
    label: 'Консоль',
    icon: 'lock',
    hint: 'Кабинет техотдела: обращения клиентов, дежурные, известные проблемы, справочник',
    platformOnly: true,
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
  onSwitchOrg, onSearch, onJoinCall, onOpenSecretary, onHoverSection, onLogout,
}: {
  route: Route;
  user: { id: string; role: string; fullName: string; tenantId: string; platformStaff?: boolean; uiPrefs?: MenuPrefs };
  organizations: { tenantId: string; name: string; role: string }[];
  avatarPath: string | null;
  unread: number;
  counters: NavCounters;
  /** Идёт созвон в компании — можно присоединиться. Не повод запрещать свой звонок. */
  activeCall: { participants: number } | null;
  /** Я сам сейчас в разговоре: тогда «присоединиться» к нему незачем. */
  inCall: boolean;
  onSwitchOrg: (tenantId: string) => void;
  /** voice — открыть окно поиска сразу со включённым микрофоном. */
  onSearch: (voice?: boolean) => void;
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

  const allowed = MENU.filter((i) => visible(i.roles, user.role) && (!i.platformOnly || (user.platformStaff && isConsoleHost())));
  const ordered = applyOrder(allowed, prefs);
  // В режиме настройки показываем и спрятанное — иначе вернуть его будет неоткуда.
  const menuItems = tuning ? ordered : applyHidden(ordered, prefs);
  // Меню уже трогали: только тогда «Сбросить» вообще имеет смысл.
  const hasPrefs = !!(prefs.order?.length || prefs.hidden?.length);

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

  /**
   * Выход из настройки меню.
   *
   * Отдельной функцией, потому что выйти можно тремя способами: кнопкой сверху,
   * кнопкой снизу и клавишей Esc. В настройке подменяется весь список разделов —
   * человек, не заметивший мелкую надпись «Готово» внизу, оказывался заперт:
   * ни один пункт меню в этом режиме не открывается.
   */
  const stopTuning = () => { setTuning(false); setDragged(null); };

  /** Свой статус присутствия: читается из сводки при входе, ставится из меню профиля. */
  const [myStatus, setMyStatus] = useState<'busy' | 'away' | null>(null);
  useEffect(() => {
    api.presence()
      .then((rows) => setMyStatus(rows.find((r) => String(r.userId) === String(user.id))?.status ?? null))
      .catch(() => undefined);
    // один раз при входе; дальше — своё же действие
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);
  const setStatus = (status: 'busy' | 'away' | null) => {
    setMyStatus(status);
    void api.setPresenceStatus(status).catch(() => undefined);
  };
  // Esc — тем же общим хуком, что и остальные слои: Escape закрывает верхний.
  useEscape(stopTuning, tuning);
  // В свёрнутой панели у настройки нет ни подписей, ни кнопки выхода — выходим сами.
  useEffect(() => { if (collapsed) stopTuning(); }, [collapsed]);


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
          <div className="nav-org nav-profile" ref={menuRef}>
            {/*
              Знак вместо буквы организации.

              Буква отвечала на вопрос «в какой я организации», но его же решает
              название рядом. Место в панели одно, и занимать его должен знак продукта:
              он виден на каждом экране и каждый день.
            */}
            {/*
              Знак — ещё и дорога домой.

              Так устроен любой сайт: щелчок по логотипу возвращает на главную. У нас
              он был просто картинкой, и выбраться из глубокой страницы можно было
              только через меню.
            */}
            <button
              className="nav-org-mark"
              onClick={() => go({ section: 'focus' })}
              title={`${orgName} · на главную`}
              aria-label="На главную"
            >
              <Logo size={30} />
            </button>
            {/*
              Аккаунт — наверху, над поиском (задача #1348).

              Заказчик: «в левом сайдбаре вместо названия организации — аккаунт, а
              личный кабинет поднять из самого низа наверх». Человек начинает день с
              себя: кто он, какой у него статус, куда зайти за настройками. Название
              пространства не пропало — оно второй строкой, когда пространств несколько,
              и сменить его можно в этом же меню.
            */}
            <button
              className={`nav-user${route.section === 'profile' ? ' active' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              title={`Аккаунт: ${user.fullName} — профиль, статус, тема, пространство`}
              aria-label="Аккаунт"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <Avatar path={avatarPath} fallback={user.fullName?.[0] ?? '?'} className="avatar-sm" />
              <span className={`nav-dot nav-dot-${focus?.kind ?? 'free'}`} aria-hidden="true" />
              <span className="nav-user-text">
                <span className="nav-user-name">{user.fullName}</span>
                <span className="nav-user-role" title={organizations.length > 1 ? `Пространство: ${orgName}` : focusLine(focus)}>
                  {organizations.length > 1 ? orgName : focusLine(focus)}
                </span>
              </span>
            </button>
            <button
              className="nav-collapse"
              onClick={toggleCollapsed}
              title={collapsed ? 'Развернуть панель' : 'Свернуть панель'}
              aria-label={collapsed ? 'Развернуть панель' : 'Свернуть панель'}
            >
              <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
            </button>
            {menuOpen && (
              <div className="menu-pop nav-menu-pop" role="menu">
                <FocusMenu focus={focus} onChange={(f) => { setFocus(f); setMenuOpen(false); }} />
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); go({ section: 'profile' }); }}
                >
                  <Icon name="user" size={15} /> Профиль
                </button>
                {/* Пространство — здесь же: переключить или создать. Переименовать — в профиле, у создателя. */}
                <div className="menu-theme">
                  <span className="dim">Пространство</span>
                  <select
                    className="input nav-org-select"
                    value={user.tenantId}
                    onChange={(e) => { setMenuOpen(false); onSwitchOrg(e.target.value); }}
                    aria-label="Пространство"
                  >
                    {organizations.map((o) => (
                      <option key={o.tenantId} value={o.tenantId}>
                        {organizations.length > 1 ? `${o.name} · ${roleLabel(o.role)}` : o.name}
                      </option>
                    ))}
                    {organizations.length === 0 && <option value={user.tenantId}>Моя организация</option>}
                    <option value="__new__">+ Создать пространство…</option>
                  </select>
                </div>
                {/* Свой статус для коллег — только руками (решение заказчика):
                    «занят» ставят нарочно, чтобы к тебе не шли, и снимают сами. */}
                <div className="menu-theme">
                  <span className="dim">Статус</span>
                  <span className="menu-status" role="group" aria-label="Статус для коллег">
                    {([['', 'обычный'], ['busy', 'занят'], ['away', 'отошёл']] as const).map(([v, label]) => (
                      <button
                        key={v}
                        className={`menu-status-btn${(myStatus ?? '') === v ? ' active' : ''}`}
                        onClick={() => setStatus(v === '' ? null : v)}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                </div>
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

          {/* Личный кабинет — сразу под аккаунтом, над поиском: настройки ищут рядом с собой, а не в подвале. */}
          {link({ section: 'settings' }, route.section === 'settings', 'nav-item nav-cabinet', 'Личный кабинет: профиль, команда, интеграции, настройки', (
            <>
              <Icon name="settings" size={18} />
              <span className="nav-label">Личный кабинет</span>
            </>
          ))}

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

          {/*
            Кнопок «Новая задача», «Созвон» и «Гость» здесь больше нет.

            Заказчик: постановка задачи живёт там, где задачи, — в «Проектах и досках»
            и в «Задачах», а не в панели навигации; созвон и гостевая ссылка — в чатах,
            откуда разговор и начинают. Панель — переход между разделами, и только.
            Клавиша C и командная строка по-прежнему ставят задачу из любого места.
          */}
        </div>

        {/* ── основное меню: порядок и состав человек настраивает под себя ── */}
        <nav className="nav-main" aria-label="Разделы">
          {/*
            Шапка режима настройки — липкая и всегда на виду.

            В настройке разделы не открываются, поэтому выход обязан быть заметен
            сразу, а не мелкой строчкой под списком: заказчик написал «зашёл в
            настройку меню, а обратно выхода нет». Здесь же сказано, что делать.
          */}
          {tuning && !collapsed && (
            <div className="nav-tune-head">
              <div className="nav-tune-head-row">
                <span className="nav-tune-title">Настройка меню</span>
                {/*
                  Не «Сбросить»: так читалось как «выйти без сохранения», хотя
                  несохранённого здесь не бывает вовсе. Кнопка стирает УЖЕ
                  сохранённые порядок и скрытые разделы — и только тогда, когда
                  им есть что стирать.
                */}
                {hasPrefs && (
                  <button className="btn btn-ghost btn-sm nav-tune-reset" onClick={() => savePrefs({ order: [], hidden: [] })} title="Вернуть меню к заводскому порядку и показать все разделы">
                    По умолчанию
                  </button>
                )}
                <button className="btn btn-primary btn-sm" onClick={stopTuning} title="Закрыть настройку меню">
                  <Icon name="check" size={14} />
                  Готово
                </button>
                {/*
                  Вторая дверь наружу.

                  Делают они одно и то же — и это нарочно: несохранённого здесь не
                  бывает, порядок и скрытые разделы уезжают на сервер сразу. Человек
                  в режиме настройки ищет глазами «выйти», а не «готово», и, не найдя,
                  оказывается заперт: в этом режиме ни один пункт меню не открывается.
                  Дешевле дать вторую подпись, чем спорить с тем, как её ищут.
                */}
                <button className="btn btn-ghost btn-sm" onClick={stopTuning} title="Выйти из настройки меню — всё уже сохранено">
                  <Icon name="logout" size={14} />
                  Выйти
                </button>
              </div>
            </div>
          )}
          {menuItems.map((item) => {
            const active = route.section === item.section;
            // Ноль не показываем вовсе — по ТЗ панель молчит, пока от человека
            // ничего не требуется. Пустой кружок читался бы как «что-то есть».
            const badge = item.section === 'chat' ? unread
              : item.section === 'focus' ? counters.focus.decide
              : item.section === 'calendar' ? counters.calendar?.pending ?? 0
              : item.section === 'radar' ? counters.radar?.risks ?? 0
              // Непрочитанные объявления компании: их на то и объявляют, чтобы прочитали
              : item.section === 'news' ? counters.news?.unread ?? 0
              // «В проектах что-то произошло»: чужие изменения в моих задачах, до
              // которых я ещё не дошёл. То же самое, что непрочитанное в чатах.
              : item.section === 'projects' ? counters.tasks?.unread ?? 0
              : 0;
            const badgeTitle = item.section === 'focus' ? 'ждут вашего решения'
              : item.section === 'calendar' ? 'приглашений без ответа'
              : item.section === 'projects' ? 'новых изменений в ваших задачах'
              : item.section === 'news' ? 'объявлений, которые вы не читали'
              : item.section === 'radar' ? 'задач просрочено' : undefined;
            // Разворачивать нечего, если у раздела нет ни проектов, ни подпунктов —
            // шеврон в таком месте обещает содержимое, которого не существует.
            const subs = item.subs?.filter((sub) => visible(sub.roles, user.role)) ?? [];
            /*
              Список досок из панели убран (просьба заказчика): на трёх проектах он
              удобен, на тридцати — стена ссылок, в которой ничего не найти. Проекты
              живут своим разделом с таблицей, поиском и цифрами.
            */
            const hasChildren = subs.length > 0;
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

          {/* Вход в настройку — внизу списка и мелко: ею пользуются один раз,
              а место в панели занимают каждый день. В самой настройке этой строки
              нет: выход живёт в шапке, две кнопки об одном и том же только путают. */}
          {!collapsed && !tuning && (
            <div className="nav-tune-bar">
              <button className="nav-tune-btn" onClick={() => setTuning(true)}>
                <Icon name="settings" size={13} />
                Настроить меню
              </button>
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
          {/*
            Служба заботы — над AI Секретарём (просьба заказчика).

            Раньше это был кружок в правом нижнем углу: он висел над полем ввода чатов
            и мешал печатать. Строка в панели видна из любого раздела и ничему не мешает;
            сама панель разговора открывается, как и прежде, поверх страницы.
          */}
          {/* Тот же кружок, что был в углу, — теперь здесь, над строкой: заказчик хотел именно его. */}
          <div className="nav-support-wrap">
            <button className="nav-support-fab" onClick={() => openSupport()} title="Служба заботы ANTHILL" aria-label="Служба заботы">
              <Icon name="support" size={20} />
            </button>
          </div>
          <button className="nav-item nav-support" onClick={() => openSupport()} title="Служба заботы ANTHILL: написать специалисту">
            <Icon name="support" size={18} />
            <span className="nav-label">Служба заботы</span>
          </button>
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

        </div>
      </aside>
    </>
  );
}
