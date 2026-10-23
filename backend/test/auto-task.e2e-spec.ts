import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { AutoConfirmService } from '../src/modules/nl/auto-confirm.service';

/**
 * #4615 «Автоматическое создание задач через нейросеть»: фраза → задача без вопросов
 * (проект, руководитель отдела по направлению, теги, приоритет) → через 30 секунд
 * карточка постановщику «Задача поставлена… Проверьте» → «Ок» отмечает задачу.
 * Время подменяем: сообщение отправляет проход с «сейчас + 31 с».
 */
describe('Автоматическая постановка задачи (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  let confirm: AutoConfirmService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
    confirm = app.get(AutoConfirmService);
  });
  afterAll(async () => { await app?.close(); });

  it('задача уходит руководителю отдела, через 30 с — сообщение, «Ок» подтверждает', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Авто', email: `auto_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const person = async (fullName: string, skills: string[]) => {
      const u = (await http$.post('/api/users').set(O)
        .send({ email: `a_${uniq()}@t.test`, fullName, password: 'password123', role: 'member' }).expect(201)).body.data;
      await http$.patch(`/api/users/${u.id}`).set(O).send({ skills }).expect(200);
      return String(u.id);
    };
    const lead = await person('Глеб Руководитель', ['backend']);
    const dev = await person('Ольга Разработчик', ['backend']);

    // отдел программирования: руководитель и направления
    const dept = (await http$.post('/api/groups').set(O).send({ name: 'Программирование', kind: 'department' }).expect(201)).body.data;
    await http$.post(`/api/groups/${dept.id}/members`).set(O).send({ userId: lead }).expect(201);
    await http$.post(`/api/groups/${dept.id}/members`).set(O).send({ userId: dev }).expect(201);
    const saved = (await http$.patch(`/api/groups/${dept.id}`).set(O)
      .send({ leadUserId: lead, directions: ['backend', 'frontend'] }).expect(200)).body.data;
    expect(String(saved.lead_user_id)).toBe(lead);
    expect(saved.directions).toEqual(['backend', 'frontend']);
    // чужого руководителя и выдуманное направление не принимаем
    await http$.patch(`/api/groups/${dept.id}`).set(O).send({ directions: ['magic'] }).expect(400);
    await http$.patch(`/api/groups/${dept.id}`).set(O).send({ leadUserId: '999999999' }).expect(400);

    const site = (await http$.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;

    // разбор в авто-режиме: проект — открытая доска, исполнитель — руководитель отдела
    const drafts = (await http$.post('/api/nl/parse-many').set(O)
      .send({ text: 'сделать выгрузку отчётов на бэкенде', currentProjectId: String(site.id), auto: true }).expect(201)).body.data;
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.intent).toBe('create_task');
    expect(d.task.auto).toBe(true);
    expect(String(d.task.projectId)).toBe(String(site.id));
    expect(d.task.projectHint).toBeTruthy();
    expect(String(d.task.assigneeId)).toBe(lead);
    expect(d.task.assigneeWhy).toContain('Программирование');
    expect(Array.isArray(d.task.autoTags)).toBe(true);

    // поставить: теги не подтверждаются вручную — это заменит «Ок»
    const applied = (await http$.post('/api/nl/apply').set(O).send({
      intent: 'create_task',
      task: { ...d.task, deadline: '2030-01-15', tagIds: [], auto: true },
    }).expect(201)).body.data;
    const taskId = String(applied.task.id);
    expect(String(applied.task.assignee_id)).toBe(lead);
    expect(applied.confirmAt).toBeTruthy();

    // до 30 секунд — тишина; после — карточка в ящике постановщика
    expect(await confirm.flush(new Date())).toBe(0);
    expect(await confirm.flush(new Date(Date.now() + 31_000))).toBe(1);
    // второй проход ту же задачу не шлёт
    expect(await confirm.flush(new Date(Date.now() + 60_000))).toBe(0);

    const inbox = (await http$.get('/api/assistant/proposals').set(O).expect(200)).body.data.items;
    const card = inbox.find((p: any) => p.skill === 'autotask');
    expect(card).toBeTruthy();
    expect(card.title).toBe(`Задача поставлена: #${taskId} «${applied.task.title}»`);
    expect(card.summary).toContain('Исполнитель — Глеб Руководитель');
    expect(card.summary).toContain('проект — Сайт');
    expect(card.summary).toContain('срок — 15 января');
    expect(card.summary).toContain('приоритет — обычный');
    expect(card.summary).toContain('теги — без тегов');
    expect(card.summary).toContain('Проверьте, всё ли ок.');
    expect(card.actions.map((a: any) => a.label)).toEqual(['Ок', 'Править']);
    expect(card.actions[1].link).toBe(`/projects/${site.id}/task/${taskId}`);

    await http$.post(`/api/assistant/proposals/${card.id}/confirm`).set(O).send({ action: 'ok' }).expect(201);
    const row = await db.one<{ manager_confirmed_at: Date | null }>(`SELECT manager_confirmed_at FROM tasks WHERE id=$1`, [taskId]);
    expect(row?.manager_confirmed_at).toBeTruthy();
  });

  it('руководитель не видит проект — следующий из отдела; невидящего назначить нельзя; правку видно', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Авто2', email: `auto2_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const person = async (fullName: string, skills: string[]) => {
      const u = (await http$.post('/api/users').set(O)
        .send({ email: `b_${uniq()}@t.test`, fullName, password: 'password123', role: 'member' }).expect(201)).body.data;
      await http$.patch(`/api/users/${u.id}`).set(O).send({ skills }).expect(200);
      return String(u.id);
    };
    const lead = await person('Глеб Руководитель', ['backend']);
    const dev = await person('Ольга Разработчик', ['backend']);
    const dept = (await http$.post('/api/groups').set(O).send({ name: 'Разработка', kind: 'department', leadUserId: lead }).expect(201)).body.data;
    await http$.post(`/api/groups/${dept.id}/members`).set(O).send({ userId: dev }).expect(201);
    await http$.patch(`/api/groups/${dept.id}`).set(O).send({ directions: ['backend'] }).expect(200);

    // закрытый проект: в нём только Ольга
    const secret = (await http$.post('/api/projects').set(O).send({ name: 'Закрытый' }).expect(201)).body.data;
    await http$.patch(`/api/projects/${secret.id}`).set(O).send({ visibility: 'members' }).expect(200);
    await http$.post(`/api/projects/${secret.id}/members`).set(O).send({ userIds: [dev] }).expect(201);

    const d = (await http$.post('/api/nl/parse-many').set(O)
      .send({ text: 'поправить базу данных для отчётов', currentProjectId: String(secret.id), auto: true }).expect(201)).body.data[0];
    expect(String(d.task.projectId)).toBe(String(secret.id));
    expect(String(d.task.assigneeId)).toBe(dev);
    expect(d.task.assigneeWhy).toContain('руководитель не видит проект');

    // руками подставить невидящего — отказ
    const bad = (await http$.post('/api/nl/apply').set(O).send({
      intent: 'create_task', task: { ...d.task, assigneeId: lead, deadline: '2030-01-15', tagIds: [], auto: true },
    }).expect(400)).body;
    expect(bad.error.details.code).toBe('ASSIGNEE_CANNOT_SEE_PROJECT');

    // поставили, за 30 секунд поправили — сообщение всё равно приходит и говорит об этом
    const ok = (await http$.post('/api/nl/apply').set(O).send({
      intent: 'create_task', task: { ...d.task, deadline: '2030-01-16', tagIds: [], auto: true },
    }).expect(201)).body.data;
    await http$.patch(`/api/tasks/${ok.task.id}`).set(O).send({ title: 'Поправить базу данных отчётов' }).expect(200);
    expect(await confirm.flush(new Date(Date.now() + 31_000))).toBe(1);
    const card = (await http$.get('/api/assistant/proposals').set(O).expect(200)).body.data.items.find((p: any) => p.skill === 'autotask');
    expect(card.title).toContain('Поправить базу данных отчётов');
    expect(card.summary).toContain('Вы уже поправили задачу');
  });

  /*
    #4615, доработка 23.10: структура компании в «Настройки → Команда» и ОДНО правило
    подбора — быстрая команда и форма «Новая задача» ставят руководителю направления;
    сам руководитель раздаёт — тимлиду/специалисту; роль вместо имени; теги без
    подтверждения; «Кто отвечает за…» в сообщении; обучение на правках.
  */
  it('структура через API → авто-постановка и форма уходят руководителю; роли; самому себе не ставит', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Орг', email: `org_${uniq()}@t.test`, password: 'password123', fullName: 'Борис Владелец' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    // готовые должности новой компании — с уровнями
    const positions = (await http$.get('/api/positions').set(O).expect(200)).body.data;
    expect(positions.map((p: any) => [p.name, p.level])).toEqual([
      ['Генеральный директор', 'ceo'], ['Руководитель отдела', 'head'], ['Тимлид', 'deputy'], ['Специалист', 'specialist'], ['Стажёр', 'intern'],
    ]);
    const teamlead = (await http$.post('/api/positions').set(O).send({ name: 'Тимлид фронтенда', level: 'deputy' }).expect(201)).body.data;
    await http$.post('/api/positions').set(O).send({ name: 'Странная', level: 'king' }).expect(400);
    const renamed = (await http$.patch(`/api/positions/${teamlead.id}`).set(O).send({ name: 'Тимлид фронта' }).expect(200)).body.data;
    expect(renamed).toMatchObject({ name: 'Тимлид фронта', level: 'deputy' });

    const pass = 'password123';
    const person = async (fullName: string, skills: string[]) => {
      const mail = `o_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(O).send({ email: mail, fullName, password: pass, role: 'manager' }).expect(201)).body.data;
      await http$.patch(`/api/users/${u.id}`).set(O).send({ skills }).expect(200);
      return { id: String(u.id), email: mail };
    };
    const sergey = await person('Сергей Руководитель', ['backend', 'frontend']);
    const gleb = await person('Глеб Специалист', ['backend']);
    const anna = await person('Анна Лебедева', ['frontend']);

    // «Кто отвечает за Бэкенд» → отдел создаётся сам
    const d = (await http$.post('/api/org/direction-lead').set(O).send({ skill: 'backend', userId: sergey.id }).expect(201)).body.data;
    expect(d.departmentName).toBe('Бэкенд');
    await http$.patch(`/api/groups/${d.departmentId}`).set(O).send({ directions: ['backend', 'frontend'], name: 'IT' }).expect(200);
    await http$.post(`/api/groups/${d.departmentId}/members`).set(O).send({ userId: gleb.id }).expect(201);
    await http$.post(`/api/groups/${d.departmentId}/members`).set(O).send({ userId: anna.id, role: 'deputy' }).expect(201);
    await http$.patch(`/api/users/${anna.id}`).set(O).send({ positionId: String(teamlead.id) }).expect(200);
    // кому подчиняется: не сам себе и без кольца
    await http$.patch(`/api/users/${gleb.id}`).set(O).send({ reportsToUserId: gleb.id }).expect(400);
    await http$.patch(`/api/users/${sergey.id}`).set(O).send({ reportsToUserId: gleb.id }).expect(200);
    await http$.patch(`/api/users/${gleb.id}`).set(O).send({ reportsToUserId: sergey.id }).expect(400);
    await http$.patch(`/api/users/${sergey.id}`).set(O).send({ reportsToUserId: null }).expect(200);
    // вложенность отделов: отдел не может входить сам в себя
    await http$.patch(`/api/groups/${d.departmentId}`).set(O).send({ parentId: d.departmentId }).expect(400);

    const st = (await http$.get('/api/org/structure').set(O).expect(200)).body.data;
    expect(st.departments.find((x: any) => x.id === d.departmentId)).toMatchObject({ name: 'IT', leadUserId: sergey.id, deputyIds: [anna.id] });
    expect(st.people.find((p: any) => p.id === gleb.id).managerId).toBe(sergey.id);
    expect(st.levels.map((l: any) => l.code)).toEqual(['ceo', 'head', 'deputy', 'specialist', 'intern']);

    const site = (await http$.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;

    // быстрая команда (авто) — руководителю отдела направления
    const auto = (await http$.post('/api/nl/parse-many').set(O)
      .send({ text: 'сделать выгрузку отчётов на бэкенде', currentProjectId: String(site.id), auto: true }).expect(201)).body.data[0];
    expect(String(auto.task.assigneeId)).toBe(sergey.id);
    expect(auto.task.assigneeWhy).toBe('руководитель отдела «IT» по направлению Бэкенд');

    // форма «Новая задача» — то же правило
    const form = (await http$.post('/api/nl/auto-assign').set(O)
      .send({ title: 'Сделать API авторизации для складов', projectId: String(site.id) }).expect(201)).body.data;
    expect(form.assigneeId).toBe(sergey.id);
    expect(form.reason).toBe('руководитель отдела «IT» по направлению Бэкенд');

    // роль вместо имени
    const role = (await http$.post('/api/nl/auto-assign').set(O)
      .send({ title: 'Тимлиду фронта поправить кнопку на странице' }).expect(201)).body.data;
    expect(role.assigneeId).toBe(anna.id);
    expect(role.source).toBe('role');

    // сам руководитель раздаёт — не себе: специалисту бэкенда / тимлиду фронта
    const S = H((await http$.post('/api/auth/login').send({ email: sergey.email, password: pass }).expect(201)).body.data.accessToken);
    const own = (await http$.post('/api/nl/auto-assign').set(S).send({ title: 'Сделать API выгрузки' }).expect(201)).body.data;
    expect(own.assigneeId).toBe(gleb.id);
    const ownFront = (await http$.post('/api/nl/auto-assign').set(S).send({ title: 'Сверстать страницу заказа' }).expect(201)).body.data;
    expect(ownFront.assigneeId).toBe(anna.id);
  });

  it('теги без подтверждения; «Кто отвечает за…» в сообщении; обучение на правках', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Орг2', email: `org2_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const person = async (fullName: string, skills: string[]) => {
      const u = (await http$.post('/api/users').set(O)
        .send({ email: `p_${uniq()}@t.test`, fullName, password: 'password123', role: 'member' }).expect(201)).body.data;
      await http$.patch(`/api/users/${u.id}`).set(O).send({ skills }).expect(200);
      return String(u.id);
    };
    const dina = await person('Дина Дизайн', ['design']);
    const lena = await person('Лена Дизайн', ['design']);
    const site = (await http$.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;

    // теги: по умолчанию без подтверждения — задача создаётся, хотя теги не подтверждены
    expect((await http$.get('/api/tags/settings').set(O).expect(200)).body.data.requireConfirmation).toBe(false);
    await http$.post('/api/tasks').set(O)
      .send({ projectId: String(site.id), title: 'Без подтверждения тегов', tagsConfirmed: false, confirmedWithoutTags: false }).expect(201);
    // компания может включить подтверждение — тогда без него нельзя
    await http$.post('/api/tags/settings').set(O).send({ requireConfirmation: true }).expect(201);
    await http$.post('/api/tasks').set(O)
      .send({ projectId: String(site.id), title: 'Теперь нужно подтвердить', tagsConfirmed: false, confirmedWithoutTags: false }).expect(400);
    await http$.post('/api/tags/settings').set(O).send({ requireConfirmation: false }).expect(201);

    // у дизайна нет руководителя — подбор по загрузке с честной причиной, в сообщении — «Кто отвечает»
    const draft = (await http$.post('/api/nl/parse-many').set(O)
      .send({ text: 'нарисовать макет баннера', currentProjectId: String(site.id), auto: true }).expect(201)).body.data[0];
    expect(draft.task.assigneeWhy).toContain('руководитель направления «Дизайн» не задан');
    expect(draft.task.noLeadFor).toBe('design');
    const applied = (await http$.post('/api/nl/apply').set(O)
      .send({ intent: 'create_task', task: { ...draft.task, deadline: '2030-01-15', tagIds: [], auto: true } }).expect(201)).body.data;
    expect(await confirm.flush(new Date(Date.now() + 31_000))).toBe(1);
    const card = (await http$.get('/api/assistant/proposals').set(O).expect(200)).body.data.items
      .find((p: any) => p.skill === 'autotask' && String(p.source.id) === String(applied.task.id));
    const pick = card.actions.find((a: any) => a.key === `lead:${lena}`);
    expect(pick.label).toBe('За «Дизайн» — Лена Дизайн');
    const done = (await http$.post(`/api/assistant/proposals/${card.id}/confirm`).set(O).send({ action: `lead:${lena}` }).expect(201)).body.data;
    expect(done.text).toContain('Лена Дизайн — руководитель направления «Дизайн»');
    const next = (await http$.post('/api/nl/auto-assign').set(O).send({ title: 'Нарисовать логотип' }).expect(201)).body.data;
    expect(next.assigneeId).toBe(lena);
    expect(next.source).toBe('lead');

    // обучение: постановщик дважды переназначил дизайн на Дину — карточка «Сделать руководителем?»
    for (const title of ['Макет лендинга', 'Иконки для меню']) {
      const t = (await http$.post('/api/tasks').set(O)
        .send({ projectId: String(site.id), title, assigneeId: lena, directions: ['design'], confirmedWithoutTags: true, confirmWorkload: true }).expect(201)).body.data;
      await http$.patch(`/api/tasks/${t.id}`).set(O).send({ assigneeId: dina }).expect(200);
    }
    let learn: any = null;
    for (let i = 0; i < 30 && !learn; i += 1) {
      learn = (await http$.get('/api/assistant/proposals').set(O).expect(200)).body.data.items.find((p: any) => p.kind === 'lead');
      if (!learn) await new Promise((r) => setTimeout(r, 150));
    }
    expect(learn.title).toBe('Сделать Дина Дизайн руководителем по направлению «Дизайн»?');
    expect(learn.actions.map((a: any) => a.label)).toEqual(['Да', 'Нет']);
    await http$.post(`/api/assistant/proposals/${learn.id}/confirm`).set(O).send({ action: 'lead_yes' }).expect(201);
    const after = (await http$.post('/api/nl/auto-assign').set(O).send({ title: 'Нарисовать баннер' }).expect(201)).body.data;
    expect(after.assigneeId).toBe(dina);
  });
});
