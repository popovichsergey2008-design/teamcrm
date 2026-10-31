import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Сборка: файл кладёт CI перед выкладкой (commit, время коммита, номер прогона). Нет файла — нули. */
function read(): { sha: string | null; at: string | null; run: string | null } {
  const f = join(process.cwd(), 'build-info.json');
  try {
    if (!existsSync(f)) return { sha: null, at: null, run: null };
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return { sha: j.sha ?? null, at: j.at ?? null, run: j.run ?? null };
  } catch { return { sha: null, at: null, run: null }; }
}

export const BUILD = read();
/** Короткая версия для журналов и группировки ошибок по выпускам. */
export const BUILD_VERSION = BUILD.sha ? BUILD.sha.slice(0, 7) : null;
