import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const runScript = path.resolve(import.meta.dirname, '../run.sh');
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctf-run-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bin')); await fs.mkdir(path.join(root, 'util'));
  for (const file of ['config', 'pack-public', 'util/pack-common']) await fs.writeFile(path.join(root, file), 'fixture');
  await fs.writeFile(path.join(root, 'bin/docker'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$CTF_TEST_LOG"
if [[ "$1" == ps && "\u0024{CTF_TEST_EXISTING:-}" == 1 ]]; then printf 'existing-platform-id\\n'; fi
`, { mode: 0o755 });
  return root;
}
async function run(root, { existing = false, answer = '', args = [] } = {}) {
  const log = path.join(root, 'calls.log');
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, CTF_WORKSPACE: root, CTF_TEST_LOG: log, CTF_TEST_EXISTING: existing ? '1' : '0' };
  let output = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn('bash', [runScript, ...args], { cwd: root, env });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', resolve); child.stdin.end(answer);
  });
  return { code, output, calls: await fs.readFile(log, 'utf8') };
}
test('run.sh starts a new platform without asking to restart', async t => {
  const root = await setup(t); const result = await run(root);
  assert.equal(result.code, 0);
  assert.ok(result.calls.includes('up --build --detach --wait'));
  assert.ok(!result.calls.includes(' down'));
  assert.ok(!result.output.includes('Restart it?'));
});
test('run.sh keeps the existing platform when restart is declined or input is closed', async t => {
  const root = await setup(t); const result = await run(root, { existing: true, answer: 'n\n' });
  assert.equal(result.code, 0);
  assert.ok(result.output.includes('Restart it?'));
  assert.ok(result.output.includes('Existing instance kept.'));
  assert.ok(!result.calls.includes(' down'));
  assert.ok(!result.calls.includes(' up'));
});
test('run.sh restarts only this Compose project after confirmation', async t => {
  const root = await setup(t); const result = await run(root, { existing: true, answer: 'yes\n' });
  assert.equal(result.code, 0);
  assert.ok(result.calls.includes('--project-name ctf-author'));
  assert.ok(result.calls.includes('down --remove-orphans'));
  assert.ok(result.calls.includes('up --build --detach --wait'));
  assert.ok(result.calls.indexOf('down --remove-orphans') < result.calls.indexOf('up --build'));
  assert.ok(!result.calls.includes('stop '));
});
test('run.sh --yes permits an explicitly requested unattended restart', async t => {
  const root = await setup(t); const result = await run(root, { existing: true, args: ['--yes'] });
  assert.equal(result.code, 0);
  assert.ok(result.calls.includes('down --remove-orphans'));
  assert.ok(!result.output.includes('Restart it?'));
});
