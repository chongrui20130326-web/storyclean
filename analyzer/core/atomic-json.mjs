import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeJsonAtomic(file, data, indent = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, indent), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    return file;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

