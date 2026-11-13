import { ReactNode, useEffect, useRef, useState } from 'react';
import { QevoBotMark } from './QevoBotMark';
import { CLIENTS_ENABLED } from '../config';
import { Icon, IconName } from './Icon';
import { applyOrder, MENU_PREFS_CHANGED, MenuPrefs, moreSections, moveItem } from '../lib/menu-order';
import { INBOX_CHANGED, inboxApi } from '../lib/inbox-api';
import { flowApi } from '../lib/flow-api';
import { DropdownMenu, MenuItem, MenuSeparator } from './ui/dropdown-menu';
import { setQuietSource, setStatusQuiet } from '../lib/quiet';
import { Avatar } from './Avatar';
import { ThemeSwitch } from './ThemeSwitch';
import { AuthedMedia } from './AuthedMedia';
import { buildPath, isConsoleHost, navigate, Route, Section } from '../lib/router';
import { roleLabel } from '../lib/labels';
import { NavCounters } from '../hooks/useNavCounters';
import { useEscape } from '../hooks/useEscape';
import { PRESENCE_CHANGED } from './MyStatusBar';
import { FocusDialog, FocusMenu, focusLine, focusSessionLine } from './FocusMenu';
import { useFocusSession } from '../hooks/useFocusSession';
import { lazyComponent } from '../lib/lazy';

const SidebarLists = lazyComponent(() => import('./SidebarLists').then((m) => m.default));
/** #4764: «Продолжить работу» — тем же отдельным куском, что и избранное. */
const ContinueWork = lazyComponent(() => import('./ContinueWork').then((m) => m.default));
import { getSocket } from '../lib/socket';
import { api } from '../lib/api';
import type { Focus } from '../types';
import { AppUpdateRow } from './AppUpdateRow';
import './sidebar-v3.css';
import { initialsOf } from '../lib/initials';
import { restartTour } from '../lib/tour';

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

/*
  #4725: «Избранное» — такой же пункт меню, как разделы: его перетаскивают, двигают
  шестерёнкой и прячут. Раздела-страницы за ним нет — это блок списков, поэтому ключ
  не входит в маршруты, а главной страницей его сделать нельзя.
*/
const FAV = 'fav' as Section;
const FAV_ITEM: Item = { section: FAV, label: 'Избранное', icon: 'star', hint: 'Избранное и последние задачи' };
/** #4715 (03.11): «Черновики» — отдельный пункт меню, устроен так же, как «Избранное». */
const DRAFTS = 'drafts' as Section;
/** Пункты-блоки без своей страницы: ссылкой не открываются, главной не становятся. */
/** #4807 §5, п. 9: AI-агент — пункт меню со строкой пользы под ним (раздел 7). */
const AGENT = 'agent' as Section;
const AGENT_ITEM: Item = { section: AGENT, label: 'AI-агент', icon: 'sparkles', hint: 'Работает в фоновом режиме' };
const isBlock = (s: Section) => s === FAV || s === DRAFTS || s === AGENT;
/** #4807 §5, п. 11: в «⋯ Ещё» — Черновики, Новости, Пульс команды, Личный кабинет. */
const MORE: Section[] = ['news', 'radar'];
/*
  #4826: пункты «Ещё» — такие же пункты меню: шестерёнка, порядок, перенос в основное
  меню и обратно. Раньше Черновики и Личный кабинет были вписаны в «Ещё» намертво.
*/
const DRAFTS_ITEM: Item = { section: DRAFTS, label: 'Черновики', icon: 'edit', hint: 'Недописанные задачи и сообщения' };
const SETTINGS_ITEM: Item = { section: 'settings' as Section, label: 'Личный кабинет', icon: 'settings', hint: 'Профиль, команда, интеграции и настройки' };
/** Что лежит в «Ещё», пока человек не трогал меню. */
const MORE_DEFAULT: string[] = [DRAFTS, 'news', 'radar', 'settings'];

