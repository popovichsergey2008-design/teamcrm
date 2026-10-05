-- ТЗ-14, §66–70, §112: персональные приглашения гостям по email.
--
-- Гость со стороны получает СВОЮ ссылку (строка meet_guest_links вида 'guest' с event_id):
-- письмо с файлом встречи, страница встречает его по имени, приглашение можно отозвать
-- поштучно. Ссылка гостя хранится зашифрованной (token_enc): напоминание и письмо о
-- переносе обязаны вести по ТОЙ ЖЕ ссылке (§38), а по отпечатку её не восстановить.
ALTER TABLE meet_guest_links
    ADD COLUMN invite_email      VARCHAR(320) NULL,
    ADD COLUMN invite_name       VARCHAR(120) NULL,
    ADD COLUMN invited_at        TIMESTAMPTZ NULL,
    ADD COLUMN token_enc         TEXT NULL,
    -- напоминание гостю перед встречей ушло (раз на приглашение и время начала)
    ADD COLUMN guest_reminded_at TIMESTAMPTZ NULL;

CREATE INDEX idx_meet_links_invites ON meet_guest_links (event_id) WHERE invite_email IS NOT NULL;
