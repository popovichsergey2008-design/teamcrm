import type { BadgeTone } from '../../components/ui/badge';

/** Подписи раздела «Клиенты» (ТЗ-17): ключи — как на сервере, текст — для людей. */
export const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  lead: { label: 'Лид', tone: 'info' },
  active: { label: 'Активный', tone: 'ok' },
  paused: { label: 'На паузе', tone: 'warn' },
  inactive: { label: 'Неактивный', tone: 'neutral' },
  lost: { label: 'Потерян', tone: 'danger' },
};
export const STATUS_KEYS = Object.keys(STATUS);

export const TYPE: Record<string, string> = { company: 'Компания', person: 'Частное лицо' };

export const SOURCE: Record<string, string> = {
  website: 'Сайт', referral: 'Рекомендация', advertising: 'Реклама', telegram: 'Telegram', email: 'Почта',
  manual: 'Вручную', import: 'Импорт', partner: 'Партнёр', other: 'Другое',
};

export const STAGE: Record<string, { label: string; tone: BadgeTone }> = {
  new: { label: 'Новая', tone: 'neutral' },
  negotiation: { label: 'Переговоры', tone: 'info' },
  proposal: { label: 'Предложение', tone: 'info' },
  approval: { label: 'Согласование', tone: 'warn' },
  won: { label: 'Выиграна', tone: 'ok' },
  lost: { label: 'Проиграна', tone: 'danger' },
};
export const STAGE_KEYS = Object.keys(STAGE);

export const MEMBER_ROLE: Record<string, string> = {
  account: 'Аккаунт-менеджер', sales: 'Продажи', pm: 'Руководитель проекта', support: 'Поддержка', watcher: 'Наблюдает',
};

export const FILE_CATEGORY: Record<string, string> = {
  contract: 'Договоры', invoice: 'Счета', proposal: 'Коммерческие предложения', presentation: 'Презентации',
  technical: 'Технические документы', other: 'Другое',
};

export const HEALTH: Record<string, { label: string; tone: BadgeTone }> = {
  healthy: { label: 'Всё в порядке', tone: 'ok' },
  attention: { label: 'Требует внимания', tone: 'warn' },
  risk: { label: 'Риск', tone: 'danger' },
};

export const CURRENCIES = ['RUB', 'EUR', 'USD', 'KZT', 'BYN', 'UAH', 'GBP', 'CNY'];

export function money(v: number | null | undefined, cur = 'RUB'): string {
  if (v == null) return '—';
  const sign = cur === 'RUB' ? '₽' : cur === 'EUR' ? '€' : cur === 'USD' ? '$' : cur;
  return `${new Intl.NumberFormat('ru-RU').format(Math.round(v))} ${sign}`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return 'сегодня';
  if (d === 1) return 'вчера';
  if (d < 30) return `${d} дн. назад`;
  return new Date(iso).toLocaleDateString('ru-RU');
}

export const dateRu = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '');
export const dateTimeRu = (iso: string | null | undefined) =>
  (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
