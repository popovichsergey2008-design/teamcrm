-- #5031 (24.11.2026): файл из чата скачивает и тот, кому сообщение переслали. Проверка доступа
-- ищет сообщения с этим файлом во всех чатах человека — без индекса это просмотр всей переписки.
CREATE INDEX IF NOT EXISTS idx_chat_messages_file ON chat_messages (file_id) WHERE file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_message_files_file ON chat_message_files (file_id);
