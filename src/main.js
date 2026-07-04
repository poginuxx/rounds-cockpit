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
import { commitPatient, buildDigest, buildTimeline, neuroStatus, applyChange, computeTriage, upsertSnapshot } from './lib/diff.js';
import { newPatient, seedPatients } from './lib/schema.js';
import {
  SEED_HOSPITALS, addHospital, removeHospital, moveHospital, abbrFor,
  groupPatientsByHospital,
} from './lib/hospitals.js';
import { MUSCLE_GROUPS, REGIONS, SIDES, GRADES, NOT_TESTED, motorDelta, cellKey } from './lib/motor.js';
import {
  SEIZURE_TYPES, FEATURES, TRIGGERS, summary as seizureSummary,
  isStatusEpilepticus, formatDuration, formatInterval,
} from './lib/seizures.js';
import {
  defaultWindows, elapsedMs, windowStatus, anyWindowOpen, formatHMS,
} from './lib/strokeclock.js';
import { recognize } from './lib/ocr.js';
import { createBackup, readBackup, passphraseStrength, BackupError } from './lib/backup.js';

// ---- where your model API key would come from (kept null = offline parsing) ----
// To enable the cloud parser, store the key in the encrypted vault and return it
// here. Until then the app uses the on-device fallback parser. See README.
let API_KEY = null;
const getApiKey = async () => API_KEY;
window.setApiKey = (k) => { API_KEY = k; }; // for manual testing in the console

// ---- in-memory view state (decrypted records live here while unlocked) ----
const state = { patients: [], byId: {}, currentId: null, deid: null, review: [], hospitals: [], lastBackupAt: null, editingId: null };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
// Escape a string for safe interpolation inside a single-quoted inline JS arg
// (e.g. onclick="f('...')") — chip labels include apostrophes ("Todd's paresis").
const jsq = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Real current date, in the two formats the app uses.
const pad2 = (n) => String(n).padStart(2, '0');
const todayMMDD = () => { const d = new Date(); return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`; };
const todayHeader = () => new Date().toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/,/g, ' ·').toUpperCase();

const SAMPLE = `Ramon dela Cruz rm 408 — repeat Na came back 126, still severe headache, no new weakness. BP 150/88, HR 80.
Aurora Mendoza 412: moved bowels this morning, finally. BP 150/86, sleeping better.
Efren Villaraza rm 302 — single breath count down to 14, RR up to 26, sats 94%. Flagging for review.
Carmela Soriano 310 afebrile overnight, headache improving.`;

// ============================ lock / unlock ============================
let entered = '', isSetup = false, pendingCode = null;

async function bootLock() {
  isSetup = !(await store.isInitialized());
  pendingCode = null;
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
  if (isSetup) {
    // A mistyped passcode at setup = an unreadable vault forever (no recovery by
    // design), so require the same 6 digits twice before deriving the key.
    if (pendingCode === null) {
      pendingCode = code; entered = '';
      $('lockTitle').textContent = 'Confirm passcode';
      $('lockSub').innerHTML = 'Enter the same 6 digits again.<br>If you forget it there is no recovery — only your backup file.';
      renderPin();
      return;
    }
    if (code !== pendingCode) {
      entered = '';
      $('pinDots').className = 'pin err';
      $('lockHint').textContent = "Passcodes didn't match — starting over";
      setTimeout(() => bootLock(), 800);
      return;
    }
    await store.setup(code, seedPatients());
    pendingCode = null; entered = '';
    await enterApp();
  }
  else {
    const ok = await store.unlock(code);
    if (ok) { entered = ''; await enterApp(); }
    else { entered = ''; $('pinDots').className = 'pin err'; $('lockHint').textContent = 'Wrong passcode — try again'; setTimeout(() => { renderPin(); $('lockHint').textContent = ''; }, 500); }
  }
}
async function enterApp() {
  await loadPatients();
  show('today'); renderToday();
  // Prefill the walkthrough sample only while the DEMO roster is present —
  // once real patients replace it, the intake box starts empty.
  if ($('rawText') && !$('rawText').value && state.byId['p_ramon']) $('rawText').value = SAMPLE;
}
function lockApp() { clearClockTimer(); store.lock(); entered = ''; $('lockHint').textContent = ''; bootLock(); show('lock'); }

async function loadPatients() {
  state.patients = await store.allPatients();
  state.byId = Object.fromEntries(state.patients.map((p) => [p.id, p]));
  // Seed the managed hospital list on first load only; an existing list is kept.
  state.hospitals = await store.getHospitals();
  if (!state.hospitals) {
    state.hospitals = SEED_HOSPITALS.map((h) => ({ ...h }));
    await store.setHospitals(state.hospitals);
  }
  state.lastBackupAt = await store.getLastBackupAt();
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
  $('todayDate').textContent = `${todayHeader()} · ${pts.length} PATIENT${pts.length === 1 ? '' : 'S'}`;

  const changed = buildDigest(pts);
  $('digest').innerHTML = changed.length
    ? `<b>${changed.length} changed overnight.</b> ` + changed.map((o) => `${esc(o.who)} — ${esc(o.txt)}<span class="k">${esc(o.k)}</span>${esc(o.tail)}.`).join(' ')
    : '<b>Quiet overnight.</b> No flagged changes.';

  $('routebar').innerHTML =
    `<div class="r"><div class="num">${hosps}</div><div class="lbl">hospitals</div></div>
     <div class="r"><div class="num">${reds}</div><div class="lbl">red</div></div>
     <div class="r"><div class="num">${ambers}</div><div class="lbl">amber</div></div>
     <div class="r"><div class="num">~${Math.round(pts.length * 9.6)}<span style="font-size:12px">m</span></div><div class="lbl">est. round</div></div>`;

  renderBackupNudge();

  const list = $('list');
  if (!pts.length) { list.innerHTML = `<div class="empty"><div class="big">🗂️</div>No patients. Reset demo to reseed.</div>`; return; }
  let html = '';
  // Census groups follow the managed hospital list (route order); headers show the
  // ABBREVIATION (full name when no abbr). Patients on an unlisted hospital are
  // grouped LAST under their stored name — never hidden.
  groupPatientsByHospital(state.hospitals, pts).forEach((g, i) => {
    const meta = g.listed ? `STOP ${i + 1}` : 'unlisted';
    html += `<div class="group"><div class="group-h"><div class="name"><span class="pin-i">◉</span>${esc(g.abbr)}</div><div class="meta">${esc(meta)}</div></div>`;
    g.patients.sort((a, b) => (a.room || '').localeCompare(b.room || '')).forEach((p) => {
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
  motorDraft = null;                    // fresh motor draft per patient
  $('rcName').textContent = p.name;
  $('rcDx').textContent = `${p.dx} · Day ${p.day}${p.detail ? ' · ' + p.detail : ''}`;
  $('rcLoc').textContent = `${abbrFor(state.hospitals, p.hospital).toUpperCase()} · RM ${p.room}`;
  renderScores(p);
  $('rcAsk').innerHTML = p.ask.map((a, ai) => `
    <div class="askrow"><div class="q">${esc(a.q)}${a.s ? `<small>${esc(a.s)}</small>` : ''}</div>
      <div class="toggle">${a.t.map((opt, oi) => `<button class="${oi === a.on ? 'on ' + a.k : ''}" onclick="pick(${ai},${oi})">${esc(opt)}</button>`).join('')}</div></div>`).join('');
  const hasNa = (p.na || []).length > 0;
  const naLast = hasNa ? p.na[p.na.length - 1] : null, naCls = naLast == null ? '' : naLast < 135 ? 'bad' : (naLast < 137 ? 'warn' : '');
  // Always render the Sodium cell (even at zero readings) and make it tappable —
  // previously a freshly Add-Patient-created record with no Na yet had no way to
  // ever enter the FIRST reading except by routing free text through Intake.
  const naCell = `
    <div class="labcell wide" onclick="openValueEdit('na','na','Sodium (Na)','${naLast == null ? '' : naLast}')"><div class="lh"><span class="nm">Sodium · trend</span><span class="val ${naCls}">${naLast ?? '—'}<small> mmol/L</small></span></div>
      ${hasNa && p.na.length >= 2 ? `<div class="spark">${sparkline(p.na)}</div>
      <div class="sparkrow"><span class="seq">${esc(p.naLabel)}</span><span class="seq">band 135–145</span></div>`
        : hasNa ? `<div class="seq mono" style="font-size:11px;color:var(--faint);margin-top:6px">one reading so far — trend builds as you commit updates</div>`
        : `<div class="seq mono" style="font-size:11px;color:var(--faint);margin-top:6px">tap to add the first reading</div>`}</div>`;
  // Potassium's "bad" flag is derived from the value against its own printed band
  // (3.5–5.1) — the prior code checked p.kbad, a field nothing ever set, so a
  // critically abnormal K never actually got flagged red.
  const kNum = parseFloat(p.k.v);
  const kCls = !isNaN(kNum) && (kNum < 3.5 || kNum > 5.1) ? 'bad' : '';
  $('rcLabs').innerHTML = `${naCell}
    <div class="labcell" onclick="openValueEdit('k','k','Potassium (K)','${jsq(p.k.v)}','${jsq(p.k.s)}')"><div class="lh"><span class="nm">Potassium</span></div><div class="val ${kCls}">${esc(p.k.v)}<small> mmol/L</small></div><div class="seq mono" style="font-size:10px;color:var(--faint);margin-top:4px">${esc(p.k.s)}</div></div>
    <div class="labcell" onclick="openValueEdit('osmo','osmo','Serum osmolality','${jsq(p.osmo.v)}','${jsq(p.osmo.s)}')"><div class="lh"><span class="nm">Serum osmo</span></div><div class="val ${p.osmo.v !== '—' && +p.osmo.v < 275 ? 'warn' : ''}">${esc(p.osmo.v)}</div><div class="seq mono" style="font-size:10px;color:var(--faint);margin-top:4px">${esc(p.osmo.s)}</div></div>`;
  $('rcVitals').innerHTML = p.vitals.map((v) => {
    const cfg = VITAL_EDIT.find((x) => x.vkey === v[0]);
    const click = cfg ? `onclick="openValueEdit('vital','${cfg.field}','${jsq(cfg.label)}','${jsq(v[1])}')"` : '';
    return `<div class="vital" ${click}><div class="k">${esc(v[0])}</div><div class="v">${esc(v[1])}</div></div>`;
  }).join('');
  $('rcMeds').innerHTML = p.meds.map((m, i) => `<div class="med" onclick="openMedForm(${i})"><div class="mn">${esc(m.n)} <small>· ${esc(m.d)}</small></div><div class="day ${m.w ? 'warn' : ''}">${esc(m.day)}</div></div>`).join('')
    + `<button class="mtool" style="margin-top:2px" onclick="openMedForm(null)">＋ Add medication</button>`;
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
  startClockTimer();                    // live stroke-clock tick (no-op if no active clock)
}
function closeCard() { clearClockTimer(); closeTimeline(); $('scrim').classList.remove('show'); $('sheet').classList.remove('show'); state.currentId = null; }

// GCS/NIHSS keep their dedicated bedside stepper (see neuroStep) — the generic
// score editor below only applies to everything else (WFNS, FVC, SZ-FREE, ...).
function renderScores(p) {
  $('rcScores').innerHTML = p.scores.map((s) => {
    const hasStepper = NEURO_METRICS.some((m) => m.label === s.l);
    const cls = hasStepper ? 'score' : 'score tap';
    const click = hasStepper ? '' : `onclick="openValueEdit('score','${jsq(s.l)}','${jsq(s.l)}','${jsq(s.v)}')"`;
    return `<div class="${cls}" ${click}><div class="lbl">${esc(s.l)}</div>
    <div class="v ${s.d ? 'delta-bad' : ''}">${esc(s.v)}${s.a ? `<span class="arr ${s.a}">${s.a === 'dn' ? '↓' : '↑'}</span>` : ''}</div></div>`;
  }).join('');
}

// ============================ Neuro modules ============================
// A reusable collapsed-by-default block (native <details>) that the later
// neuro modules — motor grid, seizure log, stroke clock — will reuse. The
// first module living inside it is the GCS / NIHSS trend ribbons.
const STATUS_COL = { good: 'var(--teal)', warn: 'var(--amber)', bad: 'var(--red)' };

function expandable(title, sub, bodyHtml, open = false, cls = '') {
  return `<details class="nblock${cls ? ' ' + cls : ''}"${open ? ' open' : ''}>
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
  const ribbons = NEURO_METRICS.map((m) => {
    const series = (p.snapshots || []).map((s) => s[m.key]).filter((v) => v != null);
    return series.length >= 2 ? neuroRibbonCell(m, series) : '';
  }).filter(Boolean).join('');
  // The Neuro section is a stack of collapsible blocks (each its own .nblock).
  const blocks = [];
  blocks.push(strokeClockBlock(p));      // stroke clock first — surfaces prominently when in-window
  if (ribbons) blocks.push(expandable('Neuro', 'GCS / NIHSS trend ribbons', `<div class="labgrid">${ribbons}</div>`));
  blocks.push(motorBlock(p));            // motor grid is always available (record a new exam)
  blocks.push(seizureBlock(p));          // seizure log (manual-entry-only)
  $('rcNeuro').innerHTML = blocks.join('');
}

