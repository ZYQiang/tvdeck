import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, under } from './home.ts';
import { Adb } from './adb.ts';
import { iconIndex } from './icons.ts';
import { friendlyModel, type DeviceProfile } from './profile.ts';
import {
  AOSP_NAMES,
  fillLabels,
  forgetPkg,
  humanizePkg,
  readNames,
  resolveName,
  searchKey,
  usableLabel,
  writeName,
} from './names.ts';

export interface OpResult {
  ok: boolean;
  command: string;
  detail: string;
  verified: boolean;
}

const PKG_RE = /^[A-Za-z0-9._-]+$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shq = (p: string) => `'${String(p).replace(/'/g, `'\\''`)}'`;
export const humanSize = (bytes: number): string => {
  const n = Number(bytes) || 0;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
};

/// 文件管理只让这些前缀可见：系统分区能看不能写，避免误删
const FS_ROOTS = ['/storage', '/sdcard', '/data/local/tmp', '/data/app', '/system', '/proc/meminfo'];
const BAD_PATH = /["'`$;|&<>\n]|\.\./;

export const namesPath = under('names.json');
const uploadsDir = under('uploads');

/// 名字的读写统一在 src/names.ts：桌面候选、启动项、可启动清单、应用列表共用一份缓存
export { readNames, writeName };

export const badPkg = (pkg: string): OpResult | null =>
  PKG_RE.test(pkg) ? null : { ok: false, command: `校验包名 ${pkg}`, detail: '包名字符不合法，拒绝执行', verified: false };

const thirdPartyCmd = 'pm list packages -3';

function pkgsOf(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter((l) => l && !l.includes(' '));
}

/// 一次 dumpsys package packages（本机实测 218KB / 0.25s）拿到全部版本信息，
/// 比每个包单独 dumpsys 快一个量级
function parsePackages(text: string): Map<string, { version: string; targetSdk: string; abi: string; codePath: string }> {
  const out = new Map<string, { version: string; targetSdk: string; abi: string; codePath: string }>();
  let cur: string | null = null;
  for (const line of text.split('\n')) {
    const head = line.match(/^\s*Package \[([\w.]+)\] \([0-9a-f]+\):/);
    if (head) {
      cur = head[1];
      if (!out.has(cur)) out.set(cur, { version: '', targetSdk: '', abi: '', codePath: '' });
      continue;
    }
    if (!cur) continue;
    const rec = out.get(cur)!;
    const v = line.match(/versionName=(\S+)/);
    if (v && !rec.version) rec.version = v[1];
    const t = line.match(/targetSdk=(\d+)/);
    if (t && !rec.targetSdk) rec.targetSdk = t[1];
    const c = line.match(/codePath=(\S+)/);
    if (c && !rec.codePath && c[1] !== 'null') rec.codePath = c[1];
    const a = line.match(/primaryCpuAbi=(\S+)/);
    // dumpsys 对读不到的字段写的是字面量 null，直接透出的话页面上会出现「· null ·」
    if (a && !rec.abi && a[1] !== 'null') rec.abi = a[1];
  }
  return out;
}

export interface ProcRow {
  pid: number;
  rssKb: number;
  name: string;
  kernel: boolean;
}

export async function processList(adb: Adb): Promise<ProcRow[]> {
  const r = await adb.shellAsync('ps -A -o PID,RSS,NAME', 20000);
  const rows: ProcRow[] = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), rssKb: Number(m[2]), name: m[3].trim(), kernel: m[3].startsWith('[') });
  }
  return rows.sort((a, b) => b.rssKb - a.rssKb);
}

export interface AppRow {
  pkg: string;
  label: string;
  named: string;
  version: string;
  targetSdk: string;
  abi: string;
  running: boolean;
  pid: number;
  rssKb: number;
  icon?: string;
  /// 厂商预装 / 系统包：页面据此提前禁用卸载与清数据，不等人点了才报错
  system: boolean;
  /// 有没有启动入口（LAUNCHER / LEANBACK_LAUNCHER / HOME 任一）
  launchable: boolean;
  /// 可搜索文本：显示名 + 包名 + 中英文同义叫法，页面搜索框直接比这一串
  search: string;
}

export interface Inventory {
  rows: AppRow[];
  ms: number;
  /// 设备上的已安装包总数（含未列出的框架包）
  total: number;
  /// 本次列出的条数
  listed: number;
  third: number;
  sys: number;
  /// 这台设备是否支持「查启动入口」的命令。不支持时所有 launchable 都是 false，
  /// 那是「查不出来」而不是「没有入口」，调用方不能拿它拒绝启动
  launchKnown: boolean;
  note: string;
}

