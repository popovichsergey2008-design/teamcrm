import { request } from '../../lib/api';

/**
 * Почта кнопкой (#4893, п. 2): ручки входа через Яндекс, Google, Mail.ru.
 * Отдельно от большого `api`: карточку подключения грузят лениво — в чате бота и в
 * «Настройки → Почта», первый экран её ручки не утяжеляют.
 */

export type MailOAuthProviderId = 'yandex' | 'google' | 'mailru';

export interface MailOAuthProvider { id: MailOAuthProviderId; title: string; configured: boolean }

/** Первый итог после подключения: «214 писем · важно 6 · можно не читать 202». */
export interface MailFirstSummary {
  connected: boolean;
  /** Ящик ещё ни разу не забран — подождать и спросить снова. */
  pending: boolean;
  total: number; important: number; action: number; skip: number; text: string;
}

export const mailApi = {
  oauthProviders: () => request<MailOAuthProvider[]>('GET', '/mailbox/oauth/providers'),
  /** Адрес экрана согласия почтовика; resume — исходная просьба боту, её выполнят после входа. */
  oauthStart: (provider: MailOAuthProviderId, o: { resume?: string; from?: 'bot' | 'settings' } = {}) =>
    request<{ url: string }>('POST', '/mailbox/oauth/start', {
      provider,
      ...(o.resume?.trim() ? { resume: o.resume.trim().slice(0, 500) } : {}),
      ...(o.from ? { from: o.from } : {}),
    }),
  firstSummary: () => request<MailFirstSummary>('GET', '/mailbox/first-summary'),
};
