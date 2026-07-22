-- Многоразовая ссылка-приглашение в организацию: без привязки к email (человек вводит свой),
-- с опциональным лимитом использований и сроком; можно деактивировать. Хранится только хэш токена.
CREATE TABLE invite_links (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    role_code   VARCHAR(32) NOT NULL DEFAULT 'member',   -- member | manager (owner/client через ссылку нельзя)
    position_id BIGINT NULL REFERENCES positions(id),
    token_hash  VARCHAR(255) NOT NULL UNIQUE,
    created_by  BIGINT NOT NULL REFERENCES users(id),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    max_uses    INT NULL,                                -- NULL = без лимита
    uses        INT NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NULL,                        -- NULL = бессрочно
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invite_links_tenant ON invite_links (tenant_id, is_active);