/// 三种启动入口都查：手机/平板用 LAUNCHER，大屏设备用 LEANBACK_LAUNCHER，
/// 厂商桌面可能只注册 HOME。只取包名，不补 label，够清单分类用了。
const LAUNCH_CATS = ['LAUNCHER', 'LEANBACK_LAUNCHER', 'HOME'];

async function launchablePkgs(adb: Adb): Promise<{ set: Set<string>; ok: boolean }> {
  const set = new Set<string>();
  const outs = await Promise.all(
    LAUNCH_CATS.map((c) =>
      adb
        .shellAsync(
          `cmd package query-activities --brief --components -a android.intent.action.MAIN -c android.intent.category.${c} 2>&1 || pm query-activities --brief --components -a android.intent.action.MAIN -c android.intent.category.${c} 2>&1`,
          25000,
        )
        .catch(() => null),
    ),
  );
  let ok = false;
  for (const o of outs) {
    const text = (o?.stdout ?? '') + (o?.stderr ?? '');
    // 命令本身不存在的设备（老 pm / 裁掉子命令的定制 ROM）会把用法提示打回来
    if (o && !/unknown command|Error|usage:/i.test(text)) ok = true;
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^([A-Za-z][\w.]*)\/(\S+)$/);
      if (m) set.add(m[1]);
    }
  }
  return { set, ok };
}

/// 已安装应用清单。
/// 以前只列 `pm list packages -3`（第三方包），预装为主的设备（机顶盒、
/// ATV 镜像）第三方包是 0，页面就永远空着，看起来像坏了。现在列设备上的
/// 全部包，用 system / launchable 两个标记区分身份：预装包照样能打开和强停，
/// 但卸载与清数据在页面上直接禁用（服务端 thirdPartyOnly 仍是最后一道闸）。
/// 默认只铺「有启动入口 / 第三方 / 正在运行」的，纯框架包收进「全部」筛选里，
/// 免得把上百个 com.android.xxx 倒给用户。
export async function appInventory(adb: Adb, profile: DeviceProfile): Promise<Inventory> {
  const t0 = Date.now();
  const [dump, all, third, procs, launch] = await Promise.all([
    adb.dumpsysAsync('package', 'packages', 40000),
    adb.shellAsync('pm list packages', 20000),
    adb.shellAsync(thirdPartyCmd, 20000),
    processList(adb),
    launchablePkgs(adb),
  ]);
  const meta = parsePackages(dump.stdout);
  const cached = readNames();
  const icons = iconIndex(path.join(APP_ROOT, 'public', 'icons'));
  const known = new Map(profile.apps.map((a) => [a.package, a]));
  const byName = new Map(procs.map((p) => [p.name, p]));
  const thirdSet = new Set(pkgsOf(third.stdout));
  const pkgs = pkgsOf(all.stdout);
  const rows: AppRow[] = pkgs
    .map((pkg) => {
      const m = meta.get(pkg) ?? { version: '', targetSdk: '', abi: '', codePath: '' };
      // 系统包统一给固定中文名，设备语言是英文也不会顶出 Calendar / Settings。
      const fromAosp = AOSP_NAMES[pkg];
      // profile 里有些 label 是 probe 当时取不到应用名退写成包名的，这种不能算"有中文名"
      const fromIcon = usableLabel(icons[pkg]?.label ?? '', pkg);
      const fromProfile = usableLabel(known.get(pkg)?.name ?? known.get(pkg)?.label ?? '', pkg);
      const fromCache = usableLabel(cached[pkg] ?? '', pkg);
      const label = fromAosp || fromIcon || fromProfile || fromCache || pkg;
      const named = fromAosp || fromIcon || fromProfile ? '设备已登记' : fromCache ? 'APK 解析' : '包名（未解析）';
      const p = byName.get(pkg);
      return {
        pkg,
        label,
        named,
        version: m.version,
        targetSdk: m.targetSdk,
        abi: m.abi,
        running: !!p,
        pid: p?.pid ?? 0,
        rssKb: p?.rssKb ?? 0,
        icon: icons[pkg]?.file ? `/icons/${icons[pkg].file}` : (known.get(pkg)?.icon ?? ''),
        system: !thirdSet.has(pkg),
        launchable: launch.set.has(pkg),
        /// 占位：label 还要等下面的 APK 解析补全，search 在补完后统一算
        search: '',
      };
    })
    .sort(
      (a, b) =>
        Number(b.running) - Number(a.running) ||
        Number(!a.system) - Number(!b.system) ||
        Number(b.launchable) - Number(a.launchable) ||
        a.label.localeCompare(b.label, 'zh'),
    );

  // 值得认名字的那批：有启动入口的、用户自己装的。纯框架包不去解 APK，
  // 否则一次清单要拉上百个 adb exec-out，首屏必然变慢。
  const worth = rows.filter((r) => r.launchable || !r.system);
  // 「常用」= 有启动入口的 + 自己装的。正在运行的后台框架包（Gms、Systemui 这类）
  // 不算常用，它们在「运行中」和「全部」里能看到，默认铺出来只会挤掉真正的应用。
  const shown = worth;
  const unresolved = worth.filter((r) => r.named === '包名（未解析）').slice(0, 24);
  // 解 APK 名字是清单里最慢的一段（一包一次 adb exec-out）。给它 6 秒预算：
  // 超时就先用包名末段出结果，剩下的下一轮续温再补，页面不该为名字站在原地等。
  const deadline = t0 + 6000;
  for (let i = 0; i < unresolved.length; i += 5) {
    if (Date.now() > deadline) {
      unresolved.splice(i);
      break;
    }
    const batch = unresolved.slice(i, i + 5);
    const names = await Promise.all(batch.map((r) => resolveName(adb, r.pkg).catch(() => '')));
    batch.forEach((row, j) => {
      if (names[j]) {
        row.label = names[j];
        row.named = 'APK 解析';
      }
    });
  }
  // 还是解析不出来的：整串包名对用户没有信息量，退成包名末段
  for (const r of rows) if (r.named === '包名（未解析）') r.label = humanizePkg(r.pkg);
  // 名字全部定稿后才算可搜索串：中英文同义叫法在这一步并进去
  for (const r of rows) r.search = searchKey(r.label, r.pkg);

  const autoResolved = unresolved.filter((r) => r.named === 'APK 解析').length;
  const thirdCount = rows.filter((r) => !r.system).length;
  const sysCount = rows.length - thirdCount;
  const hidden = rows.length - shown.length;
  return {
    // 全量回给页面，由页面按筛选决定显示哪一批：切「全部」不需要再等一次 adb
    rows,
    ms: Date.now() - t0,
    total: rows.length,
    listed: shown.length,
    third: thirdCount,
    sys: sysCount,
    launchKnown: launch.ok,
    note: [
      `共 ${rows.length} 个包：${thirdCount} 个自己装的，${sysCount} 个预装`,
      hidden ? `另有 ${hidden} 个后台/框架包` : '',
      '预装包可打开和强停，不参与卸载',
      autoResolved ? `本轮自动解析出 ${autoResolved} 个名字` : '',
      !launch.ok && !launch.set.size ? '没查到启动入口，列表按运行状态排列' : '',
    ]
      .filter(Boolean)
      .join('。'),
  };
}

