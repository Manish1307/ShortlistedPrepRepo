'use strict';
// A minimal Word (.docx) writer for the career toolkit: plain, single-column documents (what ATS systems read best).
// No packages: a .docx is a zip of a few XML files, written here with Node's zlib.

const zlib = require('zlib');

const xml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** One paragraph. kind: title | subtitle | heading | role | bullet | text */
function paragraph({ kind = 'text', text = '' }) {
  const run = (t, { bold = false, size = 22, color = null, italic = false } = {}) =>
    `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}` +
    `${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
  const p = (props, runs) => `<w:p><w:pPr>${props}</w:pPr>${runs}</w:p>`;
  switch (kind) {
    case 'title': return p('<w:spacing w:after="40"/>', run(text, { bold: true, size: 36 }));
    case 'subtitle': return p('<w:spacing w:after="160"/>', run(text, { size: 20, color: '444444' }));
    case 'heading': return p('<w:spacing w:before="240" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>',
      run(String(text).toUpperCase(), { bold: true, size: 24 }));
    case 'role': return p('<w:spacing w:before="120" w:after="40"/>', run(text, { bold: true, size: 22 }));
    case 'bullet': return p('<w:spacing w:after="40"/><w:ind w:left="360" w:hanging="220"/>', run('• ' + text));
    default: return p('<w:spacing w:after="120"/>', run(text));
  }
}

function documentXml(paragraphs) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map(paragraph).join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="600" w:footer="600" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';
}

/** A zip file (deflated entries) from {name: string} files. */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** A .docx file (Buffer) from a list of {kind, text} paragraphs. */
function buildDocx(paragraphs) {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': documentXml(paragraphs),
  });
}

/** Paragraphs for a structured resume (see career.js RESUME_SHAPE). */
function resumeParagraphs(r) {
  const out = [];
  const list = v => (Array.isArray(v) ? v.filter(Boolean) : []);
  out.push({ kind: 'title', text: r.name || 'Your Name' });
  const contact = r.contact || {};
  const line = [r.headline, contact.email, contact.phone, contact.location, contact.linkedin].filter(Boolean).join('  |  ');
  if (line) out.push({ kind: 'subtitle', text: line });
  if (r.summary) { out.push({ kind: 'heading', text: 'Professional Summary' }, { kind: 'text', text: r.summary }); }
  if (list(r.skills).length) {
    out.push({ kind: 'heading', text: 'Skills' });
    for (const g of list(r.skills)) out.push({ kind: 'text', text: (g.group ? g.group + ': ' : '') + list(g.items).join(', ') });
  }
  if (list(r.experience).length) {
    out.push({ kind: 'heading', text: 'Experience' });
    for (const e of list(r.experience)) {
      out.push({ kind: 'role', text: [e.title, e.company].filter(Boolean).join(', ') + ((e.start || e.end) ? `  (${[e.start, e.end].filter(Boolean).join(' – ')})` : '') });
      if (e.location) out.push({ kind: 'text', text: e.location });
      for (const b of list(e.bullets)) out.push({ kind: 'bullet', text: b });
    }
  }
  if (list(r.projects).length) {
    out.push({ kind: 'heading', text: 'Projects' });
    for (const p of list(r.projects)) {
      out.push({ kind: 'role', text: p.name || 'Project' });
      for (const b of list(p.bullets)) out.push({ kind: 'bullet', text: b });
    }
  }
  if (list(r.education).length) {
    out.push({ kind: 'heading', text: 'Education' });
    for (const ed of list(r.education)) out.push({ kind: 'text', text: [ed.degree, ed.institution, ed.year].filter(Boolean).join(', ') });
  }
  if (list(r.certifications).length) {
    out.push({ kind: 'heading', text: 'Certifications' });
    for (const c of list(r.certifications)) out.push({ kind: 'bullet', text: c });
  }
  return out;
}

/** Paragraphs for a cover letter: one paragraph per blank-line-separated block. */
function letterParagraphs(text) {
  return String(text || '').split(/\n\s*\n/).map(t => ({ kind: 'text', text: t.replace(/\s*\n\s*/g, ' ').trim() })).filter(p => p.text);
}

module.exports = { buildDocx, resumeParagraphs, letterParagraphs };
