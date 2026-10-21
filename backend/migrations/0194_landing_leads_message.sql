-- Вопрос посетителя из «Проверьте нас за 30 секунд» на рекламной странице (#4616).
ALTER TABLE landing_leads ADD COLUMN IF NOT EXISTS message TEXT NULL;
