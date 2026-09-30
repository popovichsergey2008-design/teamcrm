import { mentionsEveryone } from './chats.service';

describe('«@все» в общем чате', () => {
  it.each(['@все, созвон в 15', 'Коллеги @Все посмотрите', '@всем привет', 'ping @all', '@everyone!'])(
    '«%s» — обращение ко всем', (t) => expect(mentionsEveryone(t)).toBe(true),
  );
  it.each(['@всеволод, глянь', 'почта vse@all.ru', 'все молодцы', '@allan'])(
    '«%s» — нет', (t) => expect(mentionsEveryone(t)).toBe(false),
  );
});
