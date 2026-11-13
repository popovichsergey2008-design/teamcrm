import JSZip from 'jszip';
import { openArchive } from './archive';
import { readTelegramExport, telegramText, telegramTime } from './telegram-parse';

const single = {
  name: 'Команда проекта',
  type: 'private_supergroup',
  id: 1001,
  messages: [
    { id: 1, type: 'service', date: '2024-01-01T10:00:00', date_unixtime: '1704103200', actor: 'Анна', action: 'create_group' },
    { id: 2, type: 'message', date: '2024-01-01T10:01:00', date_unixtime: '1704103260', from: 'Анна Петрова', from_id: 'user11', text: 'Всем привет' },
    {
      id: 3, type: 'message', date_unixtime: '1704103320', from: 'Борис', from_id: 'user12', reply_to_message_id: 2,
      text: ['Смотри ', { type: 'text_link', text: 'тут', href: 'https://qevo.one' }, ' и ', { type: 'bold', text: 'срочно' }],
    },
    { id: 4, type: 'message', date_unixtime: '1704103380', from: 'Анна Петрова', from_id: 'user11', photo: 'photos/photo_1.jpg', text: '' },
    { id: 5, type: 'message', date_unixtime: '1704103440', from: 'Борис', from_id: 'user12', file: '(File not included. Change data exporting settings to download.)', file_name: 'big.mp4', mime_type: 'video/mp4', text: 'видео' },
    { id: 6, type: 'message', date_unixtime: '1704103500', from: null, from_id: 'user13', media_type: 'sticker', file: 'stickers/s.webp', sticker_emoji: '👍', text: '' },
    { id: 7, type: 'message', date_unixtime: '1704103560', from: 'Борис', from_id: 'user12', poll: { question: 'Созвон?', answers: [{ text: 'Да' }, { text: 'Нет' }] }, text: '' },
  ],
};

describe('telegram-parse', () => {
  it('одиночный чат: тексты, ответы, медиа, служебные', () => {
    const b = readTelegramExport(single, 'ChatExport/', true);
    expect(b.source).toBe('telegram');
    expect(b.sourceKey).toBe('tg');
    expect(b.skippedService).toBe(1);
    const chat = b.chats[0];
    expect(chat).toMatchObject({ ext: '1001', kind: 'tg_group', title: 'Команда проекта' });
    expect(chat.messages.map((m) => m.ext)).toEqual(['2', '3', '4', '5', '6', '7']);
    const [hello, link, photo, video, sticker, poll] = chat.messages;
    expect(hello).toMatchObject({ authorExt: 'user11', authorName: 'Анна Петрова', at: 1704103260000 });
    expect(link.body).toBe('Смотри тут (https://qevo.one) и срочно');
    expect(link.replyToExt).toBe('2');
    expect(photo.files[0]).toMatchObject({ zipPath: 'ChatExport/photos/photo_1.jpg', mime: 'image/jpeg', name: 'photo_1.jpg' });
    expect(video.files[0].missing).toMatch(/не включён/);
    expect(sticker).toMatchObject({ body: '[стикер 👍]', files: [], authorName: 'Удалённый аккаунт' });
    expect(poll.body).toBe('Опрос: Созвон?\n— Да\n— Нет');
    expect(b.people.map((p) => p.ext).sort()).toEqual(['user11', 'user12', 'user13']);
  });

  it('только result.json без архива: файлы честно в «не удалось»', () => {
    const b = readTelegramExport(single, '', false);
    expect(b.chats[0].messages[2].files[0].missing).toMatch(/архив \.zip целиком/);
  });

  it('полный экспорт аккаунта: список чатов, «Избранное» пропускаем, личка с участниками в ключе', () => {
    const b = readTelegramExport({
      chats: {
        list: [
          { ...single },
          { name: null, type: 'saved_messages', id: 5, messages: [{ id: 1, type: 'message', date_unixtime: '1', from: 'Я', from_id: 'user1', text: 'заметка' }] },
          { name: 'Олег', type: 'personal_chat', id: 77, messages: [
            { id: 1, type: 'message', date_unixtime: '1704103200', from: 'Олег', from_id: 'user77', text: 'привет' },
            { id: 2, type: 'message', date_unixtime: '1704103201', from: 'Я', from_id: 'user1', text: 'здравствуй' },
          ] },
        ],
      },
    });
    expect(b.chats.map((c) => c.kind)).toEqual(['tg_group', 'tg_personal']);
    expect(b.chats[1].ext).toBe('77~user1~user77');
  });

  it('не экспорт Telegram — понятная ошибка', () => {
    expect(() => readTelegramExport({ foo: 1 })).toThrow(/не экспорт Telegram/);
  });

  it('время и текст', () => {
    expect(telegramTime({ date: '2024-01-01T10:00:00' })).toBe(Date.parse('2024-01-01T10:00:00Z'));
    expect(telegramTime({ date_unixtime: '1704103200', date: 'x' })).toBe(1704103200000);
    expect(telegramText(undefined)).toBe('');
    expect(telegramText(['a', { type: 'mention', text: '@b' }])).toBe('a@b');
  });

  it('архив .zip: находит result.json в папке и пути медиа от неё', async () => {
    const zip = new JSZip();
    zip.file('ChatExport_2024-01-01/result.json', '﻿' + JSON.stringify(single));
    zip.file('ChatExport_2024-01-01/photos/photo_1.jpg', Buffer.from([0xff, 0xd8, 0xff]));
    const opened = await openArchive('telegram', await zip.generateAsync({ type: 'nodebuffer' }));
    const photo = opened.bundle.chats[0].messages[2].files[0];
    expect(photo.zipPath).toBe('ChatExport_2024-01-01/photos/photo_1.jpg');
    expect(opened.zip?.file(photo.zipPath!)).toBeTruthy();
  });

  it('голый result.json тоже принимается', async () => {
    const opened = await openArchive('telegram', Buffer.from(JSON.stringify(single)));
    expect(opened.zip).toBeNull();
    expect(opened.bundle.chats[0].messages).toHaveLength(6);
    await expect(openArchive('telegram', Buffer.from('<html>'))).rejects.toThrow(/JSON/);
  });
});
