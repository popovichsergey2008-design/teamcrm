-- BYOK: ключ OpenRouter (агрегатор моделей, в т.ч. бесплатных) — третий провайдер к OpenAI/Anthropic.
ALTER TABLE ai_settings ADD COLUMN openrouter_key_enc TEXT NULL;
