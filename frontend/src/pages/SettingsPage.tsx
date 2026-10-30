import { Icon, IconName } from '../components/Icon';
import { ReportsPanel } from '../components/ReportsPanel';
import { IntegrationsPanel } from '../components/IntegrationsPanel';
import { AssistantPanel } from '../components/AssistantPanel';
import { HandoffGatePanel } from '../components/HandoffGatePanel';
import { SecurityPanel } from '../components/SecurityPanel';
import { TagsSettingsPanel } from '../components/TagsSettingsPanel';
import { OnboardingPanel } from '../components/OnboardingPanel';
import { ChatAnalysisPanel } from '../components/ChatAnalysisPanel';
import { WorkSettingsPanel } from '../components/WorkSettingsPanel';
import { AiUsagePanel } from '../components/AiUsagePanel';
import { AiPlanPanel } from '../components/AiPlanPanel';
import { KnowledgePanel } from '../components/KnowledgePanel';
import { TeamPanel } from '../components/TeamPanel';
import { FocusSettingsPanel } from '../components/FocusSettingsPanel';
import { MailPanel } from '../components/MailPanel';
import { GooglePanel } from '../components/google/GooglePanel';
import { GuestBrandPanel } from '../components/GuestBrandPanel';
import { lazyComponent } from '../lib/lazy';
// оплата открывается редко — отдельным куском
const BillingPanel = lazyComponent(() => import('../components/billing/BillingPanel').then((m) => m.default));
import { navigate, Route } from '../lib/router';
import { useState } from 'react';
import { useAuth } from '../state/auth';
import { confirmAction } from '../components/ui/dialog';
import { enterQa } from '../lib/qa-switch';

/**
 * «Настройки и интеграции» — единая точка вместо кнопок, разбросанных по верхней панели.
 *
 * Содержимое пока не переписано: открываются те же панели, что и раньше, но теперь
 * у каждой есть адрес (`/settings/integrations`), её можно послать ссылкой и закрыть
 * кнопкой «назад». Полноценный экран настроек по ТЗ (5 блоков, каталог интеграций,
 * права, биллинг) — отдельный этап.
 */

type Card = {
  tab: string;
  title: string;
  hint: string;
  icon: IconName;
  roles?: string[];
};