// ---------------------------- motor power grid ----------------------------
// MRC grid (neuro module #2), inside its own collapsible block. Trend colour and
// ordering are pure (lib/motor.js); this only renders and wires the picker.
//
// motorDraft is the exam currently being composed at the bedside: a working copy
// of the latest RECORDED exam. Edits live here until "Record exam" persists them.
// It is never written to the vault until the user records (invariant #4 spirit).
let motorDraft = null;          // { id, cells } | null
let mpickKey = null;            // cell key the picker is editing

const latestExam = (p) => (p.motorExams || [])[(p.motorExams || []).length - 1] || null;
const prevExam   = (p) => (p.motorExams || [])[(p.motorExams || []).length - 2] || null;

function ensureDraft(p) {
  if (!motorDraft || motorDraft.id !== p.id) {
    const cur = latestExam(p);
    motorDraft = { id: p.id, cells: { ...(cur ? cur.cells : {}) } };
  }
  return motorDraft;
}

function motorBlock(p) {
  ensureDraft(p);
  return expandable('Motor', 'MRC power grid', `<div id="motorBody">${motorBodyHtml(p)}</div>`);
}

// The block's inner content. Re-rendered on its own (not the whole section) so an
// edit keeps the <details> open and the bedside flow uninterrupted.
function motorBodyHtml(p) {
  const d = ensureDraft(p);
  const cur = latestExam(p), prev = prevExam(p);
  const delta = motorDelta(prev, cur);                 // trend from RECORDED exams only
  const dates = cur ? (prev ? `${prev.date} → ${cur.date}` : cur.date) : 'no exam recorded';

  const rows = REGIONS.map((reg) => {
    const body = MUSCLE_GROUPS.filter((g) => g.region === reg.id).map((g) => {
      const cells = SIDES.map((side) => {
        const key = cellKey(g, side);
        return motorCellHtml(key, d.cells[key], delta[key], cur ? cur.cells[key] : undefined);
      }).join('');
      return `<div class="mrow"><span class="mglabel">${esc(g.label)}</span>${cells}</div>`;
    }).join('');
    return `<div class="mregion">${esc(reg.label)}</div>${body}`;
  }).join('');

  return `
    <div class="mtools">
      <button class="mtool" onclick="motorSetAll5()">Set all 5/5</button>
      <button class="mtool primary" onclick="motorRecord()">Record exam</button>
      <span class="mdates">${esc(dates)}</span>
    </div>
    <div class="mhead"><span></span><span>Left</span><span>Right</span></div>
    ${rows}
    <div class="mlegend"><span class="mk worse">▼ weaker</span><span class="mk better">▲ stronger</span><span class="mk same">– same</span><span class="mk">— not tested</span></div>`;
}

// One cell: shows the DRAFT grade (or — for not tested), coloured by its trend
// vs the last recorded exam. An edited-but-unsaved cell is flagged 'pending'.
function motorCellHtml(key, draftVal, dl, recordedVal) {
  const val = draftVal == null ? '—' : draftVal;
  const dirCls = dl ? dl.direction : '';
  const arrow = dl && dl.direction === 'worse' ? '▼' : dl && dl.direction === 'better' ? '▲' : '';
  const pending = (draftVal == null ? null : draftVal) !== (recordedVal == null ? null : recordedVal);
  return `<button class="mcell ${dirCls} ${val === '—' ? 'nt' : ''} ${pending ? 'pending' : ''}" onclick="motorPick('${key}')">
    <span class="mv">${esc(val)}</span>${arrow ? `<span class="md">${arrow}</span>` : ''}</button>`;
}

function refreshMotor() {
  const p = state.byId[state.currentId];
  if (p && $('motorBody')) $('motorBody').innerHTML = motorBodyHtml(p);
}

