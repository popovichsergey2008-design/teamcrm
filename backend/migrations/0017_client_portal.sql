-- Этап 5 — клиентский портал «маржа-сейф»: привязка client-пользователя к заказчику.
ALTER TABLE users ADD COLUMN client_id BIGINT NULL REFERENCES clients(id);   -- NOT NULL по смыслу для роли client
CREATE INDEX idx_users_client ON users (tenant_id, client_id);

ALTER TABLE invites ADD COLUMN client_id BIGINT NULL REFERENCES clients(id);  -- для приглашения client-пользователя
