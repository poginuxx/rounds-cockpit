/**
 * deid.js — local de-identification. PURE, no side effects, fully testable.
 *
 * This runs on-device BEFORE any text is sent to a cloud parser. It swaps known
 * patient names for tokens ([PT1]…), and redacts rooms/beds and long ID numbers.
 * The token→id map it returns is the re-identification key and MUST stay on device.
 *
 * IMPORTANT: de-identification reduces but does not eliminate re-identification
 * risk. Rare diagnosis + hospital + age can still narrow a person down. The UI
 * shows the user the exact outbound payload so they can judge before sending.
 */

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text  raw nurse update (may mention several patients)
 * @param {Array<{id:string,name:string}>} roster  known patients to tokenize
 * @returns {{ redacted:string, map:Record<string,string>, removed:Array<{tok,name}> }}
 */
export function deidentify(text, roster) {
  let redacted = text;
  const map = {};
  const removed = [];
  let i = 1;

  // Longest names first so "dela Cruz" matches before "Cruz".
  const sorted = [...roster].sort((a, b) => b.name.length - a.name.length);

  for (const p of sorted) {
    const tok = '[PT' + i + ']';
    const last = p.name.trim().split(/\s+/).slice(-1)[0];
    const reFull = new RegExp(escRe(p.name), 'gi');
    const reLast = new RegExp('\\b' + escRe(last) + '\\b', 'gi');
    let hit = false;
    if (reFull.test(redacted)) { redacted = redacted.replace(reFull, tok); hit = true; }
    else if (reLast.test(redacted)) { redacted = redacted.replace(reLast, tok); hit = true; }
    if (hit) { map[tok] = p.id; removed.push({ tok, name: p.name }); i++; }
  }

  redacted = redacted
    .replace(/\b(?:rm|room|bed)\s*\.?\s*\d+\b/gi, '[ROOM]')
    .replace(/\b\d{6,}\b/g, '[ID]');

  return { redacted, map, removed };
}
