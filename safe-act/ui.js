'use strict';
// SAFE Act NMLS-to-HR reconciliation screen. Standalone: open index.html directly or serve it. Files never leave this browser.
const $ = s => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat(9)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
const app = $('#app'), pop = $('#pop'), SA = SafeAct;
// from: where the columns in use came from — 'default' map, 'saved' map, or 'chosen' for this review only.
const SRC = { nmls: { title: 'NMLS MU4R extract', short: 'NMLS', files: [], headers: [], map: {}, notFound: [], from: '' }, adp: { title: 'ADP report', short: 'ADP', files: [], headers: [], map: {}, notFound: [], from: '' } };
let result = null, ran = null, stack = [], fwd = [];
const BASIS = { ref: 'SAFE Act / Regulation G', name: 'S.A.F.E. Mortgage Licensing Act - Federal Registration of Residential Mortgage Loan Originators', cite: '12 U.S.C. 5101 et seq.; 12 CFR Part 1007',
  plain: 'A covered institution must require its mortgage loan originators to register with the NMLS Registry and keep the registration current, and must have procedures to confirm the accuracy of that information. This reconciliation compares the registry record (Form MU4R) with the HR record for each originator.' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.className = 'on'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 5000); }
// The job code column is required only while an MLO job code list is in use.
const fieldsFor = side => SA.FIELDS.filter(f => side === 'adp' || !f.adpOnly).map(f => (f.scope ? Object.assign({}, f, { required: codesOn() }) : f));
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return JSON.stringify(store.get(k)) === JSON.stringify(v); } catch (e) { return false; } }, // false: this browser does not allow saving
};
// The field map: which column heading each field is read from. The saved map wins; without one, the defaults (the same names for both files).
const MAP_KEY = side => 'safe-act-map-' + side;
const savedMap = side => { const m = store.get(MAP_KEY(side)); return m && typeof m === 'object' ? m : null; };
// A field the saved map does not mention (one added since it was saved) takes its default heading.
const mapFor = side => { const m = savedMap(side); return Object.fromEntries(fieldsFor(side).map(f => [f.key, String((m && f.key in m ? m[f.key] : SA.DEFAULT_MAP[f.key]) || '')])); };
const headingOf = (side, key) => (SRC[side].map[key] >= 0 ? SRC[side].headers[SRC[side].map[key]] : '');
function applyMap(side, map, from) { const r = SA.resolveMap(SRC[side].headers, map, fieldsFor(side)); SRC[side].map = r.index; SRC[side].notFound = r.notFound; SRC[side].from = from; SRC[side].mapUsed = map; }

// MLO job codes: which ADP job codes are mortgage loan originators. Kept like the field map: saved in this browser, or chosen for one review.
const CODES_KEY = 'safe-act-mlo-codes';
const CODES = { list: [], from: 'none', file: null }; // from: 'none' | 'saved' | 'chosen'; file: { name, hash, rows } when loaded from a CSV
(() => { const s = store.get(CODES_KEY); if (s && Array.isArray(s.list) && s.list.length) Object.assign(CODES, { list: s.list.map(String), from: 'saved', file: s.file || null }); })();
function codesOn() { return CODES.list.length > 0; }
const CODES_FROM = { saved: 'saved in this browser', chosen: 'chosen for this review (not saved)', none: '' };
function setCodes(list, save, file) {
  const seen = new Set(), clean = [];
  for (const c of list) { const t = String(c).trim(), k = SA.stdCode(t); if (k && !seen.has(k)) { seen.add(k); clean.push(t); } }
  let ok = false;
  if (save) ok = store.set(CODES_KEY, clean.length ? { list: clean, file } : null);
  Object.assign(CODES, { list: clean, file: clean.length ? file : null, from: !clean.length ? 'none' : ok ? 'saved' : 'chosen' });
  result = null;
  if (SRC.adp.files.length) applyMap('adp', SRC.adp.mapUsed, SRC.adp.from); // the job code column may now be required
  pop.close(); render();
  if (save) toast(ok ? (clean.length ? 'MLO job codes saved. This browser will use them next time.' : 'MLO job code list cleared.') : 'This browser does not allow saving. The codes apply to this review only.');
  if (SRC.adp.notFound.length) show({ type: 'map' });
}

