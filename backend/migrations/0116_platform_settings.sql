/*
  Настройки платформы — ключ/значение.

  Служба заботы вендорская, и у неё есть параметры, которые не принадлежат ни одной
  клиентской организации: как зовут первую линию, каким тоном она говорит. Заводить под
  каждый такой параметр колонку в tenants — раздувать таблицу организаций тем, что
  касается одной из них. Одна маленькая таблица: ключ, JSON и когда меняли.
*/
CREATE TABLE IF NOT EXISTS platform_settings (
    key        VARCHAR(64) PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_by BIGINT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
