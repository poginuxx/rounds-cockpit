/**
 * schema.js — the single source of truth for a patient record.
 *
 * Every other module (store, parser, diff, screens) reads and writes this shape.
 * If you change the shape, change it HERE and update the tests.
 */

import { defaultWindows } from './strokeclock.js';

/** Create an empty patient with sane defaults. */
export function newPatient(fields = {}) {
  return {
    id: fields.id || 'p_' + Date.now(),
    name: '', age: '', sex: 'M',
    dx: '', day: '1', detail: '',
    hospital: '', room: '',
    triage: 'g',           // 'g' | 'a' | 'r' — derived by diff.js, not set by hand
    flags: [],             // census chips: [{ t, lv }]  lv: '' | 'warn' | 'bad'
    overnight: null,       // digest entry: { who, txt, k, tail } | null
    newCount: 0,
    ready: false,
    scores: [],            // [{ l, v, a, d }]  a: '' | 'dn' | 'up'
    ask: [],               // [{ q, s, t:[...], on, k }]  k: 'pos' | 'neg' | 'neu'
    na: [], naLabel: '',   // sodium trend series + axis label
    k: { v: '—', s: '3.5–5.1' },
    osmo: { v: '—', s: '' },
    vitals: [],            // [[label, value], ...] labels: BP HR RR TEMP SPO₂
    meds: [],              // [{ n, d, day, w }]
    doMain: { t: 'Set plan', s: 'new admission' },
    snapshots: [],         // [{ date, na, rr, spo2, temp }] — drives diff.js
    motorExams: [],        // [{ date, cells:{ 'UL.shoulderAbd.R':'4', ... } }] — MRC grid.
                           //   cell values are strings ('0'..'5','4-','4+'); an ABSENT
                           //   key means NOT TESTED (never auto-filled to a normal score).
    seizures: [],          // [{ id, onset (ISO datetime), durationSec, type, features:[],
                           //   trigger, rescueMed, rescueResponded:bool|null, witnessed:bool,
                           //   note }] — APPEND-ONLY, manual-entry-only (see lib/seizures.js).
                           //   Never written by the parser or the Ask toggle, by design.
    strokeClock: null,     // OFF until the physician activates it (neuro module #4).
                           //   When active: { lastKnownWell (ISO), onsetDiscovered
                           //   (ISO|null), type:'ischemic'|'hemorrhagic'|'undetermined',
                           //   windows:[{ id, label, minutes, kind, note }] }. The anchor
                           //   is LAST KNOWN WELL — never inferred from admission/parsed/
                           //   automated data. Treatment windows are reference thresholds,
                           //   NOT eligibility (see lib/strokeclock.js). Physician-set only.
    ...fields,
  };
}

/**
 * Backfill a patient's snapshots[] from their existing sodium series so the
 * timeline shows the real multi-day trajectory immediately. The snapshot SHAPE
 * is unchanged ({ date, na, rr, spo2, temp }) — this only populates more days.
 * One reading per day, ending on the latest date in naLabel; the final day
 * keeps any vitals the original seed snapshot already carried.
 */
function backfillSnapshots(p) {
  const na = p.na || [];
  if (na.length < 2) return p.snapshots || [];
  const end = parseEnd(p.naLabel);                 // {mm, dd} of the latest reading
  const last = (p.snapshots || [])[(p.snapshots || []).length - 1] || {};
  return na.map((v, i) => {
    const back = na.length - 1 - i;                // days before the latest reading
    const snap = { date: stepBack(end, back), na: v };
    if (i === na.length - 1) {                      // newest day inherits seed vitals
      if (last.rr != null) snap.rr = last.rr;
      if (last.spo2 != null) snap.spo2 = last.spo2;
      if (last.temp != null) snap.temp = last.temp;
    }
    return snap;
  });
}
/**
 * Overlay seed-only neuro day-series (gcs[], nihss[]) onto the backfilled
 * snapshots, aligned oldest→newest by index. The series live on the seed
 * literal only — they are deleted from the stored record so the canonical
 * snapshot shape ({ date, na, ... , gcs?, nihss? }) stays clean.
 */
