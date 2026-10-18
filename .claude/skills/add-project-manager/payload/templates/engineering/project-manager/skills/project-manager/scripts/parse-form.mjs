#!/usr/bin/env node
// Parse the Steward's iteration form into JSON. Keeps only the known fields,
// cuts every value to its limit, and exits non-zero when the input is not a
// form. No dependencies; run with node or bun, form text on stdin.

const FIELDS = [
  { key: 'busy_days', label: 'Busy days', lines: 1, chars: 200 },
  { key: 'away', label: 'Away', lines: 1, chars: 200 },
  { key: 'energy', label: 'Energy', lines: 1, chars: 10, oneOf: ['low', 'normal', 'high'] },
  { key: 'hours_for_projects', label: 'Hours for projects', lines: 1, chars: 10 },
  { key: 'requests', label: 'Requests', lines: 5, chars: 200 },
];
const HEADER = /^PM form, week of (\d{4}-\d{2}-\d{2})\s*$/;

function parse(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const headerAt = lines.findIndex((l) => HEADER.test(l));
  if (headerAt === -1) return { ok: false, error: 'no "PM form, week of <date>" header' };

  const out = { ok: true, week_of: lines[headerAt].match(HEADER)[1], fields: {}, dropped: [], truncated: [] };
  const byLabel = new Map(FIELDS.map((f) => [f.label.toLowerCase(), f]));
  let current = null;
  let count = 0;

  for (const raw of lines.slice(headerAt + 1)) {
    if (raw.trim() === '') continue;
    const m = raw.match(/^([A-Za-z ]+):\s*(.*)$/);
    const field = m ? byLabel.get(m[1].trim().toLowerCase()) : undefined;
    if (field) {
      current = field;
      count = 0;
      out.fields[field.key] = [];
      if (m[2].trim() !== '') push(out, field, m[2], ++count);
      continue;
    }
    if (current && /^\s*[-*]\s+/.test(raw)) {
      push(out, current, raw.replace(/^\s*[-*]\s+/, ''), ++count);
      continue;
    }
    out.dropped.push(raw);
  }

  for (const f of FIELDS) {
    const v = out.fields[f.key] ?? [];
    if (f.lines === 1) {
      let value = v[0] ?? '';
      if (f.oneOf && !f.oneOf.includes(value.toLowerCase())) {
        if (value !== '') out.dropped.push(`${f.label}: ${value}`);
        value = '';
      }
      out.fields[f.key] = value;
    } else {
      out.fields[f.key] = v;
    }
  }
  return out;
}

function push(out, field, value, n) {
  if (n > field.lines) {
    out.dropped.push(`${field.label}: ${value}`);
    return;
  }
  let v = value.trim();
  if (v.length > field.chars) {
    v = v.slice(0, field.chars);
    out.truncated.push(field.key);
  }
  out.fields[field.key].push(v);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const result = parse(input);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
});
