import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A minimal, dependency-free zip reader and writer.
 *
 * The reader is deliberately strict because it is the first step of a sanitizer: it rejects anything it does
 * not fully understand (zip64, encryption, methods other than stored/deflate, inconsistent headers, duplicate or
 * unsafe names, overlapping entries, wrong CRCs, oversized archives) instead of guessing. Sizes and CRCs are
 * taken from the central directory, so entries written with data descriptors (as Playwright does) read fine.
 * Error messages describe structure only and never include archive content.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export const ZIP_MAX_ENTRIES = 20_000;
export const ZIP_MAX_TOTAL_BYTES = 1024 ** 3;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;

let crcTable: Uint32Array | undefined;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(data: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (t[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Throws for names that could escape an extraction directory or that are ambiguous. */
export function checkZipName(name: string): void {
  if (name.length === 0) throw new ZipError('zip entry with an empty name');
  if (name.includes('\0')) throw new ZipError('zip entry name contains a NUL byte');
  if (name.includes('\\')) throw new ZipError('zip entry name contains a backslash');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipError('zip entry name is an absolute path');
  if (name.split('/').includes('..')) throw new ZipError('zip entry name contains a ".." segment');
}

export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ZipError('not a zip archive (too short)');

  // End of central directory: the last record whose comment length reaches exactly to the end of the file.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip archive (no end of central directory)');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) throw new ZipError('zip64 archives are not supported');

  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countHere = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0 || countHere !== count) throw new ZipError('multi-disk zip archives are not supported');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
  if (count > ZIP_MAX_ENTRIES) throw new ZipError(`zip has more than ${ZIP_MAX_ENTRIES} entries`);
  if (cdOffset + cdSize > eocd) throw new ZipError('central directory is out of bounds');

  interface CdRecord {
    name: string;
    method: number;
    flags: number;
    crc: number;
    csize: number;
    usize: number;
    offset: number;
    nameBytes: Buffer;
    dir: boolean;
  }
  const records: CdRecord[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('bad central directory record');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const disk = buf.readUInt16LE(p + 34);
    const offset = buf.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cdOffset + cdSize) throw new ZipError('central directory record is out of bounds');
    if (flags & 0x1 || flags & 0x40 || flags & 0x2000) throw new ZipError('encrypted zip entries are not supported');
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported zip compression method ${method}`);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff || disk !== 0) throw new ZipError('zip64 archives are not supported');
    // Extra fields: a zip64 field means the sizes above are not the real ones.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = buf.readUInt16LE(x);
      const len = buf.readUInt16LE(x + 2);
      if (id === 0x0001 || id === 0x9901) throw new ZipError('zip64 or encrypted extra fields are not supported');
      x += 4 + len;
    }
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    let name = nameBytes.toString('utf8');
    const dir = name.endsWith('/');
    if (dir) name = name.slice(0, -1);
    checkZipName(name);
    if (seen.has(name)) throw new ZipError('duplicate zip entry name');
    seen.add(name);
    if (method === 0 && csize !== usize) throw new ZipError('stored zip entry has mismatched sizes');
    records.push({ name, method, flags, crc, csize, usize, offset, nameBytes: Buffer.from(nameBytes), dir });
    p = end;
  }
  if (p !== cdOffset + cdSize) throw new ZipError('central directory size mismatch');

  const extents: Array<[number, number]> = [];
  const entries: ZipEntry[] = [];
  let total = 0;
  for (const r of records) {
    if (r.offset + 30 > cdOffset || buf.readUInt32LE(r.offset) !== SIG_LOCAL) throw new ZipError('bad local header');
    const lflags = buf.readUInt16LE(r.offset + 6);
    const lmethod = buf.readUInt16LE(r.offset + 8);
    const lcrc = buf.readUInt32LE(r.offset + 14);
    const lcsize = buf.readUInt32LE(r.offset + 18);
    const lusize = buf.readUInt32LE(r.offset + 22);
    const lnameLen = buf.readUInt16LE(r.offset + 26);
    const lextraLen = buf.readUInt16LE(r.offset + 28);
    if (lmethod !== r.method) throw new ZipError('local header disagrees with the central directory (method)');
    if (lflags & 0x1) throw new ZipError('encrypted zip entries are not supported');
    const nameStart = r.offset + 30;
    if (nameStart + lnameLen > cdOffset || !buf.subarray(nameStart, nameStart + lnameLen).equals(r.nameBytes)) {
      throw new ZipError('local header disagrees with the central directory (name)');
    }
    const dataStart = nameStart + lnameLen + lextraLen;
    const dataEnd = dataStart + r.csize;
    if (dataEnd > cdOffset) throw new ZipError('zip entry data is out of bounds');
    let entryEnd = dataEnd;
    if (lflags & 0x8) {
      // Sizes and CRC follow the data; they must agree with the central directory.
      let d = dataEnd;
      if (d + 4 <= cdOffset && buf.readUInt32LE(d) === SIG_DESCRIPTOR) d += 4;
      if (d + 12 > cdOffset) throw new ZipError('missing data descriptor');
      if (buf.readUInt32LE(d) !== r.crc || buf.readUInt32LE(d + 4) !== r.csize || buf.readUInt32LE(d + 8) !== r.usize) {
        throw new ZipError('data descriptor disagrees with the central directory');
      }
      entryEnd = d + 12;
    } else if (lcrc !== r.crc || lcsize !== r.csize || lusize !== r.usize) {
      throw new ZipError('local header disagrees with the central directory (sizes)');
    }
    extents.push([r.offset, entryEnd]);

    if (r.dir) {
      if (r.usize !== 0) throw new ZipError('zip directory entry has content');
      continue;
    }
    total += r.usize;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new ZipError('zip expands to more than 1 GiB');
    const raw = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (r.method === 0) data = Buffer.from(raw);
    else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(r.usize, 1) });
      } catch {
        throw new ZipError('zip entry cannot be inflated (corrupt or larger than declared)');
      }
    }
    if (data.length !== r.usize) throw new ZipError('zip entry size does not match its header');
    if (crc32(data) !== r.crc) throw new ZipError('zip entry fails its CRC check');
    entries.push({ name: r.name, data });
  }

  extents.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < extents.length; i++) {
    if ((extents[i] as [number, number])[0] < (extents[i - 1] as [number, number])[1]) throw new ZipError('zip entries overlap');
  }
  return entries;
}

export function writeZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xfffe) throw new ZipError('too many zip entries to write');
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    checkZipName(e.name);
    if (seen.has(e.name)) throw new ZipError('duplicate zip entry name');
    seen.add(e.name);
    const name = Buffer.from(e.name, 'utf8');
    const compressed = deflateRawSync(e.data, { level: 6 });
    const crc = crc32(e.data);
    if (e.data.length >= 0xffffffff || compressed.length >= 0xffffffff || offset >= 0xffffffff) throw new ZipError('zip entry too large to write');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x0021, 12); // date: 1980-01-01, fixed so output is reproducible
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, 2.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x0021, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + compressed.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
