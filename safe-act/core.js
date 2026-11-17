'use strict';
// SAFE Act NMLS-to-HR reconciliation: pure logic, no DOM. Runs in the browser and in Node (for tests).
const SafeAct = (() => {
  const FIELDS = [
    { key: 'email', label: 'Work email', required: true, syn: ['work email', 'work e-mail', 'business email', 'email', 'e-mail', 'email address'] },
    { key: 'nmlsId', label: 'NMLS ID', required: true, compare: true, syn: ['nmls id', 'nmlsid', 'nmls number', 'nmls #', 'nmls', 'individual id', 'individual nmls id'] },
    { key: 'first', label: 'First name', required: true, compare: true, syn: ['first name', 'firstname', 'legal first name', 'first'] },
    { key: 'last', label: 'Last name', required: true, compare: true, syn: ['last name', 'lastname', 'legal last name', 'surname', 'last'] },
    { key: 'address', label: 'Address', required: true, compare: true, syn: ['address', 'street address', 'address line 1', 'address 1', 'address1', 'street', 'work address'] },
    { key: 'address2', label: 'Address line 2 (optional)', syn: ['address line 2', 'address 2', 'address2'] },
    { key: 'city', label: 'City', required: true, compare: true, syn: ['city', 'town'] },
    { key: 'zip', label: 'ZIP', required: true, compare: true, syn: ['zip', 'zip code', 'zipcode', 'postal code', 'postal'] },
    { key: 'assocId', label: 'Associate ID', adpOnly: true, required: true, syn: ['associate id', 'associate', 'employee id', 'file number', 'position id'] },
    // Required only while an MLO job code list is in use (the screen decides).
    { key: 'jobCode', label: 'Job code', adpOnly: true, scope: true, syn: ['job code', 'jobcode', 'job', 'position code'] },
  ];
  const COMPARED = FIELDS.filter(f => f.compare);

  // ---------- CSV ----------
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const first = text.slice(0, text.search(/\r|\n|$/));
    const delim = [',', '\t', ';', '|'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const body = rows.filter(r => r.some(v => v.trim() !== ''));
    const headers = (body.shift() || []).map(s => s.trim());
    return { headers, rows: body.map((r, i) => ({ line: i + 2, cells: r })) };
  }
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
  function guess(headers, field) {
    const hs = headers.map(norm);
    for (const s of field.syn) { const i = hs.indexOf(s); if (i >= 0) return i; }
    for (const s of field.syn) { const i = hs.findIndex(x => x.includes(s) && (field.key !== 'address' || !/2|email/.test(x))); if (i >= 0) return i; }
    return -1;
  }
  // The field map: field key -> the column heading to read it from. Both files start with the same names.
  const DEFAULT_MAP = { email: 'Work Email', nmlsId: 'NMLS ID', first: 'First Name', last: 'Last Name', address: 'Address', address2: '', city: 'City', zip: 'Zip', assocId: 'Associate ID', jobCode: 'Job Code' };
  // Finds each mapped heading in a file. Case, spacing and punctuation are ignored. notFound lists required fields the map
  // does not find, with the heading it looked for ('' when the map has none), so the screen can ask for a column.
  function resolveMap(headers, map, fields) {
    const hs = headers.map(norm), index = {}, notFound = [];
    for (const f of fields) {
      const want = String((map && map[f.key]) || '').trim(), i = want ? hs.indexOf(norm(want)) : -1;
      index[f.key] = i;
      // An optional heading the file lacks is reported too, except a scope field (job code), which matters only while required.
      if (i < 0 && (f.required || (want && !f.scope))) notFound.push({ key: f.key, label: f.label, want });
    }
    return { index, notFound };
  }
  const mapRows = (parsed, mapping, file) => parsed.rows.map(r => {
    const o = { file, line: r.line };
    for (const f of FIELDS) o[f.key] = mapping[f.key] >= 0 ? String(r.cells[mapping[f.key]] || '').trim() : '';
    return o;
  });

  // ---------- standardization (USPS Publication 28 abbreviations) ----------
  const WORDS = {
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
    STREET: 'ST', STR: 'ST', AVENUE: 'AVE', AV: 'AVE', AVEN: 'AVE', BOULEVARD: 'BLVD', BOUL: 'BLVD', BOULV: 'BLVD', DRIVE: 'DR', DRV: 'DR', ROAD: 'RD',
    LANE: 'LN', COURT: 'CT', PLACE: 'PL', CIRCLE: 'CIR', CIRC: 'CIR', TERRACE: 'TER', TERR: 'TER', PARKWAY: 'PKWY', PKY: 'PKWY', PKWAY: 'PKWY',
    HIGHWAY: 'HWY', HIWAY: 'HWY', SQUARE: 'SQ', TRAIL: 'TRL', PLAZA: 'PLZ', CENTER: 'CTR', CENTRE: 'CTR', CNTR: 'CTR', EXPRESSWAY: 'EXPY', FREEWAY: 'FWY',
    TURNPIKE: 'TPKE', CROSSING: 'XING', HEIGHTS: 'HTS', POINT: 'PT', RIDGE: 'RDG', ALLEY: 'ALY', BRIDGE: 'BRG', COVE: 'CV', CREEK: 'CRK', ESTATES: 'EST',
    GARDENS: 'GDNS', GROVE: 'GRV', HARBOR: 'HBR', HILL: 'HL', HILLS: 'HLS', ISLAND: 'IS', JUNCTION: 'JCT', LAKE: 'LK', LANDING: 'LNDG', MANOR: 'MNR',
    MEADOWS: 'MDWS', MOUNTAIN: 'MTN', PARK: 'PARK', PIKE: 'PIKE', RUN: 'RUN', SPRINGS: 'SPGS', STATION: 'STA', VALLEY: 'VLY', VIEW: 'VW', VILLAGE: 'VLG', VISTA: 'VIS',
    SUITE: 'STE', APARTMENT: 'APT', FLOOR: 'FL', FLR: 'FL', BUILDING: 'BLDG', ROOM: 'RM', DEPARTMENT: 'DEPT', NUMBER: '#', NO: '#',
    FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH', FIFTH: '5TH', SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH',
    SAINT: 'ST', FORT: 'FT', MOUNT: 'MT',
  };
  const clean = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const stdAddress = s => clean(s).replace(/[.']/g, '').replace(/#/g, ' # ').replace(/[^A-Z0-9# ]+/g, ' ')
    .replace(/\bP(OST)? ?O(FFICE)? ?BOX\b/g, 'PO BOX').split(/\s+/).filter(Boolean).map(w => WORDS[w] || w).join(' ');
  const stdCity = s => clean(s).replace(/[.']/g, '').replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).map(w => ({ SAINT: 'ST', FORT: 'FT', MOUNT: 'MT' }[w] || w)).join(' ');
  const stdName = s => clean(s).replace(/[.']/g, '').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const stdId = s => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
  // ZIP compares on the 5-digit code; a leading zero lost in a spreadsheet is restored.
  function stdZip(s) {
    const d = String(s || '').replace(/[^0-9-]/g, ''); if (!d) return '';
    const head = d.split('-')[0];
    return head.length > 5 ? head.slice(0, head.length === 9 ? 5 : head.length - 4).padStart(5, '0') : head.padStart(5, '0');
  }
  const stdEmail = s => String(s || '').trim().toLowerCase();
  const STD = {
    nmlsId: r => stdId(r.nmlsId), first: r => stdName(r.first), last: r => stdName(r.last),
    address: r => stdAddress(r.address + ' ' + (r.address2 || '')), city: r => stdCity(r.city), zip: r => stdZip(r.zip),
  };
  const raw = (r, k) => (k === 'address' && r.address2 ? r.address + ', ' + r.address2 : r[k]);

  // ---------- reconciliation: full outer join on work email ----------
  // A job code is compared trimmed and ignoring case. Leading zeros count: "0412" and "412" are different codes.
  const stdCode = s => String(s == null ? '' : s).trim().toUpperCase();
  const SET_ASIDE = 'Not an MLO job code';
  const CATEGORIES = ['Matched', 'Mismatched', 'NMLS only', 'ADP only', 'Cannot be joined', SET_ASIDE];
  // codes: the MLO job codes (any iterable), or null to treat every ADP row as an originator.
  // The join always uses every row, so a registered person whose job code is not on the list is still compared
  // (and flagged); only ADP rows with no NMLS counterpart and a code not on the list are set aside.
  function reconcile(nmls, adp, codes) {
    const mlo = codes ? new Set([...codes].map(stdCode).filter(Boolean)) : null;
    const offList = a => !!(mlo && a && !mlo.has(stdCode(a.jobCode)));
    const codeNote = a => (offList(a) ? (stdCode(a.jobCode) ? `Job code ${a.jobCode} is not on the MLO list.` : 'No job code in the ADP report.') : '');
    // Set aside only an off-list row with no NMLS ID at all and no matching email. A row that carries an NMLS ID is
    // listed for review even when that ID is not in the extract (owner's decision, 17 Nov 2026).
    const hasId = a => !!stdId(a.nmlsId);
    const aside = (a, note) => out.push({ category: SET_ASIDE, email: stdEmail(a.email), nmls: null, adp: a, diffs: [], compare: [], note, offList: true });
    const out = [], index = rows => { const m = new Map(); for (const r of rows) { const k = stdEmail(r.email); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
    const N = index(nmls), A = index(adp);
    const byId = rows => { const m = new Map(); for (const r of rows) { const k = stdId(r.nmlsId); if (k && !m.has(k)) m.set(k, r); } return m; };
    const nById = byId(nmls), aById = byId(adp);
    const unjoin = (n, a, note) => out.push({ category: 'Cannot be joined', email: stdEmail((n || a).email), nmls: n, adp: a, diffs: [], compare: [], note: [note, codeNote(a)].filter(Boolean).join(' '), offList: offList(a) });
    for (const key of new Set([...N.keys(), ...A.keys()])) {
      const ns = N.get(key) || [], as = A.get(key) || [];
      if (!key) {
        ns.forEach(n => unjoin(n, null, 'No work email in the NMLS extract.'));
        as.forEach(a => (offList(a) && !hasId(a) ? aside(a, 'No work email in the ADP report. ' + codeNote(a)) : unjoin(null, a, 'No work email in the ADP report.')));
        continue;
      }
      if (ns.length > 1 || as.length > 1) {
        const note = `Work email appears ${ns.length} time(s) in the NMLS extract and ${as.length} time(s) in the ADP report.`;
        ns.forEach(n => unjoin(n, null, note));
        as.forEach(a => (!ns.length && offList(a) && !hasId(a) ? aside(a, note + ' ' + codeNote(a)) : unjoin(null, a, note)));
        continue;
      }
      const n = ns[0] || null, a = as[0] || null;
      if (n && a) {
        const compare = COMPARED.map(f => { const sn = STD[f.key](n), sa = STD[f.key](a); return { key: f.key, label: f.label, nmls: raw(n, f.key), adp: raw(a, f.key), stdNmls: sn, stdAdp: sa, equal: sn === sa }; });
        const diffs = compare.filter(c => !c.equal).map(c => c.label);
        out.push({ category: diffs.length ? 'Mismatched' : 'Matched', email: key, nmls: n, adp: a, diffs, compare, note: codeNote(a), offList: offList(a) });
      } else {
        const id = stdId((n || a).nmlsId), other = id && (n ? aById : nById).get(id);
        const note = other ? `The same NMLS ID is in the ${n ? 'ADP report' : 'NMLS extract'} under ${other.email || 'no work email'}.`
          : a && !id ? 'No NMLS ID in the ADP report.' : '';
        if (!n && offList(a) && !id) { aside(a, [codeNote(a), note].filter(Boolean).join(' ')); continue; }
        const missingId = !n && id && !other ? `Its NMLS ID ${a.nmlsId} is not in the NMLS extract.` : '';
        out.push({ category: n ? 'NMLS only' : 'ADP only', email: key, nmls: n, adp: a, diffs: [], compare: [], note: [note, codeNote(a), offList(a) ? missingId : ''].filter(Boolean).join(' '), offList: offList(a) });
      }
    }
    const order = r => CATEGORIES.indexOf(r.category);
    return out.sort((x, y) => order(x) - order(y) || (x.email > y.email ? 1 : x.email < y.email ? -1 : 0));
  }
  return { FIELDS, COMPARED, CATEGORIES, SET_ASIDE, DEFAULT_MAP, stdCode, parseCsv, guess, resolveMap, mapRows, reconcile, stdAddress, stdCity, stdName, stdZip, stdId, raw };
})();
if (typeof module !== 'undefined') module.exports = SafeAct;
