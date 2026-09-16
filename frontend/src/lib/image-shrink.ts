/**
 * Ужать снимок перед отправкой.
 *
 * Живая жалоба: «страшно тупит чат, секунд тридцать не мог отправить сообщение —
 * видимо, фото грузилось». Так и было: снимок с телефона — это 4–8 мегабайт, и на
 * обычном исходящем канале он уходит полминуты, всё это время занимая собой отправку.
 *
 * Лечим там, где проблема и возникает: в браузере. Фотография ужимается до разумного
 * размера ещё до отправки — в переписке её всё равно смотрят на экране, а не печатают
 * плакатом. Десять мегапикселей превращаются в 1600 точек по длинной стороне, вес
 * падает в десять-двадцать раз, и сообщение уходит за секунду.
 *
 * Чего НЕ трогаем:
 *  — файлы, которые и так малы (меньше SKIP_UNDER): выигрыш не окупит перекодировку;
 *  — не-картинки и форматы, где перекодировка вредна: gif (анимация), svg (вектор);
 *  — случаи, когда «ужатый» вышел не легче исходного: отдаём оригинал.
 *
 * Прозрачность теряется намеренно: жмём в JPEG, потому что PNG-снимок экрана в
 * полтора мегабайта — это ровно та проблема, ради которой всё и затевалось. Файлы с
 * прозрачностью в переписке встречаются реже, чем скриншоты, и на белом фоне
 * выглядят так же.
 */

/** Длинная сторона после сжатия: с запасом хватает и на просмотр во весь экран. */
const MAX_SIDE = 1600;
/** Качество JPEG: 0.82 — граница, за которой разница видна только на глаз эксперта. */
const QUALITY = 0.82;
/** Мельче этого не трогаем: перекодировка дороже выигрыша. */
const SKIP_UNDER = 400 * 1024;
/** Форматы, которые жмём. gif и svg не трогаем: у них своя природа. */
const SHRINKABLE = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Вернуть файл, готовый к отправке: ужатый снимок или исходник.
 *
 * Никогда не падает: если браузер не смог прочитать картинку, отправляем как есть —
 * потеря качества хуже сжатия, но потеря сообщения хуже всего.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!SHRINKABLE.includes(file.type) || file.size < SKIP_UNDER) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    // Картинка уже маленькая по сторонам, но тяжёлая — всё равно пережимаем в JPEG.
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // Белая подложка: без неё прозрачные места в JPEG становятся чёрными.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', QUALITY));
    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.(png|jpe?g|webp)$/i, '') || 'снимок';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/** Ужать пачку снимков. Порядок сохраняется: он и есть порядок в сообщении. */
export function shrinkAll(files: File[]): Promise<File[]> {
  return Promise.all(files.map(shrinkImage));
}
