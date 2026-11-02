-- Скачивания, установки и запуски (ТЗ консолей, §5.3; 02.11).
--
-- Три разных источника — три таблицы, без механического суммирования:
--   * app_downloads — выдачи APK с нашего сервера (nginx сообщает о каждой выдаче);
--   * app_installations — экземпляры приложения/PWA по случайному installation_id,
--     который приложение придумало само (не железо, не fingerprint);
--   * app_install_events / app_install_days — первые запуски, обновления, активные дни.
-- Скачивание ≠ установка, установка ≠ человек, обновление ≠ новая установка.

CREATE TABLE app_downloads (
  id          BIGSERIAL PRIMARY KEY,
  file        VARCHAR(120) NOT NULL,
  version     VARCHAR(40),
  -- site — кнопка на странице «Скачать приложение»; app — обновление из приложения;
  -- direct — прямая ссылка (сайт компании, мессенджер)
  source      VARCHAR(16) NOT NULL,
  -- хеш адреса и браузера с секретом сервера: повторы одного человека склеиваются,
  -- сам адрес не хранится
  visitor     CHAR(64) NOT NULL,
  os          VARCHAR(40),
  -- час выдачи: докачка кусками (Range) и повтор в тот же час — одно скачивание
  bucket      TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (visitor, file, bucket)
);
CREATE INDEX app_downloads_at ON app_downloads (created_at);

CREATE TABLE app_installations (
  installation_id UUID PRIMARY KEY,
  -- android | ios | pwa | desktop
  platform        VARCHAR(16) NOT NULL,
  channel         VARCHAR(16) NOT NULL DEFAULT 'stable',
  first_version   VARCHAR(40),
  version         VARCHAR(40),
  os              VARCHAR(60),
  -- откуда пришла установка, если приложение это знает (store, site, …)
  source          VARCHAR(32),
  -- последняя компания, из которой заходили: чтобы исключать тестовые из коммерческой статистики
  tenant_id       BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_installations_first ON app_installations (first_seen_at);

CREATE TABLE app_install_events (
  id              BIGSERIAL PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES app_installations(installation_id) ON DELETE CASCADE,
  -- first_run | update
  kind            VARCHAR(16) NOT NULL,
  from_version    VARCHAR(40),
  to_version      VARCHAR(40),
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_install_events_at ON app_install_events (at, kind);

-- Активная установка = день, когда экземпляр запускался. Повтор в тот же день ничего не добавляет.
CREATE TABLE app_install_days (
  installation_id UUID NOT NULL REFERENCES app_installations(installation_id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  PRIMARY KEY (installation_id, day)
);
CREATE INDEX app_install_days_day ON app_install_days (day);
