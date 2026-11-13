import { applyMask, detectSecrets, luhnOk, maskSecrets, matchesOutsideSecrets, SECRET_MASK } from './secrets';

/*
  #4902, п. 13 — «Готово, когда: тестовый набор из 50 секретов маскируется ≥ 95%».
  Набор — из живых чатов: русские и английские подписи, пары логин/пароль, ключи,
  карты, строки подключения. Значения выдуманы, но по форме как настоящие.
*/
const SECRETS: Array<[string, string]> = [
  // пароли с подписью
  ['Пароль: Qwerty123!', 'Qwerty123!'],
  ['пароль от dev-сайта: Dev2026qevo', 'Dev2026qevo'],
  ['Логин admin, пароль Adm1n#2026', 'Adm1n#2026'],
  ['доступ к dev.qevo.one: admin / P@ssw0rd2026', 'P@ssw0rd2026'],
  ['логин/пароль: manager / Zx9!kLm2', 'Zx9!kLm2'],
  ['Логин: ivanov\nПароль: SummerSun_77', 'SummerSun_77'],
  ['pass: hunter2hunter', 'hunter2hunter'],
  ['pwd=Tr0ub4dor&3', 'Tr0ub4dor&3'],
  ['password: correct-horse-battery-staple', 'correct-horse-battery-staple'],
  ['The password is S3cretPass!', 'S3cretPass!'],
  ['пароль от вайфая: qevo2024guest', 'qevo2024guest'],
  ['Пароль — "мой пароль 123"', 'мой пароль 123'],
  ['пароль для почты info@qevo.one: Mail_Box_2026', 'Mail_Box_2026'],
  ['вот креды: deploy:Depl0yKey99', 'Depl0yKey99'],
  ['аккаунт: test@qevo.one / Test12345', 'Test12345'],
  ['учётка wordpress — editor / Wp!Edit0r', 'Wp!Edit0r'],
  ['ivan.petrov@mail.ru:Petrov1985', 'Petrov1985'],
  ['пароль от админки котёнок2019', 'котёнок2019'],
  ['Пароль поменяли, новый: Autumn#Leaf8', 'Autumn#Leaf8'],
  ['пин-код 4821', '4821'],
  ['PIN: 7731', '7731'],
  ['credentials: root / toor1234', 'toor1234'],
  ['Пароль от Битрикса «Bx_2026_admin»', 'Bx_2026_admin'],
  ['код доступа: 99-ALPHA-31', '99-ALPHA-31'],
  // ключи и токены
  ['ключ OpenAI sk-' + 'proj-AbCdEf1234567890GhIjKlMnOpQrStUv', 'sk-' + 'proj-AbCdEf1234567890GhIjKlMnOpQrStUv'],
  ['Вот ключ Kimi: sk-' + '9f8e7d6c5b4a3210fedcba9876543210', 'sk-' + '9f8e7d6c5b4a3210fedcba9876543210'],
  ['github token gh' + 'p_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R', 'gh' + 'p_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R'],
  ['slack: xo' + 'xb-123456789012-1234567890123-AbCdEfGhIjKlMnOp', 'xo' + 'xb-123456789012-1234567890123-AbCdEfGhIjKlMnOp'],
  ['AWS AK' + 'IAIOSFODNN7EXAMPLE и секрет', 'AK' + 'IAIOSFODNN7EXAMPLE'],
  ['aws secret key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['jwt eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['Токен бота 7012345678:' + 'AAHk3jf9dKs0LmNoPqRsTuVwXyZ123456789', '7012345678:' + 'AAHk3jf9dKs0LmNoPqRsTuVwXyZ123456789'],
  ['Google API key AI' + 'zaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q', 'AI' + 'zaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
  ['Authorization: Bearer abc123DEF456ghi789JKL012mno', 'abc123DEF456ghi789JKL012mno'],
  ['OPENAI_API_KEY=sk-' + 'live-ZZZZyyyyXXXXwwww1111', 'sk-' + 'live-ZZZZyyyyXXXXwwww1111'],
  ['DB_PASSWORD=pg_Strong_Pass_9', 'pg_Strong_Pass_9'],
  ['api key: 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c', '3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'],
  ['токен доступа = a1B2c3D4e5F6g7H8i9J0', 'a1B2c3D4e5F6g7H8i9J0'],
  ['client_secret: GOC' + 'SPX-AbCdEfGhIjKlMnOpQrStUvWx', 'GOC' + 'SPX-AbCdEfGhIjKlMnOpQrStUvWx'],
  ['brevo xkey' + 'sib-0123456789abcdef0123456789abcdef-AbCdEfGh', 'xkey' + 'sib-0123456789abcdef0123456789abcdef-AbCdEfGh'],
  ['stripe sk_' + 'live_51HxYzAbCdEfGhIjKlMn', 'sk_' + 'live_51HxYzAbCdEfGhIjKlMn'],
  ['gitlab gl' + 'pat-xYz123AbC456dEf789gH', 'gl' + 'pat-xYz123AbC456dEf789gH'],
  // строки подключения
  ['База: postgres://qevo:SuperSecret42@db.qevo.one:5432/crm', 'SuperSecret42'],
  ['mongodb+srv://admin:M0ng0Pass@cluster0.example.net/test', 'M0ng0Pass'],
  ['redis://default:r3d1sPwd@10.0.0.5:6379', 'r3d1sPwd'],
  ['ftp://user:FtpPass77@ftp.example.com', 'FtpPass77'],
  // закрытый ключ
  ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7x1\nabcDEF==\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA7x1'],
  ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA'],
  // карты и CVV
  ['Карта для оплаты 4276 3800 1234 5679', '4276 3800 1234 5679'],
  ['card 5555-5555-5555-4444 exp 12/27', '5555-5555-5555-4444'],
  ['номер карты 4111111111111111, cvv 123', '4111111111111111'],
  ['CVC: 987', '987'],
  ['Amex 378282246310005', '378282246310005'],
];

/*
  То, что прятать нельзя: люди говорят о паролях, но не называют их; даты, телефоны,
  номера задач, суммы, коммиты. Каждая ложная маска делает переписку непонятной.
*/
const NOT_SECRETS: string[] = [
  'пароль от вайфая спросить у Глеба',
  'Пароль: спроси у Глеба',
  'забыл пароль, помогите сбросить',
  'Пароль должен быть не короче 8 символов',
  'сброс пароля через почту работает?',
  'токен истёк, перевыпусти',
  'ключ от офиса у охранника',
  'Ключ: в ящике стола',
  'Встреча в 12:30, переговорная 2',
  'Созвон 13.11.2026 в 15:00',
  'Сделал #4863, проверьте',
  'Задачи #4902 и #4907 на тестировании',
  'Цена 15 000 ₽, со скидкой 12 500 ₽',
  'Итого 1 250 000 рублей',
  'Мой телефон +7 999 123-45-67',
  'звоните 8 (495) 123-45-67',
  'commit 4b12401 уже в main',
  'хеш 3c35beb0a74c43d920755b33f5fb1234567890ab',
  'https://qevo.one/chat/123/thread/456',
  'ИНН 7707083893, КПП 770701001',
  'Счёт 40702810900000012345',
  'Заказ 1234 5678 9012 3456 оплачен',
  'пассажир: Иванов И.И.',
  'passport issued 12.10.2020',
  'Логин в систему через Google',
  'аккуратно: 12/2024 не трогать',
  'Доступ: выдам завтра',
  'pass the ball to QA',
  'пароль поменяли, новый в Секретах',
  'Пароль — тот же, что и раньше',
  'Нужен API key для Kimi, у кого есть?',
  'Время 10:30-11:00 занято',
  'Версия 1.49, сборка 2026.11.13',
  'pin: закрепить сверху',
  'Пароль: 🔒 в Секретах проекта',
  'Пароль: ••••••',
];

describe('детектор секретов (#4902, п. 13)', () => {
  it('набор из 50+ секретов скрывается не меньше чем на 95%', () => {
    expect(SECRETS.length).toBeGreaterThanOrEqual(50);
    const missed = SECRETS.filter(([text, secret]) => maskSecrets(text).includes(secret));
    const rate = (SECRETS.length - missed.length) / SECRETS.length;
    if (missed.length) console.log('не скрыто:', missed.map(([t]) => t));
    expect(rate).toBeGreaterThanOrEqual(0.95);
  });

  it('обычные фразы не трогает (ложных срабатываний не больше 1 из 30+)', () => {
    expect(NOT_SECRETS.length).toBeGreaterThanOrEqual(30);
    const hit = NOT_SECRETS.filter((t) => detectSecrets(t).length > 0);
    if (hit.length) console.log('ложно скрыто:', hit.map((t) => `${t} → ${maskSecrets(t)}`));
    expect(hit.length).toBeLessThanOrEqual(1);
  });

  it('прячет только значение — подпись остаётся читаемой', () => {
    expect(maskSecrets('Пароль: Qwerty123!')).toBe(`Пароль: ${SECRET_MASK}`);
    expect(maskSecrets('postgres://qevo:SuperSecret42@db:5432/crm')).toBe(`postgres://qevo:${SECRET_MASK}@db:5432/crm`);
  });

  it('несколько секретов в одном сообщении', () => {
    const t = 'dev: admin / Adm1n#2026, база postgres://u:DbPass99@h/db, ключ sk-' + 'proj-AbCdEf1234567890GhIjKl';
    const masked = maskSecrets(t);
    expect(masked).not.toMatch(/Adm1n#2026|DbPass99|sk-proj/);
    expect(detectSecrets(t).length).toBe(3);
  });

  it('отрезки не пересекаются и applyMask совпадает с maskSecrets', () => {
    const t = 'OPENAI_API_KEY=sk-' + 'proj-AbCdEf1234567890GhIjKlMn и пароль: Zz12345!';
    const spans = detectSecrets(t);
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    expect(applyMask(t, spans)).toBe(maskSecrets(t));
  });

  it('карта — только с верной контрольной суммой', () => {
    expect(luhnOk('4111111111111111')).toBe(true);
    expect(luhnOk('4111111111111112')).toBe(false);
    expect(luhnOk('0000000000000000')).toBe(false);
  });

  it('поиск не находит сообщение по буквам пароля', () => {
    expect(matchesOutsideSecrets('пароль: Qwerty123', 'qwer')).toBe(false);
    expect(matchesOutsideSecrets('пароль: Qwerty123', 'пароль')).toBe(true);
  });

  it('пустое и короткое — как есть', () => {
    expect(maskSecrets('')).toBe('');
    expect(maskSecrets(null)).toBe(null);
    expect(maskSecrets('ок')).toBe('ок');
  });
});