/// 复用 scripts/extract-icons.mjs 的 AXML/arsc 解析器：只读 zip 中央目录和两个条目，不 pull 整个 APK
async function extractor() {
  process.env.ICON_LIB_ONLY = '1';
  const url = new URL('../scripts/extract-icons.mjs', import.meta.url).href;
  return import(url);
}

export async function resolveAppName(
  adb: Adb,
  pkg: string,
): Promise<OpResult & { label?: string; search?: string }> {
  const err = badPkg(pkg);
  if (err) return err;
  const cmd = `pm path ${pkg}`;
  const p = await adb.shellAsync(cmd, 20000).catch(() => null);
  const apk = pkgsOf(p?.stdout ?? '')[0] ?? '';
  if (!apk) return { ok: false, command: cmd, detail: `读不到 ${pkg} 的 APK 路径（系统内置或已卸载）`, verified: false };
  const label = await resolveName(adb, pkg);
  // 一并回传可搜索串：页面上点「解析名称」只改 label 的话，
  // 那一行的搜索关键词会停在旧名字上，搜新名字反而找不到
  if (label)
    return {
      ok: true,
      command: `解析 ${path.basename(apk)}`,
      detail: `${pkg} → ${label}`,
      verified: true,
      label,
      search: searchKey(label, pkg),
    };
  return { ok: false, command: `解析 ${path.basename(apk)}`, detail: '解析不出应用名，只能显示包名', verified: false };
}

/// 本机上传的 APK：本地解析包名和中文名，装完用它做回读确认
export async function apkMetaLocal(hostPath: string): Promise<{ pkg: string; label: string; version: string }> {
  const lib = await extractor();
  const zip = lib.zipEntries(lib.localReader(hostPath));
  const manifest = lib.manifestOf(zip);
  const arsc = zip.list.find((x: { name: string }) => x.name === 'resources.arsc');
  const table = arsc ? lib.parseArsc(lib.zipRead(zip.rd, arsc)) : null;
  return {
    pkg: String(manifest.nodes[0]?.attrs?.package?.raw ?? ''),
    label: String(lib.launcherLabel(manifest, table, '') || '').trim(),
    version: '',
  };
}

