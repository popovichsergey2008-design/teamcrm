-- Этап 5, K2 — «Корпоративный разум» (AI Brain): диалоги RAG с цитатами.
CREATE TABLE brain_conversations (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    title       VARCHAR(255) NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_brain_conv_user ON brain_conversations (tenant_id, user_id, created_at);

CREATE TABLE brain_messages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES brain_conversations(id),
    role            VARCHAR(16) NOT NULL,          -- user | assistant
    content         TEXT NOT NULL,
    citations       JSONB NULL,                    -- [{source_type, source_id, title}]
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_brain_msg_conv ON brain_messages (conversation_id, created_at);
