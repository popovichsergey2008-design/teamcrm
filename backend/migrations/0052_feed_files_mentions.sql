-- Лента: вложения к постам и упоминания через @.
--
-- Объявление без файла — половина объявления: приказ, инструкция, схема проезда
-- живут документом, и пересылать их отдельно в чат значит потерять связь с текстом.
--
-- Упоминание — способ позвать конкретного человека, не заводя ради одной фразы
-- отдельную переписку. Храним связь, а не разметку в тексте: человека переименуют,
-- и разметка вида «@Иван Петров» перестанет указывать на него.
CREATE TABLE feed_post_files (
    post_id   BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    file_id   BIGINT NOT NULL REFERENCES files(id),
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    PRIMARY KEY (post_id, file_id)
);

CREATE TABLE feed_mentions (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    post_id    BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    -- Упоминание в комментарии к посту. NULL — упомянули в самом посте.
    comment_id BIGINT NULL REFERENCES feed_comments(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_feed_mentions_user ON feed_mentions (tenant_id, user_id, created_at DESC);