async function sha256(buf) {
  if (!(window.crypto && crypto.subtle)) return 'not available in this browser';
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function addFiles(side, list) {
  const src = SRC[side]; src.files = []; src.headers = []; result = null;
  for (const file of list) {
    const buf = await file.arrayBuffer(), parsed = SA.parseCsv(new TextDecoder().decode(buf));
    if (!parsed.headers.length) { toast(`${file.name} has no header row.`); continue; }
    if (src.files.length && parsed.headers.join('|') !== src.headers.join('|')) { toast(`${file.name} was not added: its columns differ from ${src.files[0].name}.`); continue; }
    src.headers = parsed.headers;
    src.files.push({ name: file.name, parsed, hash: await sha256(buf) });
  }
  if (!src.files.length) { src.map = {}; src.notFound = []; render(); return; }
  applyMap(side, mapFor(side), savedMap(side) ? 'saved' : 'default');
  render();
  if (src.notFound.length) show({ type: 'map' }); // the map does not fit this file: ask for the columns now
}
const missing = side => fieldsFor(side).filter(f => f.required && !(SRC[side].map[f.key] >= 0));
const ready = () => ['nmls', 'adp'].every(s => SRC[s].files.length && !missing(s).length);
function reconcile() {
  const rows = side => SRC[side].files.flatMap(f => SA.mapRows(f.parsed, SRC[side].map, f.name));
  result = SA.reconcile(rows('nmls'), rows('adp'), codesOn() ? CODES.list : null);
  result.codes = codesOn() ? { list: CODES.list.slice(), from: CODES.from, file: CODES.file } : null; // the list as it was for this run
  ran = new Date(); render();
}

// ---------- one definition of every figure ----------
const inCat = c => result.filter(r => r.category === c);
const withDiff = label => result.filter(r => r.diffs.includes(label));
const person = r => r.nmls || r.adp;
const nameOf = r => { const p = person(r); return `${p.first} ${p.last}`.trim() || '(no name)'; };

function render() {
  const fileCard = side => {
    const src = SRC[side];
    return h('div', null,
      h('h3', null, src.title),
      h('input', { type: 'file', accept: '.csv,.txt,text/csv', multiple: side === 'adp', 'aria-label': src.title, onchange: e => addFiles(side, [...e.target.files]).catch(err => toast(err.message)) }),
      src.files.length ? [
        h('table', null, h('tbody', null, src.files.map(f => h('tr', null, h('td', { class: 'wrap' }, f.name), h('td', { class: 'n nowrap' }, plural(f.parsed.rows.length, 'row')), h('td', { class: 'hide-s' }, h('code', { title: 'SHA-256 ' + f.hash }, f.hash.slice(0, 12))))))),
        src.notFound.length
          ? h('p', { class: 'warn' }, 'Not found in this file: ', src.notFound.map(n => n.want ? `${n.label} (map says “${n.want}”)` : `${n.label} (no column in the map)`).join(', '), '. ',
              h('button', { class: 'link', onclick: () => show({ type: 'map' }) }, 'Choose columns'))
          : h('p', { class: 'mute' }, `${plural(fieldsFor(side).filter(f => src.map[f.key] >= 0).length, 'column')} read, ${({ saved: 'using the saved field map', default: 'using the default field map', chosen: 'chosen for this review (not saved)' })[src.from]}. `,
              h('button', { class: 'link', onclick: () => show({ type: 'map' }) }, 'Check'))
          ,
      ] : h('p', { class: 'mute' }, side === 'adp' ? 'No file chosen. Several ADP files with the same columns may be chosen together.' : 'No file chosen.'));
  };
  const scopeOn = !!(result && result.codes);
  const figRow = (label, n, frame) => h('tr', n ? opens(frame, true) : null, h('td', null, label), h('td', { class: 'n' }, n));
  app.replaceChildren(
    h('header', null, h('b', null, 'SAFE Act'), h('span', { class: 'grow' }, 'NMLS to HR reconciliation'),
      h('button', { onclick: () => show({ type: 'codes' }), title: 'Which ADP job codes are mortgage loan originators' }, 'MLO job codes'),
      h('button', { onclick: () => show({ type: 'map' }), title: 'Which column each field is read from' }, '⇄ Field map'),
      h('button', { class: 'link', onclick: () => show({ type: 'basis' }) }, BASIS.ref)),
    h('main', null,
      h('section', { class: 'card' },
        h('h2', null, 'Source files'),
        h('div', { class: 'files' }, fileCard('nmls'), fileCard('adp')),
        h('p', null, h('button', { class: 'primary', disabled: !ready(), onclick: reconcile }, 'Reconcile'), ' ',
          h('span', { class: 'mute' }, 'Files are read in this browser and are not uploaded. Records are joined on work email.')),
        codesOn()
          ? h('p', { class: 'mute' }, `${plural(CODES.list.length, 'MLO job code')}, ${CODES_FROM[CODES.from]}. ADP rows with another code, no NMLS ID and no matching email are set aside. `, h('button', { class: 'link', onclick: () => show({ type: 'codes' }) }, 'Change'))
          : h('p', { class: 'warn' }, 'No MLO job code list: every ADP row is treated as an originator. ', h('button', { class: 'link', onclick: () => show({ type: 'codes' }) }, 'Set the list'))),
      result && h('section', { class: 'card' },
        h('h2', null, `Result · ${stamp(ran)}`),
        h('div', { class: 'cols' },
          h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Outcome'), h('th', { class: 'n' }, 'Records'))),
            h('tbody', null, cats().map(c => figRow(c, inCat(c).length, { type: 'list', cat: c }))),
            h('tfoot', null, h('tr', null, h('td', null, 'Total'), h('td', { class: 'n' }, result.length)))),
          h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Field that differs'), h('th', { class: 'n' }, 'Records'))),
            h('tbody', null, SA.COMPARED.map(f => figRow(f.label, withDiff(f.label).length, { type: 'list', diff: f.label }))),
            h('tfoot', null, h('tr', null, h('td', null, 'Mismatched records'), h('td', { class: 'n' }, inCat('Mismatched').length)))),
          scopeOn && h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'ADP job code'), h('th', { class: 'n' }, 'Rows'))),
            h('tbody', null, Object.keys(SCOPE).map(k => figRow(SCOPE[k].label, SCOPE[k].rows().length, { type: 'list', scope: k }))),
            h('tfoot', null, h('tr', null, h('td', null, 'ADP rows read'), h('td', { class: 'n' }, adpRowsRead()))))),
        h('p', { class: 'mute' }, 'A record with two differing fields is counted under each field. Names, addresses, cities and ZIP codes are compared after standardization; the values as filed are kept and shown.'),
        h('p', { class: 'tools' }, h('button', { onclick: exportCsv }, 'CSV'), h('button', { onclick: () => print() }, 'Print')),
        h('p', { class: 'print-only' }, inputsLine(), h('br'), columnsLine(), h('br'), codesLine()))));
}
// Every ADP row read lands in exactly one of these; together they add up to the rows read.
// Outcomes shown: "Not an MLO job code" only when a code list was used.
const cats = () => SA.CATEGORIES.filter(c => c !== SA.SET_ASIDE || (result && result.codes));
const SCOPE = {
  on: { label: 'On the MLO list', rows: () => result.filter(r => r.adp && !r.offList) },
  joined: { label: 'Not on the list, listed for review', rows: () => result.filter(r => r.adp && r.offList && r.category !== SA.SET_ASIDE) },
  aside: { label: 'Not on the list, set aside', rows: () => inCat(SA.SET_ASIDE) },
};
const adpRowsRead = () => SRC.adp.files.reduce((n, f) => n + f.parsed.rows.length, 0);
const codesLine = () => (result.codes
  ? `MLO job codes (${CODES_FROM[result.codes.from]}${result.codes.file ? `, from ${result.codes.file.name}, SHA-256 ${result.codes.file.hash}` : ''}): ${result.codes.list.join(', ')}`
  : 'No MLO job code list: every ADP row was treated as an originator.');
