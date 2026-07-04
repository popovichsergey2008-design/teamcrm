-- Этап 5, K3 — семантический кэш ответов AI Brain (похожие вопросы → без вызова LLM).
CREATE TABLE ai_answer_cache (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    citations   JSONB NULL,
    embedding   vector(1536) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_cache_hnsw ON ai_answer_cache USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_ai_cache_tenant ON ai_answer_cache (tenant_id, created_at);
