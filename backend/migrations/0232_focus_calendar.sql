-- #4787 (ТЗ календаря, п. 12–13): один глубокий фокус из календаря и из меню аккаунта.
--
-- task_ids        — над какими задачами («Работаю над задачами №1326 и №1350»); task_id
--                   остаётся первой из них — на него смотрят прежние экраны.
-- urgent_mode     — кто может обратиться по срочному вопросу: все, у кого есть право
--                   «постучать», только выбранные люди или никто.
-- outcomes        — «Как продвинулась работа?» по каждой задаче: done · later · more.
ALTER TABLE focus_sessions
    ADD COLUMN IF NOT EXISTS task_ids        BIGINT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS urgent_mode     VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (urgent_mode IN ('all', 'selected', 'nobody')),
    ADD COLUMN IF NOT EXISTS urgent_user_ids BIGINT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS outcomes        JSONB NOT NULL DEFAULT '{}'::jsonb;

-- запланированный фокус в календаре: напомнить «пора начинать» ровно один раз
ALTER TABLE calendar_blocks
    ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ NULL;
