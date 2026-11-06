-- #4779: откуда пришло пространство — UTM-метки с кнопки сайта при регистрации
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS signup_utm JSONB;