async function pkgState(adb: Adb, pkg: string): Promise<{ present: boolean; system: boolean; version: string }> {
  if (!PKG_RE.test(pkg)) return { present: false, system: false, version: '' };
  const [list, sys, dump] = await Promise.all([
    adb.shellAsync(`pm list packages ${shq(pkg)}`, 20000),
    adb.shellAsync(`pm list packages -s ${shq(pkg)}`, 20000),
    adb.shellAsync(`dumpsys package ${shq(pkg)} | grep -m1 versionName`, 20000),
  ]);
  const exact = pkgsOf(list.stdout).includes(pkg);
  return {
    present: exact,
    system: pkgsOf(sys.stdout).includes(pkg),
    version: (dump.stdout.match(/versionName=(\S+)/) ?? [])[1] ?? '',
  };
}

/// 上传后先给页面看一眼：这个 APK 是谁、设备端有没有、是不是厂商预装的（预装包覆盖要用户确认）
export async function apkPreview(adb: Adb, hostPath: string): Promise<{ pkg: string; label: string; present: boolean; system: boolean; version: string }> {
  const empty = { pkg: '', label: '', present: false, system: false, version: '' };
  if (!/\.apk$/i.test(hostPath)) return empty;
  let meta: { pkg: string; label: string };
  try {
    meta = await apkMetaLocal(hostPath);
  } catch {
    return empty;
  }
  if (!meta.pkg) return empty;
  const st = await pkgState(adb, meta.pkg);
  return { ...meta, ...st };
}

export async function installFromHost(adb: Adb, hostPath: string, confirmSystem = false): Promise<OpResult & { pkg?: string; needsConfirm?: boolean }> {
  if (!fs.existsSync(hostPath)) return { ok: false, command: `安装 ${hostPath}`, detail: '上传文件不存在或已被清理', verified: false };
  const size = fs.statSync(hostPath).size;
  const remote = `/data/local/tmp/${path.basename(hostPath).replace(/[^\w.\-]/g, '_')}`;
  let meta = { pkg: '', label: '' };
  try {
    meta = await apkMetaLocal(hostPath);
  } catch {
    meta = { pkg: '', label: '' };
  }
  const before = meta.pkg ? await pkgState(adb, meta.pkg) : { present: false, system: false, version: '' };
  if (before.system && !confirmSystem) {
    return {
      ok: false,
      command: `安装 ${path.basename(hostPath)}`,
      detail: `已拦下：${meta.pkg}（${meta.label || '无中文名'}）是系统包，覆盖会改动原厂状态，需在页面确认后执行`,
      verified: false,
      pkg: meta.pkg,
      needsConfirm: true,
    };
  }
  const push = await adb.pushAsync(hostPath, remote, 300000);
  if (push.code !== 0 && !/pushed|file pushed/i.test(push.stdout + push.stderr)) {
    return { ok: false, command: `adb push → ${remote}`, detail: `${(push.stderr + push.stdout).trim().slice(0, 240)}（${humanSize(size)}）`, verified: false };
  }
  const ins = await adb.runAsync(['shell', `pm install -r -t ${shq(remote)}`], 300000);
  const text = (ins.stdout + ins.stderr).trim();
  await adb.shellAsync(`rm -f ${shq(remote)}`, 20000);
  const after = meta.pkg ? await pkgState(adb, meta.pkg) : { present: false, system: false, version: '' };
  const success = /Success/i.test(text);
  if (meta.pkg && meta.label) writeName(meta.pkg, meta.label);
  /// 重装换了 APK 位置或补上了 launcher 标签，旧缓存必须作废，否则页面一直显示老名字
  if (meta.pkg && success) forgetPkg(adb.serial, meta.pkg);
  const who = meta.pkg ? `${meta.pkg}${meta.label ? `（${meta.label}）` : ''}` : path.basename(hostPath);
  let how = '安装完成';
  if (!before.present && after.present) how = '新装';
  else if (before.present && after.version && after.version !== before.version) how = `版本 ${before.version} → ${after.version}`;
  else if (before.present) how = `同版本覆盖（设备端已有 ${before.version || '未知版本'}${before.system ? '，这是厂商预装包' : ''}）`;
  return {
    ok: success && after.present,
    command: `push ${humanSize(size)} + pm install -r -t`,
    detail: success
      ? `${who} · ${how}（pm list / versionName 已回读）· ${text}`
      : `安装失败：${text.slice(0, 240) || '无输出'}`,
    verified: success && after.present,
    pkg: meta.pkg,
  };
}