const CARDS: Card[] = [
  // Профиль первым: сюда заходят чаще всего и все, а не только владелец —
  // пароль, уведомления и оформление нужны каждому, интеграции почти никому.
  {
    tab: 'account',
    title: 'Профиль',
    hint: 'Имя и фото, день рождения, пароль, уведомления, доступность, оформление, сессии',
    icon: 'user',
  },
  {
    tab: 'team',
    title: 'Команда и пространство',
    hint: 'Сотрудники, должности, отделы и группы, приглашения по ссылке',
    icon: 'users',
    roles: ['owner', 'manager'],
  },
  {
    tab: 'integrations',
    title: 'Интеграции',
    hint: 'Битрикс24 и YouGile, ключи ИИ, библиотека промптов, Telegram',
    icon: 'plug',
    roles: ['owner'],
  },
  {
    /* Клиенты переехали из левого меню сюда — в кабинет руководителя (20.10). */
    tab: 'clients',
    title: 'Клиенты',
    hint: 'Клиенты и сделки: контакты, задачи, встречи и что делать дальше',
    icon: 'building',
    roles: ['owner', 'manager'],
  },
  {
    tab: 'mail',
    title: 'Почта',
    hint: 'Ваш ящик Gmail, Яндекс, Mail.ru, Outlook или свой: секретарь разбирает письма и готовит ответы',
    icon: 'mail',
    roles: ['owner', 'manager', 'member'],
  },
  {
    // #1565: личное подключение Google — Диск, Документы, Календарь
    tab: 'google',
    title: 'Google',
    hint: 'Диск, Документы и Календарь: файлы при задачах, документы из QEVO, встречи в Google Календаре',
    icon: 'link',
    roles: ['owner', 'manager', 'member'],
  },
  {
    // мастер-план релиза, этап 4: подписка компании через ЮKassa
    tab: 'billing',
    title: 'Тариф и оплата',
    hint: 'Пробный период, тариф, оплата картой через ЮKassa и история платежей',
    icon: 'building',
  },
  {
    // ТЗ-33: тариф ИИ, интернет-лимит и смена тарифа
    tab: 'ai-plan',
    title: 'Тариф и ИИ',
    hint: '«Базовый» или «Расширенный» с интернетом, сколько интернет-запросов осталось, лимит',
    icon: 'sparkles',
    roles: ['owner', 'manager'],
  },
  {
    tab: 'ai-usage',
    title: 'Расход ИИ',
    hint: 'Сколько токенов ушло, на какие возможности и по дням — включая те, где ИИ не запускался',
    icon: 'sparkles',
    roles: ['owner', 'manager'],
  },
  {
    // Отчёты — сразу за профилем: их собирают регулярно (неделя, месяц), и сотрудник
    // тоже — свой отчёт для руководителя. Руководитель видит отчёт по всей компании.
    tab: 'reports',
    title: 'Отчёты',
    hint: 'PDF по задачам за период: выполнено, сроки, проекты и люди, просрочки, время — со сравнением',
    icon: 'chart',
  },
  {
    tab: 'knowledge',
    title: 'База знаний и регламенты',
    hint: 'Архив компании для поиска по смыслу и ответов ИИ',
    icon: 'book',
  },
  {
    tab: 'handoff',
    title: 'Приёмка работы',
    hint: 'Что спросить у исполнителя, когда он сдаёт задачу: чек-лист, отчёт, результат',
    icon: 'check',
  },
  {
    tab: 'onboarding',
    title: 'Настройка QEVO',
    hint: 'Путь от пустого пространства до первой задачи: что уже сделано и что осталось',
    icon: 'target',
    roles: ['owner', 'manager'],
  },
  {
    tab: 'work',
    title: 'Рабочее время',
    hint: 'Часы, выходные и праздники: по ним живут календарь и тихие часы ассистента',
    icon: 'clock',
  },
  {
    tab: 'security',
    title: 'Безопасность',
    hint: 'Кто что может, скрытые контакты, корзина задач и журнал действий',
    icon: 'lock',
    // Карточку видит владелец: правила компании задаёт он, и содержимое всё равно
    // закрыто сервером — прятать её от остальных незачем, но и показывать нечего.
    roles: ['owner'],
  },
  {
    tab: 'tags',
    title: 'Теги задач',
    hint: 'Классификация задач компании: ИИ подбирает и ставит теги сам',
    icon: 'tag',
  },
  {
    tab: 'chat-analysis',
    title: 'Разбор переписки',
    hint: 'Агент читает затихшие рабочие разговоры и показывает, что в них понял',
    icon: 'chat',
    roles: ['owner', 'manager'],
  },
  {
    tab: 'guest',
    title: 'Гостевая страница',
    hint: 'Как клиент видит встречу по ссылке: логотип, цвет, приветствие, запись и итоги',
    icon: 'users',
    roles: ['owner', 'manager'],
  },
  {
    tab: 'focus',
    title: 'Фокус дня',
    hint: 'Три главных действия дня, глубокая работа, «Команда сейчас» — включение и как работает',
    icon: 'target',
    roles: ['owner', 'manager'],
  },
  {
    tab: 'assistant',
    title: 'Напоминания ассистента',
    hint: 'О чём AI Секретарь напоминает сам, а о чём спрашивает разрешения',
    icon: 'sparkles',
  },
];

/** Разделы с ограничением по роли: адрес открывается, а содержимое — нет. */
const DENIED: [string, string[]][] = [
  ['reports', ['owner', 'manager', 'member']],
  ['chat-analysis', ['owner', 'manager']],
  ['security', ['owner']],
  ['team', ['owner', 'manager']],
  ['integrations', ['owner']],
  ['ai-usage', ['owner', 'manager']],
  ['ai-plan', ['owner', 'manager']],
  ['focus', ['owner', 'manager']],
  ['guest', ['owner', 'manager']],
];

