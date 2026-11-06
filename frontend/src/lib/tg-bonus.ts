import { api } from './api';

/**
 * «Открыть бота» за +7 дней (#4779): ссылка с кодом привязки — человек жмёт «Запустить»,
 * аккаунт привязывается сам, и бот начисляет бонус пространству (один раз).
 * Окно открываем сразу, адрес подставляем после ответа: иначе браузер сочтёт это
 * всплывающим окном не от нажатия и заблокирует.
 */
export async function openTelegramBot(): Promise<boolean> {
  const win = window.open('about:blank', '_blank');
  try {
    const st = await api.telegramStatus();
    if (!st.botUrl) { win?.close(); return false; }
    let url = st.botUrl;
    if (!st.linked) {
      const { code } = await api.telegramLinkCode();
      url = `${st.botUrl}${st.botUrl.includes('?') ? '&' : '?'}start=${encodeURIComponent(code)}`;
    }
    if (win) { win.opener = null; win.location.href = url; } else window.open(url, '_blank', 'noopener');
    return true;
  } catch {
    win?.close();
    return false;
  }
}

/** Сколько дней осталось до даты — для «Осталось N дней из 7». Сегодняшний неполный день считается. */
export function daysUntil(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

export const dayMonth = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');