/// monkey 的 stdout 是一大串 arg 回显，没有意义；启动是否成功只认进程表回读。
/// 但设备端明确拒绝时不能再看进程表：输入法、GMS 这类常驻包本来就在表里，
/// 照着回读会把「根本没启动」报成「已启动」（Gboard 就是这样被误判的）。
export async function launchPackage(adb: Adb, pkg: string): Promise<OpResult> {
  const err = badPkg(pkg);
  if (err) return err;
  /// 大屏应用只注册 LEANBACK_LAUNCHER，厂商桌面可能只有 HOME，三个类别都要试
  const cats = ['LAUNCHER', 'LEANBACK_LAUNCHER', 'HOME'];
  const REJECT_RE = /No activities found|does not specify a category|Error|Exception/i;
  let cmd = '';
  let accepted = false;
  let lastText = '';
  for (const cat of cats) {
    cmd = `monkey -p ${pkg} -c android.intent.category.${cat} 1`;
    const r = await adb.shellAsync(cmd, 30000);
    const text = (r.stdout + r.stderr).trim();
    lastText = text;
    /// 退 0 且没有拒绝字样才算这一类别通了（monkey 找不到 activity 时会退非 0 并打
    /// 「No activities found to run, monkey aborted.」）
    if (r.code === 0 && !REJECT_RE.test(text)) {
      accepted = true;
      break;
    }
  }
  if (!accepted) {
    /// 「没装」和「装了但没启动入口」是两回事，前者页面上应该提示去装，
    /// 后者是输入法、GMS 这类常驻包，只能从设备图标进
    const probe = await adb.shellAsync(`pm list packages ${pkg}`, 15000).catch(() => null);
    const installed = (probe?.stdout ?? '').split('\n').some((l) => l.trim() === `package:${pkg}`);
    return {
      ok: false,
      command: cmd,
      detail: installed
        ? '这个应用没有可启动入口（系统常驻组件），只能在设备上点图标打开'
        : '设备上没装这个应用。确认包名，或先在应用列表里找到它',
      verified: false,
    };
  }
  let pid = 0;
  for (let i = 0; i < 10; i++) {
    const p = (await processList(adb)).find((x) => x.name === pkg);
    if (p) {
      pid = p.pid;
      break;
    }
    await sleep(200);
  }
  return {
    ok: true,
    command: cmd,
    detail: pid ? `${pkg} 已启动（pid ${pid}，进程表回读确认）` : '已交给系统启动（应用复用现有进程，暂时看不到新 pid）',
    verified: !!pid,
  };
}

export async function forceStopApp(adb: Adb, pkg: string): Promise<OpResult> {
  const err = badPkg(pkg);
  if (err) return err;
  const cmd = `am force-stop ${pkg}`;
  const r = await adb.shellAsync(cmd, 20000);
  let gone = false;
  for (let i = 0; i < 6; i++) {
    const procs = await processList(adb);
    if (!procs.some((p) => p.name === pkg || p.name.startsWith(`${pkg}:`))) {
      gone = true;
      break;
    }
    await sleep(220);
  }
  const text = (r.stdout + r.stderr).trim();
  return {
    ok: r.code === 0,
    command: cmd,
    detail: gone ? `${pkg} 的进程已消失（回读确认）` : `命令已发出但进程还在：${text || pkg}（可能被系统拉起）`,
    verified: gone,
  };
}

/// 用户定的硬规则：只动第三方（用户自己装的）包。厂商预装/系统包一律拒绝卸载和清数据。
async function thirdPartyOnly(adb: Adb, pkg: string, verb: string): Promise<OpResult | null> {
  const list = await adb.shellAsync(thirdPartyCmd, 20000);
  if (pkgsOf(list.stdout).includes(pkg)) return null;
  const sys = pkgsOf((await adb.shellAsync(`pm list packages -s ${shq(pkg)}`, 20000)).stdout);
  return {
    ok: false,
    command: `${verb} ${pkg}`,
    detail: sys.includes(pkg)
      ? `已拒绝：${pkg} 是厂商预装/系统包，不在第三方包列表里`
      : `已拒绝：${pkg} 不在第三方包列表里（可能没装，也可能是系统包）`,
    verified: false,
  };
}

export async function clearAppData(adb: Adb, pkg: string): Promise<OpResult> {
  const err = badPkg(pkg);
  if (err) return err;
  const guard = await thirdPartyOnly(adb, pkg, 'pm clear');
  if (guard) return guard;
  const cmd = `pm clear ${pkg}`;
  const r = await adb.shellAsync(cmd, 30000);
  const ok = /Success/i.test(r.stdout + r.stderr);
  return { ok, command: cmd, detail: ok ? `${pkg} 数据已清除（系统回读确认成功）` : (r.stdout + r.stderr).trim().slice(0, 200) || '无输出', verified: ok };
}

export async function uninstallApp(adb: Adb, pkg: string): Promise<OpResult> {
  const err = badPkg(pkg);
  if (err) return err;
  const guard = await thirdPartyOnly(adb, pkg, 'pm uninstall');
  if (guard) return guard;
  const cmd = `pm uninstall ${pkg}`;
  const r = await adb.shellAsync(cmd, 60000);
  forgetPkg(adb.serial, pkg);
  const said = /Success/i.test(r.stdout + r.stderr);
  const list = await adb.shellAsync(thirdPartyCmd, 20000);
  const still = pkgsOf(list.stdout).includes(pkg);
  return {
    ok: said && !still,
    command: cmd,
    detail: still ? `${pkg} 仍在第三方包列表里` : said ? `${pkg} 已卸载（列表回读确认不存在）` : (r.stdout + r.stderr).trim().slice(0, 200) || '无输出',
    verified: said && !still,
  };
}

