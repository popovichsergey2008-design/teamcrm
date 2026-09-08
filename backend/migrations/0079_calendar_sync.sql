-- Синхронизация с внешним календарём (Google, Outlook, Apple) — БЕЗ OAuth.
--
-- Два направления, и оба работают на обычном iCalendar-адресе:
--   export — мы отдаём личный календарь по секретной ссылке; человек добавляет её в
--            Google как «Другие календари → Подписаться по URL», и наши встречи
--            видны там же, где остальная его жизнь;
--   import — человек даёт нам «секретный адрес в формате iCal» из настроек своего
--            Google-календаря, и мы показываем его встречи рядом с нашими.
--
-- Почему не OAuth: приложение Google требует проверки и согласия администратора
-- домена — это недели переписки. Ссылка работает сегодня и покрывает то, ради чего
-- синхронизацию просили: видеть всё в одном месте и не назначать встречу на занятое.
-- Двусторонняя ЗАПИСЬ в чужой календарь без OAuth невозможна — это честная граница.
CREATE TABLE calendar_links (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          VARCHAR(8) NOT NULL,            -- export | import
    -- export: секрет прямо в адресе (другого способа у подписки нет — Google ходит без заголовков)
    token         VARCHAR(64) NULL,
    -- import: чужой секретный адрес, шифрованный: он даёт доступ ко всему календарю человека
    url_enc       TEXT NULL,
    title         VARCHAR(120) NULL,
    last_sync_at  TIMESTAMPTZ NULL,
    last_error    TEXT NULL,
    events_count  INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Ссылка на выгрузку одна на человека: вторая означала бы, что первую отозвать нечем.
CREATE UNIQUE INDEX uq_calendar_links_export ON calendar_links (user_id) WHERE kind = 'export';
CREATE UNIQUE INDEX uq_calendar_links_token ON calendar_links (token) WHERE token IS NOT NULL;
CREATE INDEX idx_calendar_links_user ON calendar_links (tenant_id, user_id, kind);

-- Встречи из чужого календаря. Лежат отдельно от наших: править их мы не вправе, а
-- смешав таблицы, однажды отправили бы приглашение от имени чужого события.
CREATE TABLE calendar_external_events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    link_id     BIGINT NOT NULL REFERENCES calendar_links(id) ON DELETE CASCADE,
    uid         VARCHAR(300) NOT NULL,            -- ключ события у источника (у повторов — с датой)
    title       VARCHAR(300) NOT NULL,
    location    VARCHAR(300) NULL,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ NOT NULL,
    all_day     BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (link_id, uid)
);
CREATE INDEX idx_calendar_external_range ON calendar_external_events (tenant_id, link_id, starts_at);
