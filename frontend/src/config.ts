/**
 * Глобальные переключатели UI.
 * MONETIZATION_ENABLED — показывать ли всё, что связано с деньгами:
 * P&L-панель проекта, себестоимость на карточках, ставки сотрудников.
 * Временно отключено по запросу (бэкенд не тронут — можно вернуть, поставив true).
 */
export const MONETIZATION_ENABLED = false;

/**
 * Разделы, которые пока открыты только на dev.anthill.team (ТЗ-17: «пока только на дев,
 * будем тестить»). Сборка для dev получает VITE_DEV_FEATURES=clients; боевая — нет,
 * и раздела в ней не видно. Сервер при этом общий, данные — настоящие.
 */
const DEV_FEATURES = new Set(String(import.meta.env.VITE_DEV_FEATURES ?? '').split(',').map((s) => s.trim()).filter(Boolean));
export const CLIENTS_ENABLED = DEV_FEATURES.has('clients');
