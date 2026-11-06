-- #4779, п. 4: лимиты пробного периода — 1 ИИ-разбор созвона (до 15 минут) и 20 задач голосом на пространство
CREATE TABLE IF NOT EXISTS trial_usage (
  tenant_id  BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind       VARCHAR(24) NOT NULL,
  used       INT         NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);
