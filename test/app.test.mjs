import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { Workspace } from '../app/workspace.mjs';
import { scan, makePlan, safePath, readConfig, inspectFile, diffFiles, hash } from '../app/core.mjs';
import { createApplication } from '../app/server.mjs';

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctf-author-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'util'));
  for (const script of ['pack-public', 'pack-private', 'util/pack-common']) await fs.copyFile(path.join(repository, script), path.join(root, script));
  await fs.writeFile(path.join(root, 'config'), 'categories="crypto web"\ntar_mtime="2016-09-01"\nflag_prefix="CTF"\n');
  await addChallenge(root);
  const workspace = new Workspace(root);
  await workspace.init();
  return { root, workspace };
}
async function addChallenge(root, category = 'crypto', name = 'one', flag = 'CTF{secret-unique-one}') {
  const base = path.join(root, category, name);
  for (const dir of ['src', 'sol', 'public', 'private']) await fs.mkdir(path.join(base, dir), { recursive: true });
  await fs.writeFile(path.join(base, 'flag'), `${flag}\n`);
  await fs.writeFile(path.join(base, 'README.md'), '# Challenge\n## Description\nText\n## Vulnerability\nText\n## Solution\nText\n## Environment\nText\n## Deploy\nText\n');
  await fs.writeFile(path.join(base, 'src/Makefile'), 'clean:\n\trm -f output\npublic:\n\ttrue\n');
  await fs.writeFile(path.join(base, 'sol/solution.txt'), 'human-readable solution');
  await fs.writeFile(path.join(base, 'public/message.txt'), 'hello public\n');
  await fs.writeFile(path.join(base, 'public/program.sh'), '#!/bin/sh\necho hello\n', { mode: 0o755 });
  await fs.writeFile(path.join(base, 'private/server.txt'), 'private deployment content');
  return base;
}
const request = (publicFiles = ['public/message.txt', 'public/program.sh'], privateFiles = ['private/server.txt']) => ({ selections: [{ id: 'crypto/one', public: publicFiles, private: privateFiles }] });

test('scan parses config, accepts text solutions and populates defaults', async t => {
  const { root } = await fixture(t);
  const result = await scan(root);
  assert.deepEqual(result.config.categories, ['crypto', 'web']);
  assert.equal(result.challenges.length, 1);
  assert.deepEqual(result.challenges[0].issues, []);
  assert.equal(result.challenges[0].defaults.public.length, 2);
  assert.equal(result.challenges[0].defaults.private.length, 1);
});

test('validator reports required files, targets, empty flags, README sections and duplicates', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'crypto/one/flag'), '');
  await fs.writeFile(path.join(root, 'crypto/one/src/Makefile'), 'all:\n\ttrue\n');
  await fs.writeFile(path.join(root, 'crypto/one/README.md'), 'no sections');
  await fs.rm(path.join(root, 'crypto/one/sol/solution.txt'));
  let issues = (await scan(root)).challenges[0].issues;
  for (const code of ['flag', 'makefile', 'readme', 'solution']) assert.ok(issues.some(i => i.code === code));
  await fs.writeFile(path.join(root, 'crypto/one/flag'), 'CTF{same}');
  await addChallenge(root, 'web', 'two', 'CTF{same}');
  assert.ok((await scan(root)).challenges.every(c => c.issues.some(i => i.code === 'duplicate-flag')));
  await fs.writeFile(path.join(root, 'web/two/flag'), 'WRONG{format}');
  assert.ok((await scan(root)).challenges.find(c => c.id === 'web/two').issues.some(i => i.code === 'flag-format'));
});

test('leak scanner detects flags across challenges, private copies and sensitive paths', async t => {
  const { root } = await fixture(t);
  await addChallenge(root, 'web', 'two', 'CTF{other-challenge}');
  await fs.writeFile(path.join(root, 'crypto/one/public/message.txt'), 'accidental CTF{other-challenge} leak');
  await fs.copyFile(path.join(root, 'crypto/one/private/server.txt'), path.join(root, 'crypto/one/public/copy.txt'));
  await fs.writeFile(path.join(root, 'crypto/one/public/.env'), 'SECRET=example');
  const plan = await makePlan(root, request(['public/message.txt', 'public/copy.txt', 'public/.env', 'sol/solution.txt', 'private/server.txt']));
  assert.equal(plan.blocked, true);
  for (const code of ['flag-leak', 'private-leak', 'sensitive-path']) assert.ok(plan.issues.some(i => i.code === code));
  assert.ok(!JSON.stringify(plan).includes('CTF{other-challenge}'));
});

