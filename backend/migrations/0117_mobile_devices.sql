/*
  Устройства мобильного приложения (ТЗ-9, волна 3).

  Сессия (refresh_tokens) — это «вход»; устройство — то, ЧЕМ вошли: телефон с его
  моделью, версией оболочки и веб-бандла и push-токеном. Одно устройство может
  входить много раз (каждый вход — новая сессия), поэтому привязка идёт со стороны
  сессии: refresh_tokens.device_id. По устройству администратор видит «iPhone Глеба,
  версия 1.2» и отзывает именно его; сервер знает, какой push-токен будить и какой
  версии бандла клиент.
*/
CREATE TABLE mobile_devices (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_uuid        VARCHAR(128) NOT NULL,        -- стабильный id установки от ОС
    platform           VARCHAR(16)  NOT NULL,        -- android | ios | web
    model              VARCHAR(160) NULL,
    os_version         VARCHAR(64)  NULL,
    native_version     VARCHAR(64)  NULL,            -- версия оболочки
    web_bundle_version VARCHAR(64)  NULL,            -- версия веб-бандла внутри
    push_token         TEXT         NULL,            -- FCM (волна 4)
    voip_token         TEXT         NULL,            -- APNs VoIP для звонков (волна 7)
    last_seen_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    revoked_at         TIMESTAMPTZ  NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (user_id, device_uuid)
);
CREATE INDEX idx_mobile_devices_tenant ON mobile_devices (tenant_id, user_id);

ALTER TABLE refresh_tokens
    ADD COLUMN device_id BIGINT NULL REFERENCES mobile_devices(id) ON DELETE SET NULL;
CREATE INDEX idx_refresh_tokens_device ON refresh_tokens (device_id) WHERE device_id IS NOT NULL;