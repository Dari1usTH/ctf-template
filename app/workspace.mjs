import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError, id, exists, safePath, relativeName, readConfig, realDirectory, atomicJSON, inspectFile, makePlan, diffFiles, json, inventory } from './core.mjs';

export class Workspace {
  constructor(root, { timezone = 'Europe/Bucharest', scriptTimeout = 120000 } = {}) {
    this.root = path.resolve(root);
    this.state = path.join(this.root, '.ctf-author');
    this.output = path.join(this.root, 'Challenges');
    this.timezone = timezone;
    this.scriptTimeout = scriptTimeout;
    this.busy = false;
    this.previews = new Map();
  }
  async init() {
    for (const directory of [this.state, this.output]) await realDirectory(directory);
    for (const name of ['trash', 'build', 'operations', 'checks']) await realDirectory(path.join(this.state, name));
    // A crash leaves staging outside Challenges, never a partially published batch.
    await this.recover();
  }
  async exclusive(work) {
    if (this.busy) throw new AppError('An operation is already running. Wait for it to finish.', 409);
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  async log(event) {
    await fs.appendFile(path.join(this.state, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  }
  async logs() {
    let lines = [];
    try { lines = (await fs.readFile(path.join(this.state, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return lines.slice(-300).reverse().flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  }
  async operations() {
    const entries = [];
    for (const name of await fs.readdir(path.join(this.state, 'operations'))) {
      if (!/^[\da-f-]+\.json$/.test(name)) continue;
      entries.push(JSON.parse(await fs.readFile(await safePath(this.state, `operations/${name}`), 'utf8')));
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async saveOperation(op) { await atomicJSON(path.join(this.state, 'operations', `${op.id}.json`), op); }
  async recover() {
    for (const op of await this.operations()) {
      if (op.status !== 'pending') continue;
      const source = await safePath(this.root, op.from, { missing: true });
      const target = await safePath(this.root, op.to, { missing: true });
      if (!await exists(source) && await exists(target)) {
        op.status = 'done';
        await this.saveOperation(op);
        await this.log({ type: 'recovered', operation: op.id, message: 'Recovered an operation completed before restart.' });
      } else if (await exists(source) && !await exists(target)) {
        op.status = 'failed'; await this.saveOperation(op);
      } else { op.status = 'conflict'; await this.saveOperation(op); }
    }
    // Reconcile completed undo records even if the process stopped before updating their parent.
    const ops = await this.operations();
    for (const undo of ops.filter(o => o.type === 'undo' && o.status === 'done')) {
      const parent = ops.find(o => o.id === undo.undoOf);
      if (parent && parent.status !== 'undone') { parent.status = 'undone'; parent.undoneBy = undo.id; await this.saveOperation(parent); }
    }
  }
  async run(script, args) {
    return await new Promise((resolve, reject) => {
      const child = spawn('bash', [script, ...args], { cwd: this.root, detached: true, env: { ...process.env, TMPDIR: path.join(this.state, 'build'), LC_ALL: 'C', TZ: 'UTC', TAR_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', timedOut = false;
      const capture = data => { output = (output + data.toString()).slice(-32768); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, this.scriptTimeout);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        code === 0 && !timedOut ? resolve(output.trim()) : reject(new AppError(timedOut ? 'Script timed out.' : `Script ${path.basename(script)} failed: ${output}`, 500));
      });
    });
  }
  async preview(request) {
    const plan = await makePlan(this.root, request);
    const token = id();
    const now = Date.now();
    for (const [key, entry] of this.previews) if (entry.expires < now) this.previews.delete(key);
    if (this.previews.size > 100) this.previews.delete(this.previews.keys().next().value);
    const expires = now + 15 * 60000;
    this.previews.set(token, { request: structuredClone(request), plan, expires });
    await this.log({ type: 'preview', message: `${plan.jobs.length} archives previewed.`, blocked: plan.blocked });
    return { ...plan, token, expiresAt: new Date(expires).toISOString() };
  }
  dateFolder() {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  async pack(token) {
    return this.exclusive(async () => {
      const entry = this.previews.get(token);
      if (!entry || entry.expires < Date.now()) throw new AppError('Preview expired. Run review again.', 409);
      const plan = await makePlan(this.root, entry.request);
      if (plan.fingerprint !== entry.plan.fingerprint) throw new AppError('Files, configuration or scripts changed. Run review again.', 409);
      if (plan.blocked) throw new AppError('Resolve validation errors and leaks before packaging.', 422);
      this.previews.delete(token);
      const operationId = id();
      const build = await safePath(this.state, `build/${operationId}`, { missing: true });
      await fs.mkdir(build);
      const batch = path.join(build, 'batch');
      for (const kind of ['public', 'private']) await fs.mkdir(path.join(batch, kind), { recursive: true });
      const createdAt = new Date().toISOString();
      let folder = this.dateFolder();
      await safePath(this.root, 'Challenges');
      if (await exists(path.join(this.output, folder))) folder += `_${createdAt.slice(11, 19).replaceAll(':', '-')}_${operationId.slice(0, 8)}`;
      try {
        // Execute the reviewed script bytes even if a source script changes mid-batch.
        const scriptDirectory = path.join(build, 'scripts');
        for (const script of plan.scripts) {
          const source = await safePath(this.root, script.path);
          const destination = path.join(scriptDirectory, script.path);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
          if ((await inspectFile(destination)).sha256 !== script.sha256) throw new AppError('Script changed during preparation. Run review again.', 409);
        }
        const archives = [];
        for (const [index, job] of plan.jobs.entries()) {
          const staging = path.join(build, `input-${index}`);
          await fs.mkdir(path.join(staging, job.name), { recursive: true, mode: 0o755 });
          for (const file of job.files) {
            const source = await safePath(this.root, `${job.challenge}/${file.source}`);
            const destination = path.join(staging, file.path);
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
            await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
            await fs.chmod(destination, parseInt(file.mode, 8));
            if ((await inspectFile(destination)).sha256 !== file.sha256) throw new AppError('Content changed during copy. Run review again.', 409);
          }
          const script = await safePath(scriptDirectory, job.script);
          await this.log({ type: 'script-start', operation: operationId, script: job.script, challenge: job.challenge });
          await this.run(script, ['--prepared', staging, path.join(batch, job.kind), job.name, plan.config.tarMtime]);
          await this.log({ type: 'script-done', operation: operationId, script: job.script, challenge: job.challenge });
          const candidates = (await fs.readdir(path.join(batch, job.kind))).filter(name => name.startsWith(`${job.name}_`) && /^[a-f0-9]{32}\.tar$/.test(name.slice(job.name.length + 1)));
          if (candidates.length !== 1) throw new AppError('Script did not produce the expected archive.', 500);
          const name = candidates[0];
          const archivePath = await safePath(batch, `${job.kind}/${name}`);
          const { md5, sha256, size } = await inspectFile(archivePath);
          if (name !== `${job.name}_${md5}.tar`) throw new AppError('Archive filename checksum is invalid.', 500);
          archives.push({ challenge: job.challenge, kind: job.kind, path: `${job.kind}/${name}`, size, md5, sha256, files: job.files });
        }
        const manifest = { version: 1, id: operationId, createdAt, timezone: this.timezone, folder, tarMtime: plan.config.tarMtime, scripts: plan.scripts, warnings: plan.issues, archives };
        await fs.writeFile(path.join(batch, 'manifest.json'), json(manifest));
        await fs.writeFile(path.join(batch, 'checksums.txt'), archives.map(a => `MD5 (${a.path}) = ${a.md5}\nSHA256 (${a.path}) = ${a.sha256}`).join('\n') + '\n');
        const op = { id: operationId, type: 'create', createdAt, from: `.ctf-author/build/${operationId}/batch`, to: `Challenges/${folder}`, status: 'pending', path: folder };
        await this.saveOperation(op);
        const target = await safePath(this.root, op.to, { missing: true });
        if (await exists(target)) throw new AppError('Destination already exists.', 409);
        await fs.rename(batch, target);
        op.status = 'done'; await this.saveOperation(op);
        await this.log({ type: 'create', operation: operationId, message: `Created Challenges/${folder}: ${archives.length} archives.`, path: folder });
        return manifest;
      } catch (error) {
        await this.log({ type: 'error', operation: operationId, message: error.message });
        throw error;
      } finally { await fs.rm(build, { recursive: true, force: true }); }
    });
  }
  async batches() {
    await safePath(this.root, 'Challenges');
    const batches = [];
    for (const entry of await fs.readdir(this.output, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}(?:_|$)/.test(entry.name)) continue;
      const directory = await safePath(this.output, entry.name);
      if (!await exists(path.join(directory, 'manifest.json'))) continue;
      const manifest = JSON.parse(await fs.readFile(await safePath(directory, 'manifest.json'), 'utf8'));
      const files = await inventory(directory);
      const checkFile = await safePath(this.state, `checks/${entry.name}.json`, { missing: true });
      const check = await exists(checkFile) ? JSON.parse(await fs.readFile(checkFile, 'utf8')) : null;
      batches.push({ check: check?.batchId === manifest.id ? check : null, folder: entry.name, createdAt: manifest.createdAt, id: manifest.id, files, archives: manifest.archives.map(a => ({ ...a, files: undefined, missing: !files.some(f => f.path === a.path && f.type === 'file') })) });
    }
    return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async inspect(relative) {
    const file = await safePath(this.output, relative);
    const [folder, ...parts] = relative.split('/');
    const manifest = JSON.parse(await fs.readFile(await safePath(this.output, `${folder}/manifest.json`), 'utf8'));
    const archive = manifest.archives.find(a => a.path === parts.join('/'));
    if (!archive) throw new AppError('File is not an archive listed in the manifest.', 404);
    const actual = await inspectFile(file);
    if (actual.sha256 !== archive.sha256) throw new AppError('Archive was modified after creation; checksum does not match the manifest.', 409);
    let previous = null;
    for (const batch of await this.batches()) {
      if (batch.createdAt >= manifest.createdAt) continue;
      const candidate = batch.archives.find(a => !a.missing && a.challenge === archive.challenge && a.kind === archive.kind);
      if (candidate) { previous = { folder: batch.folder, archive: candidate }; break; }
    }
    let diff = null;
    if (previous) {
      const previousManifest = JSON.parse(await fs.readFile(await safePath(this.output, `${previous.folder}/manifest.json`), 'utf8'));
      const old = previousManifest.archives.find(a => a.path === previous.archive.path);
      const oldHash = await inspectFile(await safePath(this.output, `${previous.folder}/${old.path}`));
      if (oldHash.sha256 !== old.sha256) throw new AppError('Previous archive was modified after creation.', 409);
      diff = diffFiles(archive.files, old.files);
    }
    return { archive, verified: true, previous: previous ? `${previous.folder}/${previous.archive.path}` : null, diff };
  }
  async moveOperation(type, from, to, extra = {}) {
    const op = { id: id(), type, createdAt: new Date().toISOString(), from, to, status: 'pending', ...extra };
    const source = await safePath(this.root, from);
    const target = await safePath(this.root, to, { missing: true });
    if (await exists(target)) throw new AppError('Destination already exists. It will not be overwritten.', 409);
    const identity = await fs.stat(source);
    op.sourceIdentity = `${identity.dev}:${identity.ino}`;
    await this.saveOperation(op);
    try {
      await this.run(path.join(import.meta.dirname, 'scripts/trash.sh'), [source, target]);
      op.status = 'done'; await this.saveOperation(op);
      await this.log({ type, operation: op.id, message: `${from} → ${to}`, path: extra.path });
      return op;
    } catch (e) {
      if (await exists(source) && !await exists(target)) { op.status = 'failed'; await this.saveOperation(op); }
      await this.log({ type: 'error', operation: op.id, message: e.message });
      throw e;
    }
  }
  async removeChallenge(challengeId) {
    return this.exclusive(async () => {
      relativeName(challengeId);
      const parts = challengeId.split('/');
      const config = await readConfig(this.root);
      if (parts.length !== 2 || !config.categories.includes(parts[0])) throw new AppError('Invalid challenge.');
      const source = await safePath(this.root, challengeId);
      if (!(await fs.stat(source)).isDirectory()) throw new AppError('Choose a challenge folder.');
      const operation = await this.moveOperation('challenge-delete', challengeId, `.ctf-author/trash/${id()}/item`, { path: challengeId });
      this.previews.clear();
      return operation;
    });
  }
  async checkBatch(folder) {
    return this.exclusive(async () => {
      relativeName(folder);
      if (folder.includes('/') || !/^\d{4}-\d{2}-\d{2}(?:_|$)/.test(folder)) throw new AppError('Invalid batch.');
      const directory = await safePath(this.output, folder);
      const manifest = JSON.parse(await fs.readFile(await safePath(directory, 'manifest.json'), 'utf8'));
      const archives = [];
      for (const archive of manifest.archives) {
        let result;
        try {
          const file = await safePath(directory, archive.path);
          const actual = await inspectFile(file);
          const ok = actual.md5 === archive.md5 && actual.sha256 === archive.sha256 && actual.size === archive.size;
          result = { path: archive.path, ok, status: ok ? 'OK' : 'Mismatch' };
        } catch (error) {
          result = { path: archive.path, ok: false, status: error.code === 'ENOENT' ? 'Missing' : 'Unreadable' };
        }
        archives.push(result);
      }
      const report = { folder, batchId: manifest.id, checkedAt: new Date().toISOString(), ok: archives.every(a => a.ok), archives };
      await atomicJSON(path.join(this.state, 'checks', `${folder}.json`), report);
      await this.log({ type: 'check', message: `${folder}: ${report.ok ? 'OK' : 'Failed'}` });
      return report;
    });
  }
  async remove(relative) {
    return this.exclusive(async () => {
      relativeName(relative);
      const first = relative.split('/')[0];
      if (!first || !/^\d{4}-\d{2}-\d{2}(?:_|$)/.test(first)) throw new AppError('Only generated results in Challenges/ can be deleted.');
      // Manifests are needed for inspection, checksums and recovery. Delete the whole batch instead.
      if (relative.split('/').length === 2 && ['manifest.json', 'checksums.txt'].includes(relative.split('/')[1])) throw new AppError('Delete the whole batch to remove its metadata.');
      const source = await safePath(this.output, relative);
      if (!await exists(source)) throw new AppError('Result no longer exists.', 404);
      return this.moveOperation('delete', `Challenges/${relative}`, `.ctf-author/trash/${id()}/item`, { path: relative });
    });
  }
  async undo(operationId) {
    return this.exclusive(async () => {
      const ops = await this.operations();
      const op = ops.find(o => o.id === operationId && ['create', 'delete', 'challenge-delete', 'import'].includes(o.type));
      if (!op || op.status !== 'done') throw new AppError('Operation cannot be undone.', 409);
      if (op.sourceIdentity) {
        const current = await fs.stat(await safePath(this.root, op.to));
        if (`${current.dev}:${current.ino}` !== op.sourceIdentity) throw new AppError('The original item was replaced. Undo is unavailable.', 409);
      }
      const from = op.to, to = ['create', 'import'].includes(op.type) ? `.ctf-author/trash/${id()}/item` : op.from;
      if (['delete', 'challenge-delete'].includes(op.type)) {
        try {
          const parent = await safePath(this.root, path.posix.dirname(to));
          if (!(await fs.stat(parent)).isDirectory()) throw new Error('not a directory');
        } catch { throw new AppError('Parent directory is missing. Restore the parent batch or folder first.', 409); }
      }
      const undo = await this.moveOperation('undo', from, to, { undoOf: op.id, path: op.path });
      op.status = 'undone'; op.undoneBy = undo.id; await this.saveOperation(op);
      this.previews.clear();
      return undo;
    });
  }
}