const columnsLine = () => 'Columns used · ' + ['nmls', 'adp'].map(s => `${SRC[s].short}: ` + fieldsFor(s).filter(f => SRC[s].map[f.key] >= 0).map(f => `${f.label} = “${headingOf(s, f.key)}”`).join('; ')).join(' · ');
const inputsLine = () => `SAFE Act NMLS to HR reconciliation · ${BASIS.cite} · run ${stamp(ran)} · ` + ['nmls', 'adp'].map(s => SRC[s].files.map(f => `${f.name} (${plural(f.parsed.rows.length, 'row')}, SHA-256 ${f.hash})`).join(', ')).join(' · ');

function exportCsv() {
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"', v = (r, k) => (r ? SA.raw(r, k) : '');
  const head = ['Outcome', 'Fields that differ', 'Work email', 'Associate ID', 'Job code', ...SA.COMPARED.flatMap(f => [f.label + ' (NMLS)', f.label + ' (ADP)']), 'Note', 'NMLS source', 'ADP source'];
  const lines = [head].concat(result.map(r => [r.category, r.diffs.join('; '), r.email, r.adp ? r.adp.assocId : '', r.adp ? r.adp.jobCode : '', ...SA.COMPARED.flatMap(f => [v(r.nmls, f.key), v(r.adp, f.key)]), r.note,
    r.nmls ? `${r.nmls.file} line ${r.nmls.line}` : '', r.adp ? `${r.adp.file} line ${r.adp.line}` : '']))
    .concat([[], ['SAFE Act NMLS to HR reconciliation'], ['Basis', BASIS.cite], ['Run at', ran.toISOString()], ['Join', 'Full outer join on work email'],
      ...cats().map(c => [c, inCat(c).length]), ['Total', result.length],
      ['MLO job codes', result.codes ? CODES_FROM[result.codes.from] : 'none: every ADP row treated as an originator', result.codes && result.codes.file ? result.codes.file.name : '', result.codes && result.codes.file ? 'SHA-256 ' + result.codes.file.hash : '', result.codes ? result.codes.list.join(' ') : ''],
      ...(result.codes ? Object.keys(SCOPE).map(k => ['ADP job code', SCOPE[k].label, SCOPE[k].rows().length]).concat([['ADP job code', 'ADP rows read', adpRowsRead()]]) : []),
      ...['nmls', 'adp'].flatMap(s => fieldsFor(s).filter(f => SRC[s].map[f.key] >= 0).map(f => ['Column used', SRC[s].title, f.label, headingOf(s, f.key)])),
      ...['nmls', 'adp'].flatMap(s => SRC[s].files.map(f => [SRC[s].title, f.name, f.parsed.rows.length + ' rows', 'SHA-256 ' + f.hash]))]);
  const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv' })), download: `safe-act-reconciliation-${ran.toISOString().slice(0, 10)}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------- the window: figure -> records -> record ----------
const opens = (frame, fresh) => ({ class: 'row', tabIndex: 0, onclick: () => (fresh ? show(frame) : push(frame)), onkeydown: e => { if (e.key === 'Enter') (fresh ? show(frame) : push(frame)); } });
function show(frame) { stack = [frame]; fwd = []; renderPop(); if (!pop.open) pop.showModal(); }
function push(frame) { stack.push(frame); fwd = []; renderPop(); }
function back() { if (stack.length > 1) { fwd.push(stack.pop()); renderPop(); } else pop.close(); }
function forward() { if (fwd.length) { stack.push(fwd.pop()); renderPop(); } }
document.addEventListener('keydown', e => { if (!pop.open) return; if (e.key === 'ArrowLeft' && stack.length > 1) back(); else if (e.key === 'ArrowRight') forward(); });
pop.addEventListener('click', e => { if (e.target === pop) pop.close(); });
const VIEWS = {};
function renderPop() {
  const fr = stack[stack.length - 1], v = VIEWS[fr.type](fr);
  fr.crumb = v.crumb || v.title;
  pop.replaceChildren(
    h('div', { class: 'bar' },
      h('button', { onclick: back, disabled: stack.length < 2, 'aria-label': 'Back', title: 'Back one step' }, '‹'),
      h('button', { onclick: forward, disabled: !fwd.length, 'aria-label': 'Forward', title: 'Forward one step' }, '›'),
      h('div', { class: 't' },
        stack.length > 1 && h('div', { class: 'trail' }, stack.slice(0, -1).map((f, i) => [h('button', { class: 'link', onclick: () => { fwd = []; stack.length = i + 1; renderPop(); } }, f.crumb), ' / '])),
        h('div', { class: 'title' }, v.title)),
      h('button', { onclick: () => pop.close(), 'aria-label': 'Close' }, '✕')),
    h('div', { class: 'body' }, v.body));
  pop.scrollTop = 0;
}
const facts = pairs => h('dl', { class: 'facts' }, pairs.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v === '' || v == null ? '–' : v))));