function motorPick(key) {
  mpickKey = key;
  const opts = [...GRADES, NOT_TESTED];
  $('mpick').innerHTML = `<div class="mpick-h">MRC grade</div>
    <div class="mpick-grid">${opts.map((g) =>
      `<button onclick="motorSet('${g === NOT_TESTED ? 'NT' : g}')">${g === NOT_TESTED ? 'not<br>tested' : g}</button>`).join('')}</div>`;
  $('mpick').classList.add('show'); $('mpickScrim').classList.add('show');
}

function closeMpick() { $('mpick').classList.remove('show'); $('mpickScrim').classList.remove('show'); mpickKey = null; }

function motorSet(g) {
  const p = state.byId[state.currentId]; if (!p || !mpickKey) return;
  const d = ensureDraft(p);
  if (g === 'NT') delete d.cells[mpickKey];   // not tested = ABSENT key, never a value
  else d.cells[mpickKey] = g;
  closeMpick();
  refreshMotor();                              // draft only — not persisted until Record
}

function motorSetAll5() {
  const p = state.byId[state.currentId]; if (!p) return;
  const d = ensureDraft(p);
  for (const g of MUSCLE_GROUPS) for (const s of SIDES) d.cells[cellKey(g, s)] = '5';
  refreshMotor();
}

async function motorRecord() {
  const p = state.byId[state.currentId]; if (!p) return;
  const d = ensureDraft(p);
  const cells = { ...d.cells };
  if (!Object.keys(cells).length) { toast('Grade at least one muscle first'); return; }
  p.motorExams = [...(p.motorExams || []), { date: todayMMDD(), cells }];
  await store.savePatient(p);                  // encrypted vault — invariant #2
  motorDraft = null;                           // rebuild draft from the new latest exam
  refreshMotor();
  toast('Motor exam recorded', '✓');
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

// ---------------------------- seizure log ----------------------------
// Neuro module #3, inside its own collapsible block. MANUAL ENTRY ONLY: the log
// is written EXCLUSIVELY through the Record-seizure form below. The intake
// parser's `seizure` field and the bedside "Any seizures?" Ask toggle are fully
// decoupled and never append here — that decoupling is a safety property. The
// only allowed bridge is a convenience shortcut: when the Ask toggle reads "Yes"
// we surface a one-tap button that OPENS the empty form; the physician fills it.
// All derived numbers come from the pure, tested lib/seizures.js.

// The collapsed header summary: today's count, else the seizure-free interval,
// else an explicit "no seizures" (which is NOT the same as "0h").
function seizureSub(entries) {
  const s = seizureSummary(entries, Date.now());
  if (s.freeIntervalSec == null) return 'No seizures recorded';
  if (s.count24h > 0) return `${s.count24h} seizure${s.count24h > 1 ? 's' : ''} today`;
  return `Seizure-free ${formatInterval(s.freeIntervalSec)}`;
}

function seizureBlock(p) {
  return expandable('Seizures', seizureSub(p.seizures || []),
    `<div id="seizBody">${seizureBodyHtml(p)}</div>`);
}

// Re-render just the block body (keeps the <details> open after recording) and
// refresh the collapsed-header summary in place, without rebuilding the section.
function refreshSeizures() {
  const p = state.byId[state.currentId];
  if (!p) return;
  const body = $('seizBody');
  if (!body) return;
  body.innerHTML = seizureBodyHtml(p);
  const sub = body.closest('.nblock')?.querySelector('.nsub');
  if (sub) sub.textContent = seizureSub(p.seizures || []);
}

function seizureBodyHtml(p) {
  const entries = [...(p.seizures || [])].sort(
    (a, b) => Date.parse(b.onset) - Date.parse(a.onset)); // newest first
  const askYes = /^yes$/i.test(askAns(p, 'Any seizure'));
  const log = entries.length
    ? entries.map(seizureRowHtml).join('')
    : `<div class="sz-empty">No seizures recorded.</div>`;
  return `
    <div class="sztools">
      <button class="mtool primary" onclick="openSeizureForm()">＋ Record seizure</button>
      ${askYes ? `<button class="szshortcut" onclick="openSeizureForm()">Ask says “Yes” — log it</button>` : ''}
    </div>
    <div class="szlog">${log}</div>`;
}

function seizureRowHtml(e) {
  const d = new Date(e.onset);
  const when = isNaN(d.getTime()) ? '—'
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const status = isStatusEpilepticus(e);
  const feats = (e.features || []).join(' · ');
  const meta = [];
  if (e.trigger) meta.push('trigger: ' + e.trigger);
  if (e.rescueMed) meta.push(e.rescueMed + (e.rescueResponded === true ? ' ✓ responded'
    : e.rescueResponded === false ? ' ✗ no response' : ''));
  meta.push(e.witnessed ? 'witnessed' : 'reported');
  return `<div class="szrow">
    <div class="szhd">
      <span class="szwhen">${esc(when)}</span>
      <span class="szdur">${esc(formatDuration(e.durationSec))}</span>
      ${status ? '<span class="szse">status epilepticus</span>' : ''}</div>
    <div class="sztype">${esc(e.type)}</div>
    ${feats ? `<div class="szmeta">${esc(feats)}</div>` : ''}
    <div class="szmeta">${esc(meta.join(' · '))}</div>
    ${e.note ? `<div class="sznote">${esc(e.note)}</div>` : ''}</div>`;
}

// ----- Record-seizure form (the ONLY writer of seizures[]) -----
// szDraft holds the in-progress entry's tap-selections (chip groups). Free-text
// fields (onset, duration, rescue med, note) are read from the inputs on save, so
// re-rendering chips never clobbers typed text. Nothing persists until "Save".
let szDraft = null;

// Local 'YYYY-MM-DDTHH:MM' for a datetime-local default of "now".
function nowLocalDatetime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openSeizureForm() {
  const p = state.byId[state.currentId];
  if (!p) return;
  szDraft = { type: null, features: new Set(), trigger: null, witnessed: true, responded: null };
  $('seizsheet').innerHTML = seizFormHtml();
  $('seizsheet').classList.add('show');
  $('seizScrim').classList.add('show');
}
function closeSeizureForm() {
  $('seizsheet').classList.remove('show');
  $('seizScrim').classList.remove('show');
  szDraft = null;
}

const chip = (label, on, handler) =>
  `<button type="button" class="szchip${on ? ' on' : ''}" onclick="${handler}">${esc(label)}</button>`;

function seizFormHtml() {
  const types = SEIZURE_TYPES.map((t) => chip(t, szDraft.type === t, `szPickType(this,'${jsq(t)}')`)).join('');
  const feats = FEATURES.map((f) => chip(f, szDraft.features.has(f), `szToggleFeature(this,'${jsq(f)}')`)).join('');
  const trigs = TRIGGERS.map((t) => chip(t, szDraft.trigger === t, `szPickTrigger(this,'${jsq(t)}')`)).join('');
  return `
    <div class="grab"></div>
    <h2>Record seizure</h2>
    <div class="lead">Manual entry — append-only. Essentials are required; leave the rest blank if not observed (blanks are honest, never auto-filled).</div>
    <div class="form">
      <div class="frow">
        <div class="field"><label>Onset (date &amp; time) *</label>
          <input type="datetime-local" id="sz_onset" value="${nowLocalDatetime()}"></div>
      </div>
      <div class="field"><label>Duration *</label>
        <div class="frow">
          <div class="field"><input id="sz_min" inputmode="numeric" placeholder="min"></div>
          <div class="field"><input id="sz_sec" inputmode="numeric" placeholder="sec"></div>
        </div>
        <div class="hint">≥ 5:00 flags status epilepticus.</div>
      </div>
      <div class="field"><label>Type *</label><div class="szchips" id="sz_types">${types}</div></div>
      <div class="field"><label>Features</label><div class="szchips">${feats}</div></div>
      <div class="field"><label>Likely trigger</label><div class="szchips">${trigs}</div></div>
      <div class="field"><label>Rescue medication</label>
        <input id="sz_rescue" placeholder="e.g. Lorazepam 4mg IV">
        <div class="szchips" style="margin-top:7px">
          ${chip('responded', szDraft.responded === true, 'szSetResponded(this,true)')}
          ${chip('no response', szDraft.responded === false, 'szSetResponded(this,false)')}
        </div>
      </div>
      <div class="field"><label>Source</label><div class="szchips">
        ${chip('witnessed', szDraft.witnessed === true, 'szSetWitnessed(this,true)')}
        ${chip('reported', szDraft.witnessed === false, 'szSetWitnessed(this,false)')}
      </div></div>
      <div class="field"><label>Note</label><textarea id="sz_note" rows="2" placeholder="free text (optional)"></textarea></div>
    </div>
    <div class="formbtns">
      <button class="btn ghost" onclick="closeSeizureForm()">Cancel</button>
      <button class="btn primary" onclick="saveSeizure()">Encrypt &amp; save</button>
    </div>`;
}

// Chip handlers mutate szDraft + toggle classes (no re-render → text inputs kept).
function szGroupSelect(el) {
  [...el.parentElement.children].forEach((c) => c.classList.remove('on'));
  el.classList.add('on');
}
function szPickType(el, t) { szDraft.type = t; szGroupSelect(el); }
function szPickTrigger(el, t) { szDraft.trigger = szDraft.trigger === t ? null : t; el.classList.toggle('on', szDraft.trigger === t); if (szDraft.trigger === t) szGroupSelect(el); }
function szToggleFeature(el, f) {
  if (szDraft.features.has(f)) { szDraft.features.delete(f); el.classList.remove('on'); }
  else { szDraft.features.add(f); el.classList.add('on'); }
}
function szSetWitnessed(el, b) { szDraft.witnessed = b; szGroupSelect(el); }
function szSetResponded(el, v) { szDraft.responded = szDraft.responded === v ? null : v; el.classList.toggle('on', szDraft.responded === v); if (szDraft.responded === v) szGroupSelect(el); }

async function saveSeizure() {
  const p = state.byId[state.currentId];
  if (!p || !szDraft) return;
  const onsetRaw = $('sz_onset').value;
  if (!onsetRaw) { toast('Onset date & time is required'); return; }
  const onsetDate = new Date(onsetRaw);
  if (isNaN(onsetDate.getTime())) { toast('Onset date & time is invalid'); return; }
  // A future onset would silently corrupt the "seizure-free Xh" interval.
  if (onsetDate.getTime() > Date.now() + 5 * 60 * 1000) { toast('Onset is in the future — check the date & time'); return; }
  const onset = onsetDate.toISOString();
  const durationSec = (parseInt($('sz_min').value, 10) || 0) * 60 + (parseInt($('sz_sec').value, 10) || 0);
  if (durationSec <= 0) { toast('Duration is required'); return; }
  if (!szDraft.type) { toast('Seizure type is required'); return; }
  const rescueMed = $('sz_rescue').value.trim() || null;
  const entry = {
    id: 'sz_' + Date.now(),
    onset,
    durationSec,
    type: szDraft.type,
    features: [...szDraft.features],
    trigger: szDraft.trigger,                 // null when untapped — never defaulted
    rescueMed,
    rescueResponded: rescueMed ? szDraft.responded : null,
    witnessed: szDraft.witnessed,
    note: $('sz_note').value.trim(),
  };
  p.seizures = [...(p.seizures || []), entry];   // APPEND-ONLY — no edit/delete path
  await store.savePatient(p);                    // encrypted vault — invariant #2
  closeSeizureForm();
  refreshSeizures();                             // header + log update immediately
  toast('Seizure recorded', '✓');
}

// ---------------------------- stroke clock ----------------------------
// Neuro module #4, inside its own collapsible block. A live count of time since
// LAST KNOWN WELL against acute-stroke treatment windows — DECISION-SUPPORT
// REFERENCE ONLY. All time/window maths is pure & tested in lib/strokeclock.js;
// this file only renders and owns the live interval + its cleanup.
//
// SAFETY (mirrors lib/strokeclock.js — keep these true):
//  · The anchor is LAST KNOWN WELL, never discovery/admission time. Physician-set
//    only; nothing here infers or auto-activates it.
//  · Windows render ONLY for confirmed ischemic (windowStatus returns [] for
//    hemorrhagic and undetermined). Wording stays factual ("window passed"),
//    never "(in)eligible" / "give|withhold". Eligibility is not assessed here.

let clockTimer = null;          // the single live tick; cleared on close/lock (no leaks)
let scDraft = null;             // activation form's in-progress type selection

function clearClockTimer() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }

