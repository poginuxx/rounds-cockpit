/**
 * main.js — the only file that touches the DOM.
 *
 * It contains NO crypto, parsing, or clinical logic. Everything consequential is
 * delegated to the tested modules in src/lib. This file just renders state into
 * the markup in index.html and routes user actions to those modules.
 *
 * Handlers are attached to `window` so the inline onclick="" in index.html keep
 * working. (A future refactor could switch to event delegation; not required.)
 */

import * as store from './lib/store.js';
import { deidentify } from './lib/deid.js';
import { parseUpdate } from './lib/parser.js';
import { commitPatient, buildDigest, buildTimeline, neuroStatus } from './lib/diff.js';
import { newPatient, seedPatients, HOSPITALS } from './lib/schema.js';

// ---- where your model API key would come from (kept null = offline parsing) ----
// To enable the cloud parser, store the key in the encrypted vault and return it
// here. Until then the app uses the on-device fallback parser. See README.
let API_KEY = null;
const getApiKey = async () => API_KEY;
window.setApiKey = (k) => { API_KEY = k; }; // for manual testing in the console

// ---- in-memory view state (decrypted records live here while unlocked) ----
const state = { patients: [], byId: {}, currentId: null, deid: null, review: [] };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const SAMPLE = `Ramon dela Cruz rm 408 — repeat Na came back 126, still severe headache, no new weakness. BP 150/88, HR 80.
Aurora Mendoza 412: moved bowels this morning, finally. BP 150/86, sleeping better.
Efren Villaraza rm 302 — single breath count down to 14, RR up to 26, sats 94%. Flagging for review.
Carmela Soriano 310 afebrile overnight, headache improving.`;

// ============================ lock / unlock ============================
let entered = '', isSetup = false;

async function bootLock() {
  isSetup = !(await store.isInitialized());
  $('lockTitle').textContent = isSetup ? 'Set a passcode' : 'Enter passcode';
  $('lockSub').innerHTML = isSetup
    ? 'This key encrypts every record on this phone.<br>Nothing is stored unlocked.'
    : 'Unlocks the encrypted records on this device.';
  buildKeys();
  renderPin();
}
function buildKeys() {
  const k = $('keys'); k.innerHTML = '';
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].forEach((d) => {
    const b = document.createElement('button');
    if (d === '⌫') { b.className = 'fn'; b.textContent = '⌫'; b.onclick = () => { entered = entered.slice(0, -1); renderPin(); }; }
    else if (d === '') { b.style.visibility = 'hidden'; }
    else { b.textContent = d; b.onclick = () => tap(d); }
    k.appendChild(b);
  });
}
function renderPin() {
  const w = $('pinDots'); w.className = 'pin'; w.innerHTML = '';
  for (let i = 0; i < 6; i++) { const d = document.createElement('div'); d.className = 'b' + (i < entered.length ? ' on' : ''); w.appendChild(d); }
}
function tap(d) { if (entered.length >= 6) return; entered += d; renderPin(); if (entered.length === 6) submitPin(); }
async function submitPin() {
  const code = entered;
  if (isSetup) { await store.setup(code, seedPatients()); entered = ''; await enterApp(); }
  else {
    const ok = await store.unlock(code);
    if (ok) { entered = ''; await enterApp(); }
    else { entered = ''; $('pinDots').className = 'pin err'; $('lockHint').textContent = 'Wrong passcode — try again'; setTimeout(() => { renderPin(); $('lockHint').textContent = ''; }, 500); }
  }
}
async function enterApp() {
  await loadPatients();
  show('today'); renderToday();
  if ($('rawText') && !$('rawText').value) $('rawText').value = SAMPLE;
}
function lockApp() { store.lock(); entered = ''; $('lockHint').textContent = ''; bootLock(); show('lock'); }

async function loadPatients() {
  state.patients = await store.allPatients();
  state.byId = Object.fromEntries(state.patients.map((p) => [p.id, p]));
}

// ============================ navigation ============================
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  document.querySelector('.tabbar').style.display = id === 'lock' ? 'none' : 'flex';
  $('addFab').style.display = id === 'today' ? 'flex' : 'none';
}
function goTab(id) {
  show(id);
  $('tab_today').classList.toggle('active', id === 'today');
  $('tab_intake').classList.toggle('active', id === 'intake');
  closeCard();
  if (id === 'today') renderToday();
}

