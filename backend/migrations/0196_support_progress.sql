-- ТЗ-34 (#4620), п. 3.6 и «Сегодня» 4.3: живой прогресс инженера по обращению.
--
-- Инженер в консоли пишет «что делаю», проценты и сколько осталось — клиент видит
-- полосу в окне заботы, на свёрнутом кружке и (Android) в уведомлении. Одно состояние
-- на разговор: важно, что происходит сейчас, а не история шагов — она и так в ленте.
ALTER TABLE support_conversations
    ADD COLUMN IF NOT EXISTS progress_text    VARCHAR(160) NULL,
    ADD COLUMN IF NOT EXISTS progress_percent SMALLINT NULL CHECK (progress_percent BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS progress_minutes SMALLINT NULL CHECK (progress_minutes BETWEEN 0 AND 1440),
    ADD COLUMN IF NOT EXISTS progress_by      BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS progress_at      TIMESTAMPTZ NULL;
