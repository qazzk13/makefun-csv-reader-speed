// Fast CSV reader: a faster drop-in for csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for the same
// input {text, header}: {columns, rows, errors}. The reading rules it
// implements, all of them taken from the reference's own description:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is
//     no record;
//   - outside a quoted field a CR not followed by LF is dropped
//     (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside
//     it is read as LF; what follows its closing quote, up to the next
//     comma or line break, is appended as it stands (error quote_junk
//     when the field ends); a quote that never closes is a literal
//     character, and the text after it is read again as unquoted
//     (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows
//     holds the records after it (every record when header is false),
//     each padded with "" (short_row, with fields: its field count) or
//     cut (long_row, with extra: the cut fields) to the first record's
//     width;
//   - each error is {code, line, row}, in the order met, a field's
//     quote_junk when the field ends and a record's short_row or long_row
//     when the record ends; line is the 1-based line its record starts
//     on, counting every LF, CRLF and lone CR inside quotes, and row is
//     its record's index in rows, null for the header.
//
// How it is fast: the reference reads one character at a time and builds
// every field up a character at a time. This reader instead reads in bulk.
// Most records hold no quote and no CR at all, so a whole record is taken
// in one slice and split on commas (the fast path below). Only a record
// that holds a quote or a CR falls back to field-by-field reading, and
// even there every field is taken with indexOf scans and slices instead
// of a character loop; the character loop only runs for a field that
// actually holds a stray CR, or for a quoted segment that actually holds
// a line break. Nothing is cached from one case to the next, and nothing
// is kept from one call to the next: pure, no clock, no randomness.
//
// Written from the reference's rules for this competition; no code is
// taken from the reference, from d3-dsv, from papaparse or from any other
// CSV library.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;

/** The next comma, CR or LF: one scan finds an unquoted field's end. */
const SEP = /[,\r\n]/g;

/** A quote or a CR anywhere in a line: the record needs field-by-field reading. */
const BADLINE = /["\r]/;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, appending onto `value`
  // ('' for a fresh field, the quoted value for the junk after a closing
  // quote). Returns [value, ended, added], `added` counting the
  // characters kept during this read.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      SEP.lastIndex = pos;
      const m = SEP.exec(text);
      if (m === null) {
        const seg = text.slice(pos);
        if (seg.length !== 0) {
          value += seg;
          added += seg.length;
        }
        pos = len;
        return [value, END, added];
      }
      const i = m.index;
      const code = text.charCodeAt(i);
      if (code === 44) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        return [value, COMMA, added];
      }
      if (code === 10) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      // A CR: followed by LF it ends the record; otherwise it is stray.
      if (text.charCodeAt(i + 1) === 10) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 2;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      error('stray_cr');
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
      }
      pos = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  // Returns [value, ended, 0].
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1; // the opening quote
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      const seg = text.slice(pos, q);
      const doubled = text.charCodeAt(q + 1) === 34;
      // CRLF and a lone CR inside quotes are each one LF; count every
      // line break the segment holds for the line the next record starts on.
      let piece = seg;
      if (seg.indexOf('\n') !== -1 || seg.indexOf('\r') !== -1) {
        piece = seg.replace(/\r\n?/g, '\n');
        let n = 0;
        let idx = piece.indexOf('\n');
        while (idx !== -1) {
          n += 1;
          idx = piece.indexOf('\n', idx + 1);
        }
        line += n;
      }
      if (doubled) {
        value += piece;
        value += '"';
        pos = q + 2;
        continue;
      }
      value += piece;
      pos = q + 1;
      if (pos >= len) return [value, END, 0];
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return [value, COMMA, 0];
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return [value, LINE_BREAK, 0];
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return [value, LINE_BREAK, 0];
      }
      // What follows the closing quote is appended as it stands, up to
      // the next comma or line break.
      const junk = readUnquoted(value);
      if (junk[2] > 0) error('quote_junk');
      return junk;
    }
  }

  // Settles one record's fields: the header takes them, every other
  // record is padded or cut to the first record's width.
  function settle(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record up to the next LF holds no quote and no CR,
    // so no field is quoted, no CR is stray and no line break hides
    // inside a quoted field. Take the whole line in one slice and split
    // it on commas. (A CR right before the LF is the CRLF line break and
    // is left out of the slice.)
    const lf = text.indexOf('\n', pos);
    const recEnd = lf === -1 ? len : lf;
    let lineEnd = recEnd;
    if (lf !== -1 && recEnd > pos && text.charCodeAt(recEnd - 1) === 13) lineEnd = recEnd - 1;
    const lineText = text.slice(pos, lineEnd);
    if (!BADLINE.test(lineText)) {
      const fields = lineText.split(',');
      pos = lf === -1 ? len : lf + 1;
      if (lf !== -1) line += 1;
      // A line with no characters cannot reach here (blank lines are
      // skipped above), but a single empty field is no record all the same.
      if (fields.length === 1 && fields[0] === '') continue;
      settle(fields);
      continue;
    }

    // Slow path: the record holds a quote or a CR; read it field by field.
    // Unquoted fields are scanned inline here (one SEP exec each); only
    // quoted fields go through readQuoted.
    const fields = [];
    let quoted = false;
    let ended = COMMA;
    while (ended === COMMA) {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const f = readQuoted();
        fields.push(f[0]);
        ended = f[1];
        continue;
      }
      quoted = false;
      // Unquoted field, scanned inline: the value is built from slices.
      let value = '';
      for (;;) {
        SEP.lastIndex = pos;
        const m = SEP.exec(text);
        if (m === null) {
          if (pos < len) value += text.slice(pos);
          pos = len;
          ended = END;
          break;
        }
        const i = m.index;
        const code = text.charCodeAt(i);
        if (code === 44) {
          if (i > pos) value += text.slice(pos, i);
          pos = i + 1;
          ended = COMMA;
          break;
        }
        if (code === 10) {
          if (i > pos) value += text.slice(pos, i);
          pos = i + 1;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        if (text.charCodeAt(i + 1) === 10) {
          if (i > pos) value += text.slice(pos, i);
          pos = i + 2;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        error('stray_cr');
        if (i > pos) value += text.slice(pos, i);
        pos = i + 1;
      }
      fields.push(value);
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    settle(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
