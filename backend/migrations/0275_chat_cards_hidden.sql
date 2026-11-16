-- #4933 (16.11): автор сообщения может убрать карточку ссылки под ним (как предпросмотр в Telegram) —
-- у всех участников. Остальные скрывают карточку только у себя, на устройстве.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS cards_hidden BOOLEAN NOT NULL DEFAULT false;
