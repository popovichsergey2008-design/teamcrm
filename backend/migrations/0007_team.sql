-- TEAMCRM Enhancements v1, Этап B — должности, группы/отделы, участники, приглашения.

CREATE TABLE positions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    name        VARCHAR(96) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE groups (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    name         VARCHAR(96) NOT NULL,
    kind         VARCHAR(16) NOT NULL DEFAULT 'group',  -- department | group
    lead_user_id BIGINT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE user_groups (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    group_id    BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
);
CREATE INDEX idx_user_groups_group ON user_groups (tenant_id, group_id);

ALTER TABLE users
    ADD COLUMN position_id BIGINT NULL REFERENCES positions(id);

CREATE TABLE invites (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    email       VARCHAR(255) NOT NULL,
    role_code   VARCHAR(32) NOT NULL,
    position_id BIGINT NULL REFERENCES positions(id),
    token_hash  VARCHAR(255) NOT NULL,             -- хранится только хэш
    invited_by  BIGINT NOT NULL REFERENCES users(id),
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (token_hash)
);
CREATE INDEX idx_invites_tenant ON invites (tenant_id, accepted_at);
