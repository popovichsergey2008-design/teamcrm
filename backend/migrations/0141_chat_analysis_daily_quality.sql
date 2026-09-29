-- ТЗ-12, этапы 8–9: суточная сверка и качество.

-- ── суточная сверка (ТЗ разд. 3.3, 19, 27–29) ──
--
-- Раз в сутки, в нерабочее время организации, агент ещё раз проходит весь день
-- переписки целиком: разбор по затиханию видит разговор кусками, а связи между
-- кусками («утром поручили — вечером договорились о сроке») видны только отсюда.
-- Повторно ничего не заводится: уже разобранное узнаётся по сообщениям-источникам.
ALTER TABLE chat_analysis_settings
    ADD COLUMN IF NOT EXISTS daily_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    -- Час запуска по поясу организации. 23 — после работы, но в тот же день.
    ADD COLUMN IF NOT EXISTS daily_hour SMALLINT NOT NULL DEFAULT 23,
    -- Сводка владельцу и руководителям после прохода (разд. 27).
    ADD COLUMN IF NOT EXISTS daily_summary BOOLEAN NOT NULL DEFAULT TRUE,
    -- За какой местный день сверка уже прошла: второй запуск в тот же день — пустой.
    ADD COLUMN IF NOT EXISTS last_daily_date DATE NULL;
ALTER TABLE chat_analysis_settings DROP CONSTRAINT IF EXISTS chat_analysis_daily_hour;
ALTER TABLE chat_analysis_settings ADD CONSTRAINT chat_analysis_daily_hour CHECK (daily_hour BETWEEN 0 AND 23);

-- ── качество (ТЗ разд. 58–60) ──

-- Версия наших правил у прохода: качество меняется не только от промпта и модели, но
-- и от того, как мы разбираем ответ (разд. 60, routing_version).
ALTER TABLE chat_analysis_runs ADD COLUMN IF NOT EXISTS rules_version TEXT NULL;

-- «ИИ определил правильно?» (разд. 59). Один отзыв от человека на наблюдение: передумал —
-- отзыв переписывается. Причины — из короткого списка, иначе их не посчитать.
CREATE TABLE IF NOT EXISTS chat_action_feedback (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    action_id  BIGINT      NOT NULL REFERENCES chat_extracted_actions(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    correct    BOOLEAN     NOT NULL,
    reasons    TEXT[]      NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (action_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_action_feedback_tenant_idx ON chat_action_feedback (tenant_id, created_at DESC);