const MENU: Item[] = [
  {
    // #4807 §6: одно место для всего, что ждёт моей реакции; заменило блок «Уведомления»
    section: 'inbox',
    label: 'Входящие',
    icon: 'inbox',
    hint: 'Решения, упоминания, назначенное вам, протоколы и предложения ИИ',
  },
  {
    section: 'focus',
    label: 'Фокус дня',
    icon: 'target',
    hint: 'Что делать сегодня, поручения другим и то, что ждёт вашего решения',
    // «Входящие» из меню убраны: письмо в задачу невозможно, пока у домена нет входящей
    // почты, а голосовая постановка и так стоит кнопкой выше и в командной строке.
    // Экран и приёмные вебхуки живы — пункт возвращается одной строкой здесь.
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
    label: 'Чаты & Созвоны',
    icon: 'chat',
    hint: 'Личные, групповые и проектные обсуждения, созвоны',
    subs: [
      { label: 'Встречи — созвоны', icon: 'record', route: { section: 'chat', view: 'meetings' } },
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
  /** journal — открыть сразу вкладку «Журнал» (из строки пользы ИИ, #4807 §7). */
  onOpenSecretary: (journal?: boolean) => void;
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
  // #4777: глубокий фокус сессией (с задачами) важнее ручного статуса — он и в строке под именем
  const { session: focusSession, receivedAt: focusAt } = useFocusSession();
  const inSession = !!focusSession && !focusSession.finished;
  const statusLine = inSession ? focusSessionLine(focusSession, focusAt) : focusLine(focus);
  const menuRef = useRef<HTMLDivElement>(null);
  /** #4831: окно глубокого фокуса — вне меню аккаунта, иначе оно закрывалось вместе с меню. */
  const [deepOpen, setDeepOpen] = useState(false);

  /**
   * Личное меню: порядок пунктов и скрытые разделы.
   *
   * Настройка приходит с сервера вместе с профилем — человек садится за другой
   * компьютер и видит то же меню, которое себе собрал. В браузере такое «сбрасывалось
   * само» при первой же смене устройства.
   */
  const [prefs, setPrefs] = useState<MenuPrefs>(user.uiPrefs ?? {});
  /*
    Перетаскивание пунктов как в Битриксе (#4601): зажал пункт мышью и тянешь —
    меню целиком подсвечивается (режим правки), соседи расступаются, отпустил —
    порядок сохранён. Без отдельного режима «Настроить меню».
  */
  const [drag, setDrag] = useState<{ section: string; from: number; to: number; dy: number; h: number; zone: 'main' | 'more' } | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  /** Отпустили после перетаскивания — следующий клик по ссылке не переход. */
  const noClickUntil = useRef(0);
  useEffect(() => { setPrefs(user.uiPrefs ?? {}); }, [user.uiPrefs]);
  useEffect(() => {
    const on = (e: Event) => setPrefs((cur) => ({ ...cur, ...((e as CustomEvent<MenuPrefs>).detail ?? {}) }));
    window.addEventListener(MENU_PREFS_CHANGED, on);
    return () => window.removeEventListener(MENU_PREFS_CHANGED, on);
  }, []);
  /*
    #4807 §6.4: одно число у «Входящих» — непрочитанное «Важное» вместе с решениями,
    которые ждут меня. Жёлтое, если среди них есть решения, иначе синее.
  */
  const [inbox, setInbox] = useState<{ n: number; decisions: number; tip: string }>({ n: 0, decisions: 0, tip: '' });
  useEffect(() => {
    let t = 0;
    const load = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        void Promise.all([inboxApi.counters(), flowApi.queue().catch(() => [])]).then(([c, q]) => {
          const decisions = q.length + c.decisions;
          const next = { n: c.important - c.decisions + decisions, decisions, tip: `Ждут решения ${decisions} · Упоминания ${c.mentions} · Назначено ${c.assigned}` };
          setInbox(next);
          // колокольчик на телефоне показывает то же число, что «Входящие» (NotificationBell)
          (window as Window & { __qevoInbox?: typeof next }).__qevoInbox = next;
          window.dispatchEvent(new CustomEvent('qevo:inbox-count', { detail: next }));
        }).catch(() => undefined);
      }, 300);
    };
    load();
    const socket = getSocket();
    socket.on('inbox.item', load); socket.on('inbox.read', load); socket.on('connect', load);
    window.addEventListener(INBOX_CHANGED, load);
    window.addEventListener('teamcrm:tasks-changed', load);
    return () => {
      window.clearTimeout(t);
      socket.off('inbox.item', load); socket.off('inbox.read', load); socket.off('connect', load);
      window.removeEventListener(INBOX_CHANGED, load);
      window.removeEventListener('teamcrm:tasks-changed', load);
    };
  }, []);
  /** #4807 §7: строка пользы ИИ — только подтверждённое и только моё, за сегодня. */
  const [aiLine, setAiLine] = useState<{ line: string; tip: string; hint: string } | null>(null);
  useEffect(() => {
    const load = () => api.aiStats().then(setAiLine).catch(() => undefined);
    load();
    const t = window.setInterval(load, 60_000);
    window.addEventListener('teamcrm:tasks-changed', load);
    return () => { window.clearInterval(t); window.removeEventListener('teamcrm:tasks-changed', load); };
  }, []);
  const [moreOpen, setMoreOpen] = useState(false);

  const allowed = MENU.filter((i) => visible(i.roles, user.role) && (!i.platformOnly || (user.platformStaff && isConsoleHost()))
    && (!i.devOnly || CLIENTS_ENABLED));
  // #4807: «Входящие» — первыми и у тех, кто уже расставил меню по-своему
  const menuPrefs: MenuPrefs = prefs.order?.length && !prefs.order.includes('inbox') ? { ...prefs, order: ['inbox', ...prefs.order] } : prefs;
  // AI-агент и «Избранное» — под разделами; Черновики, Новости, Пульс и Личный кабинет — в «Ещё»
  const universe: Item[] = [
    ...allowed.filter((i) => !MORE.includes(i.section)), AGENT_ITEM, FAV_ITEM,
    DRAFTS_ITEM, ...allowed.filter((i) => MORE.includes(i.section)), SETTINGS_ITEM,
  ];
  // #4826: «Ещё» — свой порядок (prefs.more); спрятанные прежде пункты тоже здесь
  const moreKeys = moreSections(prefs, MORE_DEFAULT, universe.map((i) => String(i.section)));
  const ordered = applyOrder(universe.filter((i) => !moreKeys.includes(i.section)), menuPrefs);
  const menuItems = ordered;
  const moreItems = moreKeys.map((k) => universe.find((i) => i.section === k)!).filter(Boolean);
  // Меню уже трогали: только тогда «Вернуть по умолчанию» вообще имеет смысл.
  const hasPrefs = !!(prefs.order?.length || prefs.hidden?.length || prefs.home || prefs.more);
  /** Главная страница: открывается при входе и по логотипу (#4601). */
  const home = prefs.home && allowed.some((i) => i.section === prefs.home) ? prefs.home : 'focus';

  const savePrefs = (next: MenuPrefs) => {
    setPrefs(next);
    // Не ждём ответа: перестановка должна ощущаться мгновенно, а неудача сохранения
    // хуже всего лечится замиранием интерфейса.
    // Только своё — порядок, скрытые, главная: остальные ключи настроек пишут другие
    // места (обучение, Chat Bar), и устаревшая копия отсюда затирала бы их.
    // «Ещё» шлём, только когда его меняли: null — «как по умолчанию»
    const more = next.more !== undefined ? { more: next.more } : {};
    void api.saveUiPrefs({ order: next.order ?? [], hidden: next.hidden ?? [], home: next.home ?? '', ...more }).catch(() => undefined);
    window.dispatchEvent(new CustomEvent(MENU_PREFS_CHANGED, { detail: { order: next.order ?? [], hidden: next.hidden ?? [], home: next.home ?? '', ...more } }));
  };

  /** Новый порядок: видимые как расставлены, скрытые — следом, их место неважно. */
  const placeAt = (section: string, to: number) => {
    const shown = menuItems.map((i) => String(i.section)).filter((x) => x !== section);
    shown.splice(to, 0, section);
    const rest = ordered.map((i) => String(i.section)).filter((x) => !shown.includes(x));
    savePrefs({ ...prefs, order: [...shown, ...rest] });
  };

  const startDrag = (e: { button: number; pointerType: string; clientY: number; target: EventTarget }, section: string, zone: 'main' | 'more' = 'main') => {
    if (e.button !== 0 || e.pointerType !== 'mouse' || collapsed) return;
    if ((e.target as HTMLElement).closest('.nav-gear')) return;
    // у «Избранного» тянут за заголовок: строки внутри — ссылки, клик по ним не должен стать переносом
    if ((e.target as HTMLElement).closest('.sbl-body')) return;
    // #4826: в «Ещё» переставляют так же, мышью, — внутри своего списка
    const keys = zone === 'main' ? menuItems.map((i) => String(i.section)) : moreKeys;
    const groups = zone === 'main'
      ? Array.from(navRef.current?.querySelectorAll<HTMLElement>(':scope > .nav-group') ?? [])
      : Array.from(moreRef.current?.querySelectorAll<HTMLElement>(':scope > .nav-group') ?? []);
    const from = keys.indexOf(section);
    if (from < 0 || groups.length !== keys.length) return;
    const rects = groups.map((g) => g.getBoundingClientRect());
    const h = rects[from].height + 2;
    const startY = e.clientY;
    let to = from;
    let started = false;
    let lastY = startY;
    const move = (ev: PointerEvent) => {
      lastY = ev.clientY;
      const dy = ev.clientY - startY;
      if (!started && Math.abs(dy) < 5) return;
      started = true;
      // место среди остальных пунктов: сколько их центров выше указателя
      to = rects.filter((r, k) => k !== from && ev.clientY > r.top + r.height / 2).length;
      setDrag({ section, from, to, dy, h, zone });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('nav-dragging-body');
      if (started) {
        noClickUntil.current = Date.now() + 300;
        /*
          Из «Ещё» — вверх, в основное меню, и обратно (просьба заказчика к #4826):
          отпустили выше кнопки «Ещё» — пункт встаёт в основное меню на то место, где
          отпустили; пункт основного меню, опущенный в раскрытое «Ещё», уходит туда.
        */
        const moreBtn = navRef.current?.querySelector<HTMLElement>('.nav-more-btn')?.getBoundingClientRect();
        const mainRects = Array.from(navRef.current?.querySelectorAll<HTMLElement>(':scope > .nav-group') ?? []).map((g) => g.getBoundingClientRect());
        const moreRects = Array.from(moreRef.current?.querySelectorAll<HTMLElement>(':scope > .nav-group') ?? []).map((g) => g.getBoundingClientRect());
        const above = (rs: DOMRect[], skip = -1) => rs.filter((r, k) => k !== skip && lastY > r.top + r.height / 2).length;
        if (zone === 'more' && moreBtn && lastY < moreBtn.top) {
          const order = menuItems.map((i) => String(i.section));
          order.splice(above(mainRects), 0, section);
          saveMore(moreKeys.filter((x) => x !== section), { order });
        } else if (zone === 'main' && moreBtn && lastY > moreBtn.bottom && home !== section) {
          const more = moreKeys.filter((x) => x !== section);
          more.splice(moreOpen ? above(moreRects) : more.length, 0, section);
          saveMore(more);
        } else if (to !== from) {
          if (zone === 'main') placeAt(section, to);
          else saveMore(moveItem(moreKeys, section, to));
        }
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.body.classList.add('nav-dragging-body');
  };
  /** Сдвиг соседа, пока тянут: место освобождается там, куда пункт встанет. */
  const dragShift = (k: number, zone: 'main' | 'more' = 'main'): number => {
    if (!drag || drag.zone !== zone || k === drag.from) return 0;
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
  /*
    #4826: «Ещё» — второй список меню. Записываем его целиком; прежние «скрытые» при
    этом переезжают в него насовсем (hidden пустеет), чтобы правда была одна.
  */
  const saveMore = (more: string[], patch: MenuPrefs = {}) => savePrefs({ ...prefs, ...patch, more, hidden: [] });
  /** «Скрыть пункт» — убрать в «Ещё», в конец. */
  const hide = (section: string) => saveMore([...moreKeys.filter((x) => x !== section), section]);
  /** Вернуть из «Ещё» в основное меню — последним. */
  const toMain = (section: string) => saveMore(moreKeys.filter((x) => x !== section), {
    order: [...menuItems.map((i) => String(i.section)), section],
  });
  const moreShift = (section: string, dir: -1 | 1) => {
    const at = moreKeys.indexOf(section);
    if (at + dir < 0 || at + dir >= moreKeys.length) return;
    saveMore(moveItem(moreKeys, section, at + dir));
  };
  /*
    «Сделать главной страницей»: пункт встаёт первым и возвращается в меню, если был
    скрыт, — главная страница не может прятаться (#4601, как в Битриксе).
  */
  const makeHome = (section: string) => {
    const current = ordered.map((i) => String(i.section));
    const order = current.includes(section) ? moveItem(current, section, 0) : [section, ...current];
    // из «Ещё» главная тоже уходит в основное меню: главная страница не прячется
    if (moreKeys.includes(section)) saveMore(moreKeys.filter((x) => x !== section), { home: section, order });
    else savePrefs({ ...prefs, home: section, order, hidden: (prefs.hidden ?? []).filter((x) => x !== section) });
    go({ section: section as Section });
  };
  const resetMenu = () => savePrefs({ order: [], hidden: [], home: '', more: null });
  // Вход на «/» — открываем выбранную главную, а не всегда «Фокус дня».
  useEffect(() => {
    if (window.location.pathname !== '/') return;
    const goHome = () => { if (home !== 'focus') navigate({ section: home as Section }, { replace: true }); };
    if (prefs.startup === 'project' && prefs.startProject) {
      navigate({ section: 'projects', projectId: String(prefs.startProject) }, { replace: true });
    } else if (prefs.startup === 'focus_session') {
      api.focusSessionCurrent().then((s) => {
        const t = s && !s.finished ? s.task ?? s.tasks?.[0] : null;
        if (t && window.location.pathname === '/') navigate({ section: 'projects', projectId: String(t.projectId), taskId: String(t.id) }, { replace: true });
        else goHome();
      }).catch(goHome);
    } else goHome();
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
    loadFocus();
    // фокус можно поставить и из командной строки — строка под именем обязана это показать
    window.addEventListener('teamcrm:focus-changed', loadFocus);
    return () => {
      window.removeEventListener('teamcrm:focus-changed', loadFocus);
    };
  }, []);

  // «Не беспокоить» — это в том числе тишина: глубокий фокус глушит и сигналы, и звонок
  useEffect(() => { setQuietSource('manual', focus?.kind === 'deep'); }, [focus]);
  /*
    #4782, п. 8: остальные статусы тоже объясняют, что пробивается. «Занят» — ручной
    статус (presence), остальные — фокус под именем. Просроченный фокус не действует.
  */
  const [manualStatus, setManualStatus] = useState<'busy' | 'away' | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    const load = () => api.presence().then((rows) => setManualStatus(rows.find((r) => String(r.userId) === String(user.id))?.status ?? null)).catch(() => undefined);
    load();
    window.addEventListener(PRESENCE_CHANGED, load);
    return () => window.removeEventListener(PRESENCE_CHANGED, load);
  }, [user?.id]);
  // «Отошёл» кончается при возвращении (#4782, п. 8): вкладка снова перед глазами — снимаем
  useEffect(() => {
    if (manualStatus !== 'away') return;
    const since = Date.now();
    const back = () => {
      if (document.hidden || Date.now() - since < 60_000) return;
      void api.setPresenceStatus(null).then(() => { setManualStatus(null); window.dispatchEvent(new Event(PRESENCE_CHANGED)); }).catch(() => undefined);
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => { window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); };
  }, [manualStatus]);
  useEffect(() => {
    const live = focus && (!focus.until || new Date(focus.until).getTime() > Date.now()) ? focus.kind : null;
    setStatusQuiet(live === 'call' || live === 'break' ? 'all' : live === 'quick' || manualStatus === 'busy' ? 'personal' : 'none');
  }, [focus, manualStatus]);

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
          {/* #4807 §5, п. 1: строка 36 px — переключатель пространства и «Свернуть» справа */}
          <div className="nav-ws-row">
            <DropdownMenu
              align="start"
              trigger={(
                <button className="nav-ws" title={`Пространство: ${orgName}`}>
                  {(() => { const letter = <span className="nav-ws-logo" aria-hidden="true">{orgName.trim().charAt(0).toUpperCase()}</span>; return orgLogo ? <AuthedMedia bare fileId={orgLogo} name={orgName} mime="image/png" className="nav-ws-logo is-img" fallback={letter} /> : letter; })()}
                  <span className="nav-label nav-ws-text"><b>{orgName} <Icon name="chevron-down" size={12} /></b><span>пространство</span></span>
                </button>
              )}
            >
              {organizations.map((o) => (
                <MenuItem key={o.tenantId} onSelect={() => { if (String(o.tenantId) !== String(user.tenantId)) onSwitchOrg(o.tenantId); }} icon={<Icon name={String(o.tenantId) === String(user.tenantId) ? 'check' : 'building'} size={15} />}>
                  {o.name} · {roleLabel(o.role)}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => onSwitchOrg('__new__')} icon={<Icon name="plus" size={15} />}>Создать пространство…</MenuItem>
            </DropdownMenu>
            <button className="nav-ws-fold" onClick={toggleCollapsed} title={collapsed ? 'Развернуть меню' : 'Свернуть меню'} aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}>
              <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={15} />
            </button>
          </div>
          <div className="nav-org">
            {/*
              Верхнего меню больше нет (#4717, 02.11): наверху — сквозной поиск, он открывается
              из любого раздела (и по Ctrl+K). Аккаунт и личный кабинет — внизу (#4716). Знак
              компании переехал вниз, к аккаунту, — чтобы поиску хватило ширины.
            */}
            <div className="nav-search-row nav-search-top">
              <button className="nav-search" onClick={() => { setOpen(false); onSearch(); }} title="Поиск и команды (Ctrl+K)">
                <Icon name="search" size={16} />
                <span className="nav-label">Поиск</span>
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
          {/* #4764: появляется только при незавершённых действиях */}
          <ContinueWork onGo={() => setOpen(false)} compact={collapsed} />
          {menuItems.map((item) => {
            if ((item.section === FAV || item.section === DRAFTS) && collapsed) return null;
            // реестр задач живёт внутри «Проектов» — там и подсветка
            const active = route.section === item.section || (item.section === 'projects' && route.section === 'tasks');
            // Ноль не показываем вовсе — по ТЗ панель молчит, пока от человека
            // ничего не требуется. Пустой кружок читался бы как «что-то есть».
            /*
              #4807 §5: счётчиков в меню два — «Входящие» (жёлтый, если ждут ваши решения,
              иначе синий) и «Чаты» (синий). У «Фокуса дня» — серое число задач на сегодня.
              Красного в меню нет.
            */
            const badge = item.section === 'inbox' ? inbox.n
              : item.section === 'chat' ? unread
              : item.section === 'focus' ? counters.focus.today
              : 0;
            const badgeTitle = item.section === 'inbox' ? inbox.tip
              : item.section === 'chat' ? 'непрочитанных чатов'
              : item.section === 'focus' ? 'задач на сегодня' : undefined;
            const badgeTone = item.section === 'inbox' ? (inbox.decisions ? ' nav-count-warn' : ' nav-count-info')
              : item.section === 'chat' ? ' nav-count-info' : ' nav-count-mute';
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
                onMouseEnter={() => { if (!isBlock(item.section)) onHoverSection(item.section); }}
                onPointerDown={(e) => startDrag(e, item.section)}
                style={drag?.zone === 'main' ? { transform: `translateY(${drag.section === item.section ? drag.dy : dragShift(idx)}px)` } : undefined}
              >
                {/* #4713, #4715, #4725: избранное и черновики; модуль грузится после первого экрана */}
                {item.section === AGENT ? (
                  <button className="nav-item nav-agent" onClick={() => { setOpen(false); onOpenSecretary(!!aiLine?.line); }} title={collapsed ? `AI-агент${aiLine?.line ? ` · ${aiLine.line}` : aiLine?.hint ? ` · ${aiLine.hint}` : ''}` : aiLine?.tip || 'Работает в фоновом режиме'}>
                    <Icon name="sparkles" size={18} />
                    <span className="nav-label nav-agent-text">
                      <span>AI-агент</span>
                      {aiLine?.line ? <span className="nav-agent-line">сегодня: {aiLine.line}</span> : aiLine?.hint ? <span className="nav-agent-hint">{aiLine.hint}</span> : null}
                    </span>
                  </button>
                ) : isBlock(item.section) ? <SidebarLists onGo={() => setOpen(false)} part={item.section === DRAFTS ? 'drafts' : 'fav'} /> : link({ section: item.section }, active, 'nav-item', item.label, (
                  <>
                    <Icon name={item.icon} size={18} />
                    <span className="nav-label">{item.label}</span>
                    {/* #4901: колокольчик у «Входящих» — чтобы не путать их с чатом и входящими сообщениями */}
                    {item.section === 'inbox' && !collapsed && (
                      <span aria-hidden="true" style={{ display: 'inline-flex', color: '#f5a524', marginLeft: -4, filter: 'drop-shadow(0 0 3px rgba(245,165,36,.45))' }}>
                        <Icon name="bell" size={16} />
                      </span>
                    )}
                    {home === item.section && !collapsed && (
                      <span className="nav-home" title="Главная страница — открывается при входе">
                        <Icon name="home" size={13} />
                      </span>
                    )}
                    {badge > 0 && (
                      <span
                        className={`nav-count${badgeTone}`}
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
                    {isBlock(item.section) ? null : home === item.section
                      ? <MenuItem disabled icon={<Icon name="home" size={15} />} onSelect={() => undefined}>Это главная страница</MenuItem>
                      : <MenuItem icon={<Icon name="home" size={15} />} onSelect={() => makeHome(item.section)}>Сделать главной страницей</MenuItem>}
                    {idx > 0 && <MenuItem icon={<Icon name="arrow-up" size={15} />} onSelect={() => shift(item.section, -1)}>Переместить выше</MenuItem>}
                    {idx < menuItems.length - 1 && <MenuItem icon={<Icon name="arrow-down" size={15} />} onSelect={() => shift(item.section, 1)}>Переместить ниже</MenuItem>}
                    {home !== item.section && (
                      <MenuItem icon={<Icon name="eye-off" size={15} />} onSelect={() => hide(item.section)}>Убрать в «Ещё»</MenuItem>
                    )}
                    {hasPrefs && (
                      <>
                        <MenuSeparator />
                        <MenuItem icon={<Icon name="refresh" size={15} />} onSelect={resetMenu}>Вернуть меню по умолчанию</MenuItem>
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
                {/* #1567: идущий созвон — сразу под «Чаты & Созвоны», а не в самом низу под прокруткой */}
                {item.section === 'chat' && callWidget}
              </div>
            );
          })}
          {!menuItems.some((i) => i.section === 'chat') && callWidget}

          {/* #4807 §5, п. 11: «⋯ Ещё» — Черновики, Новости, Пульс команды, Личный кабинет и скрытые пункты */}
          {!collapsed && (
            <div className="nav-more">
              <button className="nav-item nav-more-btn" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}>
                <Icon name="more" size={18} />
                <span className="nav-label">Ещё</span>
                <Icon name={moreOpen ? 'chevron-down' : 'chevron-right'} size={14} />
              </button>
              {moreOpen && (
                <div className="nav-more-body" ref={moreRef}>
                  {moreItems.map((item, k) => (
                    <div
                      key={item.section}
                      className={`nav-group nav-more-row${drag?.section === item.section ? ' nav-group-dragged' : ''}`}
                      onPointerDown={(e) => startDrag(e, item.section, 'more')}
                      style={drag?.zone === 'more' ? { transform: `translateY(${drag.section === item.section ? drag.dy : dragShift(k, 'more')}px)` } : undefined}
                    >
                      {item.section === AGENT ? (
                        <button className="nav-item nav-agent" onClick={() => { setOpen(false); onOpenSecretary(!!aiLine?.line); }}>
                          <Icon name="sparkles" size={18} /><span className="nav-label">AI-агент</span>
                        </button>
                      ) : isBlock(item.section) ? (
                        <SidebarLists onGo={() => setOpen(false)} part={item.section === DRAFTS ? 'drafts' : 'fav'} />
                      ) : link({ section: item.section }, route.section === item.section, 'nav-item', item.label, (
                        <>
                          <Icon name={item.icon} size={18} /><span className="nav-label">{item.label}</span>
                          {home === item.section && <span className="nav-home" title="Главная страница — открывается при входе"><Icon name="home" size={13} /></span>}
                        </>
                      ))}
                      {/* #4826: шестерёнка — как у пунктов основного меню */}
                      <DropdownMenu
                        align="start"
                        trigger={(
                          <button className="nav-gear" title="Настроить пункт меню" aria-label={`Настроить пункт «${item.label}»`}>
                            <Icon name="settings" size={14} />
                          </button>
                        )}
                      >
                        {!isBlock(item.section) && (
                          <MenuItem icon={<Icon name="home" size={15} />} onSelect={() => makeHome(item.section)}>Сделать главной страницей</MenuItem>
                        )}
                        <MenuItem icon={<Icon name="arrow-left" size={15} />} onSelect={() => toMain(item.section)}>Вернуть в основное меню</MenuItem>
                        {k > 0 && <MenuItem icon={<Icon name="arrow-up" size={15} />} onSelect={() => moreShift(item.section, -1)}>Переместить выше</MenuItem>}
                        {k < moreItems.length - 1 && <MenuItem icon={<Icon name="arrow-down" size={15} />} onSelect={() => moreShift(item.section, 1)}>Переместить ниже</MenuItem>}
                        {hasPrefs && (
                          <>
                            <MenuSeparator />
                            <MenuItem icon={<Icon name="refresh" size={15} />} onSelect={resetMenu}>Вернуть меню по умолчанию</MenuItem>
                          </>
                        )}
                      </DropdownMenu>
                    </div>
                  ))}
                  {!moreItems.length && <p className="sbl-empty">Здесь пусто: все пункты в основном меню. Уберите сюда редкие — шестерёнка у пункта → «Убрать в «Ещё»».</p>}
                </div>
              )}
            </div>
          )}
          {/* В приложении на телефоне: версия, последнее обновление и кнопка обновиться */}
          {!collapsed && <AppUpdateRow />}
          {deepOpen && (
            <FocusDialog
              onClose={() => setDeepOpen(false)}
              onSaved={() => { setDeepOpen(false); window.dispatchEvent(new Event('teamcrm:focus-changed')); }}
            />
          )}

        </nav>

        {/* ── нижний блок ── */}
        <div className="nav-bottom">
          {/* #4807 §5, п. 14: одна точка помощи — QEVO Bot с кнопкой «Позвать инженера» */}
          <button
            className="nav-item nav-help"
            data-care-hold=""
            onClick={() => { setOpen(false); navigate({ section: 'chat', chatId: 'anthill' }); }}
            title="Помощь и бот: QEVO Bot ответит сразу, инженер — за 30 секунд"
            aria-label="Помощь и бот"
          >
            {/* #4877: знак QEVO Bot (как в шапке бота) с сердечком заботы — помощь и бот в одном */}
            <span className="nav-help-ico" aria-hidden="true"><QevoBotMark size={26} /></span>
            <span className="nav-label">Помощь и бот</span>
            <span className="nav-label nav-help-time">30 сек</span>
          </button>
          <div className="nav-profile" ref={menuRef} style={{ display: 'flex', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center', gap: 6 }}>
            {/*
              Аккаунт — внизу (#4716, 02.11; до того — наверху по #1348).

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
              <span className={`nav-dot nav-dot-${inSession ? 'deep' : focus?.kind ?? 'free'}`} aria-hidden="true" />
              <span className="nav-user-text">
                <span className="nav-user-name">{user.fullName}</span>
                <span className="nav-user-role" title={statusLine}>
                  {myStatus === 'busy' ? 'Занят' : myStatus === 'away' ? 'Отошёл' : 'Свободен'} · {statusLine.charAt(0).toLowerCase() + statusLine.slice(1)}
                </span>
              </span>
              {!collapsed && <span className="nav-user-more" aria-hidden="true"><Icon name="more" size={16} /></span>}
            </button>
            {menuOpen && (
              <div className="menu-pop nav-menu-pop" role="menu">
                {/* #4807 §5: статус — один раз; пространство — наверху меню */}
                <div className="menu-theme">
                  <span className="dim">Статус</span>
                  <span className="menu-status" role="group" aria-label="Статус для коллег">
                    {([['', 'свободен'], ['busy', 'занят'], ['away', 'отошёл']] as const).map(([v, label]) => (
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
                <FocusMenu focus={focus} onChange={(f) => { setFocus(f); setMenuOpen(false); }} onDeep={() => { setMenuOpen(false); setDeepOpen(true); }} />
                <button className="menu-item" role="menuitem" onClick={() => { setMenuOpen(false); go({ section: 'profile' }); }}>
                  <Icon name="user" size={15} /> Профиль
                </button>
                <button className="menu-item" role="menuitem" onClick={() => { setMenuOpen(false); setOpen(false); go({ section: 'settings' }); }}>
                  <Icon name="settings" size={15} /> Личный кабинет
                </button>
                <button className="menu-item" role="menuitem" onClick={() => { setMenuOpen(false); go({ section: 'settings', tab: 'navigation' }); }}>
                  <Icon name="list" size={15} /> Настроить меню
                </button>
                <div className="menu-theme">
                  <span className="dim">Тема</span>
                  <ThemeSwitch />
                </div>
                {/* #4605: пройти обучение заново — общий обзор и подсказки разделов */}
                <button className="menu-item" role="menuitem" onClick={() => { setMenuOpen(false); setOpen(false); restartTour(); }}>
                  <Icon name="book" size={15} /> Обучение
                </button>
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
