#!/usr/bin/env node
// 从设备上的 APK 提取真实启动图标与应用名。
// 只远程读 zip 中央目录 + 需要的几个条目，避免 adb pull 整个 250MB 安装包。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const rawArgs = argv;
const positional = argv.filter((a) => !a.startsWith('--'));
const OUT_DIR = path.join(rawArgs.find((f) => f.startsWith('--out='))?.slice(6) || 'public', 'icons');
const DEBUG = flags.includes('--debug');

/// 目标设备。调用方（src/manage.ts）每次解析前用 setSerial 注入；
/// 命令行跑脚本时用 --serial=xxx。没有它，adb 在多设备机器上直接报
/// "more than one device/emulator"，应用名解析必然失败，页面只能显示包名。
let SERIAL = rawArgs.find((f) => f.startsWith('--serial='))?.slice(9) || process.env.ANDROID_SERIAL || '';
export function setSerial(s) {
  SERIAL = String(s || '');
}
const scoped = (a) => (SERIAL ? ['-s', SERIAL, ...a] : a);

const adb = (...a) => execFileSync('adb', scoped(a), { maxBuffer: 256 * 1024 * 1024 });
const adbText = (...a) => execFileSync('adb', scoped(a), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const shq = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;

function remoteSize(p) {
  return Number(adbText('shell', `stat -c %s ${shq(p)}`).trim());
}

function remoteRead(p, offset, length) {
  const B = 512;
  const start = Math.floor(offset / B) * B;
  const pre = offset - start;
  const blocks = Math.ceil((pre + length) / B);
  const raw = adb('exec-out', `dd if=${shq(p)} bs=${B} skip=${start / B} count=${blocks} 2>/dev/null`);
  return raw.subarray(pre, Math.min(raw.length, pre + length));
}

// reader：{path,size,read(offset,length)} —— 本地 seek，设备端分块 dd，解析逻辑共用
function localReader(p) {
  const fd = fs.openSync(p, 'r');
  return {
    path: p,
    size: fs.fstatSync(fd).size,
    read(offset, length) {
      const buf = Buffer.alloc(length);
      return buf.subarray(0, fs.readSync(fd, buf, 0, length, offset));
    },
  };
}

function remoteReader(p) {
  return { path: p, size: remoteSize(p), read: (o, l) => remoteRead(p, o, l) };
}

// ---------------------------------------------------------------- zip

function zipEntries(rd) {
  const tailLen = Math.min(rd.size, 65536);
  const tail = rd.read(rd.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const total = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cd = rd.read(tail.readUInt32LE(eocd + 16), cdSize);
  const list = [];
  let o = 0;
  while (list.length < total && o + 46 <= cd.length && cd.readUInt32LE(o) === 0x02014b50) {
    const method = cd.readUInt16LE(o + 10);
    const comp = cd.readUInt32LE(o + 20);
    const uncomp = cd.readUInt32LE(o + 24);
    const nameLen = cd.readUInt16LE(o + 28);
    const extraLen = cd.readUInt16LE(o + 30);
    const cmtLen = cd.readUInt16LE(o + 32);
    const lho = cd.readUInt32LE(o + 42);
    list.push({ name: cd.subarray(o + 46, o + 46 + nameLen).toString('utf8'), method, comp, uncomp, lho });
    o += 46 + nameLen + extraLen + cmtLen;
  }
  return { rd, list };
}

function zipRead(rd, entry) {
  const lh = rd.read(entry.lho, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header ${entry.name}`);
  const dataAt = entry.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = rd.read(dataAt, entry.comp);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`method ${entry.method} unsupported`);
}

// ------------------------------------------------------------ strings

function readStringPool(buf, at) {
  const type = buf.readUInt16LE(at);
  const headerSize = buf.readUInt16LE(at + 2);
  const chunkSize = buf.readUInt32LE(at + 4);
  if (type !== 0x0001) return { strings: [], size: chunkSize || headerSize };
  const count = buf.readUInt32LE(at + 8);
  const flags = buf.readUInt32LE(at + 16);
  const stringsStart = at + buf.readUInt32LE(at + 20);
  const utf8 = (flags & 0x100) !== 0;
  const decodeU16 = (o) => {
    let n = buf.readUInt16LE(o);
    if (n & 0x8000) n = ((n & 0x7fff) << 16) | buf.readUInt16LE(o + 2);
    return buf.toString('utf16le', o + (buf.readUInt16LE(o) & 0x8000 ? 4 : 2), o + (buf.readUInt16LE(o) & 0x8000 ? 4 : 2) + n * 2);
  };
  const decodeU8 = (o) => {
    let n = buf[o];
    let p = 1;
    if (n & 0x80) { n = ((n & 0x7f) << 8) | buf[o + 1]; p = 2; }
    let bytes = buf[o + p];
    let bp = 1;
    if (bytes & 0x80) { bytes = ((bytes & 0x7f) << 8) | buf[o + p + 1]; bp = 2; }
    return buf.toString('utf8', o + p + bp, o + p + bp + bytes);
  };
  const strings = [];
  for (let i = 0; i < count; i++) {
    const s = stringsStart + buf.readUInt32LE(at + headerSize + i * 4);
    let v = '';
    try { v = utf8 ? decodeU8(s) : decodeU16(s); } catch { v = ''; }
    strings.push(v);
  }
  return { strings, size: chunkSize };
}

// --------------------------------------------------------------- AXXML

const XML_CHUNK = { start: 0x0102, resMap: 0x0180 };

function parseAXml(buf) {
  const pool = readStringPool(buf, buf.readUInt16LE(2));
  const nodes = [];
  let resMap = [];
  let o = buf.readUInt16LE(2) + pool.size;
  o = (o + 3) & ~3;
  while (o + 8 <= buf.length) {
    const type = buf.readUInt16LE(o);
    const size = buf.readUInt32LE(o + 4);
    if (size < 8 || o + size > buf.length) break;
    if (type === XML_CHUNK.resMap) {
      const n = (size - 8) >> 2;
      resMap = Array.from({ length: n }, (_, i) => buf.readUInt32LE(o + 8 + i * 4));
    } else if (type === XML_CHUNK.start) {
      const nameIdx = buf.readUInt32LE(o + 20);
      const attrCount = buf.readUInt16LE(o + 28);
      const attrs = {};
      for (let i = 0; i < attrCount; i++) {
        const a = o + 36 + i * 20;
        const ns = buf.readUInt32LE(a);
        const nm = buf.readUInt32LE(a + 4);
        const raw = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15];
        const data = buf.readUInt32LE(a + 16);
        attrs[pool.strings[nm]] = {
          ns: ns === 0xffffffff ? '' : pool.strings[ns] || '',
          resId: resMap[nm] ?? 0,
          raw: raw === 0xffffffff ? '' : pool.strings[raw] || '',
          dataType,
          data,
        };
      }
      nodes.push({ name: pool.strings[nameIdx], attrs });
    }
    o += size;
    o = (o + 3) & ~3;
  }
  return { strings: pool.strings, nodes };
}

// --------------------------------------------------------- resources.arsc

const T_STRING_POOL = 0x0001, T_TABLE = 0x0002, T_PACKAGE = 0x0200, T_TYPE = 0x0201, T_TYPE_SPEC = 0x0202;

function parseArsc(buf) {
  if (buf.readUInt16LE(0) !== T_TABLE) throw new Error('not a resource table');
  const tableHeaderSize = buf.readUInt16LE(2);
  const global = readStringPool(buf, tableHeaderSize);
  const packages = [];
  let o = tableHeaderSize + global.size;
  o = (o + 3) & ~3;
  while (o + 8 <= buf.length && buf.readUInt16LE(o) === T_PACKAGE) {
    const pkgStart = o;
    const pkgSize = buf.readUInt32LE(o + 4);
    const id = buf.readUInt32LE(o + 8);
    const name = buf.toString('utf16le', o + 12, o + 12 + 128 * 2).replace(/\u0000+$/, '');
    const typeStringsAt = pkgStart + buf.readUInt32LE(o + 268);
    const keyStringsAt = pkgStart + buf.readUInt32LE(o + 276);
    const typePool = readStringPool(buf, typeStringsAt);
    const keyPool = readStringPool(buf, keyStringsAt);
    const types = new Map();
    let t = (keyStringsAt + keyPool.size + 3) & ~3;
    // 0x0202 type-spec 与 0x0201 type 交替出现，spec 块要跳过而不是中断
    while (t + 8 <= pkgStart + pkgSize) {
      const chunkType = buf.readUInt16LE(t);
      const chunkSize = buf.readUInt32LE(t + 4);
      if (chunkSize < 8 || t + chunkSize > pkgStart + pkgSize) break;
      if (chunkType === T_TYPE_SPEC) {
        t = (t + chunkSize + 3) & ~3;
        continue;
      }
      if (chunkType !== T_TYPE) break;
      const typeId = buf[t + 8];
      if (entryGuard(buf, t, chunkSize)) { t = (t + chunkSize + 3) & ~3; continue; }
      const flags = buf[t + 9];
      const entryCount = buf.readUInt32LE(t + 12);
      const headerSize = buf.readUInt16LE(t + 2);
      const chunkEnd = t + chunkSize;
      const tableAt = (t + headerSize) & ~3;
      // 新 aapt：+16 存条目区偏移；老 aapt：条目区紧跟偏移表。两种都试，取能通过结构校验的那个
      const cands = [
        t + (buf.readUInt32LE(t + 16) || 0),
        (tableAt + entryCount * (flags & 0x8 ? 2 : 4)) & ~3,
      ].filter((e) => e > tableAt && e < chunkEnd);
      const score = (entriesAt) =>
        [0, Math.floor(entryCount / 2), entryCount - 1].every((i) => looksLikeEntry(buf, entryOffset(buf, tableAt, entriesAt, entryCount, i, flags)))
          ? 3
          : 0;
      const entriesAt = cands.sort((a, b) => score(b) - score(a))[0] || 0;
      // 同一 typeId 会有多个 config 块，某些条目只在非默认 config 里有值：全部记下，取第一个能解析的
      let rec = types.get(typeId);
      if (!rec) {
        rec = {
          typeName: typePool.strings[typeId - 1] ?? `type${typeId}`,
          chunks: [],
          debug: {
            typeAt: t,
            buf,
            headerSize,
            offsetsAt: tableAt,
            entriesAt,
            raw: (i) => {
              for (const c of rec.chunks) {
                const o = entryOffset(buf, c.tableAt, c.entriesAt, c.entryCount, i, c.flags);
                if (o) return buf.subarray(o, o + 40);
              }
              return null;
            },
          },
          entry(i) {
            for (const c of this.chunks) {
              const e = readEntry(buf, c.tableAt, c.entriesAt, c.entryCount, i, keyPool.strings, c.flags);
              if (e) return e;
            }
            return null;
          },
        };
        types.set(typeId, rec);
      }
      if (entriesAt) rec.chunks.push({ tableAt, entriesAt, entryCount, flags });
      t = (t + chunkSize + 3) & ~3;
    }
    packages.push({ id, name, types, keyPool: keyPool.strings, typePool: typePool.strings });
    o += (pkgSize + 3) & ~3;
  }
  return { global: global.strings, packages };
}

const entryGuard = (buf, t, chunkSize) => buf.readUInt32LE(t + 12) > 100000 || buf.readUInt32LE(t + 12) === 0;

function looksLikeEntry(buf, at) {
  if (!at || at + 16 > buf.length) return false;
  const size = buf.readUInt16LE(at);
  const eflags = buf.readUInt16LE(at + 2);
  if (size < 8 || size > 4096 || eflags > 0x1f) return false;
  if (eflags & 1) return true;
  const dt = buf[at + 11];
  return dt >= 1 && dt <= 0x1d;
}

function entryOffset(buf, tableAt, entriesAt, entryCount, index, flags) {
  if (!tableAt || !entriesAt || index < 0 || index >= entryCount) return 0;
  if (tableAt + index * 4 + 4 > buf.length) return 0;
  // 稀疏表：索引数组为 (u16 条目号, u16 相对偏移) 对
  if (flags & 0x8) {
    for (let i = 0; i < entryCount; i++) {
      const pair = buf.readUInt32LE(tableAt + i * 4);
      if ((pair & 0xffff) === index) return entriesAt + (pair >>> 16);
    }
    return 0;
  }
  const rel = buf.readUInt32LE(tableAt + index * 4);
  return rel === 0xffffffff ? 0 : entriesAt + rel;
}

function readEntry(buf, tableAt, entriesAt, entryCount, index, keys, flags) {
  const at = entryOffset(buf, tableAt, entriesAt, entryCount, index, flags);
  if (!at || at + 12 > buf.length) return null;
  const size = buf.readUInt16LE(at);
  const eflags = buf.readUInt16LE(at + 2);
  if (size < 8) return null;
  const out = { key: keys[buf.readUInt32LE(at + 4)] ?? '' };
  if (eflags & 0x1) {
    const count = buf.readUInt32LE(at + 20);
    out.parent = buf.readUInt32LE(at + 16);
    out.name = buf.readUInt32LE(at + 8);
    const maps = [];
    const base = at + size;
    for (let i = 0; i < count && base + i * 12 + 12 <= buf.length; i++) {
      const m = base + i * 12;
      maps.push({ name: buf.readUInt32LE(m), type: buf[m + 7], data: buf.readUInt32LE(m + 8) });
    }
    out.maps = maps;
  } else {
    out.type = buf[at + 11];
    out.data = buf.readUInt32LE(at + 12);
  }
  return out;
}

function arscLookup(table, resId) {
  const pkgId = (resId >>> 24) & 0xff;
  const typeId = (resId >>> 16) & 0xff;
  const entryId = resId & 0xffff;
  const pkg = table?.packages.find((p) => p.id === pkgId);
  const type = pkg?.types.get(typeId);
  if (!type) return null;
  const e = type.entry(entryId);
  if (!e) return null;
  return { ...e, typeName: type.typeName, pkg };
}

// 字符串型值（TYPE_STRING=3）的 data 是全局 pool 的下标（本机型 aapt 全部走全局表）
function arscString(table, entry) {
  return table.global[entry.data] ?? '';
}

// ------------------------------------------------------------- 图标解析

const DENSITY_ORDER = ['xxhdpi', 'xhdpi', 'hdpi', 'mdpi', 'nospi', 'nodpi', 'ldpi', 'anydpi-v26', ''];

function pickIconFile(zip, baseName, exts = ['png', 'webp', 'xml']) {
  const found = [];
  for (const e of zip.list) {
    const m = e.name.match(/^(?:res\/([^/]+)\/)?(.+?)((?:\.9)?\.(png|webp|xml))$/i);
    if (!m || m[2] !== baseName) continue;
    const ext = m[4].toLowerCase();
    if (!exts.includes(ext) || m[3].includes('.9')) continue;
    found.push({ ...e, folder: m[1] ?? '', ext });
  }
  if (!found.length) return null;
  const rank = (f) => {
    const idx = DENSITY_ORDER.findIndex((d) => d && f.folder.includes(d));
    return idx < 0 ? 99 : idx;
  };
  return found.sort((a, b) => rank(a) - rank(b) || a.comp - b.comp)[0];
}

function resolveIconName(table, resId) {
  const hit = arscLookup(table, resId);
  if (!hit) return null;
  if (hit.type === 3) return { kind: 'file', value: arscString(table, hit), key: hit.key };
  if (hit.type === 1 || hit.type === 4) return { kind: 'ref', value: hit.data, key: hit.key };
  if (hit.maps?.length) {
    const first = hit.maps.find((m) => m.type === 3 || m.type === 1 || m.type === 4);
    if (first) {
      return first.type === 3
        ? { kind: 'file', value: table.global[first.data] ?? '', key: hit.key }
        : { kind: 'ref', value: first.data, key: hit.key };
    }
  }
  return { kind: 'name', key: hit.key };
}

function baseName(p) {
  return path.basename(p).replace(/\.(9\.)?(png|webp|xml)$/i, '');
}

const asResult = (entry) =>
  entry
    ? { entry, name: baseName(entry.name), ext: entry.ext ?? entry.name.match(/\.(png|webp|xml)$/i)?.[1]?.toLowerCase() }
    : null;

/// 图标来源可能是：直接给 res/ 路径、给资源名要挑密度、或 adaptive-icon XML（优先 foreground，回退同名 legacy PNG）
function iconFor(zip, table, resId, depth = 0) {
  if (!resId || depth > 4) return null;
  const info = resolveIconName(table, resId);
  if (!info) return null;
  if (info.kind === 'ref') return iconFor(zip, table, info.value, depth + 1);

  const direct = info.kind === 'file' && info.value ? zip.list.find((x) => x.name === info.value) : null;
  const directExt = direct?.name.match(/\.(png|webp|xml)$/i)?.[1]?.toLowerCase();
  if (directExt === 'png' || directExt === 'webp') {
    // 默认 config 常指向 mdpi，同一图标的高密度版本更适合当磁贴
    return asResult(pickIconFile(zip, baseName(direct.name), [directExt]) ?? { ...direct, ext: directExt });
  }

  const names = [...new Set([info.key, direct ? baseName(direct.name) : null].filter(Boolean))];
  for (const n of names) {
    const hit = pickIconFile(zip, n, ['png', 'webp']);
    if (hit) return asResult(hit);
  }
  const xmlEntry = directExt === 'xml' ? { ...direct, ext: 'xml' } : names.map((n) => pickIconFile(zip, n, ['xml'])).find(Boolean);
  if (!xmlEntry) return null;
  try {
    const xml = parseAXml(zipRead(zip.rd, xmlEntry));
    const withDrawable = xml.nodes.filter((n) => n.attrs.drawable?.data);
    const order = [...withDrawable.filter((n) => n.name === 'foreground'), ...withDrawable];
    for (const n of order) {
      const got = iconFor(zip, table, n.attrs.drawable.data, depth + 1);
      if (got) return got;
    }
  } catch { /* 落到 monogram */ }
  return null;
}

/// 去掉 bidirectional isolate/override 控制符，避免应用名在页面上串位
const clean = (s) => String(s ?? '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();

// ------------------------------------------------------------------ 主流程

function readerFor(arg) {
  return arg.endsWith('.apk') ? localReader(arg) : remoteReader(appApk(arg));
}

function appApk(pkg) {
  const out = adbText('shell', `pm path ${shq(pkg)}`).trim();
  const first = out.split('\n').find((l) => l.startsWith('package:'));
  if (!first) throw new Error('无 base.apk 路径');
  return first.slice('package:'.length).trim();
}

function manifestOf(zip) {
  const e = zip.list.find((x) => x.name === 'AndroidManifest.xml');
  if (!e) throw new Error('无 AndroidManifest.xml');
  return parseAXml(zipRead(zip.rd, e));
}

function labelOf(manifest, table, resId) {
  const hit = arscLookup(table, resId);
  if (!hit) return '';
  if (hit.type === 3) return arscString(table, hit);
  if (hit.type === 1 || hit.type === 4) return labelOf(manifest, table, hit.data);
  return '';
}

function launcherNode(manifest, activityName) {
  const app = manifest.nodes.find((n) => n.name === 'application');
  const activity = activityName
    ? manifest.nodes.find((n) => n.name === 'activity' &&
        String(n.attrs.name?.raw ?? '').endsWith(activityName))
    : null;
  return { app, activity };
}

function launcherIconResId(manifest, activityName) {
  const { app, activity } = launcherNode(manifest, activityName);
  return activity?.attrs.icon?.data || app?.attrs.icon?.data || 0;
}

function launcherLabel(manifest, table, activityName) {
  const { app, activity } = launcherNode(manifest, activityName);
  for (const a of [activity?.attrs.label, app?.attrs.label]) {
    if (!a) continue;
    if (a.raw) return a.raw;
    if (a.data) {
      const s = labelOf(manifest, table, a.data);
      if (s) return s;
    }
  }
  return '';
}

export { adbText, shq, remoteRead, zipEntries, zipRead, readStringPool, parseAXml, parseArsc, arscLookup, localReader, remoteReader, readerFor, appApk, resolveIconName, pickIconFile, baseName, arscString, manifestOf, launcherLabel, launcherIconResId };

if (!process.env.ICON_LIB_ONLY) main();

function main() {
  if (flags.includes('--reset')) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  /// 默认跟既有索引合并：只跑部分应用时不会丢掉之前解出的条目，全量重建才用 --reset
  const idxFile = path.join(OUT_DIR, 'index.json');
  let index = {};
  if (fs.existsSync(idxFile)) {
    try {
      index = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    } catch {
      index = {};
    }
  }

  const all = fs.existsSync('/tmp/tvdeck_apps.json')
    ? JSON.parse(fs.readFileSync('/tmp/tvdeck_apps.json', 'utf8'))
    : [];
  const apps = positional.length
    ? positional.map((p) => all.find((a) => a.package === p) ?? { package: p, component: '' })
    : all;

  for (const app of apps) {
    const pkg = app.package;
    try {
      const zip = zipEntries(readerFor(pkg));
      const manifest = manifestOf(zip);
      const realPkg = pkg.endsWith('.apk') ? manifest.nodes[0]?.attrs.package?.raw || path.basename(pkg, '.apk') : pkg;
      const arscEntry = zip.list.find((x) => x.name === 'resources.arsc');
      const table = arscEntry ? parseArsc(zipRead(zip.rd, arscEntry)) : null;
      const act = String(app.component ?? '').includes('/')
        ? String(app.component).slice(String(app.component).indexOf('/'))
        : '';
      const iconRes = launcherIconResId(manifest, act);
      const found = iconRes ? iconFor(zip, table, iconRes) : null;
      const label = clean(launcherLabel(manifest, table, act));
      if (DEBUG) console.error(`[dbg] ${realPkg} iconRes=0x${(iconRes >>> 0).toString(16)} found=${found?.entry?.name} label=${JSON.stringify(label)}`);
      if (!found) {
        console.log(`${realPkg}: 无图标（${label || '无名'}）`);
        if (label) index[realPkg] = { label };
        continue;
      }
      const buf = zipRead(zip.rd, found.entry);
      const file = `${realPkg}.${found.ext}`;
      fs.writeFileSync(path.join(OUT_DIR, file), buf);
      index[realPkg] = { file, ext: found.ext, bytes: buf.length, icon: found.entry.name, name: found.name, label };
      console.log(`${realPkg} → ${found.entry.name} (${buf.length}B) label=${clean(label) || '-'}`);
    } catch (err) {
      console.error(`${pkg}: 失败 ${err.message}${DEBUG ? '\n' + err.stack : ''}`);
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`本次 ${apps.length} 个应用，索引共 ${Object.keys(index).length} 项 → ${OUT_DIR}/index.json`);
}