// Start ticking only when the open patient has an active clock with an anchor.
// Recompute from timestamps each tick — never accumulate, so there is no drift.
function startClockTimer() {
  clearClockTimer();
  const p = state.byId[state.currentId];
  if (p && p.strokeClock && p.strokeClock.lastKnownWell) clockTimer = setInterval(tickStrokeClock, 1000);
}
function tickStrokeClock() {
  const p = state.byId[state.currentId];
  const body = $('strokeBody');
  if (!p || !p.strokeClock || !body) { clearClockTimer(); return; }
  const now = Date.now();
  body.innerHTML = strokeBodyHtml(p, now);
  const sub = body.closest('.nblock')?.querySelector('.nsub');
  if (sub) sub.textContent = strokeSub(p.strokeClock, now);
}

// Collapsed-header glance. When active + a window is open the block is expanded
// (see strokeClockBlock), so this mainly serves the non-urgent collapsed states.
function strokeSub(c, now) {
  const el = elapsedMs(c, now);
  if (el == null) return 'last known well not set';
  const hms = formatHMS(el);
  if (c.type === 'ischemic') {
    const open = windowStatus(c, now).filter((w) => !w.passed).length;
    return open ? `${hms} since LKW · ${open} window${open > 1 ? 's' : ''} open` : `${hms} since LKW · all windows passed`;
  }
  if (c.type === 'hemorrhagic') return `${hms} since LKW · windows N/A`;
  return `${hms} since LKW · windows pending type`;
}

function strokeClockBlock(p) {
  const c = p.strokeClock;
  if (!c) {
    // OFF — a small, collapsed activation entry (physician-set, never automatic).
    return expandable('Stroke clock', 'not active',
      `<div class="sc-off">
         <div class="sc-offnote">Off. Activate by entering last known well and stroke type — never inferred from admission or parsed data.</div>
         <div class="sctools"><button class="mtool primary" onclick="openStrokeForm()">Activate stroke clock</button></div>
       </div>`);
  }
  const now = Date.now();
  const open = anyWindowOpen(c, now);   // prominent + expanded while any window is still open
  return expandable('Stroke clock', strokeSub(c, now),
    `<div id="strokeBody">${strokeBodyHtml(p, now)}</div>`, open, open ? 'sc-live' : '');
}

const fmtClockTime = (iso) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—'
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function strokeBodyHtml(p, now) {
  const c = p.strokeClock;
  const el = elapsedMs(c, now);
  const tools = `<div class="sctools">
      <button class="mtool" onclick="openStrokeForm()">Edit</button>
      <button class="mtool" onclick="deactivateStrokeClock()">Turn off</button></div>`;

  // Never fabricate a time: no anchor → no countdown, an explicit message instead.
  if (el == null) {
    return `<div class="sc-noanchor">Last known well not set — no countdown shown.</div>${tools}`;
  }

  const anchor = `<div class="sc-anchor">since last known well · <b>${esc(fmtClockTime(c.lastKnownWell))}</b></div>`;
  const countup = `<div class="sc-elapsed"><span class="sc-hms">${formatHMS(el)}</span><span class="sc-unit">elapsed</span></div>`;
  const disc = c.onsetDiscovered
    ? `<div class="sc-disc">symptom discovery · ${esc(fmtClockTime(c.onsetDiscovered))} <small>(documentation only — not the clock anchor)</small></div>`
    : '';

  // Type-specific body. Windows ONLY for confirmed ischemic.
  let windowsHtml;
  if (c.type === 'ischemic') {
    const rows = windowStatus(c, now).map((w) => {
      const tag = w.kind === 'extended' ? '<span class="sc-ext">selected-patient</span>' : '';
      const state = w.passed
        ? `<span class="sc-passed">window passed</span>`
        : `<span class="sc-left">${formatHMS(w.remainingMs)} left</span>`;
      return `<div class="sc-win${w.passed ? ' is-passed' : ' is-open'}">
          <div class="sc-wh"><span class="sc-wlabel">${esc(w.label)} <small>${(w.minutes / 60)}h</small> ${tag}</span>${state}</div>
          <div class="sc-wnote">${esc(w.note)}</div></div>`;
    }).join('');
    windowsHtml = `<div class="sc-wintitle">Treatment windows · reference thresholds, not eligibility</div>${rows}`;
  } else if (c.type === 'hemorrhagic') {
    windowsHtml = `<div class="sc-na">Haemorrhagic — thrombolysis/thrombectomy windows not applicable (thrombolysis is contraindicated in haemorrhage). Elapsed time shown for documentation.</div>`;
  } else {
    windowsHtml = `<div class="sc-na">Stroke type not yet confirmed — treatment windows pending. They are not active until the type is confirmed ischemic.</div>`;
  }

  const typeLabel = { ischemic: 'Ischemic', hemorrhagic: 'Haemorrhagic', undetermined: 'Undetermined' }[c.type] || c.type;
  return `${anchor}${countup}${disc}
    <div class="sc-type">type · <b>${esc(typeLabel)}</b></div>
    ${windowsHtml}
    <div class="sc-disclaimer">Reference only — not a treatment recommendation. Eligibility depends on imaging, contraindications, NIHSS, BP, glucose and more that this clock does not assess. Confirm windows against your current protocol.</div>
    ${tools}`;
}

