/**
 * Глобальные переключатели UI.
 * MONETIZATION_ENABLED — показывать ли всё, что связано с деньгами:
 * P&L-панель проекта, себестоимость на карточках, ставки сотрудников.
 * Временно отключено по запросу (бэкенд не тронут — можно вернуть, поставив true).
 */
export const MONETIZATION_ENABLED = false;

/**
 * Разделы, которые пока открыты только на dev.qevo.one: сборка для dev получает
 * VITE_DEV_FEATURES=имя,имя; боевая — нет. Сервер при этом общий, данные — настоящие.
 * «Клиенты» (ТЗ-17) жили так до 07.10 и перенесены на прод — включены везде.
 */
const DEV_FEATURES = new Set(String(import.meta.env.VITE_DEV_FEATURES ?? '').split(',').map((s) => s.trim()).filter(Boolean));
export const CLIENTS_ENABLED = true || DEV_FEATURES.has('clients');