// ============================ Today ============================
function renderToday() {
  const pts = state.patients;
  const reds = pts.filter((p) => p.triage === 'r').length;
  const ambers = pts.filter((p) => p.triage === 'a').length;
  const hosps = [...new Set(pts.map((p) => p.hospital))].length;
  $('todayDate').textContent = `TUE · 16 JUN · ${pts.length} PATIENTS`;

  const changed = buildDigest(pts);
  $('digest').innerHTML = changed.length
    ? `<b>${changed.length} changed overnight.</b> ` + changed.map((o) => `${esc(o.who)} — ${esc(o.txt)}<span class="k">${esc(o.k)}</span>${esc(o.tail)}.`).join(' ')
    : '<b>Quiet overnight.</b> No flagged changes.';

  $('routebar').innerHTML =
    `<div class="r"><div class="num">${hosps}</div><div class="lbl">hospitals</div></div>
     <div class="r"><div class="num">${reds}</div><div class="lbl">red</div></div>
     <div class="r"><div class="num">${ambers}</div><div class="lbl">amber</div></div>
     <div class="r"><div class="num">~${Math.round(pts.length * 9.6)}<span style="font-size:12px">m</span></div><div class="lbl">est. round</div></div>`;

  const byH = {}; pts.forEach((p) => { (byH[p.hospital] = byH[p.hospital] || []).push(p); });
  const list = $('list');
  if (!pts.length) { list.innerHTML = `<div class="empty"><div class="big">🗂️</div>No patients. Reset demo to reseed.</div>`; return; }
  let html = '';
  HOSPITALS.filter((h) => byH[h]).forEach((h, i) => {
    html += `<div class="group"><div class="group-h"><div class="name"><span class="pin-i">◉</span>${esc(h)}</div><div class="meta">STOP ${i + 1}</div></div>`;
    byH[h].sort((a, b) => (a.room || '').localeCompare(b.room || '')).forEach((p) => {
      const flags = (p.flags || []).map((f) => `<span class="flag ${f.lv}">${esc(f.t)}</span>`).join('');
      const extra = p.ready ? `<span class="chip teal">Ready for discharge</span>` : (p.newCount ? `<span class="newbadge">${p.newCount} NEW</span>` : '');
      html += `<div class="pcard ${p.triage}" onclick="openCard('${p.id}')">
        <div class="row1"><div><div class="nm">${esc(p.name)}</div>
          <div class="sub">${esc(p.age)}${esc(p.sex)} · ${esc(p.dx)} · Day ${esc(p.day)}</div></div>
          <div class="rm">RM ${esc(p.room)}</div></div>
        <div class="row2"><span class="dot ${p.triage}"></span>${flags}${extra}</div></div>`;
    });
    html += '</div>';
  });
  list.innerHTML = html;
}

// sparkline (presentation only)
function sparkline(series) {
  const w = 150, h = 34;
  const min = Math.min(...series, 128), max = Math.max(...series, 142), rng = (max - min) || 1;
  const x = (i) => 6 + i * ((w - 12) / (series.length - 1));
  const y = (v) => h - 4 - ((v - min) / rng) * (h - 10);
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const bandTop = y(Math.min(145, max)), bandBot = y(Math.max(135, min));
  const last = series[series.length - 1];
  const col = last < 135 || last > 145 ? '#CF463C' : '#0E7C6B';
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block">
    <rect x="0" y="${bandTop.toFixed(1)}" width="${w}" height="${(bandBot - bandTop).toFixed(1)}" fill="#E6F2EA"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${series.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === series.length - 1 ? 2.6 : 1.6}" fill="${i === series.length - 1 ? col : '#9AA4AD'}"/>`).join('')}</svg>`;
}

