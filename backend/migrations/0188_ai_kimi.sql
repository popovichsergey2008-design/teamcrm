-- Kimi (Moonshot AI) как провайдер ИИ компании (19.10): ключ хранится так же, как
-- ключи OpenAI/Anthropic/OpenRouter — зашифрованным (IntegrationCryptoService).
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS kimi_key_enc TEXT;
