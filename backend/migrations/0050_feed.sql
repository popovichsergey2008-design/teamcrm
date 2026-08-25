-- Лента компании: сообщения и объявления.
--
-- Чаты закрывают общение, но не закрывают ОБЪЯВЛЕНИЕ — сообщение, которое обязаны
-- прочитать все и автор должен видеть поимённо, кто прочитал. В чате такое тонет
-- за полчаса, а «поднимать наверх» приходится вручную.
CREATE TABLE feed_posts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    author_id   BIGINT NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    -- Объявление: цветная плашка, подтверждение прочтения и напоминание тем,
    -- кто ещё не отметил. Обычный пост живёт спокойно и ничего не требует.
    is_announcement BOOLEAN NOT NULL DEFAULT FALSE,
    -- Закреплённое висит наверху ленты, сколько бы ни было новых сообщений.
    is_pinned   BOOLEAN NOT NULL DEFAULT FALSE,
    -- До какого момента объявление считается действующим. NULL — бессрочно
    -- (в том числе для тех, кто придёт в компанию позже).
    active_until TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ NULL,
    deleted_at  TIMESTAMPTZ NULL
);
CREATE INDEX idx_feed_posts_tenant ON feed_posts (tenant_id, created_at DESC);

-- Кому адресовано. Пусто — всей компании; иначе перечислены подразделения.
-- Отдельной таблицей, а не массивом: подразделение переименуют или удалят, и связь
-- должна уйти вместе с ним, а не остаться числом внутри строки.
CREATE TABLE feed_post_groups (
    post_id   BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    group_id  BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    PRIMARY KEY (post_id, group_id)
);

-- Кто прочитал. Для объявления это главное: автор видит поимённо, а не число.
CREATE TABLE feed_post_reads (
    post_id   BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    user_id   BIGINT NOT NULL REFERENCES users(id),
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    read_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
);
CREATE INDEX idx_feed_reads_user ON feed_post_reads (tenant_id, user_id);

CREATE TABLE feed_comments (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    post_id    BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    author_id  BIGINT NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX idx_feed_comments_post ON feed_comments (post_id, created_at);