// ============================ Round Card ============================
function openCard(id) {
  const p = state.byId[id]; if (!p) return; state.currentId = id;
  $('rcName').textContent = p.name;
  $('rcDx').textContent = `${p.dx} · Day ${p.day}${p.detail ? ' · ' + p.detail : ''}`;
  $('rcLoc').textContent = `${p.hospital.toUpperCase()} · RM ${p.room}`;
  renderScores(p);
  $('rcAsk').innerHTML = p.ask.map((a, ai) => `
    <div class="askrow"><div class="q">${esc(a.q)}${a.s ? `<small>${esc(a.s)}</small>` : ''}</div>
      <div class="toggle">${a.t.map((opt, oi) => `<button class="${oi === a.on ? 'on ' + a.k : ''}" onclick="pick(${ai},${oi})">${esc(opt)}</button>`).join('')}</div></div>`).join('');
  const naLast = p.na[p.na.length - 1], naCls = naLast < 135 ? 'bad' : (naLast < 137 ? 'warn' : '');
  $('rcLabs').innerHTML = `
    <div class="labcell wide"><div class="lh"><span class="nm">Sodium · trend</span><span class="val ${naCls}">${naLast}<small> mmol/L</small></span></div>
      <div class="spark">${sparkline(p.na)}</div>
      <div class="sparkrow"><span class="seq">${esc(p.naLabel)}</span><span class="seq">band 135–145</span></div></div>
    <div class="labcell"><div class="lh"><span class="nm">Potassium</span></div><div class="val ${p.kbad ? 'bad' : ''}">${esc(p.k.v)}<small> mmol/L</small></div><div class="seq mono" style="font-size:10px;color:var(--faint);margin-top:4px">${esc(p.k.s)}</div></div>
    <div class="labcell"><div class="lh"><span class="nm">Serum osmo</span></div><div class="val ${p.osmo.v !== '—' && +p.osmo.v < 275 ? 'warn' : ''}">${esc(p.osmo.v)}</div><div class="seq mono" style="font-size:10px;color:var(--faint);margin-top:4px">${esc(p.osmo.s)}</div></div>`;
  $('rcVitals').innerHTML = p.vitals.map((v) => `<div class="vital"><div class="k">${esc(v[0])}</div><div class="v">${esc(v[1])}</div></div>`).join('');
  $('rcMeds').innerHTML = p.meds.map((m) => `<div class="med"><div class="mn">${esc(m.n)} <small>· ${esc(m.d)}</small></div><div class="day ${m.w ? 'warn' : ''}">${esc(m.day)}</div></div>`).join('');
  const dm = p.doMain;
  $('rcDo').innerHTML = `
    <button class="act primary" onclick="${dm.bill ? "toast('PhilHealth packet — builds in a later step','✓')" : "toast('Order placed · added to note','✓')"}">
      <span class="ai">${dm.bill ? '₱' : '✚'}</span><div class="at">${esc(dm.t)}</div><div class="sub">${esc(dm.s)}</div></button>
    <div class="act" onclick="toast('Dictation — wires in a later step')"><span class="ai">🎙</span><span class="at">Dictate exam</span></div>
    <div class="act" onclick="toast('Flagged for tomorrow','✓')"><span class="ai">⚑</span><span class="at">Flag follow-up</span></div>
    <div class="act" onclick="toast('Co-manage note sent','✓')"><span class="ai">↪</span><span class="at">Ping co-manager</span></div>
    <div class="act" onclick="toast('Progress note saved','✓')"><span class="ai">▤</span><span class="at">Save note</span></div>`;
  renderNeuro(p);
  $('scrim').classList.add('show'); $('sheet').classList.add('show');
}
function closeCard() { closeTimeline(); $('scrim').classList.remove('show'); $('sheet').classList.remove('show'); state.currentId = null; }

function renderScores(p) {
  $('rcScores').innerHTML = p.scores.map((s) => `
    <div class="score"><div class="lbl">${s.l}</div>
    <div class="v ${s.d ? 'delta-bad' : ''}">${s.v}${s.a ? `<span class="arr ${s.a}">${s.a === 'dn' ? '↓' : '↑'}</span>` : ''}</div></div>`).join('');
}

// ============================ Neuro modules ============================
// A reusable collapsed-by-default block (native <details>) that the later
// neuro modules — motor grid, seizure log, stroke clock — will reuse. The
// first module living inside it is the GCS / NIHSS trend ribbons.
const STATUS_COL = { good: 'var(--teal)', warn: 'var(--amber)', bad: 'var(--red)' };

function expandable(title, sub, bodyHtml, open = false) {
  return `<details class="nblock"${open ? ' open' : ''}>
    <summary><span class="ntag">${esc(title)}</span><span class="nsub">${esc(sub)}</span><span class="ncaret">▾</span></summary>
    <div class="nbody">${bodyHtml}</div></details>`;
}

