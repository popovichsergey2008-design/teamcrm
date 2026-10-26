-- #4619, этап 4: рабочий Telegram-бот для команды — пересылка/голос → задача,
-- «Принять / Вернуть» под сдачей работы, «Фокус дня» в 09:30, предложение переезда
-- на 4-й день пробного периода.

-- 1. Короткая память бота о человеке (не дольше 10 минут):
--    mode — что он выбрал для серии сообщений («задача» или «дейлик»);
--    pending — что ждёт ответа: сообщения до выбора кнопкой (ask) или причина
--    возврата работы (return, номер задачи и организация).
CREATE TABLE IF NOT EXISTS telegram_bot_state (
  telegram_user_id BIGINT PRIMARY KEY,
  mode             VARCHAR(8)  NULL CHECK (mode IN ('task', 'daily')),
  mode_until       TIMESTAMPTZ NULL,
  pending_kind     VARCHAR(8)  NULL CHECK (pending_kind IN ('ask', 'return')),
  pending          JSONB       NULL,
  pending_until    TIMESTAMPTZ NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Предложение переезда на 4-й день — один раз на организацию (захват строкой).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS move_offer_sent_at TIMESTAMPTZ NULL;

-- 3. Импорт из файла (CSV/Excel) не оставляет у проекта origin — отмечаем у организации,
--    что доски уже переносили: предлагать переезд таким незачем.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS boards_imported_at TIMESTAMPTZ NULL;
