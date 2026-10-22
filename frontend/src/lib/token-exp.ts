/**
 * Истёк ли access-токен (или истечёт в ближайшие `skewMs`).
 *
 * Сокет авторизуется токеном только при подключении. После выкладки API все
 * переподключаются разом, и у того, кто 15 минут не трогал REST, токен уже
 * просрочен: сервер выгоняет сокет, и socket.io сам больше не пробует. Поэтому
 * перед подключением токен проверяем и, если нужно, сначала обновляем.
 */
export function tokenStale(token: string | null | undefined, now = Date.now(), skewMs = 30_000): boolean {
  if (!token) return false;
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof p.exp === 'number' && p.exp * 1000 - skewMs <= now;
  } catch {
    return false;
  }
}
