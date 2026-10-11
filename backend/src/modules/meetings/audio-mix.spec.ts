import { mixArgs } from './audio.util';
import { parseRange } from '../files/files.controller';

describe('сведение записи и докачка', () => {
  it('каждой дорожке — своя задержка, громкость возвращается после смеси', () => {
    const a = mixArgs([{ file: 'a.ogg', offsetSec: 0 }, { file: 'b.ogg', offsetSec: 1.5 }], 'out.mp3');
    const graph = a[a.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[1:a]aresample=24000,adelay=delays=1500:all=1[a1]');
    expect(graph).toContain('amix=inputs=2:duration=longest:dropout_transition=0,volume=2[out]');
    expect(a.slice(-1)[0]).toBe('out.mp3');
    expect(mixArgs([{ file: 'a.ogg', offsetSec: 0 }], 'o.mp3').join(' ')).toContain('[a0]anull[out]');
  });

  it('диапазоны байтов', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=2000-', 1000)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});
