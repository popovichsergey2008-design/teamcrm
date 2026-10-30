import { compressArgs, compressedName, COMPRESS_MIN_BYTES, MAX_VIDEO_BYTES, shouldCompress, videoSpaceProblem } from './video-rules';
import { MAX_FILE_BYTES, validateUpload } from './files.validation';

describe('видео (#4692)', () => {
  it('видео до 400 МБ, остальное — до 25 МБ', () => {
    expect(validateUpload('video/mp4', 300 * 1024 * 1024).ok).toBe(true);
    expect(validateUpload('video/mp4', MAX_VIDEO_BYTES + 1).ok).toBe(false);
    expect(validateUpload('application/pdf', MAX_FILE_BYTES + 1).ok).toBe(false);
  });

  it('жмём только крупные видео и не трогаем записи встреч', () => {
    expect(shouldCompress({ contentType: 'video/quicktime', sizeBytes: COMPRESS_MIN_BYTES, ownerKind: 'chat_message' })).toBe(true);
    expect(shouldCompress({ contentType: 'video/mp4', sizeBytes: COMPRESS_MIN_BYTES - 1 })).toBe(false);
    expect(shouldCompress({ contentType: 'video/webm', sizeBytes: 9e8, ownerKind: 'meeting_recording' })).toBe(false);
    expect(shouldCompress({ contentType: 'image/png', sizeBytes: 9e8 })).toBe(false);
  });

  it('общий потолок места под видео', () => {
    const gb = 1024 ** 3;
    expect(videoSpaceProblem(99 * gb, 0.5 * gb, 100)).toBeNull();
    expect(videoSpaceProblem(99.8 * gb, 0.5 * gb, 100)).toMatch(/100 ГБ/);
  });

  it('рецепт заказчика: 720p, CRF 26, faststart', () => {
    const a = compressArgs('in', 'out.mp4');
    expect(a).toEqual(expect.arrayContaining(['-crf', '26', '-preset', 'veryfast', '+faststart', 'out.mp4']));
    expect(a[a.indexOf('-vf') + 1]).toBe("scale=-2:'min(720,ih)'");
  });

  it('имя сжатого — .mp4', () => {
    expect(compressedName('Запись экрана.MOV')).toBe('Запись экрана.mp4');
    expect(compressedName('clip')).toBe('clip.mp4');
  });
});