VIEWS.list = fr => {
  const rs = fr.scope ? SCOPE[fr.scope].rows() : fr.cat ? inCat(fr.cat) : withDiff(fr.diff), label = fr.scope ? SCOPE[fr.scope].label : fr.cat || fr.diff + ' differs';
  const last = !fr.scope && (fr.cat === 'Mismatched' || fr.diff) ? ['Differs', r => r.diffs.join(', ')] : ['Note', r => r.note || '–'];
  return { title: `${plural(rs.length, 'record')} · ${label}`, crumb: label, body: h('div', { class: 'scroll' }, h('table', null,
    h('thead', null, h('tr', null, h('th', null, 'Work email'), h('th', null, 'Name'), h('th', null, 'NMLS ID'), h('th', null, 'Associate ID'), fr.cat !== 'Matched' && h('th', null, last[0]))),
    h('tbody', null, rs.map(r => h('tr', opens({ type: 'record', rec: r }),
      h('td', { class: 'wrap' }, r.email || h('span', { class: 'mute' }, 'None')), h('td', null, nameOf(r)), h('td', { class: 'id' }, person(r).nmlsId || '–'),
      h('td', { class: 'id' }, r.adp ? r.adp.assocId || '–' : '–'), fr.cat !== 'Matched' && h('td', null, last[1](r))))))) };
};

