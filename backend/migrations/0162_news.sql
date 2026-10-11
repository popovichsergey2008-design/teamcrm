-- ТЗ-20 «Новости»: лента компании становится центром культуры — благодарности, опросы,
-- объявления с «Ознакомился», хайлайты дня, выводы недели, релизы и вехи.
--
-- Таблицу постов РАСШИРЯЕМ, а не заводим news_posts рядом: на проде в ленте два поста,
-- а файлы, комментарии, прочтения и отделы уже привязаны к feed_posts.

-- ── пост: тип, заголовок, статус, видимость ──
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS type VARCHAR(16) NOT NULL DEFAULT 'manual';
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS title VARCHAR(200) NULL;
-- draft — черновик от системы, ждёт одобрения; published — в ленте
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'published';
-- all | department | project | custom
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS visibility VARCHAR(12) NOT NULL DEFAULT 'all';
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS project_id BIGINT NULL REFERENCES projects(id) ON DELETE SET NULL;
-- «Ознакомился» обязателен (объявления)
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS requires_ack BOOLEAN NOT NULL DEFAULT FALSE;
-- кнопка-действие в объявлении: «Открыть документ», «Записаться»
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS cta_label VARCHAR(60) NULL;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS cta_url VARCHAR(500) NULL;
-- данные типа: кому спасибо и бейдж, факты и источники хайлайта, задачи и авторы релиза
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
-- пост написан системой (хайлайт, выводы недели): автора-человека у него нет
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS created_by_agent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE feed_posts ALTER COLUMN author_id DROP NOT NULL;
-- защита от дублей: один релиз, один хайлайт за день, одна веха — один пост
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS dedup_key VARCHAR(120) NULL;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ NULL;

UPDATE feed_posts SET type = 'announcement', requires_ack = TRUE WHERE is_announcement AND type = 'manual';
UPDATE feed_posts p SET visibility = 'department'
 WHERE visibility = 'all' AND EXISTS (SELECT 1 FROM feed_post_groups g WHERE g.post_id = p.id);
UPDATE feed_posts SET published_at = created_at WHERE published_at IS NULL;
ALTER TABLE feed_posts ALTER COLUMN published_at SET DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_posts_dedup ON feed_posts (tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND deleted_at IS NULL;
-- лента по курсору: закреплённые сверху отдельно, остальное — по номеру
CREATE INDEX IF NOT EXISTS idx_feed_posts_cursor ON feed_posts (tenant_id, id DESC)
  WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX IF NOT EXISTS idx_feed_posts_type ON feed_posts (tenant_id, type, id DESC)
  WHERE deleted_at IS NULL;

-- ── видимость «свои люди» ──
CREATE TABLE IF NOT EXISTS feed_post_users (
    post_id   BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
);

-- ── реакции ──
CREATE TABLE IF NOT EXISTS feed_reactions (
    post_id    BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    reaction   VARCHAR(8) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id, reaction)
);
CREATE INDEX IF NOT EXISTS idx_feed_reactions_post ON feed_reactions (post_id);

-- ── «Ознакомился» — отдельно от «видел»: подтверждение, а не прокрутка ──
CREATE TABLE IF NOT EXISTS feed_post_acks (
    post_id   BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    acked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
);
-- прежняя кнопка «Прочитал» у объявлений и была подтверждением
INSERT INTO feed_post_acks (post_id, user_id, tenant_id, acked_at)
SELECT r.post_id, r.user_id, r.tenant_id, r.read_at
  FROM feed_post_reads r JOIN feed_posts p ON p.id = r.post_id
 WHERE p.is_announcement
ON CONFLICT DO NOTHING;

-- ── «новое с прошлого визита»: одна отметка на человека, а не строка на каждый пост ──
CREATE TABLE IF NOT EXISTS feed_seen (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

-- ── опросы ──
CREATE TABLE IF NOT EXISTS feed_polls (
    post_id     BIGINT PRIMARY KEY REFERENCES feed_posts(id) ON DELETE CASCADE,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    question    VARCHAR(300) NOT NULL,
    deadline_at TIMESTAMPTZ NULL,
    anonymous   BOOLEAN NOT NULL DEFAULT FALSE,
    multiple    BOOLEAN NOT NULL DEFAULT FALSE,
    closed_at   TIMESTAMPTZ NULL,
    closed_by   BIGINT NULL REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_polls_open ON feed_polls (deadline_at) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS feed_poll_options (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    post_id   BIGINT NOT NULL REFERENCES feed_polls(post_id) ON DELETE CASCADE,
    position  SMALLINT NOT NULL,
    label     VARCHAR(120) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_poll_options_post ON feed_poll_options (post_id, position);
CREATE TABLE IF NOT EXISTS feed_poll_votes (
    option_id  BIGINT NOT NULL REFERENCES feed_poll_options(id) ON DELETE CASCADE,
    post_id    BIGINT NOT NULL REFERENCES feed_polls(post_id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (option_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_poll_votes_post ON feed_poll_votes (post_id, user_id);

-- ── кандидаты: веха, релиз, победа — система нашла повод, человек решает (§27, §65) ──
CREATE TABLE IF NOT EXISTS feed_candidates (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type            VARCHAR(16) NOT NULL,          -- milestone | release
    source_type     VARCHAR(24) NOT NULL,          -- project | task
    source_id       VARCHAR(64) NOT NULL,
    project_id      BIGINT NULL REFERENCES projects(id) ON DELETE CASCADE,
    facts           JSONB NOT NULL DEFAULT '{}'::jsonb,
    suggested_title VARCHAR(200) NOT NULL,
    suggested_body  TEXT NOT NULL,
    visibility      VARCHAR(12) NOT NULL DEFAULT 'all',
    confidence      NUMERIC(3,2) NOT NULL DEFAULT 0.5,
    -- detected | published | rejected | expired
    status          VARCHAR(12) NOT NULL DEFAULT 'detected',
    post_id         BIGINT NULL REFERENCES feed_posts(id) ON DELETE SET NULL,
    decided_by      BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    decided_at      TIMESTAMPTZ NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_candidates_open ON feed_candidates (tenant_id, created_at DESC) WHERE status = 'detected';

-- ── настройки раздела у организации (§16, §42, §75) ──
CREATE TABLE IF NOT EXISTS feed_settings (
    tenant_id          BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    highlights_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    -- хайлайт публикуется сам; выключено — ждёт одобрения владельца
    highlights_auto    BOOLEAN NOT NULL DEFAULT TRUE,
    highlight_hour     SMALLINT NOT NULL DEFAULT 9 CHECK (highlight_hour BETWEEN 0 AND 23),
    hero_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    learnings_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    -- день недели по ISO (1 — пн … 7 — вс) и час выводов недели
    learnings_dow      SMALLINT NOT NULL DEFAULT 5 CHECK (learnings_dow BETWEEN 1 AND 7),
    learnings_hour     SMALLINT NOT NULL DEFAULT 17 CHECK (learnings_hour BETWEEN 0 AND 23),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