test('stream scanner finds a flag spanning read chunks', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'large.bin');
  await fs.writeFile(file, Buffer.concat([Buffer.alloc(65532, 65), Buffer.from('CTF{boundary}'), Buffer.alloc(200000, 66)]));
  const result = await inspectFile(file, ['CTF{boundary}']);
  assert.deepEqual(result.flagMatches, [0]);
});

test('configuration is parsed without executing Bash or shell substitutions', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'config'), 'categories="crypto"\ntar_mtime="2016-09-01"\ntouch SHOULD_NOT_EXIST\nflag_prefix="$(touch ALSO_NOT)"\n');
  assert.equal((await readConfig(root)).flagPrefix, '');
  assert.equal(await fs.access(path.join(root, 'SHOULD_NOT_EXIST')).then(() => true, () => false), false);
  await fs.writeFile(path.join(root, 'config'), 'categories="$(touch MALICIOUS)"\ntar_mtime="2016-09-01"\n');
  await assert.rejects(readConfig(root), /literal/);
});

test('paths, directory symlinks, symlink files, and conflicting archive destinations are rejected', async t => {
  const { root, workspace } = await fixture(t);
  for (const name of ['../config', '/etc/passwd', 'a/../config', 'a//b', 'a\\b', 'a\nb']) await assert.rejects(safePath(root, name));
  await fs.symlink('/etc/passwd', path.join(root, 'crypto/one/public/link'));
  await assert.rejects(makePlan(root, request(['public/link'])));
  await fs.mkdir(path.join(root, 'crypto/one/extra'));
  await fs.writeFile(path.join(root, 'crypto/one/extra/data'), 'one');
  await fs.mkdir(path.join(root, 'crypto/one/public/extra'));
  await fs.writeFile(path.join(root, 'crypto/one/public/extra/data'), 'two');
  await assert.rejects(makePlan(root, request(['extra/data', 'public/extra/data'], [])), /collision/);
  await assert.rejects(workspace.remove('../config'));
  await fs.symlink('/tmp', path.join(root, 'Challenges/2026-01-01_link'));
  await assert.rejects(workspace.remove('2026-01-01_link'));
});

test('end-to-end packaging is reproducible, includes manifest and checksums, and strips kind prefix', async t => {
  const { root, workspace } = await fixture(t);
  const preview = await workspace.preview(request());
  assert.equal(preview.blocked, false);
  const first = await workspace.pack(preview.token);
  assert.equal(first.archives.length, 2);
  for (const artifact of first.archives) {
    const file = path.join(root, 'Challenges', first.folder, artifact.path);
    const data = await fs.readFile(file);
    assert.equal(hash(data, 'md5'), artifact.md5);
    assert.equal(hash(data), artifact.sha256);
    assert.equal(path.basename(file), `one_${artifact.md5}.tar`);
    const { stdout } = await exec('tar', ['-tf', file]);
    assert.ok(stdout.includes('one/'));
    assert.ok(!stdout.includes('one/public/'));
  }
  const checksums = await fs.readFile(path.join(root, 'Challenges', first.folder, 'checksums.txt'), 'utf8');
  assert.ok(checksums.includes(first.archives[0].md5));
  assert.ok(checksums.includes(first.archives[0].sha256));
  await fs.utimes(path.join(root, 'crypto/one/public/message.txt'), new Date(), new Date());
  const second = await workspace.pack((await workspace.preview(request())).token);
  assert.notEqual(first.folder, second.folder);
  assert.deepEqual(first.archives.map(a => a.sha256), second.archives.map(a => a.sha256));
  assert.equal((await workspace.batches()).length, 2);
  const inspected = await workspace.inspect(`${second.folder}/${second.archives[0].path}`);
  assert.equal(inspected.verified, true);
  assert.deepEqual(inspected.diff, { added: [], removed: [], modified: [] });
});

