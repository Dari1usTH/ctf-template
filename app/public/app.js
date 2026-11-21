const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (text, action) => { const node = el('button', text); node.type = 'button'; node.addEventListener('click', () => guarded(action)); return node; };
const bytes = size => size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1048576).toFixed(1)} MiB`;
const date = value => new Date(value).toLocaleString('en-GB');
let challenges = [], selections = new Map(), currentPlan = null, packing = false;
function notify(message, error = false) { $('#notice').textContent = message; $('#notice').dataset.error = String(error); $('#notice').hidden = false; }
function showLogin() { $('#login').hidden = false; $('#workspace').hidden = true; $('#logout').hidden = true; }
async function api(route, data) {
  const response = await fetch(`/api/${route}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CTF-Request': '1' }, body: JSON.stringify(data) });
  const payload = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(payload.error || 'Request failed.'); }
  return payload;
}
async function guarded(action) { try { await action(); } catch (error) { notify(error.message, true); } }
function invalidate() { currentPlan = null; $('#plan').hidden = true; updateSummary(); }
function issueList(issues) {
  const list = el('div');
  for (const issue of issues) list.append(el('p', `${issue.severity === 'error' ? 'ERROR' : 'WARNING'}${issue.challenge ? ` · ${issue.challenge}` : ''}: ${issue.message}`, 'issue'));
  return list;
}
function visibleChallenges() {
  const query = $('#search').value.trim().toLowerCase(), category = $('#category').value;
  return challenges.filter(c => (!category || category === c.category) && c.id.toLowerCase().includes(query));
}
function updateSummary() {
  let count = 0, files = 0, total = 0;
  for (const [id, selection] of selections) if (selection.enabled) {
    count++;
    const challenge = challenges.find(c => c.id === id);
    for (const kind of ['public', 'private']) for (const name of selection[kind]) { files++; total += challenge.files.find(f => f.path === name)?.size || 0; }
  }
  $('#selection-summary').textContent = `${count} challenges selected · ${files} file entries · ${bytes(total)} uncompressed`;
  $('#preview').disabled = packing || !count;
}
function renderChallenges() {
  const container = $('#challenge-list'); container.replaceChildren();
  const visible = visibleChallenges();
  if (!visible.length) container.append(el('p', challenges.length ? 'No matching challenges.' : 'No challenges found. Add category/challenge folders listed in config.'));
  for (const challenge of visible) {
    const selection = selections.get(challenge.id);
    const card = el('article', undefined, 'card');
    const heading = el('div', undefined, 'bar');
    const label = el('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selection.enabled;
    checkbox.addEventListener('change', () => { selection.enabled = checkbox.checked; details.open = checkbox.checked; invalidate(); });
    label.append(checkbox, el('strong', challenge.id)); heading.append(label);
    const errors = challenge.issues.filter(i => i.severity === 'error').length;
    heading.append(el('span', errors ? `${errors} validation errors` : challenge.issues.length ? `${challenge.issues.length} warnings` : 'Validation OK'));
    heading.append(button('Delete challenge', () => deleteChallenge(challenge.id)));
    card.append(heading);
    if (challenge.issues.length) {
      const details = el('details'); details.append(el('summary', 'Validation details'), issueList(challenge.issues)); card.append(details);
    }
    const details = el('details'); details.open = selection.enabled;
    details.append(el('summary', `${challenge.files.filter(f => f.type === 'file').length} files · choose public/private contents`));
    const actions = el('div', undefined, 'bar');
    actions.append(button('Reset defaults', () => { selection.public = new Set(challenge.defaults.public); selection.private = new Set(challenge.defaults.private); invalidate(); renderChallenges(); }), button('Clear files', () => { selection.public.clear(); selection.private.clear(); invalidate(); renderChallenges(); }));
    details.append(actions);
    const scroll = el('div', undefined, 'table-scroll');
    const table = el('table', undefined, 'files'); const head = el('thead'), hr = el('tr');
    for (const title of ['File / folder', 'Size', 'Public', 'Private']) hr.append(el('th', title));
    head.append(hr); table.append(head); const tbody = el('tbody');
    for (const file of challenge.files) {
      const row = el('tr'); row.append(el('td', `${file.path}${file.type === 'directory' ? '/' : file.type === 'symlink' ? ' [symlink excluded]' : file.type === 'unsupported' ? ' [unsupported]' : ''}`), el('td', file.type === 'file' ? bytes(file.size) : '—'));
      for (const kind of ['public', 'private']) {
        const cell = el('td');
        if (file.type === 'file') {
          const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selection[kind].has(file.path); check.setAttribute('aria-label', `${kind}: ${challenge.id}/${file.path}`);
          check.addEventListener('change', () => { check.checked ? selection[kind].add(file.path) : selection[kind].delete(file.path); invalidate(); }); cell.append(check);
        }
        row.append(cell);
      }
      tbody.append(row);
    }
    table.append(tbody); scroll.append(table); details.append(scroll); card.append(details); container.append(card);
  }
  updateSummary();
}
async function loadChallenges() {
  const data = await api('challenges');
  challenges = data.challenges; selections = new Map(challenges.map(c => [c.id, { enabled: false, public: new Set(c.defaults.public), private: new Set(c.defaults.private) }]));
  $('#category').replaceChildren(new Option('All', ''), ...data.config.categories.map(c => new Option(c, c)));
  $('#import-category').replaceChildren(...data.config.categories.map(c => new Option(c, c)));
  $('#config-info').textContent = `Archive timestamp: ${data.config.tarMtime} (UTC) · Flag prefix: ${data.config.flagPrefix || 'not set'}`;
  invalidate(); renderChallenges();
}
function tree(files) {
  const pre = el('pre', undefined, 'tree');
  const root = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    let branch = root;
    parts.forEach((name, index) => {
      if (!branch.has(name)) branch.set(name, { children: new Map() });
      const node = branch.get(name);
      if (index === parts.length - 1 && file.type !== 'directory') node.size = file.size;
      branch = node.children;
    });
  }
  const lines = [];
  function visit(branch, depth = 0) {
    for (const [name, node] of branch) {
      lines.push(`${'  '.repeat(depth)}${name}${node.size === undefined ? '/' : `  (${bytes(node.size)})`}`);
      visit(node.children, depth + 1);
    }
  }
  visit(root);
  pre.textContent = lines.join('\n');
  return pre;
}
function renderPlan(plan) {
  const container = $('#plan'); container.replaceChildren(el('h2', 'Package preview'));
  container.append(el('p', `${plan.jobs.length} archives · ${bytes(plan.bytes)} uncompressed · Expires: ${date(plan.expiresAt)}.`));
  if (plan.issues.length) container.append(issueList(plan.issues));
  const commands = el('pre');
  commands.textContent = plan.jobs.map(job => `bash ./${job.script} --prepared <staging-${job.kind}> <Challenges/date/${job.kind}> ${JSON.stringify(job.name)} ${JSON.stringify(plan.config.tarMtime)}\n# ${job.challenge}: ${job.files.length} files`).join('\n\n');
  container.append(el('h3', 'Scripts to run'), commands, el('p', 'Packaging only; run builds separately.'));
  const scriptDetails = el('details'); scriptDetails.append(el('summary', 'Script SHA256'), el('pre', plan.scripts.map(s => `${s.path}: ${s.sha256}`).join('\n'))); container.append(scriptDetails);
  for (const job of plan.jobs) {
    const details = el('details'); details.open = true;
    details.append(el('summary', `${job.challenge} · ${job.kind} · ${bytes(job.bytes)}`), tree(job.files)); container.append(details);
  }
  if (plan.blocked) container.append(el('p', 'Resolve errors and review again to continue.'));
  else {
    const packButton = button('Create archives', async () => {
      if (packing || !currentPlan) return;
      packing = true; packButton.disabled = true; $('#preview').disabled = true;
      const previewToken = currentPlan.token;
      notify('Packaging… See Logs for progress.');
      try {
        const result = await api('pack', { token: previewToken });
        currentPlan = null; container.hidden = true;
        await loadBatches(); showTab('archives');
        notify(`Created Challenges/${result.folder}/: ${result.archives.length} archives, manifest.json and checksums.txt.`);
      } catch (error) { invalidate(); throw error; }
      finally { packing = false; updateSummary(); }
    });
    packButton.className = 'primary'; container.append(packButton);
  }
  container.hidden = false; container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function download(relative, title) { const link = el('a', title); link.href = `/api/download?path=${encodeURIComponent(relative)}`; return link; }
function checksum(label, value) {
  const row = el('div', undefined, 'checksum'); const code = el('code', value);
  row.append(el('strong', `${label}:`), code, button('Copy', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value); notify(`${label} copied.`);
    } catch {
      const range = document.createRange(); range.selectNodeContents(code); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      notify(`Checksum selected. Press Ctrl+C or Cmd+C to copy.`);
    }
  }));
  return row;
}
async function askTrash(relative) {
  $('#confirm-text').textContent = `Move ${relative} to trash?`;
  const dialog = $('#confirm-dialog');
  const accepted = await new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true }); dialog.showModal(); });
  return accepted;
}
async function deleteChallenge(id) {
  if (!await askTrash(id)) return;
  await api('challenge/delete', { id });
  await loadChallenges(); notify(`Moved to trash: ${id}. Undo is available in History.`);
}
async function confirmDelete(relative) {
  if (!await askTrash(`Challenges/${relative}`)) return;
  await api('delete', { path: relative }); notify(`Moved to trash: ${relative}. Undo is available in History.`); await loadBatches();
}
async function inspect(relative) {
  const data = await api(`inspect?path=${encodeURIComponent(relative)}`);
  const target = $('#inspector-body'); target.replaceChildren(el('p', relative), el('p', 'SHA256 verified.'), tree(data.archive.files));
  target.append(checksum('MD5', data.archive.md5), checksum('SHA256', data.archive.sha256));
  if (!data.previous) target.append(el('p', 'No previous version to compare.'));
  else {
    target.append(el('h3', 'Changes from previous version'), el('p', data.previous));
    for (const [key, title] of [['added', 'Added'], ['removed', 'Removed'], ['modified', 'Modified']]) target.append(el('h3', `${title} (${data.diff[key].length})`), el('pre', data.diff[key].join('\n') || 'No files.'));
  }
  $('#inspector').showModal();
}
async function loadBatches() {
  const batches = await api('batches'); const target = $('#batch-list'); target.replaceChildren();
  if (!batches.length) target.append(el('p', 'No archives yet.'));
  for (const batch of batches) {
    const card = el('article', undefined, 'card'), bar = el('div', undefined, 'bar');
    bar.append(el('h2', batch.folder), button('Check', async () => {
      const report = await api('check', { folder: batch.folder });
      await loadBatches(); notify(report.ok ? 'Checksums OK.' : 'Checksum check failed.', !report.ok);
    }), button('Delete batch', () => confirmDelete(batch.folder))); card.append(bar, el('p', date(batch.createdAt)));
    if (batch.check) card.append(el('p', `${batch.check.ok ? 'OK' : 'Failed'} · ${date(batch.check.checkedAt)}`));
    const links = el('div', undefined, 'bar');
    for (const name of ['manifest.json', 'checksums.txt']) if (batch.files.some(f => f.path === name)) links.append(download(`${batch.folder}/${name}`, name));
    card.append(links);
    for (const kind of ['public', 'private']) {
      const section = el('section'), title = el('div', undefined, 'bar'); title.append(el('h3', `${kind}/`));
      if (batch.files.some(f => f.path === kind)) title.append(button(`Delete ${kind}/`, () => confirmDelete(`${batch.folder}/${kind}`)));
      section.append(title);
      for (const archive of batch.archives.filter(a => a.kind === kind)) {
        const item = el('div', undefined, 'card');
        const checked = batch.check?.archives.find(a => a.path === archive.path);
        if (checked) {
          if (!checked.ok) item.classList.add('archive-invalid');
          item.append(el('p', checked.status));
        }
        item.append(el('strong', `${archive.challenge} · ${bytes(archive.size)}${archive.missing ? ' · deleted / unavailable' : ''}`));
        if (!archive.missing) {
          const actions = el('div', undefined, 'bar'); const relative = `${batch.folder}/${archive.path}`;
          actions.append(download(relative, 'Download .tar'), button('Inspect & compare', () => inspect(relative)), button('Delete archive', () => confirmDelete(relative))); item.append(actions);
          item.append(checksum('MD5', archive.md5), checksum('SHA256', archive.sha256));
        }
        section.append(item);
      }
      card.append(section);
    }
    target.append(card);
  }
}
async function loadHistory() {
  const records = await api('history'), target = $('#history-list'); target.replaceChildren();
  if (!records.length) target.append(el('p', 'No operations yet.'));
  for (const record of records) {
    const card = el('div', undefined, 'card'); card.append(el('p', `${date(record.createdAt)} · ${record.type === 'import' ? 'Import' : record.type === 'create' ? 'Create' : 'Delete'} · ${record.path} · ${record.status}`));
    if (record.status === 'done') card.append(button(record.type === 'import' ? 'Undo import' : record.type === 'create' ? 'Undo batch' : 'Restore', async () => { await api('undo', { id: record.id }); notify('Operation undone.'); await loadHistory(); }));
    target.append(card);
  }
}
async function loadLogs() {
  const logs = await api('logs'), target = $('#log-list'); target.replaceChildren();
  if (!logs.length) target.append(el('p', 'No logs yet.'));
  for (const log of logs) target.append(el('pre', `${date(log.at)} [${log.type}] ${log.message || [log.script, log.challenge].filter(Boolean).join(' · ')}${log.operation ? `\nOperation: ${log.operation}` : ''}`, 'card'));
}
function showTab(name) {
  for (const section of document.querySelectorAll('.tab')) section.hidden = section.id !== name;
  for (const tab of document.querySelectorAll('[data-tab]')) tab.setAttribute('aria-pressed', String(tab.dataset.tab === name));
}
$('#login-form').addEventListener('submit', event => { event.preventDefault(); guarded(async () => { await api('login', { token: new FormData(event.currentTarget).get('token') }); $('#login-form').reset(); $('#notice').hidden = true; await start(); }); });
$('#logout').addEventListener('click', () => guarded(async () => { await api('logout', {}); showLogin(); }));
$('#rescan').addEventListener('click', () => guarded(async () => { await loadChallenges(); notify('Rescanned. Selection reset.'); }));
$('#search').addEventListener('input', renderChallenges); $('#category').addEventListener('change', renderChallenges);
$('#select-all').addEventListener('click', () => { visibleChallenges().forEach(c => { selections.get(c.id).enabled = true; }); invalidate(); renderChallenges(); });
$('#select-none').addEventListener('click', () => { selections.forEach(s => { s.enabled = false; }); invalidate(); renderChallenges(); });
$('#preview').addEventListener('click', () => guarded(async () => {
  $('#preview').disabled = true; notify('Checking files and leaks…');
  try {
    const request = { selections: [...selections].filter(([, s]) => s.enabled).map(([id, s]) => ({ id, public: [...s.public], private: [...s.private] })) };
    currentPlan = await api('preview', request); renderPlan(currentPlan);
    notify(currentPlan.blocked ? 'Review errors below.' : 'Ready for review.', currentPlan.blocked);
  } finally { updateSummary(); }
}));
const loaders = { archives: loadBatches, history: loadHistory, logs: loadLogs };
for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => guarded(async () => { showTab(tab.dataset.tab); await loaders[tab.dataset.tab]?.(); }));
for (const [selector, loader] of [['#refresh-archives', loadBatches], ['#refresh-history', loadHistory], ['#refresh-logs', loadLogs]]) $(selector).addEventListener('click', () => guarded(loader));
$('#close-inspector').addEventListener('click', () => $('#inspector').close());
let pendingImport = null, uploading = false;
function importStatus(text) { $('#import-status').textContent = text; $('#import-status').hidden = !text; }
$('#open-import').addEventListener('click', () => { $('#import-dialog').showModal(); });
$('#import-kind').addEventListener('change', () => {
  $('#folder-input').hidden = $('#import-kind').value !== 'folder';
  $('#archive-input').hidden = $('#import-kind').value !== 'archive';
});
for (const selector of ['#import-folder', '#import-archive']) $(selector).addEventListener('change', event => {
  const file = event.target.files[0];
  if (file && !$('#import-name').value) $('#import-name').value = (file.webkitRelativePath?.split('/')[0] || file.name.replace(/\.(?:tar\.(?:gz|bz2|xz)|zip|tar|tgz|gz|bz2|xz|tbz|txz)$/i, '')).replace(/[^A-Za-z0-9_. -]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100);
});
$('#import-form').addEventListener('submit', event => {
  event.preventDefault();
  guarded(async () => {
    if (uploading) return;
    const kind = $('#import-kind').value;
    const files = [...$(kind === 'folder' ? '#import-folder' : '#import-archive').files];
    if (!files.length) { importStatus('Choose files first.'); return; }
    uploading = true; $('#review-import').disabled = true; $('#cancel-import').disabled = true;
    try {
      pendingImport = (await api('import/start', { kind, category: $('#import-category').value, name: $('#import-name').value.trim() })).token;
      for (const [index, file] of files.entries()) {
        importStatus(`Uploading ${index + 1}/${files.length}…`);
        const relative = kind === 'folder' ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
        const response = await fetch(`/api/import/upload?token=${encodeURIComponent(pendingImport)}&path=${encodeURIComponent(relative)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CTF-Request': '1' }, body: file });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Upload failed.');
      }
      importStatus('Review files.');
      const review = await api('import/review', { token: pendingImport });
      const target = $('#import-review'); target.replaceChildren(el('h3', review.target), tree(review.files));
      if (review.issues.length) {
        const details = el('details'); details.append(el('summary', 'Validation details'), issueList(review.issues)); target.append(details);
      }
      $('#import-form').hidden = true; target.hidden = false; $('#confirm-import').hidden = false;
    } catch (error) {
      importStatus(error.message);
      if (pendingImport) { try { await api('import/cancel', { token: pendingImport }); pendingImport = null; } catch {} }
    } finally { uploading = false; $('#review-import').disabled = false; $('#cancel-import').disabled = false; }
  });
});
async function closeImport() {
  if (uploading) return;
  if (pendingImport) await api('import/cancel', { token: pendingImport });
  pendingImport = null;
  $('#import-form').reset(); $('#import-form').hidden = false; $('#import-review').hidden = true; $('#confirm-import').hidden = true;
  $('#folder-input').hidden = false; $('#archive-input').hidden = true;
  importStatus(''); $('#import-dialog').close();
}
$('#cancel-import').addEventListener('click', () => guarded(closeImport));
$('#import-dialog').addEventListener('cancel', event => { event.preventDefault(); guarded(closeImport); });
$('#confirm-import').addEventListener('click', () => guarded(async () => {
  if (!pendingImport) return;
  $('#confirm-import').disabled = true;
  try {
    await api('import/confirm', { token: pendingImport }); pendingImport = null;
    await closeImport(); await loadChallenges(); notify('Challenge imported.');
  } catch (error) { importStatus(error.message); }
  finally { $('#confirm-import').disabled = false; }
}));
async function start() { await api('session'); $('#login').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false; await loadChallenges(); }
await guarded(start);
