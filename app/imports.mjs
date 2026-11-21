import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, id, exists, safePath, realDirectory, readConfig, atomicJSON, inventory, validate, inspectFile, hash, relativeName } from './core.mjs';

const MAX_UPLOAD = 256 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
export class Imports {
  constructor(workspace) { this.workspace = workspace; this.directory = path.join(workspace.state, 'imports'); }
  async init() { await realDirectory(this.directory); }
  async load(token) {
    if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) throw new AppError('Invalid import.');
    const directory = await safePath(this.directory, token);
    const meta = JSON.parse(await fs.readFile(await safePath(directory, 'meta.json'), 'utf8'));
    if (meta.expires < Date.now()) throw new AppError('Import expired. Start again.', 409);
    return { directory, meta };
  }
  async create(input) {
    return this.workspace.exclusive(async () => {
      const config = await readConfig(this.workspace.root);
      if (!input || !['folder', 'archive'].includes(input.kind) || !config.categories.includes(input.category) || typeof input.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/.test(input.name) || input.name.endsWith('.')) throw new AppError('Choose a category and a valid challenge name.');
      const target = `${input.category}/${input.name}`;
      if (await exists(await safePath(this.workspace.root, target, { missing: true }))) throw new AppError('Challenge already exists.', 409);
      // Expired staging is disposable and never contains a confirmed challenge.
      for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = await safePath(this.directory, entry.name);
        const metaFile = await safePath(directory, 'meta.json', { missing: true });
        if (await exists(metaFile) && JSON.parse(await fs.readFile(metaFile, 'utf8')).expires < Date.now()) await fs.rm(directory, { recursive: true, force: true });
      }
      if ((await fs.readdir(this.directory)).length >= 10) throw new AppError('Too many pending imports. Cancel an import first.', 409);
      const token = id(), directory = path.join(this.directory, token);
      await fs.mkdir(path.join(directory, 'content'), { recursive: true });
      const meta = { token, kind: input.kind, target, state: 'uploading', bytes: 0, count: 0, expires: Date.now() + 3600000 };
      await atomicJSON(path.join(directory, 'meta.json'), meta);
      return { token };
    });
  }
  async upload(token, relative, incoming) {
    return this.workspace.exclusive(async () => {
      const { directory, meta } = await this.load(token);
      if (meta.state !== 'uploading') throw new AppError('Import is already under review.', 409);
      if (meta.count >= 10000 || meta.kind === 'archive' && meta.count) throw new AppError('Too many uploaded files.');
      const relativeFile = meta.kind === 'archive' ? 'source.archive' : `content/${relativeName(relative)}`;
      const file = await safePath(directory, relativeFile, { missing: true });
      if (await exists(file)) throw new AppError('Duplicate upload path.', 409);
      await fs.mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        for await (const chunk of incoming) {
          size += chunk.length;
          if (size > MAX_UPLOAD || meta.bytes + size > MAX_TOTAL) throw new AppError('Upload limit: 256 MiB per file, 1 GiB per import.', 413);
          await handle.writeFile(chunk);
        }
      } catch (error) { await fs.rm(file, { force: true }); throw error; }
      finally { await handle.close(); }
      if (meta.kind === 'folder') {
        const fileHandle = await fs.open(file, 'r');
        const header = Buffer.alloc(4);
        try { await fileHandle.read(header, 0, 4, 0); } finally { await fileHandle.close(); }
        const executable = header.subarray(0, 2).toString() === '#!' || header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
        await fs.chmod(file, executable ? 0o755 : 0o644);
      }
      meta.count++; meta.bytes += size;
      await atomicJSON(path.join(directory, 'meta.json'), meta);
      return { ok: true };
    });
  }
  async fingerprint(directory, files) {
    const result = [];
    for (const file of files) {
      if (!['file', 'directory'].includes(file.type)) throw new AppError('Import contains unsupported files.');
      result.push({ ...file, ...(file.type === 'file' ? { sha256: (await inspectFile(await safePath(directory, file.path))).sha256 } : {}) });
    }
    return hash(JSON.stringify(result));
  }
  async review(token) {
    return this.workspace.exclusive(async () => {
      const { directory, meta } = await this.load(token);
      if (meta.state === 'review') return meta.review;
      if (!meta.count) throw new AppError('Choose files first.');
      let content = path.join(directory, 'content');
      if (meta.kind === 'archive') {
        await fs.rm(content, { recursive: true, force: true });
        await fs.mkdir(content);
        await this.workspace.run(path.join(import.meta.dirname, 'scripts/extract.sh'), [path.join(directory, 'source.archive'), content]);
      }
      // Archives often contain one enclosing challenge folder (or category/challenge).
      while (true) {
        const entries = await fs.readdir(content, { withFileTypes: true });
        if (entries.some(e => ['README.md', 'flag', 'public', 'private', 'src', 'sol'].includes(e.name))) break;
        if (entries.length !== 1 || !entries[0].isDirectory()) break;
        content = path.join(content, entries[0].name);
      }
      const challenge = path.join(directory, 'challenge');
      await fs.rename(content, challenge);
      for (const folder of ['public', 'src', 'sol']) await realDirectory(path.join(challenge, folder));
      const files = await inventory(challenge);
      if (!files.some(f => f.type === 'file')) throw new AppError('Import is empty.');
      const { issues } = await validate(challenge, files, await readConfig(this.workspace.root));
      const fingerprint = await this.fingerprint(challenge, files);
      meta.state = 'review';
      meta.review = { token, target: meta.target, files, issues, fingerprint };
      await atomicJSON(path.join(directory, 'meta.json'), meta);
      await this.workspace.log({ type: 'import-review', message: meta.target });
      return meta.review;
    });
  }
  async confirm(token) {
    return this.workspace.exclusive(async () => {
      const { directory, meta } = await this.load(token);
      if (meta.state !== 'review') throw new AppError('Review the files first.', 409);
      const challenge = await safePath(directory, 'challenge');
      if (await this.fingerprint(challenge, await inventory(challenge)) !== meta.review.fingerprint) throw new AppError('Import files changed. Start again.', 409);
      const config = await readConfig(this.workspace.root);
      const category = meta.target.split('/')[0];
      if (!config.categories.includes(category)) throw new AppError('Category no longer exists.', 409);
      const parent = await safePath(this.workspace.root, category, { missing: true });
      if (!await exists(parent)) await fs.mkdir(parent);
      const op = await this.workspace.moveOperation('import', `.ctf-author/imports/${token}/challenge`, meta.target, { path: meta.target });
      this.workspace.previews.clear();
      await fs.rm(directory, { recursive: true, force: true });
      return op;
    });
  }
  async cancel(token) {
    return this.workspace.exclusive(async () => {
      const { directory } = await this.load(token);
      await fs.rm(directory, { recursive: true, force: true });
      return { ok: true };
    });
  }
}
