-- #4902, п. 1: уведомления доходят, но не шумят.
-- «Только важное» по умолчанию: упоминания, личные, звонки, вопросы к вам, срок сегодня;
-- остальное — во «Входящие» и сводку «Что я пропустил». Тихие часы — по поясу человека.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_mode VARCHAR(16) NOT NULL DEFAULT 'important';
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_from VARCHAR(5) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_to VARCHAR(5) NULL;
-- Telegram — только важное (по умолчанию); true — дублировать туда всё, как раньше
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_all BOOLEAN NOT NULL DEFAULT FALSE;