test('inspector compares added, removed and changed files, and rejects tampered archives', async t => {
  const { root, workspace } = await fixture(t);
  const first = await workspace.pack((await workspace.preview(request())).token);
  await fs.writeFile(path.join(root, 'crypto/one/public/message.txt'), 'changed');
  await fs.writeFile(path.join(root, 'crypto/one/public/new.txt'), 'new');
  const second = await workspace.pack((await workspace.preview(request(['public/message.txt', 'public/new.txt'], []))).token);
  const relative = `${second.folder}/${second.archives[0].path}`;
  const inspected = await workspace.inspect(relative);
  assert.deepEqual(inspected.diff, { added: ['one/new.txt'], removed: ['one/program.sh'], modified: ['one/message.txt'] });
  await fs.appendFile(path.join(root, 'Challenges', relative), 'tampering');
  await assert.rejects(workspace.inspect(relative), /modified/);
  assert.ok(first.archives.length);
});

test('stale previews, leaks and concurrent mutations cannot publish a batch', async t => {
  const { root, workspace } = await fixture(t);
  const plan = await workspace.preview(request());
  await fs.writeFile(path.join(root, 'crypto/one/public/message.txt'), 'changed');
  await assert.rejects(workspace.pack(plan.token), /changed/);
  assert.equal((await workspace.batches()).length, 0);
  await fs.writeFile(path.join(root, 'crypto/one/public/message.txt'), 'CTF{secret-unique-one}');
  await assert.rejects(workspace.pack((await workspace.preview(request())).token), /leaks/);
  workspace.busy = true;
  await assert.rejects(workspace.remove('2026-01-01'), /running/);
  workspace.busy = false;
});

test('script failure leaves no partial output and records the failure', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'pack-private'), '#!/bin/bash\necho fail >&2\nexit 2\n');
  await assert.rejects(workspace.pack((await workspace.preview(request())).token), /failed/);
  assert.equal((await workspace.batches()).length, 0);
  assert.equal((await fs.readdir(path.join(root, '.ctf-author/build'))).length, 0);
  assert.ok((await workspace.logs()).some(e => e.type === 'error'));
});

test('delete/undo survives restart, protects source files and never overwrites restored paths', async t => {
  const { root, workspace } = await fixture(t);
  const batch = await workspace.pack((await workspace.preview(request())).token);
  const relative = `${batch.folder}/${batch.archives[0].path}`;
  const removed = await workspace.remove(relative);
  assert.equal((await workspace.batches())[0].archives[0].missing, true);
  const restarted = new Workspace(root); await restarted.init();
  await restarted.undo(removed.id);
  assert.equal((await restarted.batches())[0].archives[0].missing, false);
  await assert.rejects(restarted.undo(removed.id), /undone/);
  const folderDelete = await restarted.remove(`${batch.folder}/private`);
  await fs.mkdir(path.join(root, 'Challenges', batch.folder, 'private'));
  await assert.rejects(restarted.undo(folderDelete.id), /exists/);
  await fs.rmdir(path.join(root, 'Challenges', batch.folder, 'private'));
  await restarted.undo(folderDelete.id);
  await restarted.undo(batch.id);
  assert.equal((await restarted.batches()).length, 0);
  assert.equal(await fs.readFile(path.join(root, 'crypto/one/public/message.txt'), 'utf8'), 'hello public\n');
});

test('pending moves are reconciled after restart', async t => {
  const { root, workspace } = await fixture(t);
  const batch = await workspace.pack((await workspace.preview(request())).token);
  const op = { id: crypto.randomUUID(), type: 'delete', status: 'pending', createdAt: new Date().toISOString(), from: `Challenges/${batch.folder}`, to: '.ctf-author/trash/recovered/item', path: batch.folder };
  await workspace.saveOperation(op);
  await fs.mkdir(path.join(root, '.ctf-author/trash/recovered'));
  await fs.rename(path.join(root, op.from), path.join(root, op.to));
  const restarted = new Workspace(root); await restarted.init();
  assert.equal((await restarted.operations()).find(o => o.id === op.id).status, 'done');
  await restarted.undo(op.id);
  assert.equal((await restarted.batches()).length, 1);
});

test('undo refuses to recreate an absent parent and permits restore after the parent returns', async t => {
  const { root, workspace } = await fixture(t);
  const batch = await workspace.pack((await workspace.preview(request())).token);
  const removedFile = await workspace.remove(`${batch.folder}/${batch.archives[0].path}`);
  const removedBatch = await workspace.remove(batch.folder);
  await assert.rejects(workspace.undo(removedFile.id), /Parent/);
  await workspace.undo(removedBatch.id);
  await workspace.undo(removedFile.id);
  assert.equal((await workspace.batches())[0].archives[0].missing, false);
});