// ----- Activation form (the ONLY writer of strokeClock; physician-set) -----
const SC_TYPES = [
  { id: 'ischemic', label: 'Ischemic' },
  { id: 'hemorrhagic', label: 'Haemorrhagic' },
  { id: 'undetermined', label: 'Undetermined' },
];

function openStrokeForm() {
  const p = state.byId[state.currentId];
  if (!p) return;
  const c = p.strokeClock;
  scDraft = { type: c ? c.type : null };
  $('scsheet').innerHTML = scFormHtml(c);
  $('scsheet').classList.add('show');
  $('scScrim').classList.add('show');
}
function closeStrokeForm() {
  $('scsheet').classList.remove('show');
  $('scScrim').classList.remove('show');
  scDraft = null;
}

// datetime-local default: prefill from an existing ISO, else now.
function isoToLocalInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return nowLocalDatetime();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scFormHtml(c) {
  const types = SC_TYPES.map((t) =>
    chip(t.label, scDraft.type === t.id, `scPickType(this,'${t.id}')`)).join('');
  return `
    <div class="grab"></div>
    <h2>${c ? 'Edit stroke clock' : 'Activate stroke clock'}</h2>
    <div class="lead">Physician-set. The anchor is <b>last known well</b> — for wake-up / unwitnessed onset this is when the patient was last seen normal (e.g. before sleep), not when symptoms were discovered. Never inferred from admission time.</div>
    <div class="form">
      <div class="field"><label>Last known well (date &amp; time) *</label>
        <input type="datetime-local" id="sc_lkw" value="${isoToLocalInput(c ? c.lastKnownWell : '')}"></div>
      <div class="field"><label>Symptom discovery / onset (optional)</label>
        <input type="datetime-local" id="sc_disc" value="${c && c.onsetDiscovered ? isoToLocalInput(c.onsetDiscovered) : ''}">
        <div class="hint">Documentation only — never used as the countdown anchor.</div></div>
      <div class="field"><label>Stroke type *</label><div class="szchips" id="sc_types">${types}</div>
        <div class="hint">Treatment windows show ONLY for confirmed ischemic. Haemorrhagic shows elapsed time without windows; undetermined marks them pending.</div></div>
    </div>
    <div class="formbtns">
      <button class="btn ghost" onclick="closeStrokeForm()">Cancel</button>
      <button class="btn primary" onclick="saveStrokeClock()">Encrypt &amp; save</button>
    </div>`;
}

function scPickType(el, id) { scDraft.type = id; szGroupSelect(el); }

async function saveStrokeClock() {
  const p = state.byId[state.currentId];
  if (!p || !scDraft) return;
  const lkwRaw = $('sc_lkw').value;
  if (!lkwRaw) { toast('Last known well is required'); return; }
  if (!scDraft.type) { toast('Stroke type is required'); return; }
  const discRaw = $('sc_disc').value;
  const existing = p.strokeClock;
  p.strokeClock = {
    lastKnownWell: new Date(lkwRaw).toISOString(),
    onsetDiscovered: discRaw ? new Date(discRaw).toISOString() : null,
    type: scDraft.type,
    // Preserve any edited window config; seed defaults on first activation.
    windows: existing && existing.windows ? existing.windows : defaultWindows(),
  };
  await store.savePatient(p);            // encrypted vault — invariant #2
  closeStrokeForm();
  renderNeuro(p);                        // rebuild (recomputes prominent/expanded state)
  startClockTimer();                     // (re)start the live tick
  toast('Stroke clock activated', '✓');
}

async function deactivateStrokeClock() {
  const p = state.byId[state.currentId];
  if (!p) return;
  p.strokeClock = null;
  await store.savePatient(p);
  clearClockTimer();
  renderNeuro(p);
  toast('Stroke clock turned off', '✓');
}

// ============================ Patient timeline ============================
// Read-only admission history. All trajectory/diff logic lives in lib/diff.js;
// this only renders the rows it returns.
const naCls = (v) => (v == null ? '' : v < 135 ? 'bad' : v < 137 ? 'warn' : '');

function openTimeline() {
  const p = state.byId[state.currentId]; if (!p) return;
  $('tlName').textContent = p.name;
  $('tlDx').textContent = `${p.dx} · Day ${p.day}${p.detail ? ' · ' + p.detail : ''}`;
  $('tlLoc').textContent = `${abbrFor(state.hospitals, p.hospital).toUpperCase()} · RM ${p.room}`;

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
  // The seizure block surfaces a one-tap "log it" shortcut when the Ask toggle
  // reads "Yes" — refresh it so the shortcut appears/disappears immediately.
  if (/^any seizure/i.test(p.ask[ai].q)) refreshSeizures();
  await store.savePatient(p); // persist the answer, encrypted
}

// ---------------------------- direct value edit (bedside fast path) ----------------------------
// A small generic bottom sheet for correcting/entering ONE lab, vital, or score
// value on the spot — separate from the nightly Intake bulk-paste workflow.
// Reuses the tested diff.js pipeline (applyChange + computeTriage + upsertSnapshot)
// so triage stays derived (invariant #5) even for a single bedside tap.
const VITAL_EDIT = [
  { field: 'bp', label: 'Blood pressure', vkey: 'BP' },
  { field: 'hr', label: 'Heart rate', vkey: 'HR' },
  { field: 'rr', label: 'Respiratory rate', vkey: 'RR' },
  { field: 'temp', label: 'Temperature', vkey: 'TEMP' },
  { field: 'spo2', label: 'SpO₂', vkey: 'SPO₂' },
];
// Which vital fields feed the snapshot/timeline (see diff.js snapshotOf) — only
// these (plus 'na') warrant an upsertSnapshot call; BP/HR aren't captured there,
// and calling it anyway would spuriously create an empty-looking timeline row.
const SNAPSHOT_VITALS = new Set(['rr', 'spo2', 'temp']);

let valueEdit = null; // { kind:'na'|'vital'|'k'|'osmo'|'score', key, label, value, note }

function openValueEdit(kind, key, label, value, note) {
  const p = state.byId[state.currentId]; if (!p) return;
  valueEdit = { kind, key, label, value: value == null ? '' : String(value), note: note == null ? '' : String(note) };
  $('editsheet').innerHTML = valueEditFormHtml();
  $('editsheet').classList.add('show');
  $('editScrim').classList.add('show');
}
function closeValueEdit() {
  $('editsheet').classList.remove('show');
  $('editScrim').classList.remove('show');
  valueEdit = null;
}
function valueEditFormHtml() {
  const hasNote = valueEdit.kind === 'k' || valueEdit.kind === 'osmo';
  return `
    <div class="grab"></div>
    <h2>Edit ${esc(valueEdit.label)}</h2>
    <div class="form">
      <div class="field"><label>Value</label><input id="ve_val" value="${esc(valueEdit.value)}"></div>
      ${hasNote ? `<div class="field"><label>Note</label><input id="ve_note" value="${esc(valueEdit.note)}" placeholder="e.g. not drawn today"></div>` : ''}
    </div>
    <div class="formbtns">
      <button class="btn ghost" onclick="closeValueEdit()">Cancel</button>
      <button class="btn primary" onclick="saveValueEdit()">Save</button>
    </div>`;
}
async function saveValueEdit() {
  const p = state.byId[state.currentId]; if (!p || !valueEdit) return;
  const { kind, key, label } = valueEdit;
  const val = $('ve_val').value.trim();
  if (!val) { toast('Enter a value'); return; }
  if (kind === 'na' && isNaN(+val)) { toast('Sodium must be a number'); return; }
  const note = $('ve_note') ? $('ve_note').value.trim() : undefined;

  let affectsSnapshot = false;
  if (kind === 'na') { applyChange(p, { field: 'na', new: val, date: todayMMDD() }); affectsSnapshot = true; }
  else if (kind === 'vital') { applyChange(p, { field: key, new: val, date: todayMMDD() }); affectsSnapshot = SNAPSHOT_VITALS.has(key); }
  else if (kind === 'k' || kind === 'osmo') applyChange(p, { field: kind, new: val, note });
  else if (kind === 'score') {
    const sc = p.scores.find((s) => s.l === key);
    // Direction ('a' arrow) is meaningful only when we know which way is worse
    // per-score (see neuroStatus) — for an arbitrary custom score we don't, so
    // just update the value and drop the arrow rather than guess a direction.
    if (sc) { sc.v = val; sc.a = ''; }
  }
  p.triage = computeTriage(p);
  if (affectsSnapshot) upsertSnapshot(p, todayMMDD());
  await store.savePatient(p);
  closeValueEdit();
  openCard(p.id);   // full re-render: labs/vitals/scores/triage dot/neuro refresh
  renderToday();    // census triage dot may have changed
  toast(label + ' updated', '✓');
}