VIEWS.record = fr => {
  const r = fr.rec, src = x => (x ? `${x.file}, line ${x.line}` : 'Not present');
  const one = x => h('table', null, h('tbody', null, SA.COMPARED.map(f => h('tr', null, h('td', { class: 'mute' }, f.label), h('td', { class: 'wrap' }, SA.raw(x, f.key) || '–')))));
  return { title: nameOf(r), crumb: nameOf(r), body: [
    facts([['Outcome', r.category], ['Work email', h('span', { class: 'id' }, r.email)], ['Associate ID', r.adp && h('span', { class: 'id' }, r.adp.assocId)], ['Job code', r.adp && r.adp.jobCode], ['NMLS extract', src(r.nmls)], ['ADP report', src(r.adp)]]),
    r.note && h('p', null, r.note),
    r.compare.length ? h('div', { class: 'scroll' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Field'), h('th', null, 'NMLS, as filed'), h('th', null, 'ADP, as recorded'), h('th', null, 'Compared as'), h('th', null, 'Result'))),
      h('tbody', null, r.compare.map(c => h('tr', null, h('td', null, c.label), h('td', { class: 'wrap' }, c.nmls || '–'), h('td', { class: 'wrap' }, c.adp || '–'),
        h('td', { class: 'wrap mute' }, c.equal ? c.stdNmls || '(blank)' : `${c.stdNmls || '(blank)'}  ≠  ${c.stdAdp || '(blank)'}`),
        h('td', { class: c.equal ? '' : 'bad' }, c.equal ? 'Same' : 'Differs')))))) : one(r.nmls || r.adp)] };
};

