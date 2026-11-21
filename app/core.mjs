import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const hash = (data, algorithm = 'sha256') => crypto.createHash(algorithm).update(data).digest('hex');
export const id = () => crypto.randomUUID();
export const json = (value) => JSON.stringify(value, null, 2) + '\n';
export async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export async function atomicJSON(file, value) {
  const tmp = `${file}.${id()}.tmp`;
  await fs.writeFile(tmp, json(value), { mode: 0o600 });
  await fs.rename(tmp, file);
}
export function relativeName(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..')) throw new AppError('Invalid path.');
  return value;
}
// Every component is checked, including directories: symlinks never cross workspace boundaries.
export async function safePath(root, relative, { missing = false } = {}) {
  relativeName(relative);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new AppError(`Symlinks are not allowed: ${relative}`);
      if (i < parts.length - 1 && !stat.isDirectory()) throw new AppError('Invalid directory.');
    } catch (e) { if (missing && e.code === 'ENOENT') return current + (i < parts.length - 1 ? '/' + parts.slice(i + 1).join('/') : ''); throw e; }
  }
  return current;
}
export async function realDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: path.basename(dir) === '.ctf-author' ? 0o700 : 0o755 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError(`Unsafe directory: ${dir}`);
}
export async function readConfig(root) {
  const content = await fs.readFile(await safePath(root, 'config'), 'utf8');
  // Parse only literal assignments. Never source repository configuration in the web server.
  const values = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*(categories|tar_mtime|flag_prefix)\s*=\s*(?:"([^"$`\\]*)"|'([^']*)'|([^\s#"'`$\\]+))\s*(?:#.*)?$/);
    if (match) values[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  if (!values.categories || !values.tar_mtime) throw new AppError('config must define literal categories and tar_mtime values.');
  const categories = [...new Set(values.categories.split(/\s+/).filter(Boolean))];
  if (categories.some(c => !/^[a-zA-Z0-9_-]+$/.test(c))) throw new AppError('Invalid categories in config.');
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:Z)?)?$/.test(values.tar_mtime) || !Number.isFinite(Date.parse(values.tar_mtime))) throw new AppError('tar_mtime must be a valid ISO date.');
  return { categories, tarMtime: values.tar_mtime, flagPrefix: values.flag_prefix || '', fingerprint: hash(content) };
}
export async function inventory(root, base = '', result = []) {
  const directory = base ? await safePath(root, base) : root;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const name = base ? `${base}/${entry.name}` : entry.name;
    // Refuse unusual names that cannot be displayed or passed to tools safely.
    try { relativeName(name); } catch { result.push({ path: name, type: 'unsupported', size: 0 }); continue; }
    if (entry.isSymbolicLink()) { result.push({ path: name, type: 'symlink', size: 0 }); continue; }
    if (entry.isDirectory()) {
      result.push({ path: name, type: 'directory', size: 0 });
      if (entry.name !== '.git') await inventory(root, name, result);
    } else if (entry.isFile()) {
      const stat = await fs.lstat(await safePath(root, name));
      result.push({ path: name, type: 'file', size: stat.size, executable: Boolean(stat.mode & 0o111) });
    } else result.push({ path: name, type: 'unsupported', size: 0 });
    if (result.length > 30000) throw new AppError('Too many files in a challenge (limit: 30,000).');
  }
  return result;
}
export async function validate(root, files, config) {
  const issues = [];
  const add = (severity, code, message) => issues.push({ severity, code, message });
  const byName = new Map(files.map(f => [f.path, f]));
  for (const file of ['README.md', 'flag', 'src/Makefile']) if (byName.get(file)?.type !== 'file') add('error', 'required', `Missing required file: ${file}.`);
  for (const dir of ['src', 'sol', 'public']) if (byName.get(dir)?.type !== 'directory') add('error', 'required', `Missing required directory: ${dir}/.`);
  let flag = '';
  if (byName.get('flag')?.type === 'file') {
    if (byName.get('flag').size > 16384) add('error', 'flag', 'Flag file is too large.');
    else {
      flag = (await fs.readFile(await safePath(root, 'flag'), 'utf8')).trim();
      if (!flag) add('error', 'flag', 'Flag file is empty.');
      if (flag && config.flagPrefix && (!flag.startsWith(`${config.flagPrefix}{`) || !flag.endsWith('}') || /[\r\n]/.test(flag) || flag.length <= config.flagPrefix.length + 2)) add('error', 'flag-format', `Invalid flag format; expected ${config.flagPrefix}{...}.`);
    }
  }
  if (!config.flagPrefix) add('warning', 'prefix', 'Flag prefix not set (flag_prefix in config).');
  if (!files.some(f => f.path.startsWith('sol/') && f.type === 'file' && f.size > 0)) add('error', 'solution', 'sol/ must contain a non-empty solution (any format).');
  if (byName.get('src/Makefile')?.type === 'file') {
    const make = await fs.readFile(await safePath(root, 'src/Makefile'), 'utf8');
    const targets = new Set();
    for (const line of make.replace(/\\\r?\n/g, ' ').split('\n')) {
      // Inspect explicit targets without running make (including multi-target rules).
      const rule = line.match(/^ *([^#\t:=][^:=\n]*):(?!=)/);
      if (rule) for (const target of rule[1].trim().split(/\s+/)) targets.add(target);
    }
    for (const target of ['clean', 'public']) if (!targets.has(target)) add('error', 'makefile', `Makefile is missing target: ${target}.`);
  }
  if (byName.get('README.md')?.type === 'file') {
    const readme = await fs.readFile(await safePath(root, 'README.md'), 'utf8');
    if (!/^\s*(?:name\s*:|#\s+\S)/im.test(readme)) add('warning', 'readme', 'README is missing a title (Name: or # Title).');
    const headings = new Set();
    const lines = readme.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const heading = lines[i].match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/)?.[1] || (/^\s*(?:={3,}|-{3,})\s*$/.test(lines[i + 1] || '') ? lines[i].trim() : '');
      if (heading) headings.add(heading.toLowerCase());
    }
    for (const [name, re] of [['description', /description|descriere/], ['vulnerability', /vulnerability|vulnerabilitate/], ['solution', /exploit|solution|soluție|solutie/], ['environment', /environment|mediu/], ['deploy', /deploy|instalare/]]) if (![...headings].some(h => re.test(h))) add('warning', 'readme', `README is missing section: ${name}.`);
  }
  return { issues, flag };
}
export async function scan(root) {
  const config = await readConfig(root);
  const challenges = [];
  const flags = new Map();
  for (const category of config.categories) {
    if (!await exists(path.join(root, category))) continue;
    const dir = await safePath(root, category);
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const challengeId = relativeName(`${category}/${entry.name}`);
      const challengeRoot = await safePath(root, challengeId);
      const files = await inventory(challengeRoot);
      const { issues, flag } = await validate(challengeRoot, files, config);
      if (flag) { const group = flags.get(hash(flag)) || []; group.push(challengeId); flags.set(hash(flag), group); }
      const defaults = (kind) => files.filter(f => f.type === 'file' && f.path.startsWith(`${kind}/`)).map(f => f.path);
      challenges.push({ id: challengeId, name: entry.name, category, files, issues, defaults: { public: defaults('public'), private: defaults('private') } });
    }
  }
  for (const group of flags.values()) if (group.length > 1) for (const chall of challenges.filter(c => group.includes(c.id))) chall.issues.push({ severity: 'error', code: 'duplicate-flag', message: `Duplicate flag in: ${group.join(', ')}.` });
  return { config, challenges };
}
// Stream both hashes and flag matching, including matches crossing chunk boundaries.
export async function inspectFile(file, flags = []) {
  const handle = await fs.open(file, 'r');
  const digest = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  const found = new Set();
  let tail = Buffer.alloc(0), size = 0;
  const patterns = flags.map(value => Buffer.from(value));
  const overlap = Math.max(0, ...patterns.map(p => p.length - 1));
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      digest.update(chunk);
      md5.update(chunk);
      const data = Buffer.concat([tail, chunk]);
      patterns.forEach((p, i) => { if (data.includes(p)) found.add(i); });
      tail = overlap ? data.subarray(Math.max(0, data.length - overlap)) : Buffer.alloc(0);
    }
  } finally { await handle.close(); }
  return { sha256: digest.digest('hex'), md5: md5.digest('hex'), size, flagMatches: [...found] };
}
function suspicious(name) {
  return name.split('/').some(p => /^(?:sol|\.git|\.env(?:\..*)?|__pycache__|flag)$/i.test(p) || /(?:\.pyc|\.pyo|\.sw[op]|\.bak|\.backup|\.orig|\.tmp|~)$/i.test(p) || /^#.*#$/.test(p));
}
export async function makePlan(root, request) {
  if (!request || !Array.isArray(request.selections) || !request.selections.length || request.selections.length > 300) throw new AppError('Select between 1 and 300 challenges.');
  const snapshot = await scan(root);
  const known = new Map(snapshot.challenges.map(c => [c.id, c]));
  const globalFlags = [];
  for (const chall of snapshot.challenges) {
    const flagFile = chall.files.find(f => f.path === 'flag' && f.type === 'file' && f.size <= 16384);
    if (flagFile) { const flag = (await fs.readFile(await safePath(root, `${chall.id}/flag`), 'utf8')).trim(); if (flag && !globalFlags.includes(flag)) globalFlags.push(flag); }
  }
  const jobs = [], issues = [], seen = new Set(), names = new Set();
  for (const selection of request.selections) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new AppError('Invalid challenge selection.');
    const chall = known.get(selection.id);
    if (!chall || seen.has(selection.id)) throw new AppError('Unknown or repeated challenge.');
    seen.add(selection.id);
    if (names.has(chall.name)) throw new AppError('Selected challenges must have unique names.');
    names.add(chall.name);
    issues.push(...chall.issues.map(issue => ({ ...issue, challenge: chall.id })));
    const challengeRoot = await safePath(root, chall.id);
    const knownFiles = new Map(chall.files.map(f => [f.path, f]));
    const privateHashes = new Set();
    for (const file of chall.files.filter(f => f.type === 'file' && f.path.startsWith('private/'))) privateHashes.add((await inspectFile(await safePath(challengeRoot, file.path))).sha256);
    for (const kind of ['public', 'private']) {
      const chosen = selection[kind] ?? [];
      if (!Array.isArray(chosen) || chosen.length > 30000) throw new AppError('Invalid file selection.');
      if (!chosen.length) continue;
      const entries = [], targets = new Set();
      for (const fileName of [...new Set(chosen)].sort()) {
        const meta = knownFiles.get(fileName);
        if (meta?.type !== 'file') throw new AppError(`Unavailable file or symlink: ${fileName}`);
        const source = await safePath(challengeRoot, fileName);
        const info = await inspectFile(source, kind === 'public' ? globalFlags : []);
        const target = fileName.startsWith(`${kind}/`) ? fileName.slice(kind.length + 1) : fileName;
        relativeName(target);
        if (targets.has(target)) throw new AppError(`Archive path collision: ${target}`);
        targets.add(target);
        if (kind === 'public') {
          if (suspicious(fileName) || suspicious(target)) issues.push({ severity: 'error', code: 'sensitive-path', challenge: chall.id, message: `Sensitive file in public selection: ${fileName}.` });
          if (fileName.startsWith('private/') || (info.size > 0 && privateHashes.has(info.sha256))) issues.push({ severity: 'error', code: 'private-leak', challenge: chall.id, message: `Private content in public selection: ${fileName}.` });
          if (info.flagMatches.length) issues.push({ severity: 'error', code: 'flag-leak', challenge: chall.id, message: `A project flag appears in ${fileName}.` });
        }
        entries.push({ source: fileName, path: `${chall.name}/${target}`, size: info.size, sha256: info.sha256, mode: meta.executable ? '0755' : '0644' });
      }
      for (const target of targets) {
        const parts = target.split('/');
        for (let i = 1; i < parts.length; i++) if (targets.has(parts.slice(0, i).join('/'))) throw new AppError('Selection creates a file/directory conflict.');
      }
      jobs.push({ challenge: chall.id, name: chall.name, kind, files: entries, bytes: entries.reduce((sum, f) => sum + f.size, 0), script: `pack-${kind}` });
    }
    if (!jobs.some(j => j.challenge === chall.id)) throw new AppError(`No files selected for ${chall.id}.`);
  }
  if (!jobs.length) throw new AppError('No files selected.');
  const scripts = [];
  for (const script of [...new Set(jobs.map(j => j.script)), 'util/pack-common']) {
    scripts.push({ path: script, sha256: hash(await fs.readFile(await safePath(root, script))) });
  }
  const plan = { config: snapshot.config, flagFingerprint: hash(globalFlags.slice().sort().join('\0')), jobs, issues, scripts, bytes: jobs.reduce((sum, j) => sum + j.bytes, 0) };
  return { ...plan, fingerprint: hash(JSON.stringify(plan)), blocked: issues.some(i => i.severity === 'error') };
}
export function diffFiles(current, previous) {
  const a = new Map(current.map(f => [f.path, f])), b = new Map(previous.map(f => [f.path, f]));
  return {
    added: [...a.keys()].filter(p => !b.has(p)),
    removed: [...b.keys()].filter(p => !a.has(p)),
    modified: [...a.keys()].filter(p => b.has(p) && (a.get(p).sha256 !== b.get(p).sha256 || a.get(p).mode !== b.get(p).mode))
  };
}