// ---------------------------- medications ----------------------------
// Add / edit / delete a medication. Meds don't feed triage or the snapshot
// timeline, so this only mutates p.meds directly — no diff.js involvement.
let medDraft = null; // { index: number|null, n, d, day, w }

function openMedForm(index) {
  const p = state.byId[state.currentId]; if (!p) return;
  const existing = index != null ? p.meds[index] : null;
  medDraft = { index, n: existing ? existing.n : '', d: existing ? existing.d : '', day: existing ? existing.day : '', w: existing ? !!existing.w : false };
  $('medsheet').innerHTML = medFormHtml();
  $('medsheet').classList.add('show');
  $('medScrim').classList.add('show');
}
function closeMedForm() {
  $('medsheet').classList.remove('show');
  $('medScrim').classList.remove('show');
  medDraft = null;
}
function medFormHtml() {
  const isEdit = medDraft.index != null;
  return `
    <div class="grab"></div>
    <h2>${isEdit ? 'Edit medication' : 'Add medication'}</h2>
    <div class="form">
      <div class="field"><label>Name</label><input id="med_n" value="${esc(medDraft.n)}" placeholder="e.g. Levetiracetam"></div>
      <div class="field"><label>Dose / detail</label><input id="med_d" value="${esc(medDraft.d)}" placeholder="e.g. 500mg BID"></div>
      <div class="field"><label>Day tag</label><input id="med_day" value="${esc(medDraft.day)}" placeholder="e.g. D5"></div>
      <div class="field"><label>Flag as caution</label><div class="szchips">
        ${chip('Yes', medDraft.w === true, 'medSetWarn(this,true)')}
        ${chip('No', medDraft.w === false, 'medSetWarn(this,false)')}
      </div></div>
    </div>
    <div class="formbtns">
      ${isEdit ? `<button class="btn ghost danger" onclick="deleteMed()">Delete</button>` : ''}
      <button class="btn ghost" onclick="closeMedForm()">Cancel</button>
      <button class="btn primary" onclick="saveMed()">Save</button>
    </div>`;
}
function medSetWarn(el, v) { medDraft.w = v; szGroupSelect(el); }
async function saveMed() {
  const p = state.byId[state.currentId]; if (!p || !medDraft) return;
  const n = $('med_n').value.trim();
  if (!n) { toast('Medication name is required'); return; }
  const entry = { n, d: $('med_d').value.trim(), day: $('med_day').value.trim(), w: medDraft.w === true };
  if (medDraft.index != null) p.meds[medDraft.index] = entry;
  else p.meds = [...(p.meds || []), entry];
  await store.savePatient(p);
  const wasEdit = medDraft.index != null;
  closeMedForm();
  openCard(p.id);
  toast(wasEdit ? 'Medication updated' : 'Medication added', '✓');
}
function deleteMed() {
  const p = state.byId[state.currentId]; if (!p || !medDraft || medDraft.index == null) return;
  p.meds = p.meds.filter((_, i) => i !== medDraft.index);
  store.savePatient(p).then(() => { closeMedForm(); openCard(p.id); toast('Medication removed'); });
}

// ============================ Intake ============================
function setSrc(s) {
  ['text', 'voice', 'photo'].forEach((x) => $('src_' + x).classList.toggle('on', x === s));
  if (s === 'voice') { toast('Dictation capture wires in a later step'); return; }
  // Snap: open the on-device camera/photo picker. Recognized TEXT (never the image)
  // is dropped into the same intake textarea the typed flow uses (see handleOcrFile).
  if (s === 'photo') $('ocrFile').click();
}

// ---------------------------- OCR capture (input adapter) ----------------------------
// Reads a lab-slip photo entirely ON-DEVICE and hands the recognized TEXT to the
// EXISTING intake pipeline. The image is transient: held in memory only, OCR'd,
// then dropped. It is NEVER persisted (no store write) and NEVER sent anywhere —
// only the text continues, through the unchanged de-identify → parse → commit path.
let ocrUrl = null;           // objectURL for the thumbnail preview — revoked after use

function ocrCleanup() {       // drop the image from memory (transient by design)
  if (ocrUrl) { URL.revokeObjectURL(ocrUrl); ocrUrl = null; }
}

async function handleOcrFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';                       // allow re-picking the same file later
  if (!file) return;                          // user cancelled — nothing held
  ocrCleanup();
  ocrUrl = URL.createObjectURL(file);         // local preview only; not uploaded
  renderOcr({ thumb: ocrUrl, progress: 0, stage: 'reading' });

  let text = '';
  try {
    text = await recognize(file, { onProgress: (f) => {
      const bar = $('ocrBar'); if (bar) bar.style.width = Math.round(f * 100) + '%';
      const pct = $('ocrPct'); if (pct) pct.textContent = Math.round(f * 100) + '%';
    } });
  } catch (e) {
    ocrCleanup();
    renderOcr({ error: true });
    return;
  }

  // Hand the TEXT off to the existing textarea, then drop the image. Switching the
  // source back to text makes the existing "De-identify & preview" button the next
  // step — no new downstream code. The text is editable (OCR is imperfect by nature).
  $('rawText').value = text;
  ocrCleanup();
  setSrc('text');
  renderOcr({ done: true, empty: !text });
  $('rawText').focus();
}

function renderOcr(st) {
  const wrap = $('ocrWrap');
  if (!wrap) return;
  if (st.error) {
    wrap.innerHTML = `<div class="ocr"><div class="ocr-note bad">Couldn't read that image on-device. Try a clearer, well-lit photo.</div>
      <div class="ocr-tools"><button class="mtool" onclick="retakeOcr()">Try another photo</button></div></div>`;
    return;
  }
  if (st.done) {
    wrap.innerHTML = `<div class="ocr">
      <div class="ocr-note">📄 Text was read <b>on this device</b> from the image — the photo was not uploaded or saved, and has been discarded. ${st.empty ? 'No text was found — type the update or try another photo.' : 'Review and edit it below before continuing; it is not verified.'}</div>
      <div class="ocr-tools"><button class="mtool" onclick="retakeOcr()">Retake / new photo</button></div></div>`;
    return;
  }
  // in-progress
  wrap.innerHTML = `<div class="ocr">
    <div class="ocr-row">
      <img class="ocr-thumb" src="${st.thumb}" alt="lab slip preview">
      <div class="ocr-prog">
        <div class="ocr-stage">Reading on device… <span id="ocrPct">0%</span></div>
        <div class="ocr-track"><div class="ocr-bar" id="ocrBar" style="width:0%"></div></div>
        <div class="ocr-hint">The image stays on this phone. Only the text you confirm later leaves it.</div>
      </div>
    </div></div>`;
}

function retakeOcr() {
  ocrCleanup();
  $('ocrWrap').innerHTML = '';
  $('ocrFile').click();
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
    if (o.na != null) add('na', 'Sodium', (p.na || []).length ? p.na[p.na.length - 1] : '—', o.na, o.na < 130 ? 'bad' : o.na < 135 ? 'warn' : 'good', o.na < 130);
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
    commitPatient(p, g.changes, todayMMDD());   // tested module does the work
    if (p.snapshots.length > before) { applied += g.changes.filter((c) => c.apply).length; await store.savePatient(p); }
  }
  $('deidWrap').innerHTML = ''; $('trayWrap').innerHTML = ''; state.deid = null;
  await loadPatients();
  goTab('today');
  toast(applied + ' change' + (applied > 1 ? 's' : '') + ' committed', '✓');
}

// ============================ Add / reset ============================
function closeAdd() {
  $('scrim2').classList.remove('show'); $('addsheet').classList.remove('show');
  state.editingId = null;
}

// The Add-Patient dropdown lists hospitals by FULL NAME (where a wrong choice has
// consequences), in route order, from the managed list.
function fillHospitalSelect() {
  const sel = $('f_hosp'); if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = state.hospitals.map((h) => `<option>${esc(h.name)}</option>`).join('');
  if (state.hospitals.some((h) => h.name === prev)) sel.value = prev;
}

async function resetDemo() {
  await store.wipePatients();
  // Reset the hospital list to the real seed too, so the reseeded demo patients
  // (which use real full names) group correctly under the listed hospitals.
  state.hospitals = SEED_HOSPITALS.map((h) => ({ ...h }));
  await store.setHospitals(state.hospitals);
  for (const p of seedPatients()) await store.savePatient(p);
  await loadPatients(); renderToday(); toast('Demo data reseeded', '✓');
}

