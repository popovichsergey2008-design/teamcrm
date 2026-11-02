-- Консоль поддержки на support.qevo.one (ТЗ консолей, §6; решение заказчика 02.11).
--
-- Оператор входит своей учётной записью консоли (pc_accounts, 2FA), а не учёткой CRM.
-- Но обращения, ответы, назначения и доступы инженеров в службе заботы ссылаются на
-- users(id) — переписывать четыре тысячи строк ради другого ключа незачем. Поэтому у
-- оператора есть СЛУЖЕБНЫЙ профиль в организации-платформе:
--   * is_service = true, is_active = false — его нет в команде, чатах, выборе
--     исполнителя и в подсчёте мест: все эти списки берут только активных;
--   * без учётной записи CRM (account_id пуст) и с паролем, который не сверяется, —
--     войти им в CRM нельзя;
--   * сообщения рабочих чатов и уведомления CRM ему не приходят: он ни в одном чате
--     и не подключён к realtime — консоль сама спрашивает сервер.
-- Право работать с обращениями служба заботы по-прежнему берёт из platform_staff.

ALTER TABLE users ADD COLUMN is_service BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE pc_accounts ADD COLUMN crm_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX pc_accounts_crm_user_uq ON pc_accounts (crm_user_id) WHERE crm_user_id IS NOT NULL;
