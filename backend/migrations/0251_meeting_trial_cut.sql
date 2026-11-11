-- ТЗ 10.11: созвон длиннее 15 минут в пробном периоде — ИИ разобрал только первые 15 минут.
-- Отметка у встречи: о ней скажут первая строка протокола и уведомление «итоги готовы».
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS trial_cut BOOLEAN NOT NULL DEFAULT false;