function openAdd() {
  state.editingId = null;
  $('addSheetTitle').textContent = 'Add patient';
  $('btnDeletePatient').style.display = 'none';
  
  ['f_name', 'f_age', 'f_day', 'f_dx', 'f_detail', 'f_room'].forEach((i) => ($(i).value = ''));
  $('f_sex').value = 'M';
  
  fillHospitalSelect(); 
  $('scrim2').classList.add('show'); 
  $('addsheet').classList.add('show'); 
}

// Opens the sheet pre-filled with the current patient's data
function openEdit() {
  const p = state.byId[state.currentId]; 
  if (!p) return;
  
  state.editingId = p.id;
  $('addSheetTitle').textContent = 'Edit patient';
  $('btnDeletePatient').style.display = 'block';

  $('f_name').value = p.name || '';
  $('f_age').value = p.age || '';
  $('f_sex').value = p.sex || 'M';
  $('f_day').value = p.day || '';
  $('f_dx').value = p.dx || '';
  $('f_detail').value = p.detail || '';
  $('f_room').value = p.room || '';

  fillHospitalSelect();
  if (state.hospitals.some((h) => h.name === p.hospital)) {
    $('f_hosp').value = p.hospital;
  }

  $('scrim2').classList.add('show'); 
  $('addsheet').classList.add('show');
}

async function savePatient() {
  const g = (id) => $(id).value.trim();
  const name = g('f_name'); if (!name) { toast('Name is required'); return; }

  const wasEdit = !!state.editingId;
  let p;
  if (wasEdit) {
    // Edit mode: mutate the existing patient record
    p = state.byId[state.editingId];
    p.name = name;
    p.age = g('f_age');
    p.sex = g('f_sex');
    p.day = g('f_day') || '1';
    p.dx = g('f_dx');
    p.detail = g('f_detail');
    p.hospital = g('f_hosp');
    p.room = g('f_room');
  } else {
    // Add mode: create a brand new record
    p = newPatient({
      name, age: g('f_age'), sex: g('f_sex'), dx: g('f_dx'), day: g('f_day') || '1', detail: g('f_detail'),
      hospital: g('f_hosp'), room: g('f_room'), triage: 'g',
      scores: [{ l: 'GCS', v: '15', a: '' }],
      ask: [{ q: 'Bowel movement', s: '', t: ['Yes', 'No'], on: 0, k: 'pos' }, { q: 'Sleep', s: '', t: ['Good', 'Poor'], on: 0, k: 'pos' }],
      vitals: [['BP', '—'], ['HR', '—'], ['RR', '—'], ['TEMP', '—'], ['SPO₂', '—']],
    });
  }

  await store.savePatient(p); // store.js encrypts it before saving
  closeAdd();
  await loadPatients();
  renderToday();

  // If we edited from the Round Card, refresh the card UI seamlessly
  if (wasEdit && state.currentId === p.id) openCard(p.id);

  toast(wasEdit ? 'Patient updated' : 'Encrypted & saved', '✓');
}

async function doDeletePatient() {
  if (!state.editingId) return;
  const p = state.byId[state.editingId];
  
  // Native confirm is ugly but perfect for a fast, zero-dependency safety check
  if (!confirm(`Are you sure you want to delete ${p.name}?\n\nThis will permanently remove their record and history from this device.`)) return;

  await store.deletePatient(state.editingId);
  closeAdd();
  closeCard(); // Close the Round Card since the patient no longer exists
  await loadPatients();
  renderToday();
  toast('Patient deleted');
}

// ============================ Manage hospitals ============================
// A focused sheet (NOT a full Settings screen) to add / remove / reorder the
// hospital list. Full name is the source of truth; here we show full name WITH
// its abbreviation. Reordering uses move-up / move-down (no drag-and-drop).
function openHospitals() { renderHospitals(); $('hospScrim').classList.add('show'); $('hospsheet').classList.add('show'); }
function closeHospitals() { $('hospScrim').classList.remove('show'); $('hospsheet').classList.remove('show'); }

function renderHospitals() {
  const rows = state.hospitals.map((h, i) => `
    <div class="hosp-row">
      <div class="hosp-id"><div class="hosp-nm">${esc(h.name)}</div><div class="hosp-ab">${esc(h.abbr || '— no abbreviation')}</div></div>
      <div class="hosp-ctl">
        <button class="iconbtn" title="Move up" ${i === 0 ? 'disabled' : ''} onclick="hospMove(${i},-1)">↑</button>
        <button class="iconbtn" title="Move down" ${i === state.hospitals.length - 1 ? 'disabled' : ''} onclick="hospMove(${i},1)">↓</button>
        <button class="iconbtn danger" title="Remove" onclick="hospRemove(${i})">✕</button>
      </div>
    </div>`).join('');
  $('hospsheet').innerHTML = `
    <div class="grab"></div>
    <h2>Manage hospitals</h2>
    <div class="lead">Route order, top to bottom. The full name is stored on each patient; the abbreviation is the short label shown on the census and round card.</div>
    <div class="form">
      <div class="hosp-list">${rows || '<div class="lead" style="padding-left:0">No hospitals yet — add one below.</div>'}</div>
      <div class="hosp-add">
        <div class="frow">
          <div class="field" style="flex:2"><label>Full name</label><input id="h_name" placeholder="The Medical City Pangasinan"></div>
          <div class="field"><label>Abbreviation</label><input id="h_abbr" placeholder="TMCP"></div>
        </div>
        <button class="btn primary" onclick="hospAdd()">Add hospital</button>
      </div>
    </div>
    <div class="formbtns"><button class="btn ghost" onclick="closeHospitals()">Done</button></div>`;
}

async function persistHospitals() {
  await store.setHospitals(state.hospitals);
  renderHospitals();
  renderToday();
}
async function hospAdd() {
  const name = $('h_name').value.trim();
  if (!name) { toast('Hospital name is required'); return; }
  state.hospitals = addHospital(state.hospitals, name, $('h_abbr').value);
  await persistHospitals();
  toast('Hospital added', '✓');
}
async function hospRemove(i) { state.hospitals = removeHospital(state.hospitals, i); await persistHospitals(); }
async function hospMove(i, dir) { state.hospitals = moveHospital(state.hospitals, i, dir); await persistHospitals(); }

// ============================ Backup & restore ============================
// A focused sheet (NOT a full Settings screen) for an ENCRYPTED, portable backup.
// SAFETY (see CLAUDE.md): the file is always encrypted under a SEPARATE strong
// recovery passphrase (never the daily PIN, never stored); it is downloaded for
// the user to keep — never uploaded. Restore snapshots the current vault first
// and is undoable. This file does file I/O + confirmations only; the envelope
// crypto is in lib/backup.js and the atomic swap is in lib/store.js.

const freshRestore = () => ({ step: 'idle', fileName: null, fileText: null, env: null, payload: null, pass: null });
let restore = freshRestore();

