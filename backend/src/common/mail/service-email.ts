/**
 * Служебная почта учётки без настоящего адреса (#4619).
 *
 * Учётке нужен e-mail (accounts.email NOT NULL UNIQUE), а человек, заведший
 * пространство из Telegram-бота, адреса не давал. Кладём заглушку на нашем домене
 * в отдельной зоне users.qevo.one: ящиков там нет и не будет, а настоящий адрес
 * человек укажет в профиле. Писем на такие адреса НЕ отправляем — очередь почты
 * отбрасывает их до транспорта (копия в Telegram и push при этом уходят как обычно).
 */
export const SERVICE_EMAIL_DOMAIN = 'users.qevo.one';

export function telegramServiceEmail(telegramUserId: string | number): string {
  return `tg${String(telegramUserId).replace(/\D/g, '')}@${SERVICE_EMAIL_DOMAIN}`;
}

export function isServiceEmail(email: string | null | undefined): boolean {
  return String(email ?? '').trim().toLowerCase().endsWith(`@${SERVICE_EMAIL_DOMAIN}`);
}