/**
 * A neuro trend ribbon — same band+polyline+dots style as the sodium sparkline,
 * but coloured by DIRECTION via lib/diff.neuroStatus (falling GCS / rising NIHSS
 * are worsening). `cfg`: { lo, hi, band:[lo,hi], worseDir }.
 */
function ribbon(series, cfg) {
  const w = 150, h = 34;
  const min = Math.min(...series, cfg.band[0]), max = Math.max(...series, cfg.band[1]);
  const rng = (max - min) || 1;
  const x = (i) => 6 + i * ((w - 12) / (series.length - 1));
  const y = (v) => h - 4 - ((v - min) / rng) * (h - 10);
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const bandTop = y(Math.min(cfg.band[1], max)), bandBot = y(Math.max(cfg.band[0], min));
  const col = STATUS_COL[neuroStatus(series, cfg.worseDir)];
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block">
    <rect x="0" y="${bandTop.toFixed(1)}" width="${w}" height="${(bandBot - bandTop).toFixed(1)}" fill="var(--green-soft)"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${series.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === series.length - 1 ? 2.6 : 1.6}" fill="${i === series.length - 1 ? col : '#9AA4AD'}"/>`).join('')}</svg>`;
}

// Each ribbon-able neuro metric: where its data lives + which way is worsening.
const NEURO_METRICS = [
  { key: 'gcs', label: 'GCS', sub: 'normal band 13–15', band: [13, 15], lo: 3, hi: 15, worseDir: 'down' },
  { key: 'nihss', label: 'NIHSS', sub: 'normal band 0–4', band: [0, 4], lo: 0, hi: 42, worseDir: 'up' },
];

function neuroRibbonCell(m, series) {
  const status = neuroStatus(series, m.worseDir);
  const last = series[series.length - 1];
  const cls = status === 'bad' ? 'bad' : status === 'warn' ? 'warn' : '';
  const dir = status === 'good' ? 'stable / improving' : 'worsening';
  return `<div class="labcell wide">
    <div class="lh"><span class="nm">${esc(m.label)} · trend</span><span class="val ${cls}">${last}<small> ${esc(dir)}</small></span></div>
    <div class="spark">${ribbon(series, m)}</div>
    <div class="sparkrow"><span class="seq">${esc(m.sub)}</span><span class="seq">${esc(m.worseDir === 'down' ? '↓ worse' : '↑ worse')}</span></div>
    <div class="nstep"><button onclick="neuroStep('${m.label}',-1)">−</button>
      <span class="nstepv" id="nstep_${m.key}">${(p_score(state.byId[state.currentId], m.label) ?? last)}</span>
      <button onclick="neuroStep('${m.label}',1)">+</button>
      <span class="nstephint">today · captured at next commit</span></div></div>`;
}

// numeric current value of a score label, or null
function p_score(p, label) {
  const s = (p?.scores || []).find((x) => x.l === label);
  if (!s) return null;
  const m = String(s.v).match(/-?\d+(\.\d+)?/);
  return m ? +m[0] : null;
}

function renderNeuro(p) {
  const cells = NEURO_METRICS.map((m) => {
    const series = (p.snapshots || []).map((s) => s[m.key]).filter((v) => v != null);
    return series.length >= 2 ? neuroRibbonCell(m, series) : '';
  }).filter(Boolean).join('');
  // Render the Neuro section only when at least one ribbon has data.
  $('rcNeuro').innerHTML = cells
    ? expandable('Neuro', 'GCS / NIHSS trend ribbons', `<div class="labgrid">${cells}</div>`)
    : '';
}

async function neuroStep(label, d) {
  const p = state.byId[state.currentId]; if (!p) return;
  const sc = p.scores.find((s) => s.l === label); if (!sc) return;
  const m = NEURO_METRICS.find((x) => x.label === label); if (!m) return;
  const cur = p_score(p, label) ?? 0;
  const v = Math.max(m.lo, Math.min(m.hi, cur + d));
  if (v === cur) return;
  sc.v = String(v);
  await store.savePatient(p);          // encrypted vault — invariant #2
  renderScores(p);                     // current value updates now…
  renderNeuro(p);                      // …ribbon point only moves after next commit
}

// ============================ Patient timeline ============================
// Read-only admission history. All trajectory/diff logic lives in lib/diff.js;
// this only renders the rows it returns.
const naCls = (v) => (v == null ? '' : v < 135 ? 'bad' : v < 137 ? 'warn' : '');

