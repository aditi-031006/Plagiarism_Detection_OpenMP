/* DocSim dashboard - application logic.
   Talks to server.py (JSON API), which runs the Plagiarism_Project's C program. */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const S = {
  info: null, src: 'upload', files: [], threshold: 0.8,
  result: null, scaling: null, runId: null, lastSig: null,
  job: null, docFilter: null, showAll: false, histLog: null,
  hero: null, scaleMax: '', heroTop: null,
};

/* =============================================================== helpers == */
async function api(path, body) {
  const r = await fetch(path, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : undefined);
  const d = await r.json().catch(() => ({error: 'The server sent a response that is not valid JSON.'}));
  if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}
function showAlert(msg) {
  $('#alertBox').innerHTML = msg ? `<div class="alert" role="alert"><span>${esc(msg)}</span><button type="button" aria-label="Dismiss" data-act="dismiss">×</button></div>` : '';
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
const bandOf = s => s >= 0.8 ? {key: 'high', label: 'High', color: 'var(--high)'}
  : s >= 0.4 ? {key: 'mod', label: 'Moderate', color: 'var(--mod)'}
  : {key: 'low', label: 'Low', color: 'var(--low)'};
const heat = s => `hsl(${150 - 142 * s} 78% ${52 - 4 * s}% / ${0.22 + 0.78 * s})`;
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const fmtEdge = v => String(+v.toFixed(2));

/* ================================================================= theme == */
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
};

/* ================================================================== init == */
async function init() {
  try {
    const i = S.info = await api('/api/info');
    const chip = $('#chipProject');
    chip.querySelector('.dot').className = 'dot ' + (i.project ? 'ok' : 'bad');
    chip.querySelector('span').textContent = i.project ? 'Plagiarism_Project linked' : 'Project not found';
    chip.title = i.project ? `${i.project}\nProgram: ${i.origin || 'will be compiled on first run'}` : 'Start the server with --project <path>';
    $('#chipCpu').hidden = false;
    $('#chipCpu').textContent = plural(i.cpu_count, 'logical CPU');
    buildThreadChips(i.cpu_count);
    $('#testsInfo').innerHTML = i.tests
      ? `The ${i.tests.files.length} short files in the project's <code>tests/</code> folder:<br>${i.tests.files.map(f => '• ' + esc(f)).join('<br>')}<br><br>Two are identical, one overlaps partly and the rest are unrelated, which makes them handy for a first run.`
      : 'No <code>tests/</code> folder found in the project.';
    $('#datasetInfo').innerHTML = i.dataset
      ? `<b>${i.dataset.files.toLocaleString()}</b> documents found in the PAN11 dataset.`
      : 'No dataset folder found in the project.';
    $('#nPresets').innerHTML = [50, 100, 200, 500, 1000, 0].filter(n => !i.dataset || n === 0 || n < i.dataset.files)
      .map(n => `<button type="button" class="btn small" data-n="${n}">${n ? n.toLocaleString() : 'All'}</button>`).join('');
    if (!i.project) showAlert('Plagiarism_Project folder not found.\nStart the server with:\n  python server.py --project /path/to/Plagiarism_Project');
    updatePairCount();
  } catch (e) { showAlert(e.message); }
  render();
}

function buildThreadChips(cpu) {
  const set = [...new Set([1, 2, 4, 8, cpu])].sort((a, b) => a - b);
  $('#threadChips').innerHTML = set.map(t =>
    `<label class="tchip"><input type="checkbox" value="${t}" ${t <= Math.max(cpu, 2) ? 'checked' : ''}><span>${t}</span></label>`).join('');
  $('#cpuNote').textContent = `This machine reports ${plural(cpu, 'logical CPU')}. Asking for more threads than that cannot make it faster.`;
}
const selectedThreads = () => $$('#threadChips input:checked').map(x => +x.value);

function updatePairCount() {
  const total = S.info?.dataset?.files || 0;
  let n = +$('#nDocs').value || 0; n = n <= 0 ? total : Math.min(n, total);
  const pairs = n * (n - 1) / 2;
  $('#pairCount').textContent = `${n.toLocaleString()} documents give ${pairs.toLocaleString()} pairs to compare.` +
    (pairs > 500000 ? ' A run this large can take a few minutes.' : '');
}
$('#nDocs').oninput = updatePairCount;
$('#nPresets').addEventListener('click', e => {
  const b = e.target.closest('[data-n]'); if (!b) return;
  $('#nDocs').value = b.dataset.n; updatePairCount();
});

/* ------------------------------------------------------------ source tabs */
function setSource(src) {
  S.src = src;
  $$('#srcSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.src === src)));
  $('#srcUpload').hidden = src !== 'upload';
  $('#srcTests').hidden = src !== 'tests';
  $('#srcDataset').hidden = src !== 'dataset';
}
$$('#srcSeg button').forEach(b => b.onclick = () => setSource(b.dataset.src));

/* ---------------------------------------------------------------- uploads */
const drop = $('#drop'), fileIn = $('#fileIn');
drop.onclick = () => fileIn.click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } };
fileIn.onchange = () => { addFiles(fileIn.files); fileIn.value = ''; };
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
async function addFiles(list) {
  for (const f of list) {
    if (f.size > 25 * 1024 * 1024) { showAlert(f.name + ' is larger than 25 MB, so it was skipped.'); continue; }
    S.files.push({name: f.name, text: await f.text()});
  }
  renderFiles();
}
function renderFiles() {
  $('#fileList').innerHTML = S.files.map((f, i) =>
    `<div class="file"><b title="${esc(f.name)}">${esc(f.name)}</b><span>${(f.text.length / 1000).toFixed(1)}k chars</span><button type="button" data-i="${i}" aria-label="Remove ${esc(f.name)}">×</button></div>`).join('');
}
$('#fileList').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  S.files.splice(+b.dataset.i, 1); renderFiles();
});
$('#pasteAdd').onclick = () => {
  const t = $('#pasteText').value.trim(); if (!t) return;
  let n = $('#pasteName').value.trim() || ('pasted_' + (S.files.length + 1));
  if (!/\.[a-z0-9]+$/i.test(n)) n += '.txt';
  S.files.push({name: n, text: t});
  $('#pasteText').value = ''; $('#pasteName').value = ''; renderFiles();
};

