-- ТЗ-12, этап 4: политика и автосоздание.
--
-- Решение заказчика от 29.09 остаётся в силе: по умолчанию агент ТОЛЬКО ПРЕДЛАГАЕТ.
-- Автосоздание — выключенный режим, который владелец включает сам, посмотрев на
-- счётчики попадания на своих переписках. Всё, что здесь заводится, нужно ровно для
-- этого: чтобы решение включить было основано на цифрах, а ошибку можно было отменить.

-- Задача, которую завёл ИИ, а не человек. Нужна карточке (пометка «Создано Anthill AI»)
-- и письму: получатель должен понимать, что это не личное поручение из формы.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by_ai BOOLEAN NOT NULL DEFAULT FALSE;

-- Потолок расхода на разбор в месяц, в долларах по оценке ai_usage. Пусто — без
-- потолка. Достигнут — разбор останавливается до начала следующего месяца, и экран
-- настроек говорит об этом прямо, а не молчит.
ALTER TABLE chat_analysis_settings
    ADD COLUMN IF NOT EXISTS monthly_limit_usd NUMERIC(10,2) NULL;

-- Что человек поправил, заводя задачу. Это и есть мера ошибки агента: исправленный
-- проект или исполнитель — промах, который в автосоздании ушёл бы людям.
ALTER TABLE chat_extracted_actions
    ADD COLUMN IF NOT EXISTS corrected_project  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS corrected_assignee BOOLEAN NOT NULL DEFAULT FALSE,
    -- Отмена автоматически заведённой задачи: сама задача уходит в корзину, а
    -- наблюдение запоминает, что агент ошибся.
    ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS undone_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;

-- Сколько повторов отсёк ключ в этом проходе (ТЗ разд. 58, duplicate_prevented_count).
ALTER TABLE chat_analysis_runs
    ADD COLUMN IF NOT EXISTS duplicates INT NOT NULL DEFAULT 0;
