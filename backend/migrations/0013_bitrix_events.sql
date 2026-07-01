-- E3: живая синхронизация — исходящие вебхуки Битрикса шлют события на /events/:token.
ALTER TABLE integration_connections ADD COLUMN event_token VARCHAR(48);
ALTER TABLE integration_connections ADD COLUMN last_event_at TIMESTAMPTZ;

-- бэкофилл токена для существующих подключений
UPDATE integration_connections
   SET event_token = md5(random()::text || id::text || clock_timestamp()::text)
 WHERE event_token IS NULL;

ALTER TABLE integration_connections ALTER COLUMN event_token SET NOT NULL;
CREATE UNIQUE INDEX uq_int_conn_event_token ON integration_connections (event_token);
