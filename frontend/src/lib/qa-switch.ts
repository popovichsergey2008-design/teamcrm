import { request, tokens } from './api';
import { readQueue } from './offline-queue';
import type { AuthResult } from '../types';

/**
 * #1562: временный вход как тестовый сотрудник и возврат. Подключается только из
 * ленивых частей (кабинет, полоса возврата) — в стартовый бандл не попадает.
 *
 * После смены токенов — полная перезагрузка: кэши, сокет и открытые разделы прошлого
 * человека не должны пережить переключение.
 */
async function swap(path: string, body?: unknown): Promise<void> {
  // неотправленные правки ушли бы уже от имени другого человека
  if (readQueue().length) throw new Error('Есть неотправленные изменения — дождитесь отправки и повторите');
  const r = await request<AuthResult>('POST', path, body ?? {});
  tokens.set(r.accessToken, r.refreshToken);
  window.location.replace('/');
}

export const enterQa = (targetUserId?: string) => swap('/auth/qa-switch', targetUserId ? { targetUserId } : {});
export const leaveQa = () => swap('/auth/qa-switch/back');