export function SettingsPage({ route, role }: { route: Route; role: string }) {
  const canManage = role === 'owner' || role === 'manager';
  const close = () => navigate({ section: 'settings' });

  return (
    <div className="page">
      <div className="page-head">
        <h2><Icon name="settings" size={18} /> Настройки и интеграции</h2>
      </div>

      <div className="settings-grid">
        <QaSwitchCard />
        {CARDS.filter((c) => !c.roles || c.roles.includes(role)).map((c) => (
          <button
            key={c.tab}
            className="settings-card"
            onClick={() => (c.tab === 'account'
              ? navigate({ section: 'profile' })
              : c.tab === 'clients'
                ? navigate({ section: 'clients' })
                : navigate({ section: 'settings', tab: c.tab }))}
          >
            <span className="settings-card-icon"><Icon name={c.icon} size={20} /></span>
            <span className="settings-card-title">{c.title}</span>
            <span className="settings-card-hint">{c.hint}</span>
          </button>
        ))}
      </div>

      {route.tab === 'team' && canManage && <TeamPanel onClose={close} />}
      {route.tab === 'integrations' && role === 'owner' && <IntegrationsPanel onClose={close} />}
      {route.tab === 'ai-usage' && canManage && <AiUsagePanel onClose={close} />}
      {route.tab === 'billing' && role !== 'client' && <BillingPanel canPay={role === 'owner'} onClose={close} />}
      {route.tab === 'ai-plan' && canManage && <AiPlanPanel canManage={role === 'owner'} onClose={close} />}
      {/* Личный ящик — у каждого свой (ТЗ-18): письма не видит никто, кроме хозяина. */}
      {route.tab === 'mail' && role !== 'client' && <MailPanel onClose={close} />}
      {route.tab === 'google' && role !== 'client' && <GooglePanel onClose={close} />}
      {route.tab === 'reports' && role !== 'client' && <ReportsPanel canManage={canManage} onClose={close} />}
      {route.tab === 'knowledge' && <KnowledgePanel canManage={canManage} onClose={close} />}
      {route.tab === 'handoff' && <HandoffGatePanel canManage={role === 'owner'} onClose={close} />}
      {route.tab === 'assistant' && <AssistantPanel canManage={role === 'owner'} onClose={close} />}
      {route.tab === 'focus' && canManage && <FocusSettingsPanel canManage={role === 'owner'} onClose={close} />}
      {route.tab === 'guest' && canManage && <GuestBrandPanel canManage={role === 'owner'} onClose={close} />}
      {/* Что агент понял в переписке, журнал решений и счётчики попадания (ТЗ-12). */}
      {route.tab === 'chat-analysis' && canManage
        && <ChatAnalysisPanel canManage={role === 'owner'} onClose={close} />}
      {/* Подсказку можно открыть заново, даже если её убрали с «Фокуса дня» (ТЗ-11, разд. 74). */}
      {route.tab === 'onboarding' && <OnboardingPanel onClose={close} />}
      {route.tab === 'work' && <WorkSettingsPanel canManage={role === 'owner'} onClose={close} />}
      {/* Список тегов видят все (по ним фильтруют), правит — руководитель. */}
      {route.tab === 'tags' && <TagsSettingsPanel canManage={canManage} onClose={close} />}
      {/* Центр безопасности: права, правила компании, журнал и просмотры контактов. */}
      {route.tab === 'security' && <SecurityPanel onClose={close} />}

      {/*
        Раздел есть, а прав нет.

        Карточки закрытых разделов сотруднику не показываются, но адрес можно
        открыть по ссылке из переписки или из закладки. Раньше в таком случае
        открывалась пустая страница — человек решал, что раздел сломан. Говорим
        прямо, кому он доступен.
      */}
      {DENIED.some(([tab, allowed]) => route.tab === tab && !allowed.includes(role)) && (
        <div className="settings-denied dim">
          Этот раздел доступен руководителю
          {route.tab === 'integrations' ? '' : ' и его заму'}.
          Сотрудники и заказчики его не открывают.
        </div>
      )}
    </div>
  );
}

/**
 * #1562: временная кнопка «Войти как qa test». Есть только у тех, кому сервер выдал
 * допуск (строка в qa_switch_access); у всех остальных компаний и людей её нет.
 */
function QaSwitchCard() {
  const qa = useAuth().user?.qaSwitch;
  const [error, setError] = useState('');
  if (!qa?.canSwitch || !qa.targetName) return null;
  const name = qa.targetName;
  const go = async () => {
    const ok = await confirmAction({
      title: `Войти как ${name}?`,
      description: `Вы войдёте как ${name}. Вернуться можно кнопкой сверху.`,
      confirmLabel: 'Войти',
    });
    if (!ok) return;
    setError('');
    try { await enterQa(qa.targetId); } catch (e) { setError((e as Error).message || 'Не удалось переключиться'); }
  };
  return (
    <button className="settings-card" onClick={go} data-testid="qa-switch">
      <span className="settings-card-icon"><Icon name="user" size={20} /></span>
      <span className="settings-card-title">Войти как {name}</span>
      <span className="settings-card-hint">{error || 'Тестовый сотрудник для проверки интерфейса — временно'}</span>
    </button>
  );
}
