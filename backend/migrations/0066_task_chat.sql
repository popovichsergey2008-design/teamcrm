-- Обсуждение задачи как настоящий чат: ответы на сообщения и реакции.
--
-- В длинной переписке по задаче без ответов невозможно понять, к чему относится
-- реплика: «да, согласен» через два дня и десять сообщений — это согласие с чем?
-- Ветку целиком заводить не станем: разговор по задаче линейный, людям нужна
-- не структура, а ссылка на то, что они цитируют.
ALTER TABLE task_comments
    ADD COLUMN reply_to_id BIGINT NULL REFERENCES task_comments(id) ON DELETE SET NULL;

-- Реакция вместо сообщения «ок»: она не засоряет обсуждение и не будит участников.
-- Один человек — одна реакция определённого вида на сообщение: «поставил три пальца
-- вверх» ничего не значит.
CREATE TABLE task_comment_reactions (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    comment_id BIGINT NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    emoji      VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, comment_id, user_id, emoji)
);

CREATE INDEX idx_task_comment_reactions ON task_comment_reactions (tenant_id, comment_id);
