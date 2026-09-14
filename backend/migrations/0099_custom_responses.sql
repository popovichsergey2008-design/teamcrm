-- Быстрые ответы AnthillBot (ТЗ-6, разд. 37–38).
--
-- Часть вопросов в рабочих чатах повторяется годами: «где инструкция по VPN»,
-- «как оформить отпуск». Гонять ради них модель — это и деньги, и секунды, и риск,
-- что ответ каждый раз чуть другой. Здесь администратор задаёт ответ ОДИН раз, и
-- он приходит слово в слово.
--
-- Живёт в чатах, а не в модуле агента: отвечает на сообщение в переписке тот же
-- путь, что и обычный ответ помощника.
CREATE TABLE ai_custom_responses (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    created_by BIGINT NULL REFERENCES users(id),
    -- по чему срабатывает: ключевые слова через запятую или точная фраза
    trigger    VARCHAR(300) NOT NULL,
    -- keyword | exact
    match_kind VARCHAR(16) NOT NULL DEFAULT 'keyword',
    answer     TEXT NOT NULL,
    -- all | channels | dms — где отвечать
    scope      VARCHAR(16) NOT NULL DEFAULT 'all',
    -- Отвечать БЕЗ упоминания бота. По умолчанию выключено: непрошеный бот в
    -- рабочем чате раздражает сильнее, чем помогает, и его быстро выключают целиком.
    auto       BOOLEAN NOT NULL DEFAULT false,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    hits       INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_responses_live ON ai_custom_responses (tenant_id) WHERE enabled;