export function uploadTarget(name: string): { host: string; base: string } {
  const base = path.basename(String(name)).replace(/[^\w.\-+() ]/g, '_').slice(0, 120) || 'upload.bin';
  fs.mkdirSync(uploadsDir, { recursive: true });
  return { host: path.join(uploadsDir, `${Date.now()}_${base}`), base };
}

export interface FsRow {
  name: string;
  kind: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: string;
  owner: string;
}

function parseLs(text: string, dir: string): { rows: FsRow[]; note: string } {
  const rows: FsRow[] = [];
  let note = '';
  for (const line of text.split('\n')) {
    const l = line.replace(/\r/g, '');
    if (!l.trim() || /^total /i.test(l)) continue;
    const m = l.match(/^([dlcpsb\-][rwxsStT\-]{9})\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.*)$/);
    if (!m) {
      note = l.slice(0, 160);
      continue;
    }
    const [, perm, owner, , size, date, time, name] = m;
    rows.push({
      name: name.replace(/\s->\s.*$/, ''),
      kind: perm[0] === 'd' ? 'dir' : perm[0] === 'l' ? 'link' : perm[0] === '-' ? 'file' : 'other',
      size: Number(size),
      mtime: `${date} ${time}`,
      owner,
    });
  }
  return { rows, note };
}

export function checkFsPath(p: string): OpResult | null {
  const s = String(p || '/storage/emulated/0');
  if (BAD_PATH.test(s)) return { ok: false, command: `校验路径 ${s}`, detail: '路径含引号/分号/.. 等字符，已拒绝', verified: false };
  if (!FS_ROOTS.some((r) => s === r || s.startsWith(r.endsWith('/') ? r : `${r}/`) || (r === '/storage' && s.startsWith('/storage')))) {
    return { ok: false, command: `校验路径 ${s}`, detail: `只允许 ${FS_ROOTS.filter((x) => !x.includes('meminfo')).join('、')} 这些目录`, verified: false };
  }
  return null;
}

export async function listDir(adb: Adb, dir: string): Promise<{ rows: FsRow[]; dir: string; note: string; ms: number }> {
  const bad = checkFsPath(dir);
  if (bad) return { rows: [], dir, note: bad.detail, ms: 0 };
  const t0 = Date.now();
  const r = await adb.shellAsync(`ls -lA ${shq(dir)}`, 20000);
  const { rows, note } = parseLs(r.stdout + r.stderr, dir);
  const sorted = rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1));
  return {
    rows: sorted,
    dir,
    note: r.code !== 0 && !sorted.length ? (r.stdout + r.stderr).trim().slice(0, 200) || '读取失败' : note,
    ms: Date.now() - t0,
  };
}

export async function pullToDevice(adb: Adb, hostPath: string, dir: string): Promise<OpResult> {
  const bad = checkFsPath(dir);
  if (bad) return bad;
  if (!fs.existsSync(hostPath)) return { ok: false, command: `推送 ${hostPath}`, detail: '上传文件不存在或已被清理', verified: false };
  const remote = `${dir.replace(/\/+$/, '')}/${path.basename(hostPath).replace(/[^\w.\-+() ]/g, '_')}`;
  const size = fs.statSync(hostPath).size;
  const r = await adb.pushAsync(hostPath, remote, 300000);
  const check = await adb.shellAsync(`ls -l ${shq(remote)}`, 20000);
  const bytes = Number((check.stdout.match(/\s(\d+)\s+\d{4}-/) ?? [])[1] ?? 0);
  const ok = check.code === 0 && bytes === size;
  return {
    ok,
    command: `adb push ${path.basename(hostPath)}`,
    detail: ok ? `${remote} 已回读，${bytes} 字节与服务端一致` : `推过去但对不上：设备端 ${bytes || '读不到'} / 服务端 ${size} · ${(r.stderr + r.stdout).trim().slice(0, 160)}`,
    verified: ok,
  };
}

export async function pullFromDevice(adb: Adb, remote: string): Promise<string> {
  const bad = checkFsPath(remote);
  if (bad) throw new Error(bad.detail);
  fs.mkdirSync(uploadsDir, { recursive: true });
  const local = path.join(uploadsDir, `dl_${Date.now()}_${path.basename(remote).replace(/[^\w.\-+() ]/g, '_')}`);
  const r = await adb.pullAsync(remote, local, 300000);
  if (!fs.existsSync(local)) throw new Error(`adb pull 失败：${(r.stderr + r.stdout).trim().slice(0, 200)}`);
  return local;
}