// The MLO job code list: typed, pasted, or read from a column of a CSV. Using it for this review never saves.
VIEWS.codes = fr => {
  if (fr.text == null) { fr.text = CODES.list.join('\n'); fr.file = CODES.file; }
  const split = t => t.split(/[\n,;\t]+/).map(x => x.trim()).filter(Boolean);
  const fromColumn = () => {
    const { parsed } = fr.csv, i = fr.col;
    // a one-column file without a heading: its first line is a code, not a heading
    const first = parsed.headers.length === 1 && !/job|code/i.test(parsed.headers[0]) ? [parsed.headers[0]] : [];
    fr.text = first.concat(parsed.rows.map(r => String(r.cells[i] || '').trim()).filter(Boolean)).join('\n');
    fr.file = { name: fr.csv.name, hash: fr.csv.hash, rows: parsed.rows.length };
  };
  const load = async e => {
    const file = e.target.files[0]; if (!file) return;
    const buf = await file.arrayBuffer(), parsed = SA.parseCsv(new TextDecoder().decode(buf));
    fr.csv = { name: file.name, hash: await sha256(buf), parsed };
    const g = SA.guess(parsed.headers, SA.FIELDS.find(f => f.key === 'jobCode'));
    fr.col = g >= 0 ? g : 0; fromColumn(); renderPop();
  };
  const n = split(fr.text).length;
  return { title: 'MLO job codes', body: [
    h('p', { class: 'mute' }, 'The ADP job codes of mortgage loan originators. An ADP row with another code is still listed and flagged when it has an NMLS ID or the NMLS extract has its work email; with neither, it is set aside.'),
    h('p', null, h('label', { class: 'mute' }, 'Load from a CSV: '), h('input', { type: 'file', accept: '.csv,.txt,text/csv', 'aria-label': 'Load MLO job codes from a CSV', onchange: e => load(e).catch(err => toast(err.message)) })),
    fr.csv && fr.csv.parsed.headers.length > 1 && h('p', null, h('label', { class: 'mute' }, 'Column with the codes: '),
      h('select', { 'aria-label': 'Column with the codes', onchange: e => { fr.col = +e.target.value; fromColumn(); renderPop(); } },
        fr.csv.parsed.headers.map((x, i) => h('option', { value: String(i), selected: i === fr.col }, x)))),
    h('textarea', { rows: 8, value: fr.text, 'aria-label': 'MLO job codes, one per line', placeholder: 'One code per line', oninput: e => { fr.text = e.target.value; fr.file = null; } }),
    h('p', { class: 'mute' }, `${plural(n, 'code')}${fr.file ? ` from ${fr.file.name}` : ''}. Codes match ignoring case and spaces. Leading zeros count: 0412 and 412 are different codes.`),
    h('p', { class: 'row-inline' },
      h('button', { class: 'primary', onclick: () => setCodes(split(fr.text), false, fr.file) }, 'Use for this review'),
      h('button', { onclick: () => setCodes(split(fr.text), true, fr.file) }, 'Use and save for next time'),
      CODES.list.length > 0 && h('button', { class: 'link', onclick: () => setCodes([], true, null) }, 'Clear the list')),
    h('p', { class: 'mute' }, 'A saved list is kept in this browser only. Each person and each computer keeps its own.')] };
};

