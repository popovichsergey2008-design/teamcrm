-- Yandex AI Studio (16.11): ключ API и каталог Yandex Cloud — третий текстовый провайдер.
-- Модели «на выбор» (YandexGPT, Алиса AI, DeepSeek) и запасной путь, когда OpenAI или Kimi
-- из России недоступны: Яндекс отвечает напрямую, без обходного канала.
-- Ключ — шифрованный, как остальные; каталог узнаём по ключу (из списка моделей) и храним.
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS yandex_key_enc TEXT NULL;
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS yandex_folder VARCHAR(64) NULL;
