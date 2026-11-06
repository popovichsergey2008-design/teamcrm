import { EMAIL_HINT, validationRu } from './validation-ru';

describe('validationRu (#4779, п. 9)', () => {
  it('почта — понятная подсказка с примером', () => {
    expect(validationRu('email must be an email')).toBe(EMAIL_HINT);
  });
  it('длина и пустое поле — по-русски с названием поля', () => {
    expect(validationRu('password must be longer than or equal to 8 characters')).toBe('Поле «Пароль» — не короче 8 символов');
    expect(validationRu('fullName should not be empty')).toBe('Заполните поле «Имя»');
    expect(validationRu('property foo should not exist')).toMatch(/^Лишнее поле «foo»/);
  });
  it('вложенные поля и свои русские тексты', () => {
    expect(validationRu('items.0.title must be a string')).toBe('Поле «Название» должно быть текстом');
    expect(validationRu('Укажите ваше имя')).toBe('Укажите ваше имя');
  });
});
