import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, under } from './home.ts';
import { Adb } from './adb.ts';
import { iconIndex } from './icons.ts';
import type { DeviceProfile } from './profile.ts';

/// 应用名解析的统一出口。
/// 以前只有 /api/name 和「我的应用」清单会解析名字，桌面候选、启动项、
/// 可启动清单各自只查图标索引和 profile；profile 里 label 取不到时直接退成包名，
/// 页面上就是一排 com.xxx.xxx。这里把「读缓存 → 解析 APK → 回写」收在一处，
/// 四个入口共用同一份 names.json，同一台设备同一个包只解析一次。

export const namesPath = under('names.json');

export function readNames(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(namesPath, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeName(pkg: string, label: string): void {
  fs.mkdirSync(path.dirname(namesPath), { recursive: true });
  const map = readNames();
  map[pkg] = label;
  fs.writeFileSync(namesPath, JSON.stringify(map, null, 1));
  cache = { at: Date.now(), map };
}

/// 解析要起 adb 进程并解 APK，单包几百毫秒；同一批请求共用一份内存快照
let cache: { at: number; map: Record<string, string> } | null = null;
function cached(): Record<string, string> {
  if (cache && Date.now() - cache.at < 15000) return cache.map;
  const map = readNames();
  cache = { at: Date.now(), map };
  return map;
}

/// 过滤「假名字」：probe 当年取不到 label 会把包名原样或截断写进 profile，
/// 这种值不能当成中文名用，否则页面永远显示 com.xxx.xxx。
/// 规则：等于包名、是包名前缀、或整体还是点分包名结构，一律作废。
export function usableLabel(s: string, pkg: string): string {
  const v = String(s ?? '').trim();
  if (!v) return '';
  const a = v.toLowerCase();
  const b = String(pkg ?? '').toLowerCase();
  if (a === b || b.startsWith(`${a}.`) || b.startsWith(`${a}/`)) return '';
  // 「com.google.android.tvlauncher」这类截断包名：段数少但仍是包名形状
  const dots = (a.match(/\./g) ?? []).length;
  const pkgDots = (b.match(/\./g) ?? []).length;
  if (dots >= 2 && dots <= pkgDots && b.startsWith(a.split('.').slice(0, dots).join('.'))) return '';
  return v;
}

/// 跨设备通用的系统级应用叫法。清单里的 label 跟着系统语言走：中文系统上是
/// 「设置」，英文系统上是「Settings」。组内任意一个词都代表整组，所以中英文
/// 双向都能互相找到，不依赖设备语言，也不需要提前知道系统是哪种语言。
/// 只收这类通用名；第三方应用交给「前缀 / 包含」的模糊匹配兜住。
export const NAME_SYNONYMS: string[][] = [
  ['设置', '系统设置', 'settings', 'setting'],
  ['主页', '首页', '桌面', '启动器', 'home', 'launcher', 'desktop'],
  ['商店', '应用商店', '应用市场', 'store', 'market', 'play'],
  ['浏览器', 'browser', 'chrome'],
  ['播放器', '视频', '影音', 'player', 'video', 'movies'],
  ['音乐', 'audio', 'music'],
  ['投屏', '投放', 'cast'],
  ['文件', '文件管理', 'files', 'filemanager'],
  ['相机', '摄像头', 'camera'],
  ['日历', 'calendar'],
  ['时钟', '闹钟', 'clock', 'alarm'],
  ['计算器', 'calculator'],
  ['相册', '图库', '照片', 'photos', 'gallery'],
  ['联系人', '通讯录', 'contacts'],
  ['电话', '拨号', 'dialer', 'phone'],
  ['短信', '信息', '消息', 'messaging', 'messages', 'sms'],
  ['邮件', '邮箱', 'email', 'mail'],
];

/// 统一归一化：去空格 + 小写。表内、用户输入、清单 label 都走这一套
export function flatName(s: string): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

/// 用户输入 → 同组的其他叫法（不含它自己）。没命中任何组就返回空
export function synonymTerms(want: string): string[] {
  const q = flatName(want);
  const group = NAME_SYNONYMS.find((g) => g.some((x) => flatName(x) === q));
  if (!group) return [];
  return group.map(flatName).filter((x) => x !== q);
}

/// 一个应用的「可搜索文本」：显示名 + 包名 + 同组的全部叫法。
/// 页面上搜「设置」要能翻出英文系统里的 Settings，反过来也一样。
/// 在前端做同义词表会和服务端两份逻辑各写各的，所以这里一次算好随清单下发。
export function searchKey(label: string, pkg: string): string {
  const parts = [flatName(label), flatName(pkg)];
  /// 按「词」命中，不是整串包含："Android TV Home" 里的 home 算一个词，
  /// 而 multidisplay 里的 play 只是字符串片段。整串包含会让框架包蹭到应用的名字。
  const words = new Set(String(label ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const whole = flatName(label);
  for (const g of NAME_SYNONYMS) {
    const flat = g.map(flatName);
    if (flat.some((x) => x === whole || words.has(x))) {
      for (const x of flat) if (!parts.includes(x)) parts.push(x);
    }
  }
  return parts.join(' ');
}

const PKG_RE = /^[A-Za-z0-9._-]+$/;

/// 复用 scripts/extract-icons.mjs 的 AXML/arsc 解析器：
/// 只读 zip 中央目录和需要的两个条目，不 pull 整个 APK。
async function extractor(): Promise<any> {
  process.env.ICON_LIB_ONLY = '1';
  const url = new URL('../scripts/extract-icons.mjs', import.meta.url).href;
  return import(url);
}

/// 正在解析中的包：并发请求同一包时共用一个 Promise，不重复起 adb
const inFlight = new Map<string, Promise<string>>();

/// 以下三份缓存是「读数据很慢」的主要止血点：
///   pathCache  APK 路径按设备缓存，包不重装就不会变
///   misses     解不出名字的包也记账。GMS 这类后台包有几百个 activity 却没有一个
///              launcher label，永远解析不出来；不记这笔账，每次清单都要为它们
///              重跑一遍 pm path + 解 APK，启动项接口就一直停在 400ms 以上
///   draining   同一台设备同时只留一个后台补名的队列，别被连续请求叠成几十条
const pathCache = new Map<string, string>();
const misses = new Map<string, number>();
const MISS_TTL = 10 * 60 * 1000;
const draining = new Set<string>();
const ckey = (serial: string, pkg: string) => `${serial}|${pkg}`;

function missed(serial: string, pkg: string): boolean {
  const at = misses.get(ckey(serial, pkg));
  if (at === undefined) return false;
  if (Date.now() - at < MISS_TTL) return true;
  misses.delete(ckey(serial, pkg));
  return false;
}

/// 一批包的 APK 路径：一次 shell 全拿。
/// 逐包 pm path 在 30 行的启动项清单上就是 30 次 adb 往返，实测每次 20~300ms。
async function apkPathsOf(adb: Adb, pkgs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const need: string[] = [];
  for (const p of pkgs) {
    if (!PKG_RE.test(p)) continue;
    const hit = pathCache.get(ckey(adb.serial, p));
    if (hit !== undefined) {
      if (hit) out.set(p, hit);
      continue;
    }
    if (!need.includes(p)) need.push(p);
  }
  if (!need.length) return out;
  // 包名已过 PKG_RE，拼进 for 循环不会引入命令注入
  const r = await adb
    .shellAsync(`for p in ${need.join(' ')}; do echo "@$p$(pm path $p 2>/dev/null | head -1)"; done`, 30000)
    .catch(() => null);
  for (const line of (r?.stdout ?? '').split('\n')) {
    const m = line.trim().match(/^@([A-Za-z0-9._-]+)package:(\S+\.apk)$/);
    if (!m) continue;
    pathCache.set(ckey(adb.serial, m[1]), m[2]);
    out.set(m[1], m[2]);
  }
  /// 查不到的也记空串：这类包（被卸载、或 shell 无权限）不该每次清单都重问一遍
  for (const p of need) if (!out.has(p)) pathCache.set(ckey(adb.serial, p), '');
  return out;
}

/// 从设备上的 APK 读 launcher label。解析器内部走 execFileSync，
/// 会短暂占住主线程，所以调用方必须给它留预算（见 fillLabels）。
async function labelFromApk(adb: Adb, apk: string): Promise<string> {
  const lib = await extractor();
  // 关键：脚本内部的 adb 必须带上当前设备。不带 -s 时，同时挂着多台设备
  // （真机 + 模拟器）会直接报 "more than one device/emulator"，名字永远解析不出来。
  lib.setSerial(adb.serial);
  const zip = lib.zipEntries(lib.remoteReader(apk));
  const manifest = lib.manifestOf(zip);
  const arsc = zip.list.find((x: { name: string }) => x.name === 'resources.arsc');
  const table = arsc ? lib.parseArsc(lib.zipRead(zip.rd, arsc)) : null;
  return String(lib.launcherLabel(manifest, table, '') || '').trim();
}

/// 从设备上的 APK 解析 launcher label，成功即写入 names.json。
/// 解析不出来返回空串（调用方自己决定显示包名还是留空）。
export function resolveName(adb: Adb, pkg: string): Promise<string> {
  const key = ckey(adb.serial, pkg);
  const running = inFlight.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      if (!PKG_RE.test(pkg)) return '';
      const hit = usableLabel(cached()[pkg] ?? '', pkg);
      if (hit) return hit;
      if (missed(adb.serial, pkg)) return '';
      const apk = (await apkPathsOf(adb, [pkg])).get(pkg) ?? '';
      if (!apk) {
        misses.set(key, Date.now());
        return '';
      }
      const label = await labelFromApk(adb, apk);
      if (!label) {
        /// 设备上确实没有 launcher 标签，是事实不是故障，记下来别再重解
        misses.set(key, Date.now());
        return '';
      }
      writeName(pkg, label);
      return label;
    } catch {
      /// 异常（设备掉线、读 zip 失败）不记账：下次请求还要再试一次
      return '';
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

/// 只按现有来源取名（图标索引 → APK 缓存 → profile 真名），不起 adb。
export function labelNow(pkg: string, profile?: DeviceProfile): string {
  /// 系统包优先用固定中文名：设备语言是英文时，launcher label 会给出
  /// Calendar / Settings 这类英文，中文控制台里不如直接给「日历 / 系统设置」。
  if (AOSP_NAMES[pkg]) return AOSP_NAMES[pkg];
  const icons = iconIndex(path.join(APP_ROOT, 'public', 'icons'));
  const fromIcon = usableLabel(icons[pkg]?.label ?? '', pkg);
  if (fromIcon) return fromIcon;
  const fromCache = usableLabel(cached()[pkg] ?? '', pkg);
  if (fromCache) return fromCache;
  const k = profile?.apps.find((a) => a.package === pkg);
  return usableLabel(k?.name ?? k?.label ?? '', pkg) || pkg;
}

/// 有些包真的没有 launcher 标签（GMS 这类后台服务包：306 个 activity，
/// 一个 LAUNCHER 都没有），解析不出来是设备事实。但页面上顶一串
/// com.google.android.gms 对用户没有信息量，所以最后兜一层「包名转人话」，
/// 规则与前端 displayName 一致：丢掉 com/android/google 这类通用段，取最后一段。
const GENERIC_SEG = new Set(['com', 'org', 'net', 'io', 'cn', 'app', 'apps', 'android', 'tv', 'stable', 'release', 'oversea', 'overseas', 'google', 'services', 'service']);

export function humanizePkg(pkg: string): string {
  if (AOSP_NAMES[pkg]) return AOSP_NAMES[pkg];
  const segs = String(pkg || '').split('.').filter((x) => x && !GENERIC_SEG.has(x.toLowerCase()));
  const s = segs.at(-1) ?? String(pkg || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(pkg || '');
}

/// AOSP 系统包统一的中文叫法。设备的 launcher label 跟着系统语言走，
/// 英文系统上就会顶出 Calendar / Settings / Clock 这类英文；控制台面向中文用户，
/// 这些通用组件一律给固定中文名，不再受设备语言影响。
export const AOSP_NAMES: Record<string, string> = {
  'com.android.settings': '系统设置',
  'com.android.tv.settings': '系统设置',
  'com.android.launcher': '系统桌面',
  'com.android.launcher3': '系统桌面',
  'com.android.contacts': '联系人',
  'com.android.quicksearchbox': '搜索',
  'com.android.systemui': '系统界面',
  'com.android.documentsui': '文件',
  'com.android.gallery3d': '图库',
  'com.android.deskclock': '时钟',
  'com.android.calendar': '日历',
  'com.android.camera2': '相机',
  'com.android.calculator2': '计算器',
  'com.android.dialer': '电话',
  'com.android.messaging': '信息',
  'com.android.email': '邮件',
  'com.android.music': '音乐',
  'com.android.vending': '应用商店',
  'com.android.inputmethod.latin': '系统输入法',
  'com.android.providers.downloads': '下载',
  'com.android.providers.downloads.ui': '下载',
  'com.android.providers.media': '媒体存储',
  'com.android.providers.calendar': '日历存储',
  'com.android.providers.contacts': '联系人存储',
  'com.android.providers.settings': '设置存储',
  'com.android.providers.telephony': '电话服务',
  'com.android.phone': '电话服务',
  'com.android.server.telecom': '电话服务',
  'com.android.packageinstaller': '安装器',
  'com.android.printspooler': '打印服务',
  'com.android.certinstaller': '证书安装',
  'com.android.storagemanager': '存储管理',
  'com.android.webview': '系统 WebView',
  'com.android.shell': 'Shell',
  'com.android.keychain': '密钥库',
  'com.android.managedprovisioning': '设备配置',
  'com.android.companiondevicemanager': '设备配对',
  'com.android.dreams.basic': '屏保',
  'com.android.wallpaperpicker': '壁纸',
  'com.android.wallpaper.livepicker': '动态壁纸',
  'com.android.wallpaperbackup': '壁纸备份',
  'com.android.htmlviewer': 'HTML 查看器',
  'com.android.development': '开发者工具',
  'com.android.egg': '彩蛋',
  'com.android.smoketest': '冒烟测试',
  'com.android.smoketest.tests': '冒烟测试',
  'com.android.gesture.builder': '手势',
  'com.android.customlocale2': '区域设置',
  'com.android.location.fused': '定位服务',
  'com.android.vpndialogs': 'VPN 对话框',
  'com.android.defcontainer': '安装组件',
  'com.android.externalstorage': '外部存储',
  'com.android.sharedstoragebackup': '存储备份',
  'com.android.mtp': '媒体传输',
  'com.android.mms.service': '彩信服务',
  'com.android.captiveportallogin': '网络登录',
  'com.android.carrierconfig': '运营商配置',
  'com.android.cellbroadcastreceiver': '小区广播',
  'com.android.statementservice': '声明服务',
  'com.android.protips': '使用提示',
  'com.android.bookmarkprovider': '书签存储',
  'com.android.bips': '打印服务',
  'com.android.printservice.recommendation': '打印推荐',
  'com.android.proxyhandler': '代理处理',
  'com.android.pacprocessor': '代理配置',
  'com.android.sdksetup': 'SDK 设置',
  'com.android.cts.ctsshim': 'CTS 组件',
  'com.android.cts.priv.ctsshim': 'CTS 组件',
  'com.android.inputdevices': '输入设备',
  'com.android.providers.blockednumber': '拦截号码',
  'com.android.providers.userdictionary': '用户词典',
  'com.android.backupconfirm': '备份确认',
};

/// 给一批行补名字：先按现有来源填，缺的再走 APK 解析（每批 5 个并发）。
/// 各接口的包名字段名不一样（pkg / package），用 pkgOf 取，结果就地写回 label。
/// 名字要解 APK，比列清单本身慢一个量级，所以这里分三段：
///   1. 现有缓存（图标索引 / names.json / profile）能填的，零成本先填
///   2. 剩下的用一条 shell 批量拿 APK 路径，在 budgetMs 预算内当场解几个
///   3. 预算用完还没解的丢给后台队列慢慢补，下一次轮询自然带上真名
/// 关键是「页面不等名字」：宁可先看到包名末段，也不该为名字站在原地等 adb。
export async function fillLabels<T extends { label: string }>(
  adb: Adb,
  rows: T[],
  pkgOf: (row: T) => string,
  profile?: DeviceProfile,
  budgetMs = 900,
): Promise<T[]> {
  if (!rows.length) return rows;
  const pending: { row: T; pkg: string }[] = [];
  for (const row of rows) {
    const pkg = pkgOf(row);
    const label = labelNow(pkg, profile);
    if (label !== pkg) row.label = label;
    else if (!missed(adb.serial, pkg)) pending.push({ row, pkg });
  }

  const deadline = Date.now() + budgetMs;
  if (pending.length) {
    const paths = await apkPathsOf(adb, [...new Set(pending.map((p) => p.pkg))]);
    const queue: { row: T; pkg: string; apk: string }[] = [];
    for (const p of pending) {
      const apk = paths.get(p.pkg) ?? '';
      if (apk) queue.push({ ...p, apk });
    }
    const later: { row: T; pkg: string }[] = [];
    for (const item of queue) {
      /// 解 APK 用的是同步 adb + 同步解压，会占住主线程；预算到了就收手，
      /// 剩下的交给后台，别让按键和状态轮询排在名字后面。
      if (Date.now() >= deadline) {
        later.push(item);
        continue;
      }
      const label = await labelFromApk(adb, item.apk).catch(() => '');
      if (label) {
        writeName(item.pkg, label);
        item.row.label = usableLabel(label, item.pkg) || item.row.label;
      } else {
        misses.set(ckey(adb.serial, item.pkg), Date.now());
        later.push(item);
      }
    }
    if (later.length) drainNames(adb, later.map((l) => l.pkg));
  }

  // 还是没名字的（设备上确实没有 launcher 标签，或已记为解不出来）退成包名末段。
  // 这里要扫全表而不是只扫 pending：被记进 misses 的包压根不进 pending，
  // 只扫 pending 会让 GMS 这类包永远顶着一串 com.google.android.gms。
  for (const row of rows) {
    const pkg = pkgOf(row);
    if (row.label === pkg) row.label = humanizePkg(pkg);
  }
  return rows;
}

/// 后台补名队列。同一台设备只留一条，每轮最多解 8 个包，包与包之间留空隙：
/// 解 APK 用的是同步 adb + 同步解压，会占住主线程，不限流的话按键和状态轮询
/// 会排在后面。名字一旦写进 names.json 就永久复用，所以这是每台设备一次的成本。
const DRAIN_BATCH = 8;
const DRAIN_GAP = 150;

function drainNames(adb: Adb, pkgs: string[]): void {
  const todo = [...new Set(pkgs)].filter((p) => PKG_RE.test(p) && !usableLabel(cached()[p] ?? '', p));
  if (!todo.length || draining.has(adb.serial)) return;
  draining.add(adb.serial);
  void (async () => {
    try {
      const paths = await apkPathsOf(adb, todo);
      let done = 0;
      for (const pkg of todo) {
        if (done >= DRAIN_BATCH) break;
        const apk = paths.get(pkg) ?? '';
        if (!apk || missed(adb.serial, pkg)) continue;
        const label = await labelFromApk(adb, apk).catch(() => '');
        if (label) writeName(pkg, label);
        else misses.set(ckey(adb.serial, pkg), Date.now());
        done++;
        await new Promise((r) => setTimeout(r, DRAIN_GAP));
      }
      /// 这轮没解完的下一轮继续；下一次清单/启动项请求也会重新排上队
      if (done >= DRAIN_BATCH && todo.some((p) => !usableLabel(cached()[p] ?? '', p))) {
        const rest = todo.filter((p) => !usableLabel(cached()[p] ?? '', p) && !missed(adb.serial, p));
        if (rest.length) setTimeout(() => drainNames(adb, rest), 1200);
      }
    } finally {
      draining.delete(adb.serial);
    }
  })();
}

/// 装/卸之后包的真实状态变了：APK 路径和「解不出来」的账都要作废重问。
export function forgetPkg(serial: string, pkg: string): void {
  const key = ckey(serial, pkg);
  pathCache.delete(key);
  misses.delete(key);
  inFlight.delete(key);
}
