-- TEAMCRM Этап 0 — закладываем векторный слой с первого шага (требование ТЗ).
-- Выполняется автоматически при первичной инициализации кластера.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
