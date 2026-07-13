import { interpolate, PromptsService } from './prompts.service';
import { PromptRepository } from './prompt.repository';

describe('interpolate({{var}})', () => {
  it('подставляет объявленные переменные', () => {
    expect(interpolate('Привет, {{name}}!', { name: 'Иван' })).toBe('Привет, Иван!');
  });
  it('недостающие → пусто, лишние игнорируются', () => {
    expect(interpolate('a={{a}} b={{b}}', { a: 1, c: 9 })).toBe('a=1 b=');
  });
  it('терпит пробелы внутри скобок и повторы', () => {
    expect(interpolate('{{ x }}-{{x}}', { x: 'z' })).toBe('z-z');
  });
  it('без переменных возвращает исходный текст', () => {
    expect(interpolate('без плейсхолдеров')).toBe('без плейсхолдеров');
  });
});

describe('PromptsService.resolve', () => {
  const mkRepo = (over: Partial<PromptRepository>) => over as unknown as PromptRepository;

  it('приоритет tenant-override над глобальным + активная версия + интерполяция', async () => {
    const repo = mkRepo({
      effectiveTemplate: async () => ({ id: 't1', tenant_id: '7', key: 'k', title: '', description: null, created_at: '' }),
      activeVersion: async () => ({
        id: 'v9', template_id: 't1', version: 3, body: 'Привет {{who}}', model: 'gpt-x',
        params: { max_tokens: 100 }, variables: [], status: 'active', ab_split: null, note: null, created_by: null, created_at: '',
      }),
    });
    const svc = new PromptsService(repo);
    const r = await svc.resolve('7', 'k', { who: 'мир' });
    expect(r).toEqual({ body: 'Привет мир', model: 'gpt-x', params: { max_tokens: 100 }, versionId: 'v9', version: 3, variant: 'active' });
  });

  it('нет шаблона → null (вызывающий берёт хардкод-фолбэк)', async () => {
    const svc = new PromptsService(mkRepo({ effectiveTemplate: async () => null }));
    expect(await svc.resolve('7', 'missing')).toBeNull();
  });

  it('шаблон есть, но нет активной версии → null', async () => {
    const svc = new PromptsService(mkRepo({
      effectiveTemplate: async () => ({ id: 't1', tenant_id: null, key: 'k', title: '', description: null, created_at: '' }),
      activeVersion: async () => null,
    }));
    expect(await svc.resolve('7', 'k')).toBeNull();
  });

  it('ошибка репозитория не роняет ИИ-слой → null', async () => {
    const svc = new PromptsService(mkRepo({
      effectiveTemplate: async () => { throw new Error('db down'); },
    }));
    expect(await svc.resolve('7', 'k')).toBeNull();
  });
});