/// 系统编译类型的中文名，页面上不露 user / userdebug 这种原始值
const BUILD_TYPE_CN: Record<string, string> = { user: '正式版', userdebug: '调试版', eng: '工程版' };

export interface InfoField {
  k: string;
  v: string;
  note?: string;
}

function gb(kb: number): string {
  return `${(kb / 1048576).toFixed(2)} GB`;
}

/// 只读设备信息：每一项都写清来源，读不到就直说这台机器没暴露
export async function deviceInfo(adb: Adb, profile: DeviceProfile): Promise<InfoField[]> {
  // 9 次 getprop 就是 9 个 adb 进程，冷读要 1.7 秒；
  // 一次 getprop 全量输出再按 key 挑，只有一个进程，快一个数量级
  const [props, df, meminfo, uptime, sensors, thermal, thermalSvc, cpu, wifi] = await Promise.all([
    Promise.resolve(adb.props()),
    adb.shellAsync('df -h', 20000),
    adb.shellAsync('cat /proc/meminfo', 20000),
    adb.shellAsync('cat /proc/uptime', 20000),
    adb
      .dumpsysAsync('sensorservice', '', 6000)
      .catch((e) => ({ stdout: '', stderr: String((e as Error).message || e) })),
    // 目录名（thermal_zone0）不是温度值：直接读 type + temp，只保留能读出数字的节点
    adb.shellAsync(
      'for z in /sys/class/thermal/thermal_zone*; do [ -d "$z" ] || continue; ' +
        't=$(cat "$z/temp" 2>/dev/null); n=$(cat "$z/type" 2>/dev/null); ' +
        '[ -n "$t" ] && echo "${n:-$z} $t"; done; true',
      15000,
    ),
    // 节点读不到时（模拟器、被裁过的系统）退到 Thermal HAL 的当前读数
    adb
      .dumpsysAsync('thermalservice', '', 8000)
      .catch((e) => ({ stdout: '', stderr: String((e as Error).message || e) })),
    adb.shellAsync('cat /sys/devices/system/cpu/online; grep -c processor /proc/cpuinfo', 15000),
    adb.shellAsync('ip addr show wlan0 2>/dev/null | grep -m1 inet; cat /proc/net/wireless 2>/dev/null | tail -1', 15000),
  ]);

  const fields: InfoField[] = [
    {
      k: '型号',
      v: friendlyModel(props) || profile.modelFriendly || profile.model || '读不到',
      note:
        friendlyModel(props) !== (props['ro.product.model'] ?? '').trim()
          ? `系统上报型号 ${props['ro.product.model'] || '未提供'}`
          : `产品代号 ${props['ro.product.device'] || '未提供'}`,
    },
    {
      k: '系统',
      v: `Android ${props['ro.build.version.release']}`,
      note: `API ${props['ro.build.version.sdk']} · ${BUILD_TYPE_CN[props['ro.build.type']] ?? props['ro.build.type']} · 补丁 ${props['ro.build.version.security_patch'] || '未提供'}`,
    },
    { k: '固件标识', v: props['ro.build.fingerprint'] || profile.buildFingerprint || '读不到', note: `构建 ${props['ro.build.version.incremental'] || '未提供'}` },
    { k: '运行时长', v: '', },
  ];

  const up = Number((uptime.stdout.match(/^\s*([\d.]+)/) ?? [])[1] ?? 0);
  fields[3].v = up ? `${Math.floor(up / 3600)} 小时 ${Math.floor((up % 3600) / 60)} 分` : '读不到';

  const mem: Record<string, number> = {};
  for (const l of meminfo.stdout.split('\n')) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = Number(m[2]);
  }
  fields.push({
    k: '内存',
    v: mem.MemTotal ? `${gb(mem.MemTotal - (mem.MemAvailable ?? mem.MemFree))} / ${gb(mem.MemTotal)}` : '读不到',
    note: meminfo.stdout.includes('MemAvailable') ? '按系统报告的可用内存统计' : '设备不报可用内存，按空闲内存估算',
  });

  /// df 里的分区分两类：用户可写的（/data、/storage/…）和只读系统分区。
  /// 只读分区出厂就接近写满（dm-verity 固定镜像），把它们和 /data 并列显示，
  /// 用户会误以为「存储 100% 满了」，所以这里只读分区收进说明行，主行只留可写的
  const WRITABLE = /^\/(data|storage|sdcard|userdata|mnt\/media)(\b|\/)/;
  /// 只读系统分区：这些是压缩好的只读镜像，出厂就接近 100%，和「空间满」是两回事
  const SYSRO = /^\/(system|vendor|product|system_ext|odm|apex|boot|recovery|oem)?$/;
  const cols = df.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 6 && c[5].startsWith('/'));
  /// 同一份数据常被挂到两个点上（/data 与 /storage/emulated 读数完全一样），
  /// 按容量三元组去重，只留第一个挂载点
  const seen = new Set<string>();
  const uniq = cols.filter((c) => {
    const key = `${c[1]}|${c[2]}|${c[3]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const writable = uniq.filter((c) => WRITABLE.test(c[5]));
  const readonly = uniq.filter((c) => !WRITABLE.test(c[5]) && SYSRO.test(c[5]));
  const fmt = (c: string[]) => `${c[5]} ${c[2]} / ${c[1]}（${c[4]}）`;
  fields.push({
    k: '存储',
    v: writable.length
      ? writable.map(fmt).join(' · ')
      : uniq.length
        ? `${fmt(uniq[0])}（没有可写的用户分区）`
        : '设备没给出分区占用',
    note: writable.length && readonly.length
      ? `另有 ${readonly.length} 个只读系统分区（出厂写满是正常的）：${readonly.slice(0, 4).map((c) => `${c[5]} ${c[4]}`).join('、')}`
      : '只读系统分区不计进用户空间',
  });

  const sensorHead = sensors.stdout.match(/Total (\d+) h\/w sensors, (\d+) running/);
  const sensorNames = [...sensors.stdout.matchAll(/^\s*\d+\)\s+(.+)$/gm)].map((m) => m[1].trim().split(/\s{2,}|\s+\(/)[0]);
  /// 设备自己会明说「没有传感器」（模拟器、大部分机顶盒）：这是结论，不是读取失败
  const sensorNone = /No Sensors on the device/i.test(sensors.stdout);
  fields.push({
    k: '传感器',
    v: sensorHead
      ? `${sensorHead[1]} 个硬件传感器（${sensorHead[2]} 个在用）`
      : sensorNone
        ? '设备没有硬件传感器'
        : '读不到',
    note: sensorNames.length ? sensorNames.slice(0, 6).join('、') : '',
  });

  /// 温度有三种可能：节点能读出数字、只有 Thermal HAL 给值、两边都没有。
  /// 各家命名和量纲都不一样（有的是毫摄氏度），所以按值大小换算，不认厂牌。
  const zoneRows = thermal.stdout
    .split('\n')
    .map((l) => l.trim().match(/^(.*?)\s+(-?\d+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => {
      const raw = Number(m[2]);
      const c = Math.abs(raw) > 1000 ? raw / 1000 : raw;
      return { name: (m[1] || 'thermal').trim(), c: Math.round(c * 10) / 10 };
    })
    .filter((x) => Number.isFinite(x.c) && x.c > 0 && x.c <= 150);
  const halTemps = [...thermalSvc.stdout.matchAll(/Temperature\{mValue=(-?[\d.]+),.*?mName=([^,]+)/g)]
    .map((m) => ({ name: m[2].trim(), c: Math.round(Number(m[1]) * 10) / 10 }))
    .filter((x) => Number.isFinite(x.c) && x.c > 0 && x.c <= 150);
  /// 和总览的健康快照同一套口径：先看 CPU/SoC 这类节点名，其次取最高的那个
  const zonePref = /(cpu|soc|tsens|gpu|core|ap|board)/i;
  const hot = [...zoneRows, ...halTemps].sort(
    (a, b) => Number(zonePref.test(b.name)) - Number(zonePref.test(a.name)) || b.c - a.c,
  )[0];
  fields.push({
    k: '温度',
    v: hot
      ? `${hot.c} ℃`
      : zoneRows.length || halTemps.length
        ? '读到的温度值不在合理范围'
        : '设备没有可读的温度节点',
    note: hot ? `${hot.name} · ${zoneRows.length || halTemps.length} 个测点` : '',
  });

  const cpuLines = cpu.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  /// 核数只留读数：整句话在紧凑表格里会把行撑成两行
  fields.push({ k: 'CPU', v: cpuLines.length > 1 ? `${cpuLines[1]} 核 · 在线 ${cpuLines[0]}` : cpuLines[0] || '读不到' });

  const inet = wifi.stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
  // /proc/net/wireless: face status quality signal noise …；只有落在 dBm 合理区间才算它真给了信号强度
  const dbm = wifi.stdout.match(/(^|\s)(-\d{2,3})(\s|$)/m);
  fields.push({
    k: '网络',
    v: inet ? `IP ${inet[1]}` : '设备没给出局域网地址',
    note: [
      inet && profile.serial ? `调试标识 ${profile.serial}` : '',
      dbm ? `链路信号 ${dbm[2]} dBm` : '设备不提供无线信号强度',
    ]
      .filter(Boolean)
      .join(' · '),
  });

  return fields;
}