function openTimeline() {
  const p = state.byId[state.currentId]; if (!p) return;
  $('tlName').textContent = p.name;
  $('tlDx').textContent = `${p.dx} · Day ${p.day}${p.detail ? ' · ' + p.detail : ''}`;
  $('tlLoc').textContent = `${p.hospital.toUpperCase()} · RM ${p.room}`;

  const rows = buildTimeline(p);                       // newest-first
  const naSeries = (p.snapshots || []).map((s) => s.na).filter((v) => v != null);
  const last = naSeries[naSeries.length - 1];
  const span = rows.length ? `${rows[rows.length - 1].snapshot.date} → ${rows[0].snapshot.date}` : '';
  $('tlTrend').innerHTML = `
    <div class="labcell wide">
      <div class="lh"><span class="nm">Sodium · admission trend</span>${last != null ? `<span class="val ${naCls(last)}">${last}<small> mmol/L</small></span>` : ''}</div>
      ${naSeries.length >= 2 ? `<div class="spark">${sparkline(naSeries)}</div>
      <div class="sparkrow"><span class="seq">${esc(span)}</span><span class="seq">band 135–145</span></div>` :
        `<div class="seq mono" style="font-size:11px;color:var(--faint);margin-top:6px">one reading so far — trajectory builds as you commit nightly updates</div>`}
    </div>`;

  $('tlList').innerHTML = rows.length
    ? rows.map((r, i) => timelineRow(r, i === 0)).join('')
    : `<div class="in-empty">No history yet for this patient.</div>`;

  $('scrim3').classList.add('show'); $('tlsheet').classList.add('show');
}
function closeTimeline() { $('scrim3').classList.remove('show'); $('tlsheet').classList.remove('show'); }

function timelineRow(r, isNewest) {
  const s = r.snapshot;
  const chips = [];
  if (s.na != null) chips.push(`<span class="vc ${naCls(s.na)}">Na ${s.na}</span>`);
  if (s.rr != null) chips.push(`<span class="vc ${s.rr >= 24 ? 'bad' : s.rr >= 22 ? 'warn' : ''}">RR ${s.rr}</span>`);
  if (s.spo2 != null) chips.push(`<span class="vc ${s.spo2 < 94 ? 'bad' : s.spo2 < 96 ? 'warn' : ''}">SpO₂ ${s.spo2}%</span>`);
  if (s.temp != null) chips.push(`<span class="vc ${s.temp >= 38 ? 'warn' : ''}">T ${s.temp}</span>`);

  let chg;
  if (r.baseline) chg = `<div class="tlchg base">admission baseline</div>`;
  else if (!r.changes.length) chg = `<div class="tlchg base">no change vs prior day</div>`;
  else chg = `<div class="tlchg">${r.changes.map(fmtChange).join(' · ')}</div>`;

  return `<div class="tlrow${isNewest ? ' new' : ''}"><div class="tldate">${esc(s.date)}</div>
    <div class="tlbody"><div class="tlchips">${chips.join('')}</div>${chg}</div></div>`;
}
function fmtChange(c) {
  const dir = c.delta < 0 ? 'dn' : 'up';
  const arr = c.delta < 0 ? '↓' : '↑';
  return `${esc(c.field)} ${c.from} → ${c.to} <span class="${dir}">(${arr}${Math.abs(c.delta)})</span>`;
}

async function pick(ai, oi) {
  const p = state.byId[state.currentId]; if (!p) return;
  p.ask[ai].on = oi;
  const rows = document.querySelectorAll('#rcAsk .askrow');
  const btns = rows[ai].querySelectorAll('.toggle button');
  btns.forEach((b) => (b.className = '')); btns[oi].className = 'on ' + p.ask[ai].k;
  await store.savePatient(p); // persist the answer, encrypted
}

