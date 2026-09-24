import { Icon, IconName } from '../components/Icon';
import { IntegrationsPanel } from '../components/IntegrationsPanel';
import { AssistantPanel } from '../components/AssistantPanel';
import { HandoffGatePanel } from '../components/HandoffGatePanel';
import { TagsSettingsPanel } from '../components/TagsSettingsPanel';
import { WorkSettingsPanel } from '../components/WorkSettingsPanel';
import { AiUsagePanel } from '../components/AiUsagePanel';
import { KnowledgePanel } from '../components/KnowledgePanel';
import { TeamPanel } from '../components/TeamPanel';
import { navigate, Route } from '../lib/router';

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
    tab: 'ai-usage',
    title: 'Расход ИИ',
    hint: 'Сколько токенов ушло, на какие возможности и по дням — включая те, где ИИ не запускался',
    icon: 'sparkles',
    roles: ['owner', 'manager'],
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
    tab: 'work',
    title: 'Рабочее время',
    hint: 'Часы, выходные и праздники: по ним живут календарь и тихие часы ассистента',
    icon: 'clock',
  },
  {
    tab: 'tags',
    title: 'Теги задач',
    hint: 'Классификация задач компании и разметка через ИИ с подтверждением',
    icon: 'tag',
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
  ['team', ['owner', 'manager']],
  ['integrations', ['owner']],
  ['ai-usage', ['owner', 'manager']],
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
        {CARDS.filter((c) => !c.roles || c.roles.includes(role)).map((c) => (
          <button
            key={c.tab}
            className="settings-card"
            onClick={() => (c.tab === 'account'
              ? navigate({ section: 'profile' })
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
      {route.tab === 'knowledge' && <KnowledgePanel canManage={canManage} onClose={close} />}
      {route.tab === 'handoff' && <HandoffGatePanel canManage={role === 'owner'} onClose={close} />}
      {route.tab === 'assistant' && <AssistantPanel canManage={role === 'owner'} onClose={close} />}
      {route.tab === 'work' && <WorkSettingsPanel canManage={role === 'owner'} onClose={close} />}
      {/* Список тегов видят все (по ним фильтруют), правит — руководитель. */}
      {route.tab === 'tags' && <TagsSettingsPanel canManage={canManage} onClose={close} />}

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
