-- «Не этой задаче»: отказы от предложений заполнить пустое поле.
--
-- Секретарь предлагает исполнителя и срок для задач, где их нет. Часть таких задач
-- пуста намеренно — идея на будущее, задача-контейнер, чужой импорт. Спросив один раз
-- и получив «нет», спрашивать снова нельзя: предложение, которое возвращается каждую
-- неделю, ничем не отличается от того шума, от которого мы уходим.
CREATE TABLE assistant_gap_skips (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    task_id    BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    -- assignee | deadline: отказ от исполнителя не означает отказа от срока
    kind       VARCHAR(16) NOT NULL,
    actor_id   BIGINT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, task_id, kind)
);