function daysAgoLabel(ts) {
  const ms = Date.now() - ts;
  const d = Math.floor(ms / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

// The gentle Today-screen nudge. Stronger wording the longer it's been (or never).
function renderBackupNudge() {
  const el = $('backupNudge');
  if (!el) return;
  if (!state.patients.length) { el.style.display = 'none'; return; }
  const ts = state.lastBackupAt;
  let cls = 'ok', txt;
  if (!ts) { cls = 'warn'; txt = 'No backup yet — protect against a lost phone or forgotten passcode.'; }
  else {
    const days = Math.floor((Date.now() - ts) / 86_400_000);
    txt = `Last backup: ${daysAgoLabel(ts)}.`;
    if (days >= 7) { cls = 'warn'; txt += ' Consider making a fresh one.'; }
  }
  el.className = `backup-nudge ${cls}`;
  el.innerHTML = `<span class="bn-i">💾</span><div>${esc(txt)}</div><span class="bn-go">Backup ›</span>`;
  el.style.display = 'flex';
}

function openBackup() { restore = freshRestore(); renderBackup(); $('bkScrim').classList.add('show'); $('bksheet').classList.add('show'); }
function closeBackup() { $('bkScrim').classList.remove('show'); $('bksheet').classList.remove('show'); }
function pickBackupFile() { $('bkFile').click(); }

function renderBackup() {
  // Re-rendering rebuilds the inputs — carry typed passphrases across so picking
  // a file (which re-renders) doesn't wipe what the user already entered.
  const keepPass = $('bk_pass') ? $('bk_pass').value : '';
  const keepRpass = $('bk_rpass') ? $('bk_rpass').value : '';
  const lastTxt = state.lastBackupAt
    ? `Last backup: <b>${esc(daysAgoLabel(state.lastBackupAt))}</b>.`
    : 'You have <b>no backup yet</b>.';

  // The restore half changes with the step in the flow.
  let restoreInner = '';
  if (restore.step === 'previewed' && restore.payload) {
    const when = restore.env?.createdAt ? new Date(restore.env.createdAt).toLocaleString() : 'unknown date';
    restoreInner = `
      <div class="bk-preview">
        <div class="bk-pv-h">This backup contains</div>
        <div class="bk-pv-row"><span>Created</span><b>${esc(when)}</b></div>
        <div class="bk-pv-row"><span>Patients</span><b>${restore.payload.patients.length}</b></div>
        <div class="bk-pv-row"><span>Hospitals</span><b>${restore.payload.hospitals.length}</b></div>
      </div>
      <div class="bk-warn">Restoring <b>replaces</b> all current patients and your hospital list. Your current data is snapshotted first, so you can undo this immediately after.</div>
      <div class="frow">
        <button class="btn ghost" onclick="cancelRestore()">Cancel</button>
        <button class="btn primary danger" onclick="doRestoreApply()">Replace my data</button>
      </div>`;
  } else if (restore.step === 'restored') {
    restoreInner = `
      <div class="bk-ok">✓ Restored ${restore.payload ? restore.payload.patients.length : ''} patient(s). Your previous data was saved — undo if this was a mistake.</div>
      <div class="frow">
        <button class="btn ghost" onclick="doUndoRestore()">Undo restore</button>
        <button class="btn primary" onclick="closeBackup()">Done</button>
      </div>`;
  } else {
    const fileLabel = restore.fileName ? `Selected: <b>${esc(restore.fileName)}</b>` : 'No file chosen';
    restoreInner = `
      <button class="btn ghost" onclick="pickBackupFile()">Choose backup file…</button>
      <div class="bk-file">${fileLabel}</div>
      <div class="field"><label>Recovery passphrase</label>
        <input id="bk_rpass" type="password" placeholder="the passphrase you set for this backup" autocomplete="off"></div>
      <button class="btn primary" onclick="doRestorePreview()" ${restore.fileText ? '' : 'disabled'}>Decrypt &amp; preview</button>`;
  }

  $('bksheet').innerHTML = `
    <div class="grab"></div>
    <h2>Backup &amp; restore</h2>
    <div class="lead">${lastTxt} A backup is a single <b>encrypted</b> file you keep yourself — it is never uploaded anywhere.</div>

    <div class="bk-sect">
      <div class="bk-sect-h">Create a backup</div>
      <div class="bk-note">Protect it with a <b>strong recovery passphrase</b> — not your daily 6-digit passcode. The file is portable, so a short PIN could be cracked offline. Use 4+ words or 12+ characters. The passphrase is <b>never stored</b>; if you lose it the backup can't be opened.</div>
      <div class="field"><label>Recovery passphrase</label>
        <input id="bk_pass" type="password" placeholder="e.g. four random unrelated words" autocomplete="off"></div>
      <button class="btn primary" onclick="doBackupExport()">Create encrypted backup</button>
    </div>

    <div class="bk-sect">
      <div class="bk-sect-h">Restore from a backup</div>
      <div class="bk-note">Restore onto this phone or a brand-new install. You'll see what the file contains and confirm before anything changes.</div>
      ${restoreInner}
    </div>

    <div class="formbtns"><button class="btn ghost" onclick="closeBackup()">Close</button></div>`;

  if ($('bk_pass') && keepPass) $('bk_pass').value = keepPass;
  if ($('bk_rpass') && keepRpass) $('bk_rpass').value = keepRpass;
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Hand the backup file to the user. In the INSTALLED iOS PWA (standalone mode) a
 * programmatic anchor download is unreliable and can fail silently — which would
 * let us record "backed up" for a file that never landed anywhere. There we use
 * the native share sheet ("Save to Files"); everywhere else the normal download.
 * Returns false if the user cancelled (no backup happened — don't record one).
 * Sharing goes to a destination THE USER picks; the app itself uploads nothing.
 */
async function deliverBackupFile(text, filename) {
  const standalone = navigator.standalone === true; // iOS home-screen install
  if (standalone && navigator.canShare) {
    const file = new File([text], filename, { type: 'application/json' });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) {
        if (e && e.name === 'AbortError') return false; // user cancelled
        // share failed for another reason — fall through to the anchor download
      }
    }
  }
  downloadText(text, filename);
  return true;
}

async function doBackupExport() {
  const pass = $('bk_pass').value;
  const s = passphraseStrength(pass);
  if (!s.ok) { toast(s.reason); return; }
  const payload = { patients: state.patients, hospitals: state.hospitals };
  let text;
  try {
    const env = await createBackup(payload, pass);
    text = JSON.stringify(env, null, 2);
    // VERIFY-AFTER-WRITE: decrypt the exact bytes we're about to save, with the
    // same passphrase, BEFORE claiming success. A backup that can't be read back
    // is worse than none.
    const check = await readBackup(text, pass);
    if (check.patients.length !== payload.patients.length
        || check.hospitals.length !== payload.hospitals.length) {
      throw new Error('verification mismatch');
    }
  } catch (e) {
    toast('Backup failed verification — nothing was saved.');
    return;
  }
  const delivered = await deliverBackupFile(text, `rounds-backup-${new Date().toISOString().slice(0, 10)}.rcbackup`);
  if (!delivered) { toast('Backup cancelled — nothing was saved.'); return; }
  const ts = Date.now();
  await store.setLastBackupAt(ts);
  state.lastBackupAt = ts;
  renderBackup(); renderBackupNudge();
  toast('Encrypted backup verified & saved', '✓');
}

async function handleBackupFile(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = ''; // allow re-selecting the same file later
  if (!f) return;
  restore = freshRestore();
  restore.fileName = f.name;
  try {
    restore.fileText = await f.text();
    try { restore.env = JSON.parse(restore.fileText); } catch { restore.env = null; }
  } catch { toast('Could not read that file.'); return; }
  renderBackup();
}

async function doRestorePreview() {
  if (!restore.fileText) { toast('Choose a backup file first'); return; }
  const pass = $('bk_rpass').value;
  if (!pass) { toast('Enter the recovery passphrase'); return; }
  try {
    const payload = await readBackup(restore.fileText, pass);
    restore.payload = payload;
    restore.pass = pass;
    restore.step = 'previewed';
    renderBackup();
  } catch (e) {
    // Typed BackupError messages are user-facing; anything else is generic.
    toast(e instanceof BackupError ? e.message : 'Could not read this backup file.');
  }
}

async function doRestoreApply() {
  if (!restore.payload) return;
  try {
    await store.replaceVault(restore.payload.patients, restore.payload.hospitals);
    await loadPatients();
    renderToday();
    restore.step = 'restored';
    renderBackup();
  } catch (e) {
    toast('Restore failed — your data is unchanged.');
  }
}

async function doUndoRestore() {
  const ok = await store.undoRestore();
  if (!ok) { toast('Nothing to undo'); return; }
  await loadPatients();
  renderToday();
  restore = freshRestore();
  renderBackup();
  toast('Restore undone — your previous data is back', '✓');
}

function cancelRestore() { restore = freshRestore(); renderBackup(); }

// ============================ toast ============================
let tt;
function toast(m, ok) { const t = $('toast'); t.innerHTML = (ok ? `<span class="ok">${ok}</span>` : '') + m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 1800); }

// ---- expose handlers for inline onclick in index.html ----
Object.assign(window, { lockApp, goTab, openCard, closeCard, openTimeline, closeTimeline, pick, neuroStep, setSrc, runDeid, runParse, toggleChange, commitReview, openAdd, closeAdd, savePatient, openEdit, doDeletePatient,resetDemo, toast, motorPick, motorSet, motorSetAll5, motorRecord, closeMpick, openSeizureForm, closeSeizureForm, saveSeizure, szPickType, szPickTrigger, szToggleFeature, szSetWitnessed, szSetResponded, openStrokeForm, closeStrokeForm, saveStrokeClock, scPickType, deactivateStrokeClock, handleOcrFile, retakeOcr, openHospitals, closeHospitals, hospAdd, hospRemove, hospMove,
  openBackup, closeBackup, pickBackupFile, doBackupExport, handleBackupFile,
  doRestorePreview, doRestoreApply, doUndoRestore, cancelRestore,
  openValueEdit, closeValueEdit, saveValueEdit,
  openMedForm, closeMedForm, medSetWarn, saveMed, deleteMed });

// ---- register the PWA service worker (added by vite-plugin-pwa on build) ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ---- boot ----
bootLock();
