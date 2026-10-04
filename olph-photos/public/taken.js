// Works out when a photo was taken. Shared by the app and the tests.

// Returns { local: "YYYY-MM-DDTHH:MM:SS", offset: "+HH:MM" | null } from JPEG camera data, or null.
export function exifTaken(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
  let o = 2;
  while (o + 4 < v.byteLength) {
    const mk = v.getUint16(o), len = v.getUint16(o + 2);
    if (mk === 0xFFE1 && o + 10 < v.byteLength && v.getUint32(o + 4) === 0x45786966) {
      try { return readTiff(v, o + 10); } catch { return null; }
    }
    if ((mk & 0xFF00) !== 0xFF00 || mk === 0xFFDA) break;
    o += 2 + len;
  }
  return null;
}

function readTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = x => v.getUint16(x, le), u32 = x => v.getUint32(x, le);
  const str = (x, n) => { let s = ""; for (let k = 0; k < n; k++) { const c = v.getUint8(x + k); if (!c) break; s += String.fromCharCode(c); } return s; };
  const ifd = (start, want) => {
    const n = u16(start), out = {};
    for (let k = 0; k < n; k++) {
      const e = start + 2 + k * 12, tag = u16(e);
      if (!want.includes(tag)) continue;
      const type = u16(e + 2), cnt = u32(e + 4);
      out[tag] = type === 2 ? str(cnt > 4 ? t + u32(e + 8) : e + 8, cnt) : u32(e + 8);
    }
    return out;
  };
  const i0 = ifd(t + u32(t + 4), [0x8769, 0x0132]);
  let d = null, off = null;
  if (i0[0x8769]) {
    const ex = ifd(t + i0[0x8769], [0x9003, 0x9011]);
    d = ex[0x9003]; off = ex[0x9011] || null;
  }
  const local = stamp(d || i0[0x0132]);
  if (!local) return null;
  return { local, offset: off && /^[+-]\d\d:\d\d$/.test(off) ? off : null };
}

export function stamp(s) {
  const m = s && String(s).match(/(\d{4})[:\-]?(\d\d)[:\-]?(\d\d)[ _T-]?(\d\d)[:\-]?(\d\d)[:\-]?(\d\d)/);
  if (!m || +m[1] < 1990 || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

// Camera-style names: 20260329_074435.jpg, IMG_20260329_074435.jpg, PXL_20260329_074435123.jpg
export function nameTaken(name) {
  const m = String(name).match(/(?:^|[^0-9])((?:19|20)\d{6})[_-](\d{6})/);
  return m ? stamp(m[1] + m[2]) : null;
}

// Offset of a time zone at a given instant, in minutes (e.g. -240 for New York in summer).
function zoneOffset(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(ms));
  const g = t => +parts.find(p => p.type === t).value;
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - ms) / 60000;
}

// "2026-03-29T07:44:35" + (offset or zone) → UTC Date.
export function toInstant(local, offset, zone = "America/New_York") {
  if (offset) return new Date(local + offset);
  const [y, mo, d, h, mi, s] = local.split(/[-T:]/).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = guess - zoneOffset(guess, zone) * 60000;
  ms = guess - zoneOffset(ms, zone) * 60000; // second pass settles DST edges
  return new Date(ms);
}

// Best available date for a File: camera data → filename → file's modified time.
export async function fileTaken(file, zone) {
  let ex = null;
  try { ex = exifTaken(await file.slice(0, 262144).arrayBuffer()); } catch { /* unreadable */ }
  if (ex) return { when: toInstant(ex.local, ex.offset, zone), source: "photo data" };
  const n = nameTaken(file.name);
  if (n) return { when: toInstant(n, null, zone), source: "filename" };
  return { when: new Date(file.lastModified || Date.now()), source: "file date", weak: true };
}
