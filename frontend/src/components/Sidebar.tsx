import { ReactNode, useEffect, useRef, useState } from 'react';
import { CLIENTS_ENABLED } from '../config';
import { Icon, IconName } from './Icon';
import { NotificationBell } from './NotificationBell';
import { applyHidden, applyOrder, isHidden, MenuPrefs, moveItem, PROTECTED, toggleHidden } from '../lib/menu-order';
import { DropdownMenu, MenuItem, MenuSeparator } from './ui/dropdown-menu';
import { setQuietSource } from '../lib/quiet';
import { Avatar } from './Avatar';
import { ThemeSwitch } from './ThemeSwitch';
import { Logo } from './Logo';
import { AuthedMedia } from './AuthedMedia';
import { buildPath, isConsoleHost, navigate, Route, Section } from '../lib/router';
import { openSupport } from './support/SupportDock';
import { roleLabel } from '../lib/labels';
import { NavCounters } from '../hooks/useNavCounters';
import { useEscape } from '../hooks/useEscape';
import { PRESENCE_CHANGED } from './MyStatusBar';
import { FocusMenu, focusLine } from './FocusMenu';
import { humanMinutes } from './SecretaryPanel';
import { getSocket } from '../lib/socket';
import { api } from '../lib/api';
import type { Focus } from '../types';
import { AppUpdateRow } from './AppUpdateRow';
import { OptionSelect } from './ui/option-select';
import { initialsOf } from '../lib/initials';
import { restartTour, restartWelcome } from '../lib/tour';

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
  /** Раздел пока живёт только в сборке для dev (config.ts → DEV_FEATURES). */
  devOnly?: 'clients';
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
  /*
    «Задачи» (реестр по всем проектам) больше не отдельная строка меню — заказчик
    перенёс их в «Проекты»: кнопка «Все задачи» стоит в шапке таблицы проектов и
    каждой доски, рядом с «Все проекты». Адрес /tasks жив, и пока он открыт,
    подсвечен пункт «Проекты и Задачи».
  */
  {
    section: 'projects',
    // «и Задачи» — задачи по всем проектам живут здесь же, кнопкой «Все задачи»
    label: 'Проекты и Задачи',
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
  route, user, organizations, avatarPath, unread, counters, activeCalls, inCall, currentCallId,
  onSwitchOrg, onSearch, onJoinCall, onOpenSecretary, onHoverSection, onLogout,
}: {
  route: Route;
  user: { id: string; role: string; fullName: string; tenantId: string; platformStaff?: boolean; uiPrefs?: MenuPrefs };
  organizations: { tenantId: string; name: string; role: string; logoFileId?: string | null }[];
  avatarPath: string | null;
  unread: number;
  counters: NavCounters;
  /**
   * Идущие созвоны, куда мне МОЖНО войти: начатые мной, куда звали или впускали.
   * Чужие сюда не попадают вовсе — ни кнопкой, ни именами (#1567).
   */
  activeCalls: { id: string; startedAt?: number; wasIn: boolean; names: string[] }[];
  /** Я сам сейчас в разговоре: тогда «присоединиться» к нему незачем. */
  inCall: boolean;
  /** Созвон, в котором я сейчас: его блок ведёт обратно в окно разговора. */
  currentCallId?: string | null;
  onSwitchOrg: (tenantId: string) => void;
  /** voice — открыть окно поиска сразу со включённым микрофоном. */
  onSearch: (voice?: boolean) => void;
  onJoinCall: (roomId: string) => void;
  onOpenSecretary: () => void;
  /** наведение на пункт меню — повод прогреть данные раздела заранее */
  onHoverSection: (section: Section) => void;
  onLogout: () => void;
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  // на узком экране панель выезжает поверх содержимого, а не сжимает его
  const [open, setOpen] = useState(false);
  // часы для «созвон идёт N мин»: тикают, только пока есть что показывать
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activeCalls.length) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [activeCalls.length]);
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
  /** Сколько предложений секретаря ждут решения (ТЗ-21) — живьём по событию. */
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    const load = () => api.proposalsSummary().then((s) => setWaiting(s.total)).catch(() => undefined);
    load();
    const socket = getSocket();
    socket.on('assistant.proposal', load);
    socket.on('connect', load);
    return () => { socket.off('assistant.proposal', load); socket.off('connect', load); };
  }, []);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * Личное меню: порядок пунктов и скрытые разделы.
   *
   * Настройка приходит с сервера вместе с профилем — человек садится за другой
   * компьютер и видит то же меню, которое себе собрал. В браузере такое «сбрасывалось
   * само» при первой же смене устройства.
   */
  const [prefs, setPrefs] = useState<MenuPrefs>(user.uiPrefs ?? {});
  const [archiveOpen, setArchiveOpen] = useState(false);
  /*
    Перетаскивание пунктов как в Битриксе (#4601): зажал пункт мышью и тянешь —
    меню целиком подсвечивается (режим правки), соседи расступаются, отпустил —
    порядок сохранён. Без отдельного режима «Настроить меню».
  */
  const [drag, setDrag] = useState<{ section: string; from: number; to: number; dy: number; h: number } | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  /** Отпустили после перетаскивания — следующий клик по ссылке не переход. */
  const noClickUntil = useRef(0);
  useEffect(() => { setPrefs(user.uiPrefs ?? {}); }, [user.uiPrefs]);

  const allowed = MENU.filter((i) => visible(i.roles, user.role) && (!i.platformOnly || (user.platformStaff && isConsoleHost()))
    && (!i.devOnly || CLIENTS_ENABLED));
  const ordered = applyOrder(allowed, prefs);
  const menuItems = applyHidden(ordered, prefs);
  const hiddenItems = ordered.filter((i) => isHidden(i.section, prefs));
  // Меню уже трогали: только тогда «Вернуть по умолчанию» вообще имеет смысл.
  const hasPrefs = !!(prefs.order?.length || prefs.hidden?.length || prefs.home);
  /** Главная страница: открывается при входе и по логотипу (#4601). */
  const home = prefs.home && allowed.some((i) => i.section === prefs.home) ? prefs.home : 'focus';

  const savePrefs = (next: MenuPrefs) => {
    setPrefs(next);
    // Не ждём ответа: перестановка должна ощущаться мгновенно, а неудача сохранения
    // хуже всего лечится замиранием интерфейса.
    // Только своё — порядок, скрытые, главная: остальные ключи настроек пишут другие
    // места (обучение, Chat Bar), и устаревшая копия отсюда затирала бы их.
    void api.saveUiPrefs({ order: next.order ?? [], hidden: next.hidden ?? [], home: next.home ?? '' }).catch(() => undefined);
  };

  /** Новый порядок: видимые как расставлены, скрытые — следом, их место неважно. */
  const placeAt = (section: string, to: number) => {
    const shown = menuItems.map((i) => String(i.section)).filter((x) => x !== section);
    shown.splice(to, 0, section);
    const rest = ordered.map((i) => String(i.section)).filter((x) => !shown.includes(x));
    savePrefs({ ...prefs, order: [...shown, ...rest] });
  };

  const startDrag = (e: { button: number; pointerType: string; clientY: number; target: EventTarget }, section: string) => {
    if (e.button !== 0 || e.pointerType !== 'mouse' || collapsed) return;
    if ((e.target as HTMLElement).closest('.nav-gear')) return;
    const groups = Array.from(navRef.current?.querySelectorAll<HTMLElement>(':scope > .nav-group') ?? []);
    const from = menuItems.findIndex((i) => i.section === section);
    if (from < 0 || groups.length !== menuItems.length) return;
    const rects = groups.map((g) => g.getBoundingClientRect());
    const h = rects[from].height + 2;
    const startY = e.clientY;
    let to = from;
    let started = false;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (!started && Math.abs(dy) < 5) return;
      started = true;
      // место среди остальных пунктов: сколько их центров выше указателя
      to = rects.filter((r, k) => k !== from && ev.clientY > r.top + r.height / 2).length;
      setDrag({ section, from, to, dy, h });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('nav-dragging-body');
      if (started) {
        noClickUntil.current = Date.now() + 300;
        if (to !== from) placeAt(section, to);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.body.classList.add('nav-dragging-body');
  };
  /** Сдвиг соседа, пока тянут: место освобождается там, куда пункт встанет. */
  const dragShift = (k: number): number => {
    if (!drag || k === drag.from) return 0;
    const other = k < drag.from ? k : k - 1;
    const pos = other < drag.to ? other : other + 1;
    return (pos - k) * drag.h;
  };

  const shift = (section: string, dir: -1 | 1) => {
    const current = ordered.map((i) => String(i.section));
    // соседа ищем среди видимых: скрытые между ними не должны «съедать» нажатие
    const shown = menuItems.map((i) => String(i.section));
    const neighbour = shown[shown.indexOf(section) + dir];
    if (!neighbour) return;
    savePrefs({ ...prefs, order: moveItem(current, section, current.indexOf(neighbour)) });
  };
  const hide = (section: string) => savePrefs({ ...prefs, hidden: toggleHidden(prefs.hidden ?? [], section) });
  const unhide = (section: string) => savePrefs({ ...prefs, hidden: (prefs.hidden ?? []).filter((x) => x !== section) });
  /*
    «Сделать главной страницей»: пункт встаёт первым и возвращается в меню, если был
    скрыт, — главная страница не может прятаться (#4601, как в Битриксе).
  */
  const makeHome = (section: string) => {
    const current = ordered.map((i) => String(i.section));
    savePrefs({ ...prefs, home: section, order: moveItem(current, section, 0), hidden: (prefs.hidden ?? []).filter((x) => x !== section) });
    go({ section: section as Section });
  };
  // Вход на «/» — открываем выбранную главную, а не всегда «Фокус дня».
  useEffect(() => {
    if (home !== 'focus' && window.location.pathname === '/') navigate({ section: home as Section }, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Свой статус присутствия: читается из сводки при входе, ставится из меню профиля. */
  const [myStatus, setMyStatus] = useState<'busy' | 'away' | null>(null);
  useEffect(() => {
    const load = () => api.presence()
      .then((rows) => setMyStatus(rows.find((r) => String(r.userId) === String(user.id))?.status ?? null))
      .catch(() => undefined);
    void load();
    // при входе и когда статус поменяли на экране «Фокус дня» (#1535)
    window.addEventListener(PRESENCE_CHANGED, load);
    return () => window.removeEventListener(PRESENCE_CHANGED, load);
  }, [user.id]);
  const setStatus = (status: 'busy' | 'away' | null) => {
    setMyStatus(status);
    void api.setPresenceStatus(status).catch(() => undefined);
  };
  // Esc — тем же общим хуком, что и остальные слои: Escape закрывает верхний.


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
  useEffect(() => { setQuietSource('manual', focus?.kind === 'deep'); }, [focus]);

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
    // «Ещё» в нижних вкладках телефона: выдвинуть панель поверх экрана (ТЗ-9)
    const openDrawer = () => setOpen(true);
    window.addEventListener('teamcrm:open-sidebar', openDrawer);
    return () => {
      window.removeEventListener('teamcrm:toggle-sidebar', toggle);
      window.removeEventListener('teamcrm:open-sidebar', openDrawer);
    };
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

  /*
    Созвон, в который можно войти (#1567). Яркий зелёный блок с тем, кто внутри и
    сколько идёт, — по нажатию сразу в разговор. Видят его только свои (сервер отдаёт
    лишь созвоны, куда человека звали).
    21.10 (заказчик): блок живёт, ПОКА ЖИВЁТ МИТ, — и когда я сам в нём: окно
    разговора свёрнуто или убрано, а блок напоминает, что созвон идёт, и по нажатию
    разворачивает его. Пока я в созвоне, чужие комнаты не показываем — нажатие
    увело бы из текущего разговора.
  */
  const visibleCalls = inCall ? activeCalls.filter((c) => c.id === currentCallId) : activeCalls;
  const callWidget = visibleCalls.map((c) => {
    const mine = inCall && c.id === currentCallId;
    const who = c.names.length === 0 ? (mine ? 'пока вы одни' : 'пока никого — вас ждут')
      : c.names.length <= 2 ? c.names.join(', ')
      : `${c.names.slice(0, 2).join(', ')} и ещё ${c.names.length - 2}`;
    const action = mine ? 'Открыть созвон' : c.wasIn ? 'Вернуться в созвон' : 'Присоединиться';
    const mins = c.startedAt ? Math.max(0, Math.floor((now - c.startedAt) / 60_000)) : null;
    const title = `${action}. В созвоне: ${c.names.join(', ') || 'никого'}`;
    return (
      <button key={c.id} className="nav-call" onClick={() => { onJoinCall(c.id); setOpen(false); }} title={title} aria-label={title}>
        <span className="nav-call-icon"><Icon name="phone" size={16} /></span>
        {!collapsed && (
          <span className="nav-call-text">
            <span className="nav-call-head">
              {mine ? 'Вы в созвоне' : c.wasIn ? 'Вы вышли из созвона' : 'Идёт созвон'}{mins !== null ? ` · ${mins < 1 ? 'только начался' : `${mins} мин`}` : ''}
            </span>
            <span className="nav-call-who">{who}</span>
            <span className="nav-call-go">{action} →</span>
          </span>
        )}
      </button>
    );
  });

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
      draggable={false}
      onClick={(e) => {
        // только что тащили пункт — это не нажатие
        if (Date.now() < noClickUntil.current) { e.preventDefault(); return; }
        // Ctrl/Cmd-клик и средняя кнопка должны открывать в новой вкладке как обычная ссылка
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        // Мы уже в этом разделе — переходить некуда, и клик работает переключателем.
        // Но из подраздела («Встречи» внутри «Чатов») клик ведёт в сам раздел: раньше
        // он лишь сворачивал подпункты, и вернуться к чатам было нельзя (14.10).
        if (active && onRepeat && !route.view) return onRepeat();
        go(to);
      }}
    >
      {children}
    </a>
  );

  const org = organizations.find((o) => o.tenantId === user.tenantId);
  const orgName = org?.name ?? 'Моя организация';
  /*
    Логотип компании вместо общего знака QEVO, если он загружен.

    Человек работает в СВОЁМ пространстве, и знак чужого продукта в шапке — первое,
    что отличает арендованную систему от своей. Знак QEVO остаётся на экране входа
    и в приложении на телефоне: там он говорит, чем человек пользуется.
  */
  const orgLogo = org?.logoFileId ?? null;

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
              onClick={() => go({ section: home as Section })}
              title={`${orgName} · на главную`}
              aria-label="На главную"
            >
              {orgLogo
                ? <AuthedMedia fileId={orgLogo} name={orgName} mime="image/png" className="nav-org-logo" />
                : <Logo size={30} />}
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
              <Avatar path={avatarPath} fallback={initialsOf(user.fullName)} className="avatar-sm" />
              <span className={`nav-dot nav-dot-${focus?.kind ?? 'free'}`} aria-hidden="true" />
              <span className="nav-user-text">
                <span className="nav-user-name">{user.fullName}</span>
                <span className="nav-user-role" title={organizations.length > 1 ? `Пространство: ${orgName}` : focusLine(focus)}>
                  {organizations.length > 1 ? orgName : focusLine(focus)}
                </span>
              </span>
            </button>
            {/* Центр уведомлений (#4655) — на виду, рядом с аккаунтом: как колокольчик в шапке Битрикса */}
            <NotificationBell className="nav-bell" />
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
                {/* #4605: пройти обучение заново — общий обзор и подсказки разделов */}
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); setOpen(false); restartTour(); }}
                >
                  <Icon name="book" size={15} /> Обучение
                </button>
                {/* #4620: первый запуск заново — слайды, выбор и Qevo-бот */}
                <button className="menu-item" role="menuitem" onClick={() => { setMenuOpen(false); setOpen(false); restartWelcome(); }}>
                  <Icon name="rocket" size={15} /> Быстрый старт
                </button>
                {/* Пространство — здесь же: переключить или создать. Переименовать — в профиле, у создателя. */}
                <div className="menu-theme">
                  <span className="dim">Пространство</span>
                  <OptionSelect
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
                  </OptionSelect>
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
            <button className="nav-search" onClick={() => { setOpen(false); onSearch(); }} title="Поиск и команды (Ctrl+K)">
              <Icon name="search" size={16} />
              <span className="nav-label">Поиск…</span>
              <kbd className="nav-kbd">Ctrl K</kbd>
            </button>
            <button
              className="nav-search-mic"
              onClick={() => { setOpen(false); onSearch(true); }}
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
        <nav ref={navRef} className={`nav-main${drag ? ' nav-editing' : ''}`} aria-label="Разделы">
          {menuItems.map((item) => {
            // реестр задач живёт внутри «Проектов» — там и подсветка
            const active = route.section === item.section || (item.section === 'projects' && route.section === 'tasks');
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
            const idx = menuItems.indexOf(item);
            return (
              <div
                key={item.section}
                className={`nav-group${drag?.section === item.section ? ' nav-group-dragged' : ''}`}
                data-tour={`nav-${item.section}`}
                onMouseEnter={() => onHoverSection(item.section)}
                onPointerDown={(e) => startDrag(e, item.section)}
                style={drag ? { transform: `translateY(${drag.section === item.section ? drag.dy : dragShift(idx)}px)` } : undefined}
              >
                {link({ section: item.section }, active, 'nav-item', item.label, (
                  <>
                    <Icon name={item.icon} size={18} />
                    <span className="nav-label">{item.label}</span>
                    {home === item.section && !collapsed && (
                      <span className="nav-home" title="Главная страница — открывается при входе">
                        <Icon name="home" size={13} />
                      </span>
                    )}
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
                {/*
                  Шестерёнка у пункта — как в Битриксе (#4601): появляется при наведении,
                  с задержкой около секунды, чтобы не мелькать, когда мышь просто
                  проходит по меню. Отдельного режима «Настроить меню» больше нет.
                */}
                {!collapsed && (
                  <DropdownMenu
                    align="start"
                    trigger={(
                      <button className="nav-gear" title="Настроить пункт меню" aria-label={`Настроить пункт «${item.label}»`}>
                        <Icon name="settings" size={14} />
                      </button>
                    )}
                  >
                    {home === item.section
                      ? <MenuItem disabled icon={<Icon name="home" size={15} />} onSelect={() => undefined}>Это главная страница</MenuItem>
                      : <MenuItem icon={<Icon name="home" size={15} />} onSelect={() => makeHome(item.section)}>Сделать главной страницей</MenuItem>}
                    {idx > 0 && <MenuItem icon={<Icon name="arrow-up" size={15} />} onSelect={() => shift(item.section, -1)}>Переместить выше</MenuItem>}
                    {idx < menuItems.length - 1 && <MenuItem icon={<Icon name="arrow-down" size={15} />} onSelect={() => shift(item.section, 1)}>Переместить ниже</MenuItem>}
                    {home !== item.section && !PROTECTED.includes(item.section) && (
                      <MenuItem icon={<Icon name="eye-off" size={15} />} onSelect={() => hide(item.section)}>Скрыть пункт</MenuItem>
                    )}
                    {hasPrefs && (
                      <>
                        <MenuSeparator />
                        <MenuItem icon={<Icon name="refresh" size={15} />} onSelect={() => savePrefs({ order: [], hidden: [], home: '' })}>Вернуть меню по умолчанию</MenuItem>
                      </>
                    )}
                  </DropdownMenu>
                )}
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
                {/* #1567: идущий созвон — сразу под «Чаты & Миты», а не в самом низу под прокруткой */}
                {item.section === 'chat' && callWidget}
              </div>
            );
          })}
          {!menuItems.some((i) => i.section === 'chat') && callWidget}

          {/*
            Скрытые пункты — архивом внизу, как в Битриксе (#4601): свёрнуты, видны
            только когда что-то скрыто. Отсюда же открыть скрытый раздел или вернуть.
          */}
          {!collapsed && hiddenItems.length > 0 && (
            <div className="nav-archive">
              <button className="nav-archive-head" onClick={() => setArchiveOpen((v) => !v)} aria-expanded={archiveOpen}>
                <Icon name={archiveOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                Скрытые пункты · {hiddenItems.length}
              </button>
              {archiveOpen && (
                <>
                  {hiddenItems.map((item) => (
                    <div key={item.section} className="nav-archive-row">
                      {link({ section: item.section }, route.section === item.section, 'nav-item', item.label, (
                        <>
                          <Icon name={item.icon} size={16} />
                          <span className="nav-label">{item.label}</span>
                        </>
                      ))}
                      <button className="nav-archive-back" onClick={() => unhide(item.section)} title="Вернуть в меню" aria-label={`Вернуть «${item.label}» в меню`}>
                        <Icon name="eye" size={14} />
                      </button>
                    </div>
                  ))}
                  <button className="nav-archive-all" onClick={() => savePrefs({ ...prefs, hidden: [] })}>
                    <Icon name="refresh" size={13} /> Восстановить все пункты
                  </button>
                </>
              )}
            </div>
          )}
          {/* В приложении на телефоне: версия, последнее обновление и кнопка обновиться */}
          {!collapsed && <AppUpdateRow />}

        </nav>

        {/* ── нижний блок ── */}
        <div className="nav-bottom">
          {/*
            Служба заботы — над AI Секретарём (просьба заказчика).

            Раньше это был кружок в правом нижнем углу: он висел над полем ввода чатов
            и мешал печатать. Строка в панели видна из любого раздела и ничему не мешает;
            сама панель разговора открывается, как и прежде, поверх страницы.
          */}
          {/*
            Тот же кружок, что был в углу, — теперь здесь, над AI Секретарём (заказчик
            хотел именно его). Строки с подписью под ним нет: раздел «Служба заботы» и так
            есть в списке разделов выше, и две одинаковые строки подряд читались как ошибка.
          */}
          {/*
            QEVO Bot — личный секретарь (ТЗ-18) — рядом со службой заботы: в списке чатов
            его не находили («его там в чатах никто не найдёт в жизни», заказчик 08.10).
            Кружок открывает бота на весь экран; виден из любого раздела.
          */}
          <div className="nav-support-wrap">
            <button
              className="nav-support-fab nav-bot-fab"
              onClick={() => { setOpen(false); navigate({ section: 'chat', chatId: 'anthill' }); }}
              title="QEVO Bot — ваш секретарь: напоминания, сводки, встречи, почта"
              aria-label="Открыть QEVO Bot — секретаря"
            >
              <Icon name="robot" size={20} />
            </button>
            {/* удержание 1 с — шторка «голосом, созвон или написать» (ТЗ-34, п. 2.1) */}
            <button className="nav-support-fab" data-care-hold="" onClick={() => { setOpen(false); openSupport(); }} title="Написать в службу заботы" aria-label="Написать в службу заботы">
              <Icon name="support" size={20} />
            </button>
          </div>
          {/* AI Секретарь: показываем ровно то, что записано в журнале действий.
              Ноль тоже показываем — это честнее, чем прятать виджет, обещавший пользу. */}
          <button className="nav-secretary" onClick={() => { setOpen(false); onOpenSecretary(); }} title="Что система сделала за вас сама">
            <Icon name="sparkles" size={18} />
            <span className="nav-label nav-secretary-text">
              <span>AI Секретарь · {secretary?.actions ?? 0}</span>
              <span className="nav-secretary-saved">
                {waiting > 0
                  ? <b className="nav-secretary-waiting">ждут решения: {waiting}</b>
                  : secretary && secretary.savedMinutes > 0 ? `сэкономлено ${humanMinutes(secretary.savedMinutes)}` : 'действий сегодня'}
              </span>
            </span>
          </button>

        </div>
      </aside>
    </>
  );
}
