-- ТЗ-2, Этап 4 — гостевой доступ в созвон по ссылке.
--
-- Ссылка привязана к комнате (room_id), а не к идущему разговору: комнаты SFU живут
-- в памяти и умирают, когда вышел последний, а ссылку клиенту отправляют заранее.
-- Комната поднимается по этому же id при первом входе.
--
-- Хранится ТОЛЬКО хэш токена — как в invite_links: доступ к базе не должен означать
-- доступ в чужие переговоры.
CREATE TABLE meet_guest_links (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    room_id      VARCHAR(64) NOT NULL,
    project_id   BIGINT NULL REFERENCES projects(id),
    label        VARCHAR(120) NULL,                    -- для кого ссылка: «ООО Вектор»
    token_hash   VARCHAR(255) NOT NULL UNIQUE,
    created_by   BIGINT NOT NULL REFERENCES users(id),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ NULL,
    max_uses     INT NULL,                             -- NULL = без лимита
    uses         INT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meet_guest_links_tenant ON meet_guest_links (tenant_id, created_at DESC);
CREATE INDEX idx_meet_guest_links_room ON meet_guest_links (room_id);