// The default map for one side; with a file chosen, only the headings that file actually has.
const defaultsFor = s => Object.fromEntries(fieldsFor(s).map(f => {
  if (!SRC[s].files.length) return [f.key, String(SA.DEFAULT_MAP[f.key] || '')];
  const i = SA.resolveMap(SRC[s].headers, SA.DEFAULT_MAP, [f]).index[f.key];
  return [f.key, i >= 0 ? SRC[s].headers[i] : ''];
}));
// One place to see and change the field map. With a file chosen, each field picks from that file's columns;
// without one, the heading is typed. Using it for this review never saves; saving is asked for separately.
VIEWS.map = fr => {
  if (!fr.draft) fr.draft = Object.fromEntries(['nmls', 'adp'].map(side => [side, Object.fromEntries(fieldsFor(side).map(f => {
    const src = SRC[side];
    if (!src.files.length) return [f.key, mapFor(side)[f.key]];
    if (src.map[f.key] >= 0) return [f.key, src.headers[src.map[f.key]]];
    const g = SA.guess(src.headers, f); // a suggestion only; required ones are marked for checking
    return [f.key, g >= 0 ? src.headers[g] : ''];
  }))]));
  const anyFile = !!(SRC.nmls.files.length || SRC.adp.files.length);
  const side = s => {
    const src = SRC[s], saved = savedMap(s), cur = mapFor(s);
    return h('div', null, h('p', { class: 'side-h' }, h('b', null, src.title), src.files.length ? h('span', { class: 'mute' }, ' · columns from ', src.files[0].name) : h('span', { class: 'mute' }, ' · no file chosen')),
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Field'), h('th', null, src.files.length ? 'Column in this file' : 'Column heading'), h('th', { class: 'hide-s' }, saved ? 'Saved map' : 'Default'))),
        h('tbody', null, fieldsFor(s).map(f => {
          const notFound = !!(src.files.length && !(src.map[f.key] >= 0) && (f.required || (cur[f.key] && !f.scope)));
          const set = e => { fr.draft[s][f.key] = e.target.value; };
          return h('tr', null,
            h('td', null, f.label.replace(' (optional)', ''), !f.required && h('span', { class: 'mute' }, ' · optional')),
            h('td', null, src.files.length
              ? h('select', { 'aria-label': `${src.title}: ${f.label}`, onchange: set },
                  h('option', { value: '', selected: !fr.draft[s][f.key] }, f.required ? 'Choose a column' : 'None'),
                  src.headers.map(x => h('option', { value: x, selected: x === fr.draft[s][f.key] }, x)))
              : h('input', { value: fr.draft[s][f.key], 'aria-label': `${src.title}: ${f.label}`, placeholder: f.required ? 'Column heading' : 'None', oninput: set }),
              notFound && h('div', { class: 'warn' }, cur[f.key] ? `“${cur[f.key]}” is not in this file. Check the column chosen.` : 'Not in the map. Check the column chosen.')),
            h('td', { class: 'hide-s mute' }, cur[f.key] || '–'));
        }))));
  };
  const done = save => () => {
    for (const s of ['nmls', 'adp']) {
      const miss = fieldsFor(s).filter(f => f.required && !String(fr.draft[s][f.key] || '').trim());
      if (miss.length && (save || SRC[s].files.length)) return toast(`${SRC[s].title}: choose a column for ${miss.map(f => f.label).join(', ')}.`);
    }
    let saved = true;
    for (const s of ['nmls', 'adp']) {
      const ok = save && store.set(MAP_KEY(s), fr.draft[s]);
      if (save) saved = ok && saved;
      if (SRC[s].files.length) applyMap(s, fr.draft[s], ok ? 'saved' : 'chosen');
    }
    result = null; pop.close(); render();
    if (save) toast(saved ? 'Field map saved. This browser will use it next time.' : 'This browser does not allow saving. The columns apply to this review only.');
  };
  return { title: 'Field map', body: [
    h('p', { class: 'mute' }, 'Which column each field is read from. Headings are matched ignoring case, spaces and punctuation.'),
    h('div', { class: 'cols' }, side('nmls'), side('adp')),
    h('p', { class: 'row-inline' },
      anyFile && h('button', { class: 'primary', onclick: done(false) }, 'Use for this review'),
      h('button', { class: anyFile ? '' : 'primary', onclick: done(true) }, anyFile ? 'Use and save for next time' : 'Save field map'),
      h('button', { class: 'link', onclick: () => { fr.draft = { nmls: defaultsFor('nmls'), adp: defaultsFor('adp') }; renderPop(); } }, 'Reset to the defaults')),
    h('p', { class: 'mute' }, 'The saved map is kept in this browser only. Each person and each computer keeps its own.')] };
};

VIEWS.basis = () => ({ title: BASIS.name, crumb: BASIS.ref, body: [facts([['Reference', BASIS.ref], ['Citation', BASIS.cite]]), h('p', null, BASIS.plain),
  h('p', { class: 'mute' }, 'Summary for orientation only. Confirm against the text currently in force.'),
  h('h3', null, 'How records are compared'),
  h('table', null, h('tbody', null, [
    ['Join', 'Full outer join on work email, ignoring case and surrounding spaces. A blank or repeated work email cannot be joined and is set aside for review.'],
    ['NMLS ID', 'Digits only.'], ['Names', 'Case, accents, periods, apostrophes and hyphens are ignored.'],
    ['Address', 'Address lines are combined, then standardized to USPS Publication 28 abbreviations (for example North to N, Street to ST, Suite to STE, Second to 2ND).'],
    ['City', 'Case and punctuation are ignored; Saint, Fort and Mount are abbreviated.'], ['ZIP', 'The five-digit code. A leading zero dropped by a spreadsheet is restored.'],
  ].map(([k, v]) => h('tr', null, h('td', { class: 'nowrap' }, k), h('td', null, v)))))] });

render();
