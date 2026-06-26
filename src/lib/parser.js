/**
 * parser.js — turn a de-identified nurse update into structured changes.
 *
 * Two providers behind one interface:
 *   - cloudParse:     sends DE-IDENTIFIED text to Claude, returns structured JSON.
 *   - heuristicParse: PURE on-device regex fallback (offline / no API key).
 *
 * parseUpdate() tries cloud first, falls back to heuristic, and tells you which ran.
 *
 * SAFETY NOTE on the fallback: regex extraction is brittle. It is tuned to
 * UNDER-report rather than guess — a missed value is safe, a fabricated lab value
 * is not. (An earlier version matched the "na" inside "fiNAlly" and invented a
 * sodium of 150; the word-boundary rules below prevent that. Keep that property.)
 *
 * Field shape returned per patient token:
 *   { token, na, bp, hr, rr, spo2, temp, bm, headache, seizure, ready, note }
 */

export async function parseUpdate(redactedText, { getApiKey } = {}) {
  try {
    const apiKey = getApiKey ? await getApiKey() : null;
    if (!apiKey) throw new Error('no api key');
    const parsed = await cloudParse(redactedText, apiKey);
    return { parsed, provider: 'cloud' };
  } catch (e) {
    return { parsed: heuristicParse(redactedText), provider: 'on-device' };
  }
}

/** Calls Claude with DE-IDENTIFIED text only. Never pass raw names here. */
export async function cloudParse(redactedText, apiKey) {
  const prompt =
`Parse this de-identified neurology nurse handover. Patients appear only as tokens like [PT1].
Return ONLY a JSON array (no prose, no markdown fences). One object per patient token:
{"token":"[PT1]","na":number|null,"bp":string|null,"hr":string|null,"rr":string|null,"spo2":string|null,"temp":string|null,"bm":"yes"|"no"|null,"headache":"better"|"same"|"worse"|null,"seizure":true|false|null,"ready":true|null,"note":string}
Include a field only if clearly stated. Text:
${redactedText}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for calling the API directly from a browser. The key lives only
      // in the on-device encrypted vault. For stronger isolation, route through a
      // minimal proxy instead — but that reintroduces a backend.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  const txt = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/```json|```/g, '')
    .trim();
  const arr = JSON.parse(txt);
  if (!Array.isArray(arr)) throw new Error('unexpected shape');
  return arr;
}

/** PURE, deterministic, offline. Conservative by design. */
export function heuristicParse(text) {
  const out = [];
  for (const seg of text.split(/(?=\[PT\d+\])/)) {
    const tm = seg.match(/\[PT\d+\]/);
    if (!tm) continue;
    const o = {
      token: tm[0], na: null, bp: null, hr: null, rr: null, spo2: null,
      temp: null, bm: null, headache: null, seizure: null, ready: null, note: '',
    };
    let m;
    if ((m = seg.match(/\b(?:na|sodium)\b[^.\d]{0,14}(\d{3})\b/i))) o.na = +m[1];
    if ((m = seg.match(/\b(\d{2,3}\/\d{2,3})\b/))) o.bp = m[1];
    if ((m = seg.match(/\bhr\b[^.\d]{0,8}(\d{2,3})\b/i))) o.hr = m[1];
    if ((m = seg.match(/\brr\b[^.\d]{0,8}(\d{2,3})\b/i))) o.rr = m[1];
    if ((m = seg.match(/(?:sats?|spo2|o2\s*sat)\b[^.\d]{0,8}(\d{2,3})/i))) o.spo2 = m[1] + '%';
    if ((m = seg.match(/\b(3[5-9]\.\d|4[01]\.\d)\b/))) o.temp = m[1];

    if (/moved bowels|bowel movement|passed stool|had bm/i.test(seg)) o.bm = 'yes';
    else if (/no bm|no bowel|hasn'?t moved/i.test(seg)) o.bm = 'no';

    if (/headache.{0,15}(severe|worse|worsen)|(severe|worse|worsen).{0,15}headache/i.test(seg)) o.headache = 'worse';
    else if (/headache.{0,15}(improv|better)|(improv|better).{0,15}headache/i.test(seg)) o.headache = 'better';

    if (/seizure[- ]free|no seizure/i.test(seg)) o.seizure = false;
    else if (/seizure|convuls|\bgtc\b/i.test(seg)) o.seizure = true;

    if (/ready|for discharge|going home/i.test(seg)) o.ready = true;

    o.note = seg.replace(/\[PT\d+\]|\[ROOM\]|\[ID\]/g, '').replace(/\s+/g, ' ').trim();
    out.push(o);
  }
  return out;
}