/* -------------------------------------------------------------- threshold */
$('#thr').oninput = e => {
  S.threshold = +e.target.value;
  $('#thrOut').textContent = S.threshold.toFixed(2);
  updateThrNote();
  if (S.result?.complete_matrix) render();
};
function updateThrNote() {
  const r = S.result;
  const stale = r && !r.complete_matrix && Math.abs(S.threshold - r.options.threshold) > 1e-9;
  $('#thrNote').textContent = stale ? 'Applies on the next run.' : (r?.complete_matrix ? 'Applied to the results straight away.' : 'Pairs at or above this score are flagged.');
}

/* ======================================================== running jobs == */
function options() {
  return {
    threshold: S.threshold, k: +$('#k').value || 3, reps: +$('#reps').value || 3,
    max_bytes: +$('#maxBytes').value || 0,
    n_docs: S.src === 'dataset' ? (+$('#nDocs').value || 0) : 0,
    thread_counts: selectedThreads(), verify: $('#optVerify').checked, distribution: $('#optDist').checked,
  };
}
const signature = () => JSON.stringify([S.src, S.src === 'upload' ? S.files.map(f => [f.name, f.text.length]) : 0]);
const maxThreads = () => Math.max(1, ...selectedThreads());

function setBusy(b) {
  ['#runBtn', '#scaleBtn'].forEach(s => $(s).disabled = b);
  ['#scaleGo'].forEach(s => { const x = $(s); if (x) x.disabled = b; });
  $('#progress').hidden = !b;
  $('#runBtn').innerHTML = (b && S.job?.type === 'analyze') ? '<span class="spin"></span>Running…' : 'Run analysis';
}
function updateProgress(st) {
  const p = st.progress, pctDone = Math.max(4, Math.min(100, (p.done / Math.max(1, p.total)) * 100));
  $('#progLabel').textContent = p.label;
  $('#progCount').textContent = `${p.done} of ${p.total}`;
  $('#progFill').style.width = pctDone + '%';
  $('#progTime').textContent = Math.round(st.elapsed) + ' s elapsed';
}
async function runJob(type, extra) {
  if (S.job) return null;
  showAlert('');
  if (!selectedThreads().length) throw new Error('Tick at least one thread count.');
  if (S.src === 'upload' && S.files.length < 2) throw new Error('Add at least two documents first.');
  const body = Object.assign({type, source: S.src, options: options()}, extra || {});
  if (S.src === 'upload') body.files = S.files;
  const {job_id} = await api('/api/jobs', body);
  S.job = {id: job_id, type};
  setBusy(true);
  try {
    for (;;) {
      const st = await api('/api/job?id=' + job_id);
      updateProgress(st);
      if (st.status === 'done') return st.result;
      if (st.status === 'error') throw new Error(st.error || 'The job failed.');
      if (st.status === 'cancelled') return null;
      await sleep(450);
    }
  } finally { S.job = null; setBusy(false); }
}
$('#cancelBtn').onclick = async () => {
  if (!S.job) return;
  $('#progLabel').textContent = 'Cancelling…';
  try { await api('/api/jobs/cancel', {job_id: S.job.id}); } catch (e) { /* job may already be over */ }
};
const sameDocs = () => S.runId && S.lastSig === signature() ? {run_id: S.runId} : {};

