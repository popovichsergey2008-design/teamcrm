-- ТЗ-18, этап 4 (и находка ТЗ-13): напоминания QEVO Bot доходят до человека.
--
-- Раньше напоминание было отложенным сообщением в «Заметки» ОТ ИМЕНИ самого
-- человека, а свои сообщения не дают ни push, ни Telegram — напоминание приходило
-- молча, то есть не приходило. Теперь это своя сущность: срабатывает по часам
-- сервера и уходит личным уведомлением (ящик, push, Telegram), может повторяться.

CREATE TABLE ai_reminders (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    user_id       BIGINT NOT NULL REFERENCES users(id),
    text          TEXT NOT NULL,
    due_at        TIMESTAMPTZ NOT NULL,
    -- расписание повтора (schedule-ru: {kind,time,weekday?,day?}); NULL — разовое
    repeat        JSONB NULL,
    -- active | done | cancelled
    status        VARCHAR(16) NOT NULL DEFAULT 'active',
    sent_count    INT NOT NULL DEFAULT 0,
    last_sent_at  TIMESTAMPTZ NULL,
    -- откуда взялось: действие бота (для отката) и разговор
    action_id     BIGINT NULL REFERENCES ai_tool_actions(id) ON DELETE SET NULL,
    session_id    BIGINT NULL REFERENCES ai_sessions(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_reminders_due ON ai_reminders (due_at) WHERE status = 'active';
CREATE INDEX idx_ai_reminders_user ON ai_reminders (tenant_id, user_id, status);
