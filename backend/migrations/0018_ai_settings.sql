-- BYOK: ключи ИИ-провайдеров на арендатора (шифрованные) + выбор модели Brain.
CREATE TABLE ai_settings (
    tenant_id         BIGINT PRIMARY KEY REFERENCES tenants(id),
    openai_key_enc    TEXT NULL,          -- зашифрованный ключ OpenAI
    anthropic_key_enc TEXT NULL,          -- зашифрованный ключ Anthropic
    brain_model       VARCHAR(64) NULL,   -- выбранная модель ответов Brain
    updated_by        BIGINT NULL REFERENCES users(id),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