async function doAnalysis() {
  try {
    const r = await runJob('analyze');
    if (!r) return;
    S.result = r; S.runId = r.run_id; S.lastSig = signature();
    S.docFilter = null; S.showAll = false; S.hero = null; S.heroTop = null;
    updateThrNote(); render(); $('#main').scrollIntoView({behavior: 'smooth', block: 'start'});
    loadHero();
  } catch (e) { showAlert(e.message); }
}
async function doScaling() {
  try {
    const r = await runJob('scaling', Object.assign({max_docs: +(S.scaleMax || 0)}, sameDocs(), {threads: maxThreads()}));
    if (!r) return;
    S.scaling = r; S.runId = r.run_id; S.lastSig = signature();
    render(); $('#scaling')?.scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (e) { showAlert(e.message); }
}
$('#runBtn').onclick = doAnalysis;
$('#scaleBtn').onclick = doScaling;

/* ============================================================ rendering == */
const liveTh = r => r.complete_matrix ? S.threshold : r.options.threshold;
const sortedPairs = r => [...r.pairs].sort((a, b) => b.sim - a.sim || a.a.localeCompare(b.a));
function flaggedPairs(r) { const t = liveTh(r); return sortedPairs(r).filter(p => p.sim >= t - 1e-9); }
function flaggedCount(r) { return r.complete_matrix ? flaggedPairs(r).length : (r.sequential.similar ?? 0); }

function render() {
  const r = S.result;
  let h = '';
  if (!r && !S.scaling) h += introHtml();
  if (r) h += verdictHtml(r) + heroHtml(r) + kpiHtml(r) + distHtml(r) + pairsHtml(r) + matrixHtml(r) + speedHtml(r);
  if (r || S.scaling) h += scalingHtml();
  h += outputHtml();
  $('#content').innerHTML = h;
  if (r) paintHero();
  setBusy(!!S.job);
}

/* ------------------------------------------------------------ empty state */
function introHtml() {
  const hasDs = !!S.info?.dataset;
  return `<section class="panel intro">
    <h2>Compare documents for copied passages</h2>
    <p>DocSim cuts every document into overlapping three-word phrases and scores each pair by the share of phrases they have in common. Every pair is compared by a sequential program and by an OpenMP version, so you can see both what was copied and how much parallelism helped.</p>
    <div class="demo" aria-label="Example of a shared phrase">
      <div><small>Document A</small>Climate change is <mark>one of the most pressing challenges</mark> facing coastal cities today.</div>
      <div><small>Document B</small>Many researchers argue it is <mark>one of the most pressing challenges</mark> for harbour towns.</div>
    </div>
    <div class="quick">
      <button class="btn primary" type="button" data-act="quick-tests" ${S.info?.tests ? '' : 'disabled'}>Try the sample files</button>
      <button class="btn" type="button" data-act="quick-ds" ${hasDs ? '' : 'disabled'}>Try 200 PAN11 documents</button>
    </div>
    <p class="note" style="margin:16px 0 0">Or add your own text files on the left and choose Run analysis.</p>
  </section>`;
}

/* --------------------------------------------------------------- verdict */
function verdictHtml(r) {
  const c = r.correctness, rows = r.openmp, allSame = rows.every(o => o.correct);
  const ths = rows.map(o => o.threads).join(', ');
  let state, pill, msg;
  if (c.ran) {
    state = c.passed && allSame ? 'pass' : 'fail';
    pill = state === 'pass' ? 'Passed' : 'Failed';
    msg = state === 'pass'
      ? `OpenMP output matches the sequential output for ${ths} thread${rows.length > 1 || rows[0].threads !== 1 ? 's' : ''}, and the program's own check agreed on all ${r.meta.pairs.toLocaleString()} pairs.`
      : 'OpenMP and sequential results differ. See the checks below.';
  } else if (allSame) {
    state = 'pass'; pill = 'Matches';
    msg = `OpenMP found the same pairs as the sequential run for ${ths} thread${rows.length > 1 ? 's' : ''}. The full check was ${c.note ? 'skipped (' + esc(c.note) + ')' : 'switched off'}.`;
  } else {
    state = 'fail'; pill = 'Failed';
    msg = `Different pairs were found with ${rows.filter(o => !o.correct).map(o => o.threads).join(', ')} thread(s).`;
  }
  const lines = c.checks.length ? `<details><summary>Show the ${c.checks.length} checks</summary><div class="lines">${c.checks.map(x =>
    `<div><b style="color:var(--${x.ok ? 'ok' : 'bad'})">${x.ok ? 'PASS' : 'FAIL'}</b><span>${esc(x.text)}</span></div>`).join('')}</div></details>` : '';
  return `<section class="panel verdict" id="verdict"><h2>Correctness</h2><span class="pill ${state}">${pill}</span><div class="msg">${msg}</div>${lines}</section>`;
}

/* ------------------------------------------------------- closest match hero */
function heroHtml(r) {
  const top = sortedPairs(r)[0];
  if (!top) return `<section class="panel hero none"><div><h2>No pairs to show</h2><p class="cap">The program did not report any pair of documents.</p></div></section>`;
  S.heroTop = top;
  const th = liveTh(r);
  if (top.sim < th - 1e-9) {
    return `<section class="panel hero none"><div><h2>No copied passages at ${th.toFixed(2)} or above</h2>
      <p class="cap">The closest pair scores ${pct(top.sim)}. Lower the threshold to list weaker matches.</p>
      <div class="go"><button class="btn small" type="button" data-pair data-a="${esc(top.a)}" data-b="${esc(top.b)}" data-s="${top.sim}">Compare the closest pair</button></div></div></section>`;
  }
  const band = bandOf(top.sim);
  return `<section class="panel hero" id="hero">
    <div><div class="big num"><span>${pct(top.sim)}</span></div><p class="cap">similarity in the closest pair</p>
      <div class="go"><span class="tag ${band.key}">${band.label}</span>
      <button class="btn small" type="button" data-pair data-a="${esc(top.a)}" data-b="${esc(top.b)}" data-s="${top.sim}">Compare the texts</button></div></div>
    <div class="names" id="heroStrips"><div class="note"><span class="spin"></span>Finding the shared passages…</div></div>
  </section>`;
}
async function fetchDoc(rid, name) {
  const mb = S.result?.options?.max_bytes || 0;
  return api(`/api/doc?run=${encodeURIComponent(rid)}&name=${encodeURIComponent(name)}${mb ? '&bytes=' + mb : ''}`);
}
async function loadHero() {
  const r = S.result, top = S.heroTop;
  if (!r || !top || top.sim < liveTh(r) - 1e-9) return;
  const key = r.run_id + '|' + top.a + '|' + top.b;
  if (S.hero?.key === key) return paintHero();
  try {
    const [A, B] = await Promise.all([fetchDoc(r.run_id, top.a), fetchDoc(r.run_id, top.b)]);
    S.hero = Object.assign({key, top}, analyzePair(A, B, r.options.k));
  } catch (e) { S.hero = {key, error: e.message}; }
  if (S.result === r) paintHero();
}
function paintHero() {
  const el = $('#heroStrips'), h = S.hero;
  if (!el || !h) return;
  if (h.error) { el.innerHTML = `<div class="note">Could not load the texts for this pair: ${esc(h.error)}</div>`; return; }
  el.innerHTML = ['a', 'b'].map(side => `<div class="strip-row"><div class="nm" title="${esc(h[side].name)}">${esc(h[side].name)}</div>
    <div class="strip">${overlapStrip(h[side].ranges, side, 'Shared passages in ' + h[side].name)}</div></div>`).join('') +
    `<div class="note">Yellow marks where the two texts share phrases. ${h.a.shared.toLocaleString()} of ${h.a.total.toLocaleString()} words in the first document, ${h.b.shared.toLocaleString()} of ${h.b.total.toLocaleString()} in the second. Click a mark to jump to it.</div>`;
}

/* -------------------------------------------------------------------- KPIs */
function kpiHtml(r) {
  const best = r.openmp.reduce((m, o) => (o.speedup != null && (!m || o.speedup > m.speedup)) ? o : m, null);
  const load = (r.meta.read_s || 0) + (r.meta.preprocess_s || 0);
  const th = liveTh(r);
  return `<section class="panel kpis" aria-label="Summary">
    <div class="kpi"><b>${fmtN(r.meta.documents)}</b><span>documents</span></div>
    <div class="kpi"><b>${fmtN(r.meta.pairs)}</b><span>pairs compared</span></div>
    <div class="kpi flag"><b>${fmtN(flaggedCount(r))}</b><span>pairs at ${th.toFixed(2)} or above</span></div>
    <div class="kpi"><b>${fmtN(r.meta.avg_shingles)}</b><span>distinct phrases per document</span></div>
    <div class="kpi"><b>${fmtT(load)}</b><span>to read and split the texts</span></div>
    <div class="kpi"><b>${best ? fmtX(best.speedup) : '—'}</b><span>${best ? `best speed-up, ${plural(best.threads, 'thread')}` : 'best speed-up'}</span></div>
  </section>`;
}

/* ------------------------------------------------------------ distribution */
function distHtml(r) {
  const d = r.distribution;
  if (!d || d.mode === 'none') return '';
  const ge = t => d.ge[String(t)] ?? 0;
  const total = d.total || 1;
  const high = ge(0.8), mod = Math.max(0, ge(0.4) - ge(0.8)), low = Math.max(0, total - ge(0.4));
  const seg = (n, key, label) => {
    const w = n ? Math.max(0.7, n / total * 100) : 0;
    return n ? `<div style="width:${w}%;background:var(--${key})" data-tip="${esc(label + '\n' + fmtN(n) + ' pairs')}">${w > 12 ? esc(label) : ''}</div>` : '';
  };
  const share = n => { const p = n / total * 100; return p === 0 ? '0%' : p < 0.1 ? '<0.1%' : p.toFixed(1) + '%'; };
  const mx = Math.max(...d.buckets.map(b => b.count));
  const nz = d.buckets.filter(b => b.count > 0).map(b => b.count);
  const auto = mx >= 100 && Math.min(...nz) <= mx / 50;
  const log = S.histLog == null ? auto : S.histLog;
  const bars = d.buckets.map((b, i) => {
    const last = i === d.buckets.length - 1, band = bandOf(b.lo);
    return {label: `${fmtEdge(b.lo)}–${fmtEdge(b.hi)}`, value: b.count, color: band.color,
      tip: `Similarity ${fmtEdge(b.lo)} to ${last ? fmtEdge(b.hi) : 'under ' + fmtEdge(b.hi)}\n${fmtN(b.count)} pairs (${share(b.count)})`};
  });
  const how = d.mode === 'exact' ? 'Every pair is shown exactly.' : 'Counted by running the program at several thresholds, because it only prints 200 pairs.';
  return `<section class="panel" id="distribution">
    <div class="phead"><div><h2>How similar are the pairs?</h2>
      <p class="sub">Most pairs of unrelated documents share almost no phrases, so the interesting pairs sit in the tail. ${how}</p></div></div>
    <div class="band-bar" role="img" aria-label="Pairs by similarity band">${seg(high, 'high', 'High')}${seg(mod, 'mod', 'Moderate')}${seg(low, 'low', 'Low')}</div>
    <div class="legend">
      <span><i style="background:var(--high)"></i>High, 0.80 or above <b class="num">${fmtN(high)}</b> (${share(high)})</span>
      <span><i style="background:var(--mod)"></i>Moderate, 0.40 to 0.80 <b class="num">${fmtN(mod)}</b> (${share(mod)})</span>
      <span><i style="background:var(--low)"></i>Low, under 0.40 <b class="num">${fmtN(low)}</b> (${share(low)})</span>
      ${d.identical != null ? `<span>Identical pairs <b class="num">${fmtN(d.identical)}</b></span>` : ''}
    </div>
    <div class="charthead"><h3>Pairs by similarity score</h3>
      <div class="seg" role="group" aria-label="Vertical scale">
        <button type="button" data-act="hist-lin" aria-pressed="${!log}">Linear</button>
        <button type="button" data-act="hist-log" aria-pressed="${log}">Log</button></div></div>
    <div class="chart">${barChart({bars, log, label: 'Number of document pairs in each similarity range', xTitle: 'similarity score (0 = nothing shared, 1 = identical)', yFmt: fmtTick})}</div>
    ${log ? '<p class="footnote">The log scale keeps the small bars visible next to the very large first one.</p>' : ''}
  </section>`;
}

/* ------------------------------------------------------------------ pairs */
function pairsHtml(r) {
  const th = liveTh(r);
  const all = flaggedPairs(r);
  let shown = all;
  if (S.docFilter) shown = all.filter(p => p.a === S.docFilter || p.b === S.docFilter);
  const cap = S.showAll ? 300 : 8;
  const rows = shown.slice(0, cap);

  let notice = '';
  if (!r.complete_matrix) {
    if (r.pairs_threshold > r.options.threshold + 1e-9) {
      notice = `<div class="hint">The program lists at most 200 pairs. ${fmtN(r.sequential.similar)} pairs reached ${r.options.threshold.toFixed(2)}, so this list starts at ${fmtEdge(r.pairs_threshold)} and holds ${fmtN(r.pairs_total_at_threshold)} pairs. Raise the threshold to narrow things down.</div>`;
    } else if (!r.pairs_complete) {
      notice = `<div class="hint">The program lists at most 200 pairs. This shows the first ${fmtN(r.pairs.length)} of ${fmtN(r.pairs_total_at_threshold)} in file order. Raise the threshold to narrow things down.</div>`;
    }
  }
  if (!all.length) {
    return `<section class="panel" id="pairs"><div class="phead"><div><h2>Most similar pairs</h2></div></div>
      ${notice}<div class="placeholder">No pairs reached ${th.toFixed(2)}. Lower the threshold to see weaker matches.</div></section>`;
  }
  const stat = new Map();
  all.forEach(p => [p.a, p.b].forEach(n => { const s = stat.get(n) || {n, c: 0, m: 0}; s.c++; s.m = Math.max(s.m, p.sim); stat.set(n, s); }));
  const docs = [...stat.values()].sort((a, b) => b.c - a.c || b.m - a.m).slice(0, 8);
  const maxC = Math.max(...docs.map(d => d.c));

  const left = rows.map(p => {
    const b = bandOf(p.sim);
    return `<button class="prow" type="button" data-pair data-a="${esc(p.a)}" data-b="${esc(p.b)}" data-s="${p.sim}">
      <span class="pc" style="color:${b.color}">${pct(p.sim)}</span>
      <span class="nm"><div>${esc(p.a)}</div><div>${esc(p.b)}</div><div class="meter"><i style="width:${p.sim * 100}%;background:${b.color}"></i></div></span>
      <span class="tag ${b.key}">${b.label}</span></button>`;
  }).join('') || '<div class="note" style="padding:12px 6px">No flagged pairs involve this document.</div>';

  const right = docs.map(d => `<button class="drow ${S.docFilter === d.n ? 'on' : ''}" type="button" data-doc="${esc(d.n)}" aria-pressed="${S.docFilter === d.n}">
      <span class="nm" title="${esc(d.n)}">${esc(d.n)}</span><span class="ct">${plural(d.c, 'pair')}, up to ${pct(d.m)}</span>
      <span class="meter"><i style="width:${d.c / maxC * 100}%;background:var(--mod)"></i></span></button>`).join('');

  return `<section class="panel" id="pairs">
    <div class="phead"><div><h2>Most similar pairs</h2>
      <p class="sub">Pairs scoring ${th.toFixed(2)} or above, highest first. Click a pair to read both texts side by side.</p></div>
      ${S.docFilter ? `<span class="filterchip">${esc(S.docFilter)}<button type="button" data-act="clear-doc" aria-label="Clear filter">×</button></span>` : ''}
      <button class="btn small" type="button" data-act="csv">Download CSV</button></div>
    ${notice}
    <div class="twocol">
      <div><div class="rank">${left}</div>
        ${shown.length > 8 ? `<button class="btn small morebtn" type="button" data-act="toggle-all">${S.showAll ? 'Show fewer' : `Show all ${fmtN(Math.min(shown.length, 300))} pairs`}</button>` : ''}</div>
      <div><h3 style="font:600 15px var(--display);margin:0 0 4px">Documents in the most flagged pairs</h3>
        <p class="note" style="margin:0 0 8px">Click a document to see only its pairs.</p><div class="rank">${right}</div></div>
    </div>
  </section>`;
}

/* ----------------------------------------------------------------- matrix */
function matrixDocs(r) { return [...new Set(r.pairs.flatMap(p => [p.a, p.b]))].sort((a, b) => a.localeCompare(b)); }
function matrixHtml(r) {
  const docs = matrixDocs(r);
  if (docs.length < 2 || docs.length > 40) return '';
  const m = new Map(); r.pairs.forEach(p => { m.set(p.a + '\u0000' + p.b, p.sim); m.set(p.b + '\u0000' + p.a, p.sim); });
  const th = liveTh(r);
  const short = (d, n) => esc(d.length > n ? d.slice(0, n - 1) + '…' : d);
  let t = `<table><thead><tr><th></th>${docs.map(d => `<th title="${esc(d)}">${short(d, 22)}</th>`).join('')}</tr></thead><tbody>`;
  docs.forEach(a => {
    t += `<tr><th title="${esc(a)}">${short(a, 26)}</th>`;
    docs.forEach(b => {
      if (a === b) { t += '<td class="self"></td>'; return; }
      const s = m.get(a + '\u0000' + b);
      t += s == null ? '<td></td>' : `<td class="${s >= th - 1e-9 ? 'flag' : ''}" data-pair data-a="${esc(a)}" data-b="${esc(b)}" data-s="${s}" style="background:${heat(s)}" data-tip="${esc(a + '\n' + b + '\n' + pct(s))}">${(s * 100).toFixed(0)}</td>`;
    });
    t += '</tr>';
  });
  return `<section class="panel" id="matrix"><div class="phead"><div><h2>Pair matrix</h2>
    <p class="sub">${r.complete_matrix ? 'Every pair of documents, with the score as a percentage. Yellow outlines are at or above the threshold.' : `Only the documents in the listed pairs. Blank cells are below ${fmtEdge(r.pairs_threshold)}.`}</p></div></div>
    <div class="matrix">${t}</tbody></table></div>
    <div class="scale"><span>0%</span><i></i><span>100%</span></div></section>`;
}

/* ------------------------------------------------------------------ speed */
function speedHtml(r) {
  const seq = r.sequential, rows = r.openmp;
  const reps = r.options.reps;
  const warn = [];
  if (seq.mean != null && seq.mean < 0.002) warn.push(`The comparison only takes ${fmtT(seq.mean)} on this input, which is too quick to time reliably. Use more documents (for example 200 or more from PAN11) for meaningful speed-ups.`);
  if (r.meta.cpu_count < 2) warn.push('This machine reports only one logical CPU, so OpenMP cannot be faster than the sequential version here.');
  const tbl = `<table class="tbl"><thead><tr><th>Version</th><th>Time (mean)</th><th>Std dev</th><th>Speed-up</th><th>Efficiency</th><th>Same output</th></tr></thead><tbody>
    <tr class="ref"><td>Sequential</td><td>${fmtT(seq.mean)}</td><td>${fmtT(seq.stdev)}</td><td>1.00×</td><td>—</td><td>reference</td></tr>
    ${rows.map(o => `<tr><td>OpenMP, ${plural(o.threads, 'thread')}</td><td>${fmtT(o.mean)}</td><td>${fmtT(o.stdev)}</td>
      <td>${fmtX(o.speedup)}</td>
      <td>${o.efficiency != null ? `<span class="eff">${(o.efficiency * 100).toFixed(1)}%<i><b style="width:${Math.min(100, o.efficiency * 100)}%"></b></i></span>` : '—'}</td>
      <td class="${o.correct ? 'ok' : 'bad'}">${o.correct ? 'yes' : 'no'}</td></tr>`).join('')}</tbody></table>`;

  const ths = rows.map(o => o.threads), tMax = Math.max(...ths);
  const timeChart = lineChart({
    label: 'Compare time against thread count', xTitle: 'threads', xTicks: ths, xFmt: v => String(v), yFmt: fmtT, left: 66, yMin: 0,
    series: [{name: 'OpenMP', color: 'var(--omp)', pts: rows.filter(o => o.mean != null).map(o => [o.threads, o.mean]),
      tip: (x, y) => `OpenMP, ${plural(x, 'thread')}\n${fmtT(y)}`}],
    hlines: seq.mean != null ? [{y: seq.mean, label: 'sequential', color: 'var(--seq)'}] : [],
  });
  const spPts = rows.filter(o => o.speedup != null).map(o => [o.threads, o.speedup]);
  const speedChart = lineChart({
    label: 'Speed-up against thread count', xTitle: 'threads', xTicks: ths, xFmt: v => String(v), yFmt: v => (+v.toFixed(1)) + '×', yMin: 0,
    yMax: Math.max(tMax, ...spPts.map(p => p[1]), 1) * 1.05,
    series: [
      {name: 'Ideal', color: 'var(--seq)', dash: '6 5', dots: false, pts: [[Math.min(...ths), Math.min(...ths)], [tMax, tMax]]},
      {name: 'Measured', color: 'var(--omp)', pts: spPts, tip: (x, y) => `${plural(x, 'thread')}\n${fmtX(y)} faster than sequential`},
    ],
  });
  return `<section class="panel" id="speed">
    <div class="phead"><div><h2>Sequential versus OpenMP</h2>
      <p class="sub">Time to compare every pair of documents, as the mean of ${plural(reps, 'run')}. Reading and splitting the texts is not included.</p></div></div>
    ${warn.map(w => `<div class="hint">${esc(w)}</div>`).join('')}
    <div class="tblwrap">${tbl}</div>
    <div class="cgrid" style="margin-top:24px">
      <div><h3>Time against threads</h3><p class="sub">Lower is better. The dashed line is the sequential time.</p>
        <div class="chart">${timeChart}</div></div>
      <div><h3>Speed-up against threads</h3><p class="sub">Measured speed-up next to the ideal of one extra core per thread.</p>
        <div class="key"><span><i style="background:var(--omp)"></i>Measured</span><span><i class="dash" style="color:var(--seq)"></i>Ideal</span></div>
        <div class="chart">${speedChart}</div></div>
    </div>
    <p class="footnote">Speed-up is the sequential time divided by the OpenMP time. Efficiency is the speed-up divided by the thread count. This machine reports ${plural(r.meta.cpu_count, 'logical CPU')}; more threads than that cannot help. Reading the files took ${fmtT(r.meta.read_s)} and splitting them into phrases took ${fmtT(r.meta.preprocess_s)}.</p>
  </section>`;
}

/* ---------------------------------------------------------------- scaling */
function scalingHtml() {
  const sc = S.scaling;
  const tot = S.info?.dataset?.files;
  const head = `<div class="phead"><div><h2>Scaling with corpus size</h2>
      <p class="sub">How the time grows as more documents are compared. The number of pairs grows with the square of the document count, so doubling the documents roughly quadruples the work.</p></div>
      <div class="studybar">${S.src === 'dataset' ? `<label>Largest corpus (documents)<input type="number" id="scaleMax" min="0" value="${esc(S.scaleMax)}" placeholder="${tot ? 'all ' + tot.toLocaleString() : 'all'}"></label>` : ''}
        <button class="btn" id="scaleGo" type="button" data-act="scale-go" ${S.job ? 'disabled' : ''}>Run scaling study</button></div></div>`;
  if (!sc) return `<section class="panel" id="scaling">${head}<div class="placeholder">Run the study to compare sequential and OpenMP across growing numbers of documents.</div></section>`;
  const rows = sc.rows;
  const pts = k => rows.filter(r => r[k] != null && r[k] > 0).map(r => [r.pairs, r[k]]);
  const timeChart = lineChart({
    label: 'Compare time against number of pairs', xScale: 'log', yScale: 'log', xTitle: 'pairs compared', xFmt: fmtTick, yFmt: fmtT, left: 70,
    xTicks: rows.length > 5 ? rows.filter((_, i) => i % 2 === (rows.length - 1) % 2).map(r => r.pairs) : rows.map(r => r.pairs),
    series: [
      {name: 'Sequential', color: 'var(--seq)', pts: pts('seq'), tip: (x, y) => `Sequential\n${fmtN(x)} pairs: ${fmtT(y)}`},
      {name: `OpenMP, ${sc.threads} threads`, color: 'var(--omp)', pts: pts('omp'), tip: (x, y) => `OpenMP, ${sc.threads} threads\n${fmtN(x)} pairs: ${fmtT(y)}`},
    ]});
  const spChart = lineChart({
    label: 'Speed-up against number of documents', xScale: 'log', xTitle: 'documents', xFmt: fmtTick, yFmt: v => (+v.toFixed(1)) + '×', yMin: 0,
    yMax: Math.max(sc.threads, ...rows.map(r => r.speedup || 0), 1) * 1.05,
    xTicks: rows.length > 5 ? rows.filter((_, i) => i % 2 === (rows.length - 1) % 2).map(r => r.docs) : rows.map(r => r.docs),
    series: [{name: 'Speed-up', color: 'var(--omp)', pts: rows.filter(r => r.speedup != null).map(r => [r.docs, r.speedup]),
      tip: (x, y) => `${fmtN(x)} documents\n${fmtX(y)}`}],
    hlines: [{y: 1, label: '1× (same speed)', color: 'var(--seq)'}, ...(sc.threads > 1 ? [{y: sc.threads, label: `ideal for ${sc.threads} threads`, color: 'var(--faint)', dash: '3 5'}] : [])],
  });
  const tbl = `<table class="tbl"><thead><tr><th>Documents</th><th>Pairs</th><th>Sequential</th><th>OpenMP, ${plural(sc.threads, 'thread')}</th><th>Speed-up</th><th>Pairs ≥ ${sc.threshold.toFixed(2)}</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${fmtN(r.docs)}</td><td>${fmtN(r.pairs)}</td><td>${fmtT(r.seq)}</td><td>${fmtT(r.omp)}</td><td>${fmtX(r.speedup)}</td><td class="${r.same_count ? '' : 'bad'}">${fmtN(r.similar)}${r.same_count ? '' : ' (differs)'}</td></tr>`).join('')}</tbody></table>`;
  const small = rows.length && rows[rows.length - 1].seq < 0.002;
  return `<section class="panel" id="scaling">${head}
    ${small ? '<div class="hint">Even the largest corpus runs in a couple of milliseconds, which is too quick for reliable timings. Try more documents.</div>' : ''}
    <div class="cgrid">
      <div><h3>Time against pairs</h3><p class="sub">Both axes are logarithmic, so a straight line means steady growth.</p>
        <div class="key"><span><i style="background:var(--seq)"></i>Sequential</span><span><i style="background:var(--omp)"></i>OpenMP</span></div>
        <div class="chart">${timeChart}</div></div>
      <div><h3>Speed-up against documents</h3><p class="sub">Small inputs cannot hide the cost of starting threads, so speed-up usually improves as the corpus grows.</p>
        <div class="chart">${spChart}</div></div>
    </div>
    <div class="tblwrap" style="margin-top:20px">${tbl}</div></section>`;
}

/* ------------------------------------------------------------ raw output */
function outputHtml() {
  const logs = [].concat(S.result?.console || [], S.scaling?.console || []);
  if (!logs.length) return '';
  return `<section class="panel" id="output"><div class="phead"><div><h2>Program output</h2>
    <p class="sub">The exact command and text printed by the C program for each run behind these charts.</p></div>
    ${S.result ? '<button class="btn small" type="button" data-act="json">Download results (JSON)</button>' : ''}</div>
    ${logs.map(l => `<details class="log"><summary><b>${esc(l.label)}</b><span>${fmtT(l.seconds)} wall time</span></summary><pre><span class="cmd">$ ${esc(l.command)}</span>\n\n${esc(l.output)}</pre></details>`).join('')}
  </section>`;
}

/* ======================================== comparing two texts (the drawer) == */
function tokenize(text) {
  const out = [], re = /[A-Za-z0-9]+/g; let m;
  while ((m = re.exec(text))) out.push({w: m[0].toLowerCase().slice(0, 255), s: m.index, e: m.index + m[0].length});
  return out;
}
function phraseSet(tok, k) {
  const set = new Set();
  for (let i = 0; i + k <= tok.length; i++) { let key = tok[i].w; for (let j = 1; j < k; j++) key += ' ' + tok[i + j].w; set.add(key); }
  return set;
}
function sharedRanges(text, tok, other, k) {
  const cover = new Uint8Array(tok.length);
  for (let i = 0; i + k <= tok.length; i++) {
    let key = tok[i].w; for (let j = 1; j < k; j++) key += ' ' + tok[i + j].w;
    if (other.has(key)) for (let j = i; j < i + k; j++) cover[j] = 1;
  }
  const ranges = []; let shared = 0;
  for (let i = 0; i < tok.length;) {
    if (!cover[i]) { i++; continue; }
    let j = i; while (j + 1 < tok.length && cover[j + 1]) j++;
    ranges.push({s: tok[i].s, e: tok[j].e, from: tok[i].s / Math.max(1, text.length), to: tok[j].e / Math.max(1, text.length), words: j - i + 1});
    shared += j - i + 1; i = j + 1;
  }
  return {ranges, shared, total: tok.length};
}
function markedHtml(text, ranges, side) {
  let out = '', pos = 0;
  ranges.forEach((r, i) => { out += esc(text.slice(pos, r.s)) + `<mark id="m-${side}-${i}">` + esc(text.slice(r.s, r.e)) + '</mark>'; pos = r.e; });
  return out + esc(text.slice(pos));
}
function analyzePair(A, B, k) {
  k = Math.min(8, Math.max(1, k || 3));
  const ta = tokenize(A.text), tb = tokenize(B.text);
  const ra = sharedRanges(A.text, ta, phraseSet(tb, k), k), rb = sharedRanges(B.text, tb, phraseSet(ta, k), k);
  return {
    a: Object.assign({name: A.name, text: A.text, truncated: A.truncated}, ra, {html: markedHtml(A.text, ra.ranges, 'a')}),
    b: Object.assign({name: B.name, text: B.text, truncated: B.truncated}, rb, {html: markedHtml(B.text, rb.ranges, 'b')}),
    k,
  };
}

let lastFocus = null;
async function openCompare(p, opts) {
  const r = S.result; if (!r) return;
  lastFocus = document.activeElement;
  const b = bandOf(p.sim);
  $('#dScore').innerHTML = `<span>${pct(p.sim)}</span>`;
  $('#dMeta').innerHTML = `<span class="tag ${b.key}">${b.label} similarity</span><div style="margin-top:6px">${esc(p.a)} and ${esc(p.b)}</div>`;
  $('#dBody').innerHTML = `<div class="note"><span class="spin"></span>Loading the documents…</div>`;
  $('#drawer').classList.add('open'); $('#scrim').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false');
  $('#dClose').focus();
  try {
    const [A, B] = await Promise.all([fetchDoc(r.run_id, p.a), fetchDoc(r.run_id, p.b)]);
    const x = analyzePair(A, B, r.options.k);
    $('#dBody').innerHTML = `
      <div class="keyline"><span><mark>shared phrase</mark> of ${x.k} or more words</span>
        <span class="num">${x.a.shared.toLocaleString()} of ${x.a.total.toLocaleString()} words in the first document</span>
        <span class="num">${x.b.shared.toLocaleString()} of ${x.b.total.toLocaleString()} in the second</span></div>
      ${(A.truncated || B.truncated) ? `<div class="hint">One of these texts is long, so only its first ${(120000).toLocaleString()} characters are shown. The score above covers the whole file.</div>` : ''}
      ${['a', 'b'].map(side => `<div class="strip-row"><div class="nm" title="${esc(x[side].name)}">${esc(x[side].name)}</div><div class="strip">${overlapStrip(x[side].ranges, side, 'Shared passages in ' + x[side].name)}</div></div>`).join('')}
      <div class="cols">
        <div class="doc"><h3>${esc(x.a.name)}</h3><pre id="docA">${x.a.html}</pre></div>
        <div class="doc"><h3>${esc(x.b.name)}</h3><pre id="docB">${x.b.html}</pre></div>
      </div>`;
    if (opts?.jump) jumpTo(opts.jump.side, opts.jump.i);
  } catch (e) { $('#dBody').innerHTML = `<div class="alert">${esc(e.message)}</div>`; }
}
function jumpTo(side, i) {
  $$('#dBody mark.cur').forEach(m => m.classList.remove('cur'));
  const el = document.getElementById(`m-${side}-${i}`);
  if (!el) return;
  el.classList.add('cur');
  el.scrollIntoView({block: 'center', behavior: 'smooth'});
}
function closeCompare() {
  $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true');
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
$('#dClose').onclick = closeCompare;
$('#scrim').onclick = closeCompare;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#drawer').classList.contains('open')) closeCompare(); });
$('#dBody').addEventListener('click', e => {
  const s = e.target.closest('rect[data-strip]'); if (s) jumpTo(s.dataset.strip, +s.dataset.i);
});

/* ============================================================== actions == */
$('#content').addEventListener('click', e => {
  const t = e.target;
  let el = t.closest('rect[data-strip]');
  if (el && S.hero && !S.hero.error) { openCompare(S.hero.top, {jump: {side: el.dataset.strip, i: +el.dataset.i}}); return; }
  el = t.closest('[data-pair]');
  if (el) { openCompare({a: el.dataset.a, b: el.dataset.b, sim: +el.dataset.s}); return; }
  el = t.closest('[data-doc]');
  if (el) { S.docFilter = S.docFilter === el.dataset.doc ? null : el.dataset.doc; S.showAll = false; render(); return; }
  el = t.closest('[data-act]');
  if (!el) return;
  switch (el.dataset.act) {
    case 'dismiss': showAlert(''); break;
    case 'hist-lin': S.histLog = false; render(); break;
    case 'hist-log': S.histLog = true; render(); break;
    case 'clear-doc': S.docFilter = null; render(); break;
    case 'toggle-all': S.showAll = !S.showAll; render(); break;
    case 'scale-go': S.scaleMax = ($('#scaleMax')?.value || ''); doScaling(); break;
    case 'quick-tests': setSource('tests'); doAnalysis(); break;
    case 'quick-ds': setSource('dataset'); $('#nDocs').value = 200; updatePairCount(); doAnalysis(); break;
    case 'csv': {
      const rows = flaggedPairs(S.result).map(p => [p.sim.toFixed(6), p.a, p.b].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      download('similar_pairs.csv', 'similarity,document_a,document_b\n' + rows.join('\n') + '\n', 'text/csv'); break;
    }
    case 'json': download('docsim_results.json', JSON.stringify(S.result, null, 2), 'application/json'); break;
  }
});
$('#alertBox').addEventListener('click', e => { if (e.target.closest('[data-act=dismiss]')) showAlert(''); });
$('#scaleMax')?.addEventListener('input', e => { S.scaleMax = e.target.value; });
$('#content').addEventListener('input', e => { if (e.target.id === 'scaleMax') S.scaleMax = e.target.value; });

init();