test('names containing spaces and shared prefixes pack correctly and legacy CLI is idempotent', async t => {
  const { root, workspace } = await fixture(t);
  await addChallenge(root, 'crypto', 'one_more', 'CTF{unique-two}');
  await addChallenge(root, 'crypto', 'two words', 'CTF{unique-three}');
  const selection = { selections: [
    { id: 'crypto/one_more', public: ['public/message.txt'], private: [] },
    { id: 'crypto/one', public: ['public/message.txt'], private: [] },
    { id: 'crypto/two words', public: ['public/message.txt'], private: [] }
  ] };
  const batch = await workspace.pack((await workspace.preview(selection)).token);
  assert.equal(batch.archives.length, 3);
  await exec('bash', ['pack-public', 'crypto/two words'], { cwd: root });
  await exec('bash', ['pack-public', 'crypto/two words'], { cwd: root });
  assert.equal((await fs.readdir(root)).filter(f => f.startsWith('two words_')).length, 1);
});

test('script edits and executable-bit edits invalidate the reviewed plan', async t => {
  const { root, workspace } = await fixture(t);
  let preview = await workspace.preview(request());
  await fs.appendFile(path.join(root, 'util/pack-common'), '\n# edited after review\n');
  await assert.rejects(workspace.pack(preview.token), /changed/);
  preview = await workspace.preview(request());
  await fs.chmod(path.join(root, 'crypto/one/public/program.sh'), 0o644);
  await assert.rejects(workspace.pack(preview.token), /changed/);
});

test('scripts are frozen for an entire batch even if originals change between jobs', async t => {
  const { root, workspace } = await fixture(t);
  const run = workspace.run.bind(workspace);
  let started = false;
  workspace.run = async (script, args) => {
    if (!started) {
      started = true;
      await fs.writeFile(path.join(root, 'pack-private'), '#!/bin/bash\nexit 99\n');
    }
    return run(script, args);
  };
  const batch = await workspace.pack((await workspace.preview(request())).token);
  assert.equal(batch.archives.length, 2);
});

test('validator recognizes multi-target Makefile rules without running recipes', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'crypto/one/src/Makefile'), 'clean public:\n\ttouch SHOULD_NOT_RUN\n');
  assert.deepEqual((await scan(root)).challenges[0].issues, []);
  assert.equal(await fs.access(path.join(root, 'SHOULD_NOT_RUN')).then(() => true, () => false), false);
});

test('HTTP auth, CSRF, dry run, pack, download, inspector, delete and undo', async t => {
  const { root } = await fixture(t);
  const token = 'test-access-token-at-least-16';
  const { server } = await createApplication({ root, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (route, cookie = '') => fetch(`${base}${route}`, { headers: { cookie } });
  let cookie = '';
  const post = (route, data, extra = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CTF-Request': '1', cookie, ...extra }, body: JSON.stringify(data) });
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/api/challenges')).status, 401);
  assert.equal((await post('/api/login', { token }, { origin: 'http://evil.test' })).status, 403);
  assert.equal((await post('/api/login', { token: 'wrong' })).status, 401);
  const login = await post('/api/login', { token });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/api/challenges', cookie)).status, 200);
  assert.equal((await post('/api/delete', { path: 123 })).status, 400);
  assert.equal((await post('/api/preview', { selections: [null] })).status, 400);
  const previewResponse = await post('/api/preview', request());
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.blocked, false);
  const packed = await post('/api/pack', { token: preview.token });
  assert.equal(packed.status, 201);
  const batch = await packed.json(), relative = `${batch.folder}/${batch.archives[0].path}`;
  const downloaded = await get(`/api/download?path=${encodeURIComponent(relative)}`, cookie);
  assert.equal(downloaded.status, 200);
  assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())), batch.archives[0].sha256);
  assert.equal((await get(`/api/inspect?path=${encodeURIComponent(relative)}`, cookie)).status, 200);
  assert.equal((await get('/api/download?path=../../config', cookie)).status, 400);
  const removed = await (await post('/api/delete', { path: relative })).json();
  assert.equal((await post('/api/undo', { id: removed.id })).status, 200);
  assert.ok((await (await get('/api/logs', cookie)).json()).length > 0);
});

test('flag changes invalidate a preview even when no file selection changed', async t => {
  const { root, workspace } = await fixture(t);
  const preview = await workspace.preview(request());
  await fs.writeFile(path.join(root, 'crypto/one/flag'), 'CTF{changed-without-a-leak}');
  await assert.rejects(workspace.pack(preview.token), /changed/);
});
