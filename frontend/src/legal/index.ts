/**
 * Политики QEVO (#4675): где лежат, какая редакция действует.
 *
 * Этот файл маленький и может попасть в стартовую сборку (галочка на форме регистрации
 * знает адрес и версию). Сами тексты — в privacy.ts и remote-support.ts и грузятся
 * лениво, только когда человек открыл документ.
 *
 * Поменяли текст — поднимите `version` здесь И в backend/src/modules/legal/
 * policy-consents.service.ts (POLICY_VERSIONS): в журнал согласий пишется версия сервера.
 */
export type LegalKind = 'privacy' | 'remote-support';

export const LEGAL: Record<LegalKind, { path: string; title: string; version: string; date: string }> = {
  privacy: { path: '/legal/privacy', title: 'Политика конфиденциальности', version: 'v2', date: '26.10.2026' },
  'remote-support': { path: '/legal/remote-support', title: 'Политика удалённой технической поддержки', version: 'v2', date: '26.10.2026' },
};

/** Какой документ открыт по адресу; null — адрес не про политики. */
export function legalKindOf(pathname: string): LegalKind | null {
  const p = pathname.replace(/\/+$/, '');
  if (p === LEGAL.privacy.path) return 'privacy';
  if (p === LEGAL['remote-support'].path) return 'remote-support';
  return null;
}