function attachNeuro(np, gcs, nihss) {
  (np.snapshots || []).forEach((s, i) => {
    if (gcs && gcs[i] != null) s.gcs = gcs[i];
    if (nihss && nihss[i] != null) s.nihss = nihss[i];
  });
  delete np.gcs;
  delete np.nihss;
}
function parseEnd(label) {
  const m = String(label || '').match(/(\d{1,2})\/(\d{1,2})\s*$/);
  return m ? { mm: +m[1], dd: +m[2] } : { mm: 6, dd: 16 };
}
function stepBack({ mm, dd }, days) {
  const d = new Date(2026, mm - 1, dd);
  d.setDate(d.getDate() - days);
  return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
}

/**
 * ISO datetime `hours` before now. Seed seizures use this (not the app's fake
 * '06/17' date strings) so the "Seizure-free Xh" interval stays realistic
 * whenever the app is opened — see lib/seizures.js.
 */
function hoursAgoISO(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

/** Hospitals in physical round order. Editable per user. */
export const HOSPITALS = [
  'Region I Medical Center',
  'Gov. T. Sison Memorial',
  'Nazareth General Hospital',
];

/** Sample roster used for the demo. Replace via real intake before using clinically. */
export function seedPatients() {
  return [
    { id:'p_ramon', name:'Ramon dela Cruz', age:'54', sex:'M', dx:'Aneurysmal SAH', day:'5', detail:'Hunt-Hess 3',
      hospital:'Region I Medical Center', room:'408', triage:'r', newCount:3,
      overnight:{ who:'Ramon dela Cruz', txt:'Na fell to ', k:'128', tail:', vasospasm watch' },
      flags:[{t:'Na 128 ↓',lv:'bad'},{t:'HA severe',lv:'warn'}],
      scores:[{l:'GCS',v:'13',a:'',d:true},{l:'WFNS',v:'3',a:''},{l:'NA',v:'128',a:'dn',d:true}],
      gcs:[15,15,14,14,13],
      ask:[{q:'Headache',s:'thunderclap → now severe',t:['Better','Same','Worse'],on:2,k:'neg'},
           {q:'Bowel movement',s:'last: yesterday',t:['Yes','No'],on:0,k:'pos'},
           {q:'Sleep',s:'',t:['Good','Poor'],on:1,k:'neg'},
           {q:'New focal deficit',s:'screen for vasospasm',t:['No','Yes'],on:0,k:'pos'}],
      na:[136,134,132,130,128], naLabel:'06/12 → 06/16', k:{v:'3.9',s:'3.5–5.1'}, osmo:{v:'268',s:'low · ?SIADH vs CSW'},
      vitals:[['BP','148/86'],['HR','78'],['RR','18'],['TEMP','37.2'],['SPO₂','98%']],
      meds:[{n:'Nimodipine',d:'60mg q4h',day:'D5·21',w:false},{n:'3% NaCl',d:'infusion',day:'started',w:true},
            {n:'Levetiracetam',d:'500mg BID',day:'D5',w:false},{n:'Paracetamol',d:'PRN',day:'PRN',w:false}],
      doMain:{t:'Repeat Na in 6h',s:'hyponatremia — confirm CSW vs SIADH'},
      snapshots:[{date:'06/16',na:128}] },

    { id:'p_aurora', name:'Aurora Mendoza', age:'67', sex:'F', dx:'L MCA infarct', day:'3', detail:'NIHSS 6',
      hospital:'Region I Medical Center', room:'412', triage:'a', newCount:2,
      overnight:{ who:'Aurora Mendoza', txt:'', k:'no BM ×2 days', tail:'' },
      flags:[{t:'Na 131 ↓',lv:'warn'},{t:'No BM ×2',lv:'bad'}],
      scores:[{l:'NIHSS',v:'6',a:'dn'},{l:'GCS',v:'15',a:''},{l:'NA',v:'131',a:'dn'}],
      gcs:[15,15,15,15,15], nihss:[10,9,8,7,6],
      ask:[{q:'Bowel movement',s:'⚑ none ×2 days',t:['Yes','No'],on:1,k:'neg'},
           {q:'Sleep',s:'',t:['Good','Poor'],on:1,k:'neg'},
           {q:'Swallowing',s:'dysphagia screen',t:['Safe','Watch'],on:1,k:'neu'},
           {q:'Arm strength',s:'R upper limb',t:['Improving','Same'],on:0,k:'pos'}],
      na:[138,136,134,132,131], naLabel:'06/14 → 06/16', k:{v:'4.1',s:'3.5–5.1'}, osmo:{v:'—',s:'not drawn today'},
      vitals:[['BP','156/90'],['HR','72'],['RR','16'],['TEMP','36.8'],['SPO₂','99%']],
      meds:[{n:'Aspirin',d:'80mg OD',day:'D3',w:false},{n:'Atorvastatin',d:'40mg HS',day:'D3',w:false},{n:'Citicoline',d:'1g BID',day:'D3',w:false}],
      doMain:{t:'Order lactulose + senna',s:'no BM ×2 days · constipation'},
      snapshots:[{date:'06/16',na:131}],
      // L MCA infarct → contralateral RIGHT-sided weakness; left limbs normal.
      // Two dated exams with a small right-arm recovery so the trend is visible.
      // R ankle dorsiflexion is genuinely not tested (absent key) — renders '—'.
      motorExams:[
        { date:'06/15', cells:{
          'UL.shoulderAbd.L':'5','UL.elbowFlex.L':'5','UL.elbowExt.L':'5','UL.wristExt.L':'5','UL.fingerAbd.L':'5',
          'LL.hipFlex.L':'5','LL.kneeExt.L':'5','LL.kneeFlex.L':'5','LL.ankleDorsi.L':'5','LL.anklePlantar.L':'5',
          'UL.shoulderAbd.R':'3','UL.elbowFlex.R':'3','UL.elbowExt.R':'3','UL.wristExt.R':'2','UL.fingerAbd.R':'2',
          'LL.hipFlex.R':'3','LL.kneeExt.R':'4-','LL.kneeFlex.R':'4-','LL.anklePlantar.R':'4' } },
        { date:'06/16', cells:{
          'UL.shoulderAbd.L':'5','UL.elbowFlex.L':'5','UL.elbowExt.L':'5','UL.wristExt.L':'5','UL.fingerAbd.L':'5',
          'LL.hipFlex.L':'5','LL.kneeExt.L':'5','LL.kneeFlex.L':'5','LL.ankleDorsi.L':'5','LL.anklePlantar.L':'5',
          'UL.shoulderAbd.R':'4-','UL.elbowFlex.R':'4-','UL.elbowExt.R':'3','UL.wristExt.R':'3','UL.fingerAbd.R':'2',
          'LL.hipFlex.R':'3','LL.kneeExt.R':'4-','LL.kneeFlex.R':'4-','LL.anklePlantar.R':'4' } },
      ],
      // ISCHEMIC stroke clock, physician-activated. Last known well is anchored
      // ~5 h before now so the demo shows the MIX of states the module is for:
      // IV 4.5 h PASSED, MT 6 h still open (~1 h left), MT-24 h open. The value is
      // ILLUSTRATIVE ONLY — a genuine Day-3 admission would not be acutely in-window;
      // this is a seed so the live count-up + window states render on first open.
      strokeClock:{ lastKnownWell:hoursAgoISO(5), onsetDiscovered:hoursAgoISO(2),
        type:'ischemic', windows:defaultWindows() } },

    { id:'p_lourdes', name:'Lourdes Bautista', age:'72', sex:'F', dx:'Epilepsy, breakthrough GTC', day:'2', detail:'',
      hospital:'Gov. T. Sison Memorial', room:'215', triage:'g', newCount:0, overnight:null, ready:true,
      flags:[{t:'seizure-free 36h',lv:''}],
      scores:[{l:'GCS',v:'15',a:''},{l:'SZ-FREE',v:'36h',a:'dn'},{l:'NA',v:'140',a:''}],
      gcs:[15,15,15,15,15],
      ask:[{q:'Any seizures',s:'since last visit',t:['No','Yes'],on:0,k:'pos'},
           {q:'Aura',s:'',t:['No','Yes'],on:0,k:'pos'},
           {q:'Sleep',s:'',t:['Good','Poor'],on:0,k:'pos'},
           {q:'Med adherence understood',s:'discharge counseling',t:['Yes','No'],on:0,k:'pos'}],
      na:[137,139,140,140,140], naLabel:'06/15 → 06/16', k:{v:'4.4',s:'3.5–5.1'}, osmo:{v:'—',s:'normal'},
      vitals:[['BP','124/78'],['HR','68'],['RR','15'],['TEMP','36.6'],['SPO₂','99%']],
      meds:[{n:'Levetiracetam',d:'1g BID',day:'D2',w:false},{n:'Folic acid',d:'5mg OD',day:'D2',w:false}],
      doMain:{t:'Generate PhilHealth packet',s:'ready for discharge',bill:true},
      snapshots:[{date:'06/16',na:140}],
      // Breakthrough-GTC patient: a manually-logged seizure history, timestamped
      // RELATIVE to now so "Seizure-free ~36h" renders whenever the app opens.
      // The earlier focal event was reported by family (not witnessed) and carries
      // no trigger (absent → unknown, never auto-filled). These are seed examples
      // of MANUAL entries; nothing automated appends here.
      seizures:[
        { id:'sz_lourdes_1', onset:hoursAgoISO(24*9), durationSec:40,
          type:'focal impaired awareness', features:['automatisms'], trigger:null,
          rescueMed:null, rescueResponded:null, witnessed:false, note:'reported by family' },
        { id:'sz_lourdes_2', onset:hoursAgoISO(36), durationSec:95,
          type:'generalized tonic-clonic',
          features:['post-ictal confusion','tongue bite','incontinence'],
          trigger:'missed meds', rescueMed:'Lorazepam 4mg IV', rescueResponded:true,
          witnessed:true, note:'breakthrough GTC at home' },
      ] },

    { id:'p_efren', name:'Efren Villaraza', age:'45', sex:'M', dx:'Guillain-Barré', day:'6', detail:'',
      hospital:'Nazareth General Hospital', room:'302', triage:'a', newCount:0, overnight:null,
      flags:[{t:'FVC watch',lv:'warn'},{t:'IVIG D4·5',lv:''}],
      scores:[{l:'FVC',v:'1.8L',a:'dn',d:true},{l:'GCS',v:'15',a:''},{l:'NA',v:'137',a:''}],
      gcs:[15,15,15,15,15],
      ask:[{q:'Breathing / single-breath count',s:'⚑ trend down',t:['≥20','<20'],on:1,k:'neg'},
           {q:'Swallowing secretions',s:'',t:['Safe','Watch'],on:1,k:'neu'},
           {q:'Bowel movement',s:'',t:['Yes','No'],on:0,k:'pos'},
           {q:'Sleep',s:'',t:['Good','Poor'],on:1,k:'neg'}],
      na:[139,138,138,137,137], naLabel:'06/12 → 06/16', k:{v:'4.0',s:'3.5–5.1'}, osmo:{v:'—',s:'normal'},
      vitals:[['BP','138/84'],['HR','96'],['RR','22'],['TEMP','37.0'],['SPO₂','96%']],
      meds:[{n:'IVIG',d:'0.4g/kg/d',day:'D4·5',w:false},{n:'Enoxaparin',d:'40mg OD',day:'D6',w:false}],
      doMain:{t:'Flag for ICU review',s:'FVC 1.8L & falling — pre-empt respiratory failure'},
      snapshots:[{date:'06/16',na:137,rr:22,spo2:96}] },

    { id:'p_carmela', name:'Carmela Soriano', age:'60', sex:'F', dx:'Bacterial meningitis', day:'4', detail:'',
      hospital:'Nazareth General Hospital', room:'310', triage:'g', newCount:0, overnight:null,
      flags:[{t:'afebrile 24h',lv:''},{t:'Ceftriaxone D4·14',lv:''}],
      scores:[{l:'GCS',v:'15',a:''},{l:'TEMP',v:'36.9',a:'dn'},{l:'NA',v:'136',a:''}],
      gcs:[14,15,15,15,15],
      ask:[{q:'Headache',s:'',t:['Better','Same','Worse'],on:0,k:'pos'},
           {q:'Neck stiffness',s:'',t:['Better','Same'],on:0,k:'pos'},
           {q:'Bowel movement',s:'',t:['Yes','No'],on:0,k:'pos'},
           {q:'Sleep',s:'',t:['Good','Poor'],on:0,k:'pos'}],
      na:[133,134,135,136,136], naLabel:'06/13 → 06/16', k:{v:'4.2',s:'3.5–5.1'}, osmo:{v:'—',s:'normal'},
      vitals:[['BP','118/74'],['HR','80'],['RR','16'],['TEMP','36.9'],['SPO₂','99%']],
      meds:[{n:'Ceftriaxone',d:'2g BID',day:'D4·14',w:false},{n:'Dexamethasone',d:'10mg q6h',day:'D4',w:false}],
      doMain:{t:'Continue plan',s:'afebrile 24h — improving on ceftriaxone'},
      snapshots:[{date:'06/16',na:136}] },
  ].map((p) => {
    const np = newPatient(p);
    np.snapshots = backfillSnapshots(np);
    attachNeuro(np, p.gcs, p.nihss);
    return np;
  });
}