// ============================ Intake ============================
function setSrc(s) {
  ['text', 'voice', 'photo'].forEach((x) => $('src_' + x).classList.toggle('on', x === s));
  if (s !== 'text') toast(s === 'voice' ? 'Dictation capture wires in a later step' : 'Photo OCR wires in a later step');
}
function runDeid() {
  const text = $('rawText').value.trim();
  if (!text) { toast('Paste an update first'); return; }
  const roster = state.patients.map((p) => ({ id: p.id, name: p.name }));
  state.deid = deidentify(text, roster);
  const payload = esc(state.deid.redacted).replace(/(\[PT\d+\]|\[ROOM\]|\[ID\])/g, '<span class="tok">$1</span>');
  const maprows = state.deid.removed.length
    ? state.deid.removed.map((r) => `<div class="maprow"><span class="tk">${r.tok}</span><span>${esc(r.name)}</span></div>`).join('')
    : '<div class="maprow"><span>no roster names matched</span></div>';
  $('deidWrap').innerHTML = `
   <div class="deid">
     <div class="dh"><span class="lk">🔒</span>What actually happens</div>
     <div class="leaves"><div class="lbl">↑ leaves this phone → cloud parser</div><div class="payload">${payload}</div></div>
     <div class="stays"><div class="lbl">⛒ stays on device · re-identify key</div>${maprows}</div>
     <div class="caveat">Removes names, rooms and long ID numbers. This reduces but does not fully eliminate re-identification risk from rare clinical detail — read the payload before sending.</div>
   </div>
   <button class="runbtn" id="parseBtn" onclick="runParse()">Send de-identified text → parse</button>`;
  $('trayWrap').innerHTML = '';
}
async function runParse() {
  const btn = $('parseBtn'); btn.disabled = true; btn.textContent = 'Parsing…';
  const { parsed, provider } = await parseUpdate(state.deid.redacted, { getApiKey });
  btn.disabled = false; btn.textContent = 'Send de-identified text → parse';
  renderTray(parsed, provider);
}
const cellOf = (p, key) => { const v = (p.vitals || []).find((x) => x[0] === key); return v ? v[1] : '—'; };
const askAns = (p, start) => { const a = (p.ask || []).find((x) => x.q.toLowerCase().startsWith(start.toLowerCase())); return a ? a.t[a.on] : '—'; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function renderTray(parsed, provider) {
  state.review = [];
  parsed.forEach((o) => {
    const pid = state.deid.map[o.token]; const p = pid && state.byId[pid]; if (!p) return;
    const ch = [];
    const add = (field, label, oldv, newv, cls, crit) => { if (newv == null || newv === '') return; ch.push({ field, label, old: String(oldv), new: String(newv), cls: cls || '', crit: !!crit, apply: true }); };
    if (o.na != null) add('na', 'Sodium', p.na[p.na.length - 1], o.na, o.na < 130 ? 'bad' : o.na < 135 ? 'warn' : 'good', o.na < 130);
    if (o.bp) add('bp', 'BP', cellOf(p, 'BP'), o.bp);
    if (o.hr) add('hr', 'HR', cellOf(p, 'HR'), o.hr);
    if (o.rr) add('rr', 'RR', cellOf(p, 'RR'), o.rr, (+o.rr >= 24 ? 'warn' : ''), +o.rr >= 24);
    if (o.spo2) add('spo2', 'SpO₂', cellOf(p, 'SPO₂'), o.spo2, (parseInt(o.spo2) < 95 ? 'warn' : ''), parseInt(o.spo2) < 95);
    if (o.temp) add('temp', 'Temp', cellOf(p, 'TEMP'), o.temp);
    if (o.bm) add('bm', 'Bowel movement', askAns(p, 'Bowel'), o.bm === 'yes' ? 'Yes' : 'No', o.bm === 'yes' ? 'good' : 'warn');
    if (o.headache) add('headache', 'Headache', askAns(p, 'Headache'), cap(o.headache), o.headache === 'worse' ? 'bad' : o.headache === 'better' ? 'good' : '');
    if (o.seizure === true) add('seizure', 'Seizure', '—', 'occurred', 'bad', true);
    if (o.ready) add('ready', 'Disposition', p.ready ? 'ready' : '—', 'ready for discharge', 'good');
    if (ch.length) state.review.push({ patientId: pid, note: o.note || '', changes: ch });
  });
  const total = state.review.reduce((n, g) => n + g.changes.length, 0);
  if (!total) { $('trayWrap').innerHTML = `<div class="in-empty">No changes parsed — try editing the update text.</div>`; return; }
  let html = `<div class="tray"><div class="tray-h"><div class="t">Review ${total} change${total > 1 ? 's' : ''}</div>
    <span class="src">${provider === 'cloud' ? 'parsed in cloud · de-identified' : 'parsed on-device · offline'}</span></div>`;
  state.review.forEach((g, gi) => {
    const p = state.byId[g.patientId];
    html += `<div class="pgroup"><div class="gh"><span class="dot ${p.triage}"></span><span class="nm">${esc(p.name)}</span><span class="lc">RM ${esc(p.room)}</span></div>`;
    g.changes.forEach((c, ci) => {
      html += `<div class="crow"><div class="cbx on" onclick="toggleChange(${gi},${ci},this)">✓</div>
        <div class="cmid"><div class="cf">${esc(c.label)}</div><div class="cv"><span class="old">${esc(c.old)}</span><span class="new ${c.cls}">${esc(c.new)}</span></div></div>
        ${c.crit ? '<span class="crit">needs eyes</span>' : ''}</div>`;
    });
    html += `</div>`;
  });
  html += `</div><div class="commitbar"><button class="btn" onclick="commitReview()">Commit confirmed changes</button></div>`;
  $('trayWrap').innerHTML = html;
}
function toggleChange(gi, ci, el) { const c = state.review[gi].changes[ci]; c.apply = !c.apply; el.classList.toggle('on', c.apply); el.textContent = c.apply ? '✓' : ''; }

async function commitReview() {
  let applied = 0;
  for (const g of state.review) {
    const p = state.byId[g.patientId];
    const before = p.snapshots.length;
    commitPatient(p, g.changes, '06/17');       // tested module does the work
    if (p.snapshots.length > before) { applied += g.changes.filter((c) => c.apply).length; await store.savePatient(p); }
  }
  $('deidWrap').innerHTML = ''; $('trayWrap').innerHTML = ''; state.deid = null;
  await loadPatients();
  goTab('today');
  toast(applied + ' change' + (applied > 1 ? 's' : '') + ' committed', '✓');
}

// ============================ Add / reset ============================
function openAdd() { $('scrim2').classList.add('show'); $('addsheet').classList.add('show'); }
function closeAdd() { $('scrim2').classList.remove('show'); $('addsheet').classList.remove('show'); }
async function savePatient() {
  const g = (id) => $(id).value.trim();
  const name = g('f_name'); if (!name) { toast('Name is required'); return; }
  const na = g('f_na') || '138', naN = +na;
  const triage = naN < 130 ? 'r' : naN < 135 ? 'a' : 'g';
  const p = newPatient({
    name, age: g('f_age'), sex: g('f_sex'), dx: g('f_dx'), day: g('f_day') || '1',
    hospital: g('f_hosp'), room: g('f_room'), triage,
    flags: [{ t: 'Na ' + na, lv: triage === 'r' ? 'bad' : triage === 'a' ? 'warn' : '' }],
    scores: [{ l: 'GCS', v: '15', a: '' }, { l: 'NA', v: na, a: '' }],
    ask: [{ q: 'Bowel movement', s: '', t: ['Yes', 'No'], on: 0, k: 'pos' }, { q: 'Sleep', s: '', t: ['Good', 'Poor'], on: 0, k: 'pos' }],
    na: [naN], naLabel: 'today',
    vitals: [['BP', '—'], ['HR', '—'], ['RR', '—'], ['TEMP', '—'], ['SPO₂', '—']],
    snapshots: [{ date: 'today', na: naN }],
  });
  await store.savePatient(p);
  ['f_name', 'f_age', 'f_day', 'f_dx', 'f_room', 'f_na'].forEach((i) => ($(i).value = ''));
  closeAdd(); await loadPatients(); renderToday(); toast('Encrypted & saved', '✓');
}
async function resetDemo() {
  await store.wipePatients();
  for (const p of seedPatients()) await store.savePatient(p);
  await loadPatients(); renderToday(); toast('Demo data reseeded', '✓');
}

// ============================ toast ============================
let tt;
function toast(m, ok) { const t = $('toast'); t.innerHTML = (ok ? `<span class="ok">${ok}</span>` : '') + m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 1800); }

// ---- expose handlers for inline onclick in index.html ----
Object.assign(window, { lockApp, goTab, openCard, closeCard, openTimeline, closeTimeline, pick, neuroStep, setSrc, runDeid, runParse, toggleChange, commitReview, openAdd, closeAdd, savePatient, resetDemo, toast });

// ---- register the PWA service worker (added by vite-plugin-pwa on build) ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ---- boot ----
bootLock();
