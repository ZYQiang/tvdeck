import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT, under } from './home.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Adb, connectedDevices, connectedDevicesAsync, type AdbDevice } from './adb.ts';
import { friendlyModel, loadProfile, saveProfile, type DeviceProfile } from './profile.ts';
import { probeDevice, refreshProfileSnapshot } from './probe.ts';
import {
  deviceHealth,
  inputPathOf,
  mousePathOf,
  logClear,
  logSnapshot,
  nightControl,
  nightSupport,
  launchNamed,
  pidOf,
  powerAction,
  mouseAction,
  recordScreen,
  sleepTv,
  wakeTv,
  pqReadout,
  pressKey,
  readPicture,
  screenTime,
  screenSize,
  setVolume,
  settingValue,
  editText,
  textPaths,
  typeText,
  volumeReadoutAsync,
  volumeStep,
  writePictureAsync,
} from './commands.ts';
import { DeviceLiveHub, MirrorHub, encodeJpeg, jpegPlan, openUrlOnDevice } from './mirror.ts';
import type { DeviceFrame } from './mirror.ts';
import { deleteMedia, listMedia, mediaDir, mediaName, mediaTarget, serveMedia } from './media.ts';
import {
  apkPreview,
  appInventory,
  checkFsPath,
  clearAppData,
  deviceInfo,
  forceStopApp,
  humanSize,
  installFromHost,
  launchPackage,
  listDir,
  processList,
  type ProcRow,
  pullFromDevice,
  pullToDevice,
  resolveAppName,
  uninstallApp,
  uploadTarget,
} from './manage.ts';
import { withIcons } from './icons.ts';
import { AOSP_NAMES, humanizePkg, labelNow } from './names.ts';

import { attachAdb, findAdbDevices } from './discover.ts';
import {
  autostartState,
  capabilities,
  homeState,
  installHelper,
  launchables,
  setAutostart,
  setHomeActivity,
  setStartupItem,
  startupItems,
  tryAutostart,
} from './system.ts';
import {
  STEP_META,
  activeRunOf,
  availableKeys,
  clearHistory,
  deleteScript,
  dueDaily,
  keyList,
  loadStore,
  markFired,
  recordSkip,
  runView,
  setEngineEnabled,
  setLastOnline,
  startRun,
  storePath as automationPath,
  upsertScript,
} from './automation.ts';

const PORT = Number(process.env.PORT ?? 8787);
/// 自动化引擎的巡检间隔。放在这里是因为接口层也要把它报给页面（"每 20 秒看一次"）
const AUTO_TICK_MS = 20000;
const publicDir = path.join(APP_ROOT, 'public');
/// 录屏落在 .tvdeck/recordings：和上传临时目录同一层，跟着项目走，重启服务不丢
const recordingsDir = under('recordings');

const hub = new MirrorHub();
/// 设备自己的屏幕走这一路直播。设备可能换（重连 / 切 IP），所以每帧现问一次
/// 当前设备是谁，而不是把 adb 句柄存进来 —— 存进去的话重连之后直播流会一直对着旧句柄
const deviceLive = new DeviceLiveHub(() => {
  const d = deviceFor(loadProfile());
  return { online: d.online, adb: d.adb };
});

/// 录像文件名白名单：只认 .tvdeck/recordings 里的 mp4，别的一律不放行
function recordingFile(name: string): { file: string; why: string } {
  const safe = path.basename(name || '');
  const file = path.join(recordingsDir, safe);
  if (!safe.endsWith('.mp4')) return { file, why: '只允许操作 .tvdeck/recordings 里的 mp4' };
  if (safe !== name || !file.startsWith(recordingsDir + path.sep)) return { file, why: '文件名越界' };
  return { file, why: '' };
}

function listRecordings(): { name: string; bytes: number; at: number }[] {
  try {
    return fs
      .readdirSync(recordingsDir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => {
        const st = fs.statSync(path.join(recordingsDir, f));
        return { name: f, bytes: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    // 目录还没建过（从没录过）不是错误，给空列表
    return [];
  }
}

/// ---- 录屏任务表 ----
/// screenrecord 是阻塞命令（录多久就等多久）。以前把它塞进 HTTP 请求里，
/// 会出现两个问题：一是录 30 秒期间这次请求一直挂着，浏览器标签一刷新进度就丢了；
/// 二是页面除了自己倒计时，根本不知道设备那边录到哪了。改成后台任务后，
/// /api/record 立刻返回 jobId，页面按 jobId 轮询阶段，刷新回来还能接上。
type RecPhase = 'record' | 'pull' | 'done' | 'error';
type RecJob = {
  id: string;
  serial: string;
  seconds: number;
  startedAt: number;
  phase: RecPhase;
  name?: string;
  bytes?: number;
  detail?: string;
};
const recJobs = new Map<string, RecJob>();

/// 给页面看的一版：把单调的时间戳折算成已用秒数与百分比。
/// 录制阶段按秒数估百分比，封顶 99% —— 真正的 100% 只留给「文件已经在本机了」；
/// 拉回阶段进度没法从中途读出来，就停在 99%，用一个阶段名告诉用户卡在哪
function recJobView(j: RecJob) {
  const elapsed = (Date.now() - j.startedAt) / 1000;
  const pct =
    j.phase === 'record'
      ? Math.min(99, Math.floor((elapsed / j.seconds) * 100))
      : j.phase === 'pull'
        ? 99
        : j.phase === 'done'
          ? 100
          : 0;
  return { ...j, elapsed: Math.round(elapsed), pct };
}

const recJobRunning = (j: RecJob) => j.phase === 'record' || j.phase === 'pull';

function lanIp(): string {
  for (const rows of Object.values(os.networkInterfaces())) {
    for (const r of rows ?? []) {
      if (r.family === 'IPv4' && !r.internal) return r.address;
    }
  }
  return '127.0.0.1';
}

/// adb devices 是同步 spawn，每次请求都跑一遍会给每个接口垫上几十到一百多毫秒。
/// 状态页 20 秒轮询、一次切页打五六条接口，全都被这一次 spawn 拖着。
/// 记 2 秒就够：设备真掉线最多晚 2 秒被看见，省下的却是每条请求的固定开销。
/// 动作（POST，含重连/扫描）都会把这份缓存一起清掉，所以连上新设备后立刻可见。
let devListCache: { at: number; rows: AdbDevice[] } | null = null;
const DEV_LIST_TTL = 2000;
function connectedDevicesCached(): AdbDevice[] {
  if (devListCache && Date.now() - devListCache.at < DEV_LIST_TTL) return devListCache.rows;
  const rows = connectedDevices();
  devListCache = { at: Date.now(), rows };
  return rows;
}

/// 切换设备沿：profile 快照可能还是上一台设备的（型号、应用都是旧数据），
/// 这里记一个「上一次生效的 serial」，只在发生变化时异步刷一次轻量快照。
/// 不阻塞当前请求（deviceFor 是同步路径），写回 profile 后下一轮 /api/state 自然变新。
let snapSerial = '';
let snapBusy = false;
function maybeRefreshSnapshot(profile: DeviceProfile, serial: string) {
  if (!serial || snapBusy || snapSerial === serial) return;
  /// 服务重启后 profile.serial 可能恰好等于当前设备，但快照字段还是更早那台设备的；
  /// 所以每个进程对每个 serial 先做一次几毫秒的 model 比对，不一致才刷全量轻快照。
  const devModel = new Adb(serial).getProp('ro.product.model');
  snapSerial = serial;
  const profileApps = Array.isArray(profile.apps) ? profile.apps.length : 0;
  const modelMatches = !!devModel && profile.model === devModel;
  /// apps 是这个轻快照里最常用的一块数据。如果只剩「型号一样」这一条对得上，
  /// 而清单是空的，说明上次刷新中途断掉了：这里补一次，避免永远停在空列表。
  /// 加了「给人看的机型名」字段后，老档案里没有这一项也要补一次，
  /// 否则顶栏会一直顶着 ro.product.model 的构建代号
  if (modelMatches && profileApps > 0 && profile.modelFriendly) return;
  snapBusy = true;
  refreshProfileSnapshot(serial)
    .then(() => {
      /// profile 写回了新设备的信息，而本轮 /api/state 等只读响应可能还挂在
      /// 旧设备数据的读缓存上；不主动清掉，前端下一轮会继续吃到最多几秒旧值。
      dropReadCache();
    })
    .catch((e) => console.log(`轻量快照刷新失败: ${(e as Error).message}`))
    .finally(() => { snapBusy = false; });
}

/// 设备连接状态的中文说法，页面和日志共用一份，避免各处自己翻译
const ADB_STATE_CN: Record<string, string> = {
  device: '在线',
  offline: '离线',
  unauthorized: '等待设备上授权',
  no_permissions: '本机权限不足',
  recovery: '恢复模式',
  sideload: '侧载模式',
  bootloader: '引导模式',
  host: '本机调试服务',
};

function deviceFor(profile: DeviceProfile): { adb: Adb | null; online: boolean; note: string } {
  const devs = connectedDevicesCached();
  if (profile.serial && devs.some((d) => d.serial === profile.serial && d.state === 'device')) {
    maybeRefreshSnapshot(profile, profile.serial);
    return { adb: new Adb(profile.serial), online: true, note: '' };
  }
  const tv = devs.find((d) => d.state === 'device');
  if (tv) {
    maybeRefreshSnapshot(profile, tv.serial);
    // 设备换了 DHCP 地址：把 serial/ip 写回 profile，重连、投放、离线提示才不会用旧地址
    const ip = tv.serial.split(':')[0];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && (tv.serial !== profile.serial || ip !== profile.ip)) {
      profile.serial = tv.serial;
      profile.ip = ip;
      saveProfile(profile);
    }
    return { adb: new Adb(tv.serial), online: true, note: `用的是列表里第一台在线设备 ${tv.serial}` };
  }
  return { adb: null, online: false, note: `设备不在线（上次地址 ${profile.ip || '无记录'}），可点“重连”` };
}

/// serial → 设备自报的可读机型名。getprop 一次几十毫秒，扫描又会被反复打开，
/// 缓存 5 分钟足够覆盖一次会话，换设备时 serial 变了自然走新的键
const PROP_LABEL_MS = 5 * 60_000;
const propLabelCache = new Map<string, { at: number; label: string }>();

function json(res: http.ServerResponse, code: number, body: unknown) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/// 跨源放行名单 —— 只放行「打包出来的客户端壳」，不放行任意网站。
/// 这个口子能发按键、装应用、改系统设置，写成 Access-Control-Allow-Origin: * 等于
/// 让任何网页都能遥控用户的设备，所以必须是白名单。
/// 真正需要跨源的只有客户端形态（前端在本地、后端在别处）：
///   Tauri     → tauri://localhost、http(s)://tauri.localhost
///   Capacitor → capacitor://localhost、ionic://localhost、http(s)://localhost
///   开发调试  → http://localhost:*、http://127.0.0.1:*
/// file:// 打开的页面来源是字面量 "null"，放行它等于对任何本地文件开门，故意不收。
const CORS_OK =
  /^(tauri|capacitor|ionic):\/\/localhost$|^https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?$/;

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin;
  /// 同源请求和 curl 根本没有 Origin 头，什么都不用做，行为跟以前一模一样
  if (!origin || !CORS_OK.test(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

/// 只读 GET 的短期缓存 + 并发合并（in-flight dedupe）。
/// 页面一进「设备」页会同一瞬间打 /api/state、/api/device、/api/health、/api/processes……
/// 每条都真的敲一遍 adb（实测 apps 1.8s、startup 3.3s、health 0.9s、state 0.7s），
/// 来回切页就把这些全重跑一遍，用户看到的就是「读数据很慢」。
/// 这里按「序列|路径|查询」记几秒的结果：同一瞬间重复打进来的请求共用同一次底层调用，
/// 窗口内再进来直接回缓存。任何 POST（按键/安装/改设置……）都会清空缓存，
/// 所以「动作 → 立刻刷新」拿到的仍然是动作之后的新状态，不会读到旧值。
const readCache = new Map<string, { at: number; ttl: number; val: unknown }>();
const readFlying = new Map<string, Promise<unknown>>();
let readGen = 0;

function readMemo<T>(key: string, ttlSec: number, run: () => Promise<T>): Promise<T> {
  const hit = readCache.get(key);
  const now = Date.now();
  /// 过期后先把旧值立即回出去，同时后台真读一次刷新：
  /// 应用清单这类 1~2 秒的读数，用户不该每次都站在原地等 adb 跑完。
  /// 窗口（默认 5 分钟）之外连旧值也不留，避免设备换掉了还回旧数据。
  const staleWindow = 5 * 60 * 1000;
  if (hit && now - hit.at < hit.ttl) return Promise.resolve(hit.val as T);
  if (hit && now - hit.at < staleWindow) {
    /// 后台刷新也要并发合并：页面一进「设备」页会同一瞬间打好几条请求，
    /// 各自触发一次真读的话，续温和用户抢同一台 adb，反而更慢
    /// 已经有在途刷新的话不再另起一次，旧值照样立刻回
    if (!readFlying.has(key)) {
      const gen = readGen;
      const p = run().then(
        (val) => {
          readFlying.delete(key);
          if (gen === readGen) readCache.set(key, { at: Date.now(), ttl: ttlSec * 1000, val });
          return val;
        },
        (e) => {
          readFlying.delete(key);
          throw e;
        },
      );
      readFlying.set(key, p);
      /// 这一路回的是旧值，在途失败不该冒泡给调用方：下一次请求会重新触发真读
      p.catch(() => undefined);
    }
    return Promise.resolve(hit.val as T);
  }
  const flying = readFlying.get(key);
  if (flying) return flying as Promise<T>;
  /// 记下这一轮的代次：期间如果来了 POST 把缓存清空，这次的在途结果就别再写回去了
  const gen = readGen;
  const p = run().then(
    (val) => {
      readFlying.delete(key);
      if (gen === readGen) readCache.set(key, { at: Date.now(), ttl: ttlSec * 1000, val });
      return val;
    },
    (e) => {
      readFlying.delete(key);
      throw e;
    },
  );
  readFlying.set(key, p);
  return p;
}

/// 动作之后旧状态就不该再用：POST 一律把只读缓存丢掉
function dropReadCache() {
  readGen += 1;
  /// POST 动作后不是把缓存全删，而是把每条记录标成「刚过期」：
  /// 下一次 GET 立刻拿到旧值回显，同时后台真读刷新；
  /// 全删的话每个动作后面跟着的页面读取都要重新等 adb 跑一遍，体感就是「接口慢」
  const now = Date.now();
  for (const hit of readCache.values()) hit.at = now - hit.ttl;
  readFlying.clear();
  /// adb 设备列表也跟着重来：重连 / 扫描之后必须立刻看到新设备
  devListCache = null;
}

/// settings put 只认这三张表，页面传错就别往下走
const PICTURE_TABLES = ['system', 'secure', 'global'] as const;

/// 哪些只读接口值得缓存、缓存几秒。都必须是「同样的输入一定给同样的输出」的纯读；
/// 带查询参数的（/api/fs、/api/log）按整条 URL 分开记，不会互相串味。
/// ttl 只求盖住「同一屏里连着打几次」和「切走再切回来」，不求替 adb 做长缓存。
const READ_TTL: Record<string, number> = {
  '/api/state': 3,
  '/api/apps': 15,
  '/api/device': 15,
  '/api/health': 5,
  '/api/processes': 4,
  '/api/picture': 4,
  '/api/system/caps': 15,
  '/api/system/home': 6,
  '/api/system/startup': 15,
  '/api/system/autostart': 15,
  '/api/system/launchables': 15,
};

/// 所有真正需要 adb 的接口。用来区分两件事：
/// 「设备暂时离线」回 503，和「这个接口根本不存在」回 404。
const KNOWN_ADB_ROUTES = new Set([
  '/api/key',
  '/api/tap',
  '/api/swipe',
  '/api/mouse',
  '/api/text',
  '/api/sleep',
  '/api/volume',
  '/api/launch',
  '/api/usage',
  '/api/night',
  '/api/picture',
  '/api/device-preview',
  '/api/mirror-on-tv',
  '/api/mirror-open',
  '/api/apps',
  '/api/processes',
  '/api/device',
  '/api/probe',
  '/api/health',
  '/api/record',
  '/api/power',
  '/api/log',
  '/api/log/clear',
  '/api/system/caps',
  '/api/system/home',
  '/api/system/startup',
  '/api/system/launchables',
  '/api/system/autostart',
  '/api/fs',
  '/api/name',
  '/api/app',
  '/api/install',
  '/api/push',
  '/api/download',
]);

/// 页面上最贵的「一坨状态读数」单独拎出来：请求处理器和后台续温都用同一份实现，
/// 不然续温要手动抄一遍七条 adb 调用，改一处忘一处就会读出两套数据。
/// 进程列表的返回形状只能有一份实现：路由以前包成 { rows }，而开机预热和后台续温
/// 直接往同一个缓存键里塞裸数组，谁先命中谁定形状。续温每 10 秒跑一次，所以页面
/// 读到的多半是数组，前端取 d.rows 就是 undefined，进程页永远显示「共 0 个」。
async function processesPayload(adb: Adb): Promise<{ rows: ProcRow[] }> {
  return { rows: await processList(adb) };
}

async function statePayload(
  profile: DeviceProfile,
  online: boolean,
  adb: Adb | null,
): Promise<unknown> {
  let focus = '';
  let levels: { stream: string; level: number; max: number }[] = [];
  let nightOn = false;
  let brightness = '';
  let inputPath: Awaited<ReturnType<typeof inputPathOf>> | null = null;
  let screen: Awaited<ReturnType<typeof screenSize>> | null = null;
  let text: Awaited<ReturnType<typeof textPaths>> | null = null;
  let mouse: Awaited<ReturnType<typeof mousePathOf>> | null = null;
  const night = online && adb ? nightSupport(adb) : { supported: false, path: 'none' as const, detail: '设备离线' };
  if (online && adb) {
    const a = adb as Adb;
    const pInput = inputPathOf(a);
    const pMouse = mousePathOf(a);
    const pScreen = screenSize(a);
    const pText = textPaths(a);
    [focus, levels, nightOn, brightness] = await Promise.all([
      a.topActivityAsync(),
      volumeReadoutAsync(a),
      a.shellAsync('settings get secure night_display_activated', 8000).then((r) => r.stdout.trim() === '1'),
      settingValue(a, 'system', 'screen_brightness'),
    ]);
    inputPath = await pInput;
    mouse = await pMouse;
    screen = await pScreen;
    text = await pText;
  }
  // 前台应用名交给页面自己查不行：页面上那份 profile.apps 只有几十个启动项，
  // 系统设置、桌面这类不在里面，于是总览上顶出来的是 com.google.android.tvlauncher。
  // 服务端有全量名字缓存，这里直接把人话名一起给出去。
  const fgPkg = (focus || '').split('/')[0];
  const fgLabel = fgPkg ? labelNow(fgPkg, profile) : '';
  let focusName = online && fgPkg ? (fgLabel !== fgPkg ? fgLabel : humanizePkg(fgPkg)) : '';
  /// Settings 的主页和子页面（Settings$XxxActivity）对用户都没有信息量，
  /// 统一换成「系统设置」这种应用级名字，页面不再顶出英文 Settings。
  if (AOSP_NAMES[fgPkg]) focusName = AOSP_NAMES[fgPkg];
  const keyAbility = availableKeys(inputPath);
  return {
    online,
    note: '',
    focusName,
    inputPath,
    mouse,
    screen,
    text,
    focus,
    volume: levels,
    brightness: /^\d+$/.test(brightness) ? Number(brightness) : null,
    night: {
      activated: nightOn,
      supported: night.supported,
      path: night.path,
      /// 不支持的机器上开关值没人读，报状态只会误导，直接给结论
      detail: night.supported ? `${nightOn ? '护眼已开' : '护眼已关'} · ${night.detail}` : night.detail,
    },
    pq: online && adb ? pqReadout(adb) : undefined,
    mirror: hub.status(),
    mirrorUrl: `http://${lanIp()}:${PORT}/watch`,
    devicePreview: { url: '/device.mjpg', poll: '/device.jpg', ...deviceLive.status() },
    keys: keyAbility.keys,
    keySource: keyAbility.keySource,
    profile: {
      ...profile,
      // probe 当年取不到应用名时把包名原样写进了 label，页面上就是一排 com.xxx。
      // 这里用已有的名字缓存（图标索引 / names.json / profile 真名）同步补名，
      // 不起 adb：状态接口每二十秒跑一轮，不能为了解析名字去拉进程。
      apps: withIcons(profile.apps, path.join(publicDir, 'icons'))
        .map((a) => {
          const name = labelNow(a.package, profile);
          return name && name !== a.package ? { ...a, label: name, name } : a;
        })
        .slice(0, 60),
    },
  };
}

/// 健康面板每 5 秒静默采样一次，同一台设备的任何一次 adb 抖动（连接被临时断开、
/// dumpsys 卡住）都不该把整块面板打掉。这里按序列号留最近一次成功的读数：
/// 底层命令失败时回旧值并标 stale=true，页面照常画曲线，同时明确提示读数没更新。
const healthFallback = new Map<string, { at: number; data: unknown }>();

/// 局域网扫描天然要等几秒，可设备不会在一两分钟里自己换局域网。
/// 这里给最近一次结果留 90 秒：窗口内再进搜索页就先回旧结果（页面标明是缓存），
/// 超过 15 秒还会顺手在后台重扫一遍，下一轮就是新数据。找不到设备的等待感就没了。
const scanCache = new Map<string, { at: number; data: unknown }>();
const SCAN_REUSE_MS = 90_000;
const SCAN_FRESH_MS = 15_000;

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const MAX_UPLOAD = 400 * 1024 * 1024;
/// 媒体库单独放一个上限：一段 1080p 视频轻松几百兆，
/// APK 那个 400MB 的尺度套过来会让正常视频传不进去
const MAX_MEDIA_UPLOAD = 2 * 1024 * 1024 * 1024;

/// APK 走原始字节流直接落盘：base64 进 JSON 会把 30MB 变成 40MB 字符串还占着内存
function saveUpload(req: http.IncomingMessage, dest: string, max = MAX_UPLOAD): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error(`上传超过 ${Math.round(max / 1048576)}MB 上限`));
        req.destroy();
        out.destroy();
      }
    });
    req.pipe(out);
    out.on('finish', () => resolve(size));
    out.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
  /// /screen 是「只放设备画面」的独立页，给浏览器自带全屏（F11 / ⌃⌘F）当落点
  /// /watch 是「服务端画面接收页」：目标设备那边不开 MJPEG 流，而是打开一个普通网页，
  /// 由页面自己适配（支持的走流，不支持的退回单帧轮询），换台设备不用改代码
  const page = { '/': 'index.html', '/screen': 'screen.html', '/watch': 'watch.html' }[urlPath];
  const rel = page ?? urlPath.replace(/^\/+/, '');
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  /// no-cache：改动 style/app 脚本后手机刷新立即生效，避免看到过期样式误判"没改好"。
  /// 但光有 no-cache 没有校验器，浏览器每次都得把 app.js（196KB）整份重下。
  /// 补上 ETag（改动就变）之后，没改动的请求回一个空的 304 —— 既保留"改完立刻生效"，
  /// 又不必每次都传整份文件
  const st = fs.statSync(file);
  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function serveMjpeg(res: http.ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=tvdeck',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
  });
  const push = (frame: { buf: Buffer }) => {
    res.write(`--tvdeck\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buf.length}\r\n\r\n`);
    res.write(frame.buf);
    res.write('\r\n');
  };
  hub.snapshot().then(push).catch(() => {});
  /// 停止投屏时由 hub 主动结束响应：只清定时器的话，设备上会停在最后一帧
  const off = hub.addListener(push, () => {
    try {
      res.end();
    } catch {
      /* 响应已经关了 */
    }
  });
  res.on('close', off);
}

/// 设备屏幕直播：和上面那条投屏流同一套写法，帧来自设备自己的屏幕。
/// 多个观看端共用同一条抓屏循环，所以开三个标签页也不会变成三倍 adb 开销；
/// 观看端全关掉时循环自己停，设备立刻空出来给别的请求
function serveDeviceLive(res: http.ServerResponse) {
  const d = deviceFor(loadProfile());
  if (!d.online || !d.adb) return json(res, 503, { error: '设备离线，无法抓取屏幕' });
  /// 编码器缺失时如实回 501：页面的 <img> 会报错，然后退回逐帧轮询那条老路，
  /// 不用在这里硬撑一条推不出去 JPEG 的流
  if (!jpegPlan().tool) return json(res, 501, { error: `${jpegPlan().note} 没有可用的 JPEG 编码器` });
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=tvdeck',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
  });
  const push = (f: DeviceFrame) => {
    res.write(`--tvdeck\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.buf.length}\r\n\r\n`);
    res.write(f.buf);
    res.write('\r\n');
  };
  /// 只复用当前设备刚刚抓到的帧。旧设备/旧会话的 latest 不能让新连接先看到
  /// 一张过期画面；没有新鲜帧时由 addListener 立即启动一轮抓屏。
  const first = deviceLive.latestFor(d.adb.serial);
  if (first) push(first);
  const off = deviceLive.addListener(push);
  res.on('close', off);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;
  const corsOk = applyCors(req, res);
  /// 预检只回答「能不能跨源」，真实权限还是由下面那条实际请求自己判
  if (req.method === 'OPTIONS') {
    res.writeHead(corsOk ? 204 : 403);
    return res.end();
  }
  const profile = loadProfile();
  const dev = deviceFor(profile);

  if (p === '/mirror.mjpg') return serveMjpeg(res);
  if (p === '/device.mjpg') return serveDeviceLive(res);
  if (p === '/mirror.jpg') {
    try {
      const f = await hub.snapshot();
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return res.end(f.buf);
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  }

  // 设备屏幕预览：adb exec-out screencap 单帧，适配手机、平板、车机、开发板和模拟器
  if (p === '/device.jpg') {
    try {
      if (!dev.online || !dev.adb) return json(res, 503, { error: '设备离线，无法抓取屏幕' });
      /// 先看共享直播 hub 手里有没有现成 JPEG：页面预览和直播流是同一路抓屏，
      /// 命中时不再单独跑一次 screencap，接口从几百毫秒降到毫秒级。
      /// 没有编码器的机器仍然按 PNG 直出，保持旧兼容
      const current = dev.adb as Adb;
      const fresh = deviceLive.latestFor(current.serial);
      if (fresh?.buf?.length && jpegPlan().tool) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        return res.end(fresh.buf);
      }
      const r = await current.runBufferAsync(['exec-out', 'screencap -p'], 15000);
      if (r.code !== 0 || !r.buf.length) return json(res, 500, { error: `screencap 失败：${r.stderr || '空输出'}` });
      /// 本机有编码器时把 PNG 转成 JPEG 再回：预览帧小 4~5 倍，全屏/轮询更快；
      /// 没有编码器仍按 PNG 直出，保持兼容。
      if (jpegPlan().tool) {
        const jpg = await encodeJpeg(r.buf, { width: deviceLive.opts.width, quality: deviceLive.opts.quality });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        return res.end(jpg);
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(r.buf);
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  }

  // 录下来的设备画面：浏览器 <video> 和「下载」都直接走这条，不套 /api 前缀
  if (p === '/recording') {
    const { file, why } = recordingFile(url.searchParams.get('name') ?? '');
    if (why) return json(res, 400, { error: why });
    if (!fs.existsSync(file)) return json(res, 404, { error: '没有这个录像文件' });
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(buf.length),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  /// 媒体库里的文件：自动化脚本的「播放图片 / 视频」把这条地址递给设备，由设备自己去拉。
  /// 支持 Range 是硬要求 —— 视频播放器几乎都会先问一下字节范围，不支持就只能整段下完才播
  if (p.startsWith('/media/')) {
    let name = p.slice('/media/'.length);
    try {
      name = decodeURIComponent(name);
    } catch {
      /* 地址被编坏成非 UTF-8：交给 mediaTarget 判掉，不在这里抛 */
    }
    return serveMedia(req, res, name);
  }

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);
  /// 这些接口不碰 adb：没有连接设备时它们照样能跑（不是「只有 Mac 能用」）
  const withoutAdb =
    p === '/api/state' ||
    p === '/api/mirror' ||
    p === '/api/connect' ||
    p === '/api/select' ||
    p === '/api/wake' ||
    p === '/api/scan' ||
    p === '/api/upload' ||
    p === '/api/upload/del' ||
    p === '/api/recordings' ||
    p === '/api/recordings/del' ||
    p === '/api/recordings/clear' ||
    p === '/api/recordings/rename' ||
    p === '/api/recordings/reveal' ||
    p === '/api/record/status' ||
    /// 自动化全是本机文件读写：没接设备时照样要能改脚本、看记录，
    /// 所以这几条走"不需要 adb"的口子，设备不在线由各接口自己说明
    p === '/api/automation' ||
    p === '/api/automation/save' ||
    p === '/api/automation/del' ||
    p === '/api/automation/engine' ||
    p === '/api/automation/history/clear' ||
    p === '/api/automation/run' ||
    p === '/api/automation/run/status' ||
    /// 媒体库也是本机文件读写：没接设备时照样要能上传、列清单、删文件
    p === '/api/media' ||
    p === '/api/media/upload' ||
    p === '/api/media/del';
  if (!dev.adb && !withoutAdb) {
    /// 已删除或拼错的接口不能被「设备离线」的 503 掩盖，否则调用方会
    /// 误以为只是暂时连不上。只有真实存在且依赖 adb 的接口才回 503。
    if (!KNOWN_ADB_ROUTES.has(p)) return json(res, 404, { error: `未知接口 ${p}` });
    return json(res, 503, { error: dev.note });
  }

  const adb = dev.adb as Adb;
  // 上传接口要把原始字节留给 saveUpload，这里提前 readBody 会把流读空
  const body = req.method === 'POST' && p !== '/api/upload' && p !== '/api/media/upload' ? await readBody(req) : {};

  /// 任何 POST 都是一次动作：先把只读缓存的旧值丢掉，后面的刷新才会读到新状态
  /// 任何 POST 都是一次动作：先把只读缓存的旧值丢掉，后面的刷新才会读到新状态。
  /// 例外：触控板的移动和滚轮一秒钟能发几十次，本身不改变设备状态。
  /// 每次都清缓存的话，后台会把 /api/state 那坨 adb 读数反复重跑，体感反而是「一动就卡」
  const transientMouse =
    p === '/api/mouse' && (req.method === 'POST' ? body.mode === 'move' || body.mode === 'scroll' : false);
  if (req.method === 'POST' && !transientMouse) dropReadCache();

  try {
    /// 只读 GET 统一从这个口子出：命中短期缓存就直接回，不再重复敲 adb。
    /// 带 fresh 的请求（用户手动「重新读取」）绕开缓存，永远真读一次
    const readTtl = req.method === 'GET' && !url.searchParams.has('fresh') ? READ_TTL[p] : undefined;
    const readKey = readTtl ? `${dev.adb?.serial ?? profile.serial ?? ''}|${p}|${url.search}` : '';
    const ro = <T>(fn: () => Promise<T>): Promise<T> => (readKey ? readMemo(readKey, readTtl as number, fn) : fn());

    if (p === '/api/state') {
      const payload = await ro(() => statePayload(profile, dev.online, dev.adb)) as Record<string, unknown>;
      /// 这两项是进程内的实时量，不该跟着 adb 读数一起被缓存 3 秒：
      /// 设备刚连上直播流时，页面会从缓存里读到「还没在播」，看着像点了没反应
      payload.mirror = hub.status();
      payload.devicePreview = { url: '/device.mjpg', poll: '/device.jpg', ...deviceLive.status() };
      if (!dev.online && dev.note) payload.note = dev.note;
      return json(res, 200, payload);
    }    // 设备休眠会让无线 adb 掉线，这里给页面一个不用回终端的重连入口
    if (p === '/api/connect') {
      const ip = String(body.ip || profile.ip || '').trim();
      /// 设备的 adb 端口不一定是 5555（改过 tcpip 端口、或走端口转发时都得能连），所以让页面传
      const port = Math.min(65535, Math.max(1, Number(body.port ?? 5555) || 5555));
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return json(res, 400, { error: '请填写有效的设备 IP 地址' });
      const r = await attachAdb(ip, Number(body.budget ?? 12000), port);
      if (r.ok && r.serial) {
        profile.serial = r.serial ? r.serial : profile.serial;
        profile.ip = ip;
        if (r.model) profile.model = r.model;
        saveProfile(profile);
      }
      return json(res, 200, r);
    }
    /// 切换到 adb 列表里的另一台设备。以前页面只能控制「adb 里的第一台」，
    /// 同时挂着手机、平板或几台盒子时用户没有任何办法点名，只能回终端改 serial。
    /// 这里只认 adb devices 里真实存在的 serial，不接受任意字符串，避免把档案写成连不上的地址。
    if (p === '/api/select' && req.method === 'POST') {
      const serial = String(body.serial || '').trim();
      if (!serial) return json(res, 400, { error: '缺少设备 serial' });
      const devs = await connectedDevicesAsync();
      const hit = devs.find((d) => d.serial === serial);
      if (!hit) {
        return json(res, 404, {
          ok: false,
          detail: `设备列表里没有 ${serial}，先在设备上打开网络调试或重新扫描`,
        });
      }
      profile.serial = serial;
      profile.ip = serial.split(':')[0];
      profile.port = serial.includes(':') ? Number(serial.split(':')[1]) || profile.port : profile.port;
      if (hit.model) profile.model = hit.model;
      saveProfile(profile);
      /// 旧设备的读数（型号、应用、健康）全部作废，否则切完还顶着上一台的数据
      dropReadCache();
      const online = hit.state === 'device';
      /// 换设备必须当场把档案换成这台的数据。以前只写 serial/model，剩下的靠
      /// deviceFor 里的「发现 serial 变了就异步补快照」，而那个补快照的判定是
      /// 「型号对得上 + 应用非空 + 有机型名」就跳过：adb devices 报的 model 和
      /// 设备上 ro.product.model 完全一致时正好命中跳过条件，结果 modelFriendly、
      /// 系统版本、应用清单会一直停在上一台（实测手机模拟器 → ATV 后仍显示 API 26）。
      /// 轻快照实测只要 0.4~0.6 秒，点名切换是用户主动动作，直接等它读完。
      let friendly = '';
      if (online) {
        try {
          Object.assign(profile, await refreshProfileSnapshot(serial));
          friendly = profile.modelFriendly || profile.model || '';
          /// 档案已经是这台的数据，别让 deviceFor 再补一次同样的快照
          snapSerial = serial;
        } catch (e) {
          console.log(`切换设备时读取档案失败: ${(e as Error).message}`);
        }
        dropReadCache();
      }
      return json(res, 200, {
        ok: online,
        verified: online,
        serial,
        model: friendly || hit.model,
        detail: online
          ? `已切到 ${friendly || hit.model || serial}，设备信息已读取完成`
          : `已指向 ${serial}，但连接状态是 ${ADB_STATE_CN[hit.state] || hit.state || '未知'}，点重连会先摘掉旧记录再握手`,
      });
    }
    /// adb devices 报的 model 是构建目标名（sdk_google_atv64_arm64 这类），
    /// 页面上列一堆代号没人看得懂。这里对在线设备补一次 getprop，
    /// 换成设备自己报的市场名 / 模拟器标注；读不到就照原样给型号。
    /// 结果按 serial 缓存 5 分钟，扫描本身也有缓存，不会拖慢首屏
    const labelAdbDevices = async (devs: AdbDevice[]) => {
      return Promise.all(
        devs.map(async (d) => {
          if (d.state !== 'device') return { ...d, modelFriendly: '' };
          const key = d.serial;
          const hit = propLabelCache.get(key);
          if (hit && Date.now() - hit.at < PROP_LABEL_MS) return { ...d, modelFriendly: hit.label };
          let label = '';
          try {
            const out = await new Adb(key).shellAsync('getprop', 4000);
            const props: Record<string, string> = {};
            for (const line of out.stdout.split('\n')) {
              const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
              if (m) props[m[1]] = m[2];
            }
            label = friendlyModel(props) || d.model || '';
          } catch {
            label = d.model || '';
          }
          propLabelCache.set(key, { at: Date.now(), label });
          return { ...d, modelFriendly: label };
        }),
      );
    };

    // 搜索页：ADB mDNS + 5555 端口探测，只返回可接入的 ADB 设备
    if (p === '/api/scan') {
      const full = url.searchParams.get('full') === '1';
      /// force=1 是用户明确点了「搜索」：必须真搜一次。
      /// 以前 90 秒的复用窗口对自动加载和手动点击一视同仁，页面上写着
      /// 「要最新点一次搜索」，点下去拿回来的还是同一份旧数据，等于按钮说谎
      const force = url.searchParams.get('force') === '1';
      const ms = Math.min(8000, Math.max(800, Number(url.searchParams.get('ms') ?? 2500)));
      const t0 = Date.now();
      const scanKey = full ? 'full' : 'quick';
      const runScan = async () => {
        const [cands, devs] = await Promise.all([findAdbDevices({ full, ms }), connectedDevicesAsync()]);
        return {
          ok: true,
          ms: Date.now() - t0,
          scope: full ? '整网段 ADB 扫描' : '局域网 ADB 发现',
          adb: (await labelAdbDevices(devs)).map((d) => ({
            serial: d.serial,
            state: d.state,
            model: d.model,
            modelFriendly: d.modelFriendly,
          })),
          candidates: cands,
        };
      };
      const cached = scanCache.get(scanKey);
      if (cached && !force && Date.now() - cached.at < SCAN_REUSE_MS) {
        const ageSec = Math.round((Date.now() - cached.at) / 1000);
        if (Date.now() - cached.at >= SCAN_FRESH_MS) {
          void runScan()
            .then((data) => scanCache.set(scanKey, { at: Date.now(), data }))
            .catch(() => {});
        }
        return json(res, 200, { ...(cached.data as Record<string, unknown>), cached: true, ageSec });
      }
      const data = await runScan();
      scanCache.set(scanKey, { at: Date.now(), data });
      return json(res, 200, data);
    }
    if (p === '/api/key' && req.method === 'POST') return json(res, 200, await pressKey(adb, body.key, !!body.long));

    /// 画面直通：页面上点一下 = 设备上 input tap，按住拖一段 = input swipe。
    /// 坐标一律是设备像素，前端的 letterbox 换算已经做完了，这里不再猜方向
    if (p === '/api/tap' && req.method === 'POST') {
      const x = Math.round(Number(body.x));
      const y = Math.round(Number(body.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return json(res, 400, { error: '点按坐标不合法' });
      const cmd = `input tap ${x} ${y}`;
      const r = await adb.shellAsync(cmd, 8000);
      return json(res, 200, { ok: r.code === 0, x, y, command: cmd, detail: (r.stderr || '').trim() || `已点按 ${x},${y}` });
    }
    if (p === '/api/swipe' && req.method === 'POST') {
      const num = (v: unknown, dflt: number) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : dflt);
      const x1 = num(body.x1, -1);
      const y1 = num(body.y1, -1);
      const x2 = num(body.x2, -1);
      const y2 = num(body.y2, -1);
      /// 时长走真实手势耗时：太快会被设备当成 fling，太快太慢都不像人手
      const ms = Math.min(4000, Math.max(40, num(body.ms, 200)));
      if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) return json(res, 400, { error: '滑动坐标不合法' });
      const cmd = `input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`;
      const r = await adb.shellAsync(cmd, 12000);
      return json(res, 200, { ok: r.code === 0, command: cmd, detail: (r.stderr || '').trim() || `已滑动 ${x1},${y1} → ${x2},${y2}` });
    }

    /// 触控板：move / click / down / up / scroll 五种动作。这台设备到底有没有鼠标驱动、
    /// 有哪几个键、能不能滚轮，全由后端探测（state.mouse）决定，页面只表达意图。
    /// move 是 fire-and-forget：每帧一个请求，等回包会把拖动变成卡顿
    if (p === '/api/mouse' && req.method === 'POST') {
      const mode = String(body.mode || '') as 'move' | 'click' | 'down' | 'up' | 'scroll';
      if (!['move', 'click', 'down', 'up', 'scroll'].includes(mode)) return json(res, 400, { error: `未知的触控板动作 ${mode}` });
      const btn = ['left', 'right', 'middle', 'side', 'extra'].includes(String(body.btn)) ? (String(body.btn) as never) : undefined;
      const dir = ['up', 'down', 'left', 'right'].includes(String(body.dir)) ? (String(body.dir) as never) : undefined;
      const num = (v: unknown): number | undefined => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined);
      const r = await mouseAction(adb, mode, {
        dx: num(body.dx),
        dy: num(body.dy),
        btn,
        dir,
        amount: num(body.amount),
        x: num(body.x),
        y: num(body.y),
      });
      return json(res, 200, r);
    }
    /// 文字输入：把本机打的字送进设备当前聚焦的输入框。
    /// 两种通路（input text / ADBKeyboard 广播）在后端选，页面只管发文字和看结论
    if (p === '/api/text' && req.method === 'POST') {
      if (body.action) {
        const a = String(body.action);
        if (a !== 'enter' && a !== 'backspace' && a !== 'clear') return json(res, 400, { error: `未知编辑动作 ${a}` });
        return json(res, 200, await editText(adb, a));
      }
      const r = await typeText(adb, String(body.text ?? ''), body.submit === true);
      /// 发不出去不是服务器错误，是这台设备缺通路：200 + ok:false，页面照着写原因
      return json(res, 200, r);
    }
    if (p === '/api/sleep' && req.method === 'POST') return json(res, 200, await sleepTv(adb));
    /// 唤醒要在请求里等设备网络回来，所以做成带预算的长请求，不用 503 拦住。
    /// IP 不是硬要求：模拟器、USB 盒子、以后的跨平台客户端可能只有 serial 没有 IP，
    /// 那种设备待机后 adb 照样连着，直接走 adb 发唤醒键就行
    if (p === '/api/wake' && req.method === 'POST') {
      const ip = String(body.ip || profile.ip || '').trim();
      const serial = String(body.serial || profile.serial || '').trim();
      const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : '';
      if (!ipv4 && !serial) return json(res, 400, { error: '缺少设备地址（IP 或 serial），无法唤醒' });
      const budget = Math.min(60000, Math.max(5000, Number(body.budget ?? 25000)));
      return json(res, 200, await wakeTv(ipv4, serial, budget));
    }
    if (p === '/api/volume' && req.method === 'POST') {
      // 两条路径内部都已回读音量，避免重复 dumpsys
      if (body.level !== undefined) return json(res, 200, await setVolume(adb, Number(body.level), body.soft ? 1 : 3));
      return json(res, 200, await volumeStep(adb, body.dir ?? 'up'));
    }
    if (p === '/api/launch' && req.method === 'POST') return json(res, 200, await launchNamed(adb, profile, String(body.name)));
    if (p === '/api/usage') {
      const u = screenTime(adb, Number(body.hours ?? url.searchParams.get('hours') ?? 24));
      /// 使用统计里只有包名，页面上那份应用清单又只收启动项，352Life 这种
      /// 正在运行但不在启动器里的应用会漏成 com.xxx。这里用服务端已有的
      /// 名字缓存（names.json / 图标索引 / profile）逐行补名，零额外 adb。
      return json(res, 200, {
        ...u,
        rows: u.rows.map((r) => ({ ...r, label: labelNow(r.package, profile) })),
      });
    }
    if (p === '/api/night' && req.method === 'POST') return json(res, 200, nightControl(adb, body.action ?? 'off', String(body.level ?? '')));
    if (p === '/api/picture' && req.method === 'GET') return json(res, 200, await ro(async () => readPicture(adb, profile)));
    if (p === '/api/picture' && req.method === 'POST') {
      /// 参数缺失必须当场拒掉：以前 body 里没有 key 时，String(undefined) 会真的写出
      /// 一条名叫 undefined 的设置（模拟器上留下过 undefined=undefined 这种垃圾键）
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      const value = typeof body.value === 'string' || typeof body.value === 'number' ? String(body.value) : '';
      /// 不传 table 时仍按以前的默认（system）走，不能因为加了校验就把老调用方拒掉
      const tableRaw = body.table === undefined ? 'system' : String(body.table);
      const table = (PICTURE_TABLES as readonly string[]).includes(tableRaw)
        ? (tableRaw as 'system' | 'secure' | 'global')
        : '';
      if (!key || !value) {
        return json(res, 400, { ok: false, detail: '缺少要写的设置项：key 和 value 都要给', verified: false });
      }
      if (!table) {
        return json(res, 400, { ok: false, detail: `未知的设置表 ${tableRaw}（只能是 system / secure / global）`, verified: false });
      }
      return json(res, 200, await writePictureAsync(adb, key, table, value));
    }
    if (p === '/api/mirror' && req.method === 'POST') {
      if (body.stop) hub.stop();
      else hub.start({ fps: Number(body.fps ?? 3), width: Number(body.width ?? 1280), quality: Number(body.quality ?? 55) });
      return json(res, 200, hub.status());
    }
    /// 服务端画面工具要单独盯「播没播起来」，为这一个字段重读 /api/state 太贵：
    /// 那种查法还要跑一串 adb，而这个状态纯是本进程内存里的
    if (p === '/api/mirror' && req.method === 'GET') return json(res, 200, hub.status());
    /// 设备预览直播流的参数：帧率太高会把 adb 占满（别的请求全排在后面），
    /// 所以上限卡在 8；宽度上限就是设备本身，超了也没意义
    if (p === '/api/device-preview' && req.method === 'POST') {
      const patch: { fps?: number; width?: number; quality?: number } = {};
      if (body.fps !== undefined) patch.fps = Math.min(8, Math.max(1, Number(body.fps) || 5));
      if (body.width !== undefined) patch.width = Math.min(2560, Math.max(320, Number(body.width) || 1280));
      if (body.quality !== undefined) patch.quality = Math.min(95, Math.max(30, Number(body.quality) || 65));
      if (Object.keys(patch).length) deviceLive.setOpts(patch);
      return json(res, 200, deviceLive.status());
    }
    if ((p === '/api/mirror-on-tv' || p === '/api/mirror-open') && req.method === 'POST') {
      const r = await openUrlOnDevice(adb, profile, `http://${lanIp()}:${PORT}/watch`);
      return json(res, r.ok ? 200 : 502, { ...r, mirrorUrl: `http://${lanIp()}:${PORT}/watch` });
    }
    if (p === '/api/apps') return json(res, 200, await ro(() => appInventory(adb, profile)));
    if (p === '/api/processes') return json(res, 200, await ro(() => processesPayload(adb)));
    if (p === '/api/device') return json(res, 200, await ro(() => deviceInfo(adb, profile)));
    /// 重新探测当前连接设备：型号、应用、画面设置全部重跑一遍并落取证目录。
    /// 入参用 adb serial，所以模拟器、USB 设备、网络调试设备都能走这条完整探测。
    /// 设备离线时由上面统一的「需要 adb」拦截回 503，这里不用重复判断。
    if (p === '/api/probe' && req.method === 'POST') {
      const serial = (dev.adb as Adb).serial;
      const prof = await probeDevice(serial);
      /// 探测已经写完快照字段，别让 deviceFor 再补一次轻量快照
      snapSerial = serial;
      dropReadCache();
      return json(res, 200, {
        ok: true,
        brand: prof.brand,
        model: prof.modelFriendly || prof.model,
        androidVersion: prof.androidVersion,
        apps: prof.apps.length,
        evidenceDir: prof.evidenceDir,
        detail: `已重新探测 ${prof.modelFriendly || prof.model}，取证目录 ${prof.evidenceDir}`,
      });
    }
  /// 健康快照：CPU / 内存 / 磁盘 / 温度全部来自 /proc 与 df，不认厂牌、不需要 root
  if (p === '/api/health') {
    const serial = (dev.adb as Adb).serial;
    const key = `health|${serial}`;
    try {
      const data = await ro(() => deviceHealth(adb));
      healthFallback.set(key, { at: Date.now(), data });
      return json(res, 200, { ...data, stale: false });
    } catch (e) {
      const old = healthFallback.get(key);
      if (!old) return json(res, 502, { error: `${(e as Error).message}（还没读出过健康数据）` });
      console.log(`健康采样失败，回退到 ${Math.round((Date.now() - old.at) / 1000)} 秒前的读数: ${(e as Error).message}`);
      return json(res, 200, { ...(old.data as Record<string, unknown>), stale: true });
    }
  }

    /// 录屏：立刻返回一个后台任务 id，不等设备录完。页面按 jobId 轮询 /api/record/status，
    /// 录完的 mp4 落在 .tvdeck/recordings，列表/下载/删除见下面的 /api/recordings*
    if (p === '/api/record' && req.method === 'POST') {
      /// 同一台设备同时只能跑一个 screenrecord：同时下两条会被系统拒掉其中一条，
      /// 更糟的是两条都会去抢同一个 /data/local/tmp 临时文件名。与其撞了再报错，不如提前拦
      const busy = [...recJobs.values()].find((j) => j.serial === dev.serial && recJobRunning(j));
      if (busy) return json(res, 200, { ok: false, verified: false, job: recJobView(busy), detail: '已有一个录屏任务在跑，等它结束再开始' });
      const seconds = Math.min(30, Math.max(3, Math.round(Number(body.seconds ?? 10) || 10)));
      const job: RecJob = { id: randomUUID(), serial: dev.serial, seconds, startedAt: Date.now(), phase: 'record' };
      recJobs.set(job.id, job);
      /// 后台跑，不 await：请求已经返回，任务自己走完并更新阶段。
      /// 结束后留 2 分钟再清，够页面把最终结果和刚录的文件名取走
      void (async () => {
        try {
          const r = await recordScreen(adb, {
            seconds,
            height: body.height === undefined ? 0 : Number(body.height),
            bitrate: body.bitrate === undefined ? 0 : Number(body.bitrate),
            dir: recordingsDir,
            onPhase: (ph) => {
              job.phase = ph;
            },
          });
          job.phase = r.ok ? 'done' : 'error';
          job.name = r.name;
          job.bytes = r.bytes;
          job.detail = r.detail;
        } catch (e) {
          job.phase = 'error';
          job.detail = (e as Error).message;
        } finally {
          setTimeout(() => recJobs.delete(job.id), 120000);
        }
      })();
      return json(res, 200, { ok: true, verified: false, job: recJobView(job), detail: `已开始录制 ${seconds} 秒` });
    }
    /// 录屏进度：带 job 就查那一条；不带 job 就把这台设备的活动任务 + 最近完成的一条回给页面，
    /// 这样页面刷新 / 切走再回来能自动接上正在跑的任务
    if (p === '/api/record/status') {
      const id = url.searchParams.get('job') || '';
      if (id) {
        const j = recJobs.get(id);
        return json(res, 200, j ? { ok: true, job: recJobView(j) } : { ok: true, gone: true, detail: '任务已结束或不存在' });
      }
      const mine = [...recJobs.values()].filter((j) => j.serial === dev.serial);
      const active = mine.find(recJobRunning);
      const last = mine.filter((j) => !recJobRunning(j)).sort((a, b) => b.startedAt - a.startedAt)[0];
      return json(res, 200, {
        ok: true,
        active: active ? recJobView(active) : null,
        last: last ? recJobView(last) : null,
      });
    }
    if (p === '/api/recordings' && req.method === 'GET') {
      return json(res, 200, { dir: recordingsDir, rows: listRecordings() });
    }
    if (p === '/api/recordings/del' && req.method === 'POST') {
      /// 支持单个 name，也支持 names 数组批量删。批量时逐个校验：某个名字越界或不存在
      /// 不拦着整批，删得掉的先删，最后按实际结果记账，页面据 removed/failed 提示
      const names = Array.isArray(body.names) ? body.names.map(String) : body.name !== undefined ? [String(body.name)] : [];
      if (!names.length) return json(res, 400, { ok: false, detail: '没有指定要删的录像' });
      const done: string[] = [];
      const failed: string[] = [];
      for (const n of names) {
        const { file, why } = recordingFile(n);
        if (why || !fs.existsSync(file)) {
          failed.push(n);
          continue;
        }
        fs.rmSync(file, { force: true });
        (fs.existsSync(file) ? failed : done).push(n);
      }
      const single = names.length === 1;
      return json(res, 200, {
        ok: failed.length === 0,
        verified: failed.length === 0,
        removed: done.length,
        failed,
        detail: single
          ? done.length
            ? `已删除 ${path.basename(done[0])}`
            : '文件还在'
          : failed.length
            ? `删掉 ${done.length} 段，${failed.length} 段没删掉`
            : `已删除 ${done.length} 段录像`,
      });
    }
    /// 重命名：只在 .tvdeck/recordings 目录内改文件名，设备端不碰。
    /// 新名字按「单个文件名」处理 —— 去掉路径、剔掉各系统都不接受的字符，并强制 .mp4 后缀
    if (p === '/api/recordings/rename' && req.method === 'POST') {
      const { file, why } = recordingFile(String(body.name ?? ''));
      if (why || !fs.existsSync(file)) return json(res, 400, { ok: false, detail: why || '文件不存在' });
      let to = path.basename(String(body.to ?? '').trim()).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
      if (!to || to === '.mp4') return json(res, 400, { ok: false, detail: '新名称不能为空' });
      if (!/\.mp4$/i.test(to)) to += '.mp4';
      const { file: dst, why: why2 } = recordingFile(to);
      if (why2) return json(res, 400, { ok: false, detail: why2 });
      if (dst !== file && fs.existsSync(dst)) return json(res, 409, { ok: false, detail: '已经有一个同名录像了，换个名字' });
      if (dst !== file) fs.renameSync(file, dst);
      return json(res, 200, { ok: true, verified: fs.existsSync(dst), name: to, detail: `已重命名为 ${to}` });
    }
    /// 清空全部录像：只动本机 .tvdeck/recordings 这一层，设备上的东西一概不碰
    if (p === '/api/recordings/clear' && req.method === 'POST') {
      const rows = listRecordings();
      let bytes = 0;
      for (const r of rows) {
        const { file } = recordingFile(r.name);
        try {
          bytes += r.bytes;
          fs.rmSync(file, { force: true });
        } catch {
          /* 单个删不掉不拦着一整批，最后按实际剩几条来报 */
        }
      }
      const left = listRecordings();
      const gone = rows.length - left.length;
      return json(res, 200, {
        ok: left.length === 0,
        verified: left.length === 0,
        removed: gone,
        bytes,
        detail:
          left.length === 0
            ? `已清空 ${gone} 段录像 · 释放 ${(bytes / 1048576).toFixed(1)}MB`
            : `删掉 ${gone} 段，还剩 ${left.length} 段没删掉`,
      });
    }
    /// 文件管理器定位：录完的 mp4 在服务端这台电脑上，用户多半是想直接拖去剪辑/发给别人。
    /// 各系统的「打开并选中这个文件」命令不一样，按平台分派，不写死某一个桌面
    if (p === '/api/recordings/reveal' && req.method === 'POST') {
      const { file, why } = recordingFile(String(body.name ?? ''));
      if (why || !fs.existsSync(file)) return json(res, 400, { ok: false, detail: why || '文件不存在' });
      if (process.platform === 'darwin') spawn('open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'win32') spawn('explorer', [`/select,${file}`], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [path.dirname(file)], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true, verified: true, detail: `已在文件管理器里定位 ${path.basename(file)}` });
    }

    /// 电源动作：重启 / Recovery / Bootloader / 关机。发出去之后连接就断，
    /// 所以返回的是「已送达」；设备什么时候回来交给连接页去重认
    if (p === '/api/power' && req.method === 'POST') {
      const r = await powerAction(adb, String(body.action ?? ''));
      return json(res, r.ok ? 200 : 502, r);
    }

    /// 设备日志：读的是设备上的 logcat 环形缓冲，不是服务端这台电脑的系统日志。
    /// scope=app 时先按包名把 pid 找出来再看那个进程；包名没给就问设备当前前台是谁。
    /// 找不到 pid 就如实退回全量（pid=0 即不加过滤），并在 detail 里写明，
    /// 免得用户以为"只看当前应用"生效了，其实读到的是整机日志
    if (p === '/api/log' && req.method === 'GET') {
      const lines = Number(url.searchParams.get('lines') ?? 400) || 400;
      const level = (url.searchParams.get('level') ?? '').toUpperCase();
      const scope = url.searchParams.get('scope') === 'app' ? 'app' : 'all';
      let pid = 0;
      let fallback = '';
      if (scope === 'app') {
        let pkg = (url.searchParams.get('pkg') ?? '').trim();
        if (!pkg) {
          /// topActivityAsync 回的是 `包名/Activity`，只取包名段
          const top = await adb.topActivityAsync().catch(() => '');
          pkg = (top || '').split('/')[0] || '';
        }
        if (pkg) pid = await pidOf(adb, pkg);
        fallback = pid
          ? ''
          : pkg
            ? `没找到「${pkg}」这个进程，已退回全量日志`
            : '读不到当前前台应用，已退回全量日志';
      }
      const r = await logSnapshot(adb, { lines, level, pid });
      return json(res, 200, fallback ? { ...r, detail: `${fallback}${r.detail ? ` · ${r.detail}` : ''}` } : r);
    }
    /// 清空设备上的日志缓冲：只动 logcat 环形缓冲，不碰系统文件
    if (p === '/api/log/clear' && req.method === 'POST') {
      return json(res, 200, await logClear(adb));
    }

    // 系统级：启动项 / 默认桌面 / 开机自启。三项都先探测再执行，探测结果直接给页面
    /// fresh=1 强制重跑探测：用户切了 root / 换了设备之后，30 秒的缓存不该继续挡住真相
    if (p === '/api/system/caps') return json(res, 200, await ro(() => capabilities(adb, url.searchParams.get('fresh') === '1')));
    if (p === '/api/system/home' && req.method === 'GET') return json(res, 200, await ro(() => homeState(adb, profile)));
    if (p === '/api/system/home' && req.method === 'POST') {
      const r = await setHomeActivity(adb, String(body.component));
      return json(res, r.ok ? 200 : 502, r);
    }
    if (p === '/api/system/startup' && req.method === 'GET') return json(res, 200, await ro(() => startupItems(adb, profile)));
    if (p === '/api/system/startup' && req.method === 'POST') {
      const r = await setStartupItem(adb, String(body.pkg), body.enabled === true, String(body.component ?? ''));
      return json(res, r.ok ? 200 : 502, r);
    }
    /// 开机自启的候选清单：所有可启动应用（含系统/预装），不只第三方
    if (p === '/api/system/launchables') return json(res, 200, await ro(() => launchables(adb, profile)));
    if (p === '/api/system/autostart' && req.method === 'GET') return json(res, 200, await ro(() => autostartState(adb)));
    if (p === '/api/system/autostart' && req.method === 'POST') {
      if (body.install) return json(res, 200, await installHelper(adb));
      if (body.try) return json(res, 200, await tryAutostart(adb));
      const r = await setAutostart(adb, {
        enabled: body.enabled === true,
        target: body.target === undefined ? undefined : String(body.target),
        delayMs: body.delayMs === undefined ? undefined : Number(body.delayMs),
        mode: body.mode === undefined ? undefined : String(body.mode),
      });
      return json(res, r.ok ? 200 : 502, r);
    }

    /// ---- 自动化脚本 ----
    /// 一次把面板要的全给：引擎状态、脚本清单、运行记录、可用的动作与按键清单。
    /// 应用清单由页面另外去 /api/system/launchables 拿
    if (p === '/api/automation' && req.method === 'GET') {
      const store = loadStore();
      const active: Record<string, string> = {};
      for (const s of store.scripts) {
        const j = activeRunOf(s.id);
        if (j) active[s.id] = j.id;
      }
      return json(res, 200, {
        ok: true,
        engine: { enabled: store.enabled, tickMs: AUTO_TICK_MS, lastTick: store.lastTick, online: dev.online },
        scripts: store.scripts,
        history: store.history,
        kinds: STEP_META,
        keys: keyList(),
        active,
        path: automationPath,
      });
    }
    /// 新建与修改走同一条路：带 id 就是覆盖，不带就是新建。存的是归一化之后的成品
    if (p === '/api/automation/save' && req.method === 'POST') {
      const r = upsertScript(body);
      return json(res, r.ok ? 200 : 400, r);
    }
    if (p === '/api/automation/del' && req.method === 'POST') {
      const r = deleteScript(String(body.id ?? ''));
      return json(res, r.ok ? 200 : 404, r);
    }
    /// 总开关：停的是「自动」，手动运行永远可用 —— 排查问题时不该被迫先把定时关掉
    if (p === '/api/automation/engine' && req.method === 'POST') {
      const on = body.enabled !== false;
      setEngineEnabled(on);
      return json(res, 200, {
        ok: true,
        enabled: on,
        detail: on ? '自动触发已开启' : '自动触发已暂停（手动运行不受影响）',
      });
    }
    if (p === '/api/automation/history/clear' && req.method === 'POST') {
      return json(res, 200, clearHistory());
    }
    /// 立刻跑一条：不等结果，先回 jobId，页面按 job 轮询每一步。
    /// 脚本里有等待，挂在一个 HTTP 请求里等下去，刷新页面这次运行就丢了
    if (p === '/api/automation/run' && req.method === 'POST') {
      const s = loadStore().scripts.find((x) => x.id === String(body.id ?? ''));
      if (!s) return json(res, 404, { ok: false, detail: '没有这条脚本' });
      if (!dev.adb) {
        const job = startRun(null, profile, s, '手动', dev.note);
        return json(res, 200, { ok: false, job, detail: `${dev.note}，脚本没有执行` });
      }
      const job = startRun(dev.adb, profile, s, '手动');
      return json(res, 200, { ok: true, job, detail: `已开始执行「${s.name}」` });
    }
    if (p === '/api/automation/run/status' && req.method === 'GET') {
      const job = runView(url.searchParams.get('job') ?? '');
      if (!job) return json(res, 200, { ok: true, gone: true, detail: '这次运行已经结束或不存在' });
      const running = job.steps.some((v) => v.state === 'pending' || v.state === 'running');
      return json(res, 200, { ok: true, job, running });
    }

    /// 媒体库：脚本里的「播放图片 / 视频」从这里挑素材。
    /// 上传走原始字节流，和 APK 上传同一套；上限放到 2GB 是因为一段视频轻松几百兆
    if (p === '/api/media' && req.method === 'GET') {
      return json(res, 200, { ok: true, items: listMedia(), dir: mediaDir });
    }
    if (p === '/api/media/upload' && (req.method === 'POST' || req.method === 'PUT')) {
      const raw = url.searchParams.get('name') ?? 'media.bin';
      const name = mediaName(raw);
      if (!name) {
        return json(res, 400, {
          ok: false,
          detail: `「${String(raw).slice(0, 60)}」不是能播放的格式。支持常见图片（jpg/png/gif/webp/bmp）、视频（mp4/mkv/webm/mov/avi/ts）和音频（mp3/m4a/aac/flac/wav/ogg）`,
        });
      }
      const dest = mediaTarget(name) as string;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const size = await saveUpload(req, dest, MAX_MEDIA_UPLOAD);
      return json(res, 200, {
        ok: true,
        verified: true,
        name,
        bytes: size,
        detail: `已加入媒体库：${name}（${humanSize(size)}）`,
      });
    }
    if (p === '/api/media/del' && req.method === 'POST') {
      const r = deleteMedia(body.name);
      return json(res, r.ok ? 200 : 404, r);
    }

    if (p === '/api/fs') {
      const dir = url.searchParams.get('path') || '/storage/emulated/0';
      return json(res, 200, await listDir(adb, dir));
    }
    if (p === '/api/name' && req.method === 'POST') return json(res, 200, await resolveAppName(adb, String(body.pkg)));
    if (p === '/api/app' && req.method === 'POST') {
      const pkg = String(body.pkg);
      if (body.action === 'stop') return json(res, 200, await forceStopApp(adb, pkg));
      if (body.action === 'clear') return json(res, 200, await clearAppData(adb, pkg));
      if (body.action === 'uninstall') return json(res, 200, await uninstallApp(adb, pkg));
      if (body.action === 'launch') return json(res, 200, await launchPackage(adb, pkg));
      return json(res, 400, { error: `未知动作 ${body.action}` });
    }
    // 上传：原始字节流落盘 → 先解析给页面看（装的是谁、设备端有没有、是否预装包）→ 再由页面确认后调 /api/install 或 /api/push
    if (p === '/api/upload' && (req.method === 'POST' || req.method === 'PUT')) {
      const { host, base } = uploadTarget(url.searchParams.get('name') ?? 'upload.bin');
      const size = await saveUpload(req, host);
      const meta = await apkPreview(adb, host).catch(() => ({ pkg: '', label: '', present: false, system: false, version: '' }));
      return json(res, 200, { ok: true, verified: false, host, name: base, bytes: size, ...meta, detail: `已收到 ${base}（${humanSize(size)}）${meta.pkg ? ` · ${meta.pkg}${meta.label ? `「${meta.label}」` : ''}${meta.present ? ` 设备端已存在 v${meta.version || '?'}` : ''}${meta.system ? ' · 厂商预装包' : ''}` : ''}` });
    }
    /// 取消安装/推送时清掉临时文件，只允许删上传目录里的东西
    if (p === '/api/upload/del' && req.method === 'POST') {
      const host = path.resolve(String(body.host ?? ''));
      const dir = under('uploads');
      if (!host.startsWith(dir + path.sep)) return json(res, 400, { ok: false, verified: false, command: `删除 ${host}`, detail: '只允许删除上传临时目录里的文件' });
      fs.rmSync(host, { force: true });
      return json(res, 200, { ok: !fs.existsSync(host), verified: !fs.existsSync(host), command: `rm ${path.basename(host)}`, detail: fs.existsSync(host) ? '文件还在' : '临时文件已删除' });
    }
    if (p === '/api/install' && req.method === 'POST') {
      const host = String(body.host ?? '');
      const r = await installFromHost(adb, host, body.confirm === true);
      // 预装包拦下的这次不删文件，页面确认后还要用同一个 tmp 路径重试
      if (!r.needsConfirm) fs.rmSync(host, { force: true });
      return json(res, 200, r);
    }
    if (p === '/api/push' && req.method === 'POST') {
      const host = String(body.host ?? '');
      const r = await pullToDevice(adb, host, String(body.dest ?? '/data/local/tmp'));
      fs.rmSync(host, { force: true });
      return json(res, 200, r);
    }
    if (p === '/api/download' && dev.online) {
      const remote = url.searchParams.get('path') ?? '';
      const bad = checkFsPath(remote);
      if (bad) return json(res, 400, bad);
      const local = await pullFromDevice(adb, remote);
      const buf = fs.readFileSync(local);
      fs.rmSync(local, { force: true });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(remote))}`,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
  return json(res, 404, { error: `未知接口 ${p}` });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ADB 工作台 http://localhost:${PORT}  (局域网 ${lanIp()}:${PORT})`);
  console.log(`服务端画面页（在目标设备浏览器中打开）http://${lanIp()}:${PORT}/watch`);
  console.log(`原始直播流 http://${lanIp()}:${PORT}/mirror.mjpg（设备支持 MJPEG 时可直接用）`);
  /// 开机预热：设备已连接时把常用只读数据提前读一遍，
  /// 用户打开页面时这些接口直接命中缓存，省掉第一次的等待。
  /// 全部失败静默吞掉：预热失败不该影响服务启动，下次正常请求会真读。
  void (async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const profile = loadProfile();
    const dev = deviceFor(profile);
    const adb = dev.adb;
    if (!adb) return;
    const serial = adb.serial;
    void readMemo(`${serial}|/api/apps|`, 15, () => appInventory(adb, profile)).catch(() => {});
    void readMemo(`${serial}|/api/device|`, 15, () => deviceInfo(adb, profile)).catch(() => {});
    void readMemo(`${serial}|/api/system/caps|`, 15, () => capabilities(adb, false)).catch(() => {});
    void readMemo(`${serial}|/api/system/startup|`, 15, () => startupItems(adb, profile)).catch(() => {});
    void readMemo(`${serial}|/api/health|`, 5, () => deviceHealth(adb)).catch(() => {});
    void readMemo(`${serial}|/api/processes|`, 4, () => processesPayload(adb)).catch(() => {});
    void readMemo(`${serial}|/api/system/home|`, 6, () => homeState(adb, profile)).catch(() => {});
    void readMemo(`${serial}|/api/system/launchables|`, 15, () => launchables(adb, profile)).catch(() => {});
    void readMemo(`${serial}|/api/system/autostart|`, 15, () => autostartState(adb)).catch(() => {});
    void readMemo(`${serial}|/api/state|`, 3, () => statePayload(profile, true, adb)).catch(() => {});
  })();
});

/// ---- 自动化引擎 ----
/// 每 20 秒问一次「有没有到点的定时」「设备是不是刚上线」。
/// 20 秒的粒度对「每天 8 点启动设备」这类诉求完全够用，也不会变成一直敲 adb 的轮询。
let autoTicking = false;
let autoBooted = false;

async function automationTick(): Promise<void> {
  /// 上一轮没跑完就跳过这一轮：一轮里可能有好几条脚本要起，别叠起来
  if (autoTicking) return;
  autoTicking = true;
  try {
    const store = loadStore();
    const profile = loadProfile();
    const dev = deviceFor(profile);
    if (!autoBooted) {
      /// 服务刚起来这轮只记录现状、不触发。否则每次重启（包括改代码热重启）
      /// 都会把「设备上线」那批脚本全部跑一遍，而设备明明一直在线
      autoBooted = true;
      setLastOnline(dev.online);
      return;
    }
    if (!store.enabled) {
      setLastOnline(dev.online);
      return;
    }
    const now = new Date();
    for (const s of store.scripts) {
      const key = dueDaily(s, now);
      if (!key) continue;
      /// 先落 firedKey 再跑：脚本跑到一半服务被重启，也不该在同一分钟里再来一次
      markFired(s.id, key);
      const by = `定时 ${s.trigger.at}`;
      if (!dev.adb) {
        recordSkip(s, `设备不在线（上次 ${profile.ip || '无记录'}），这次定时跳过`, by);
        continue;
      }
      startRun(dev.adb, profile, s, by);
    }
    /// 上线触发只看上升沿：一直在线不会反复跑，掉线再回来才是新的一次
    if (dev.online && !store.lastOnline && dev.adb) {
      for (const s of store.scripts) {
        if (!s.enabled || s.trigger.kind !== 'connect') continue;
        startRun(dev.adb, profile, s, '设备上线');
      }
    }
    setLastOnline(dev.online);
  } catch {
    /* 引擎出错不能把整个服务带崩，下一轮继续 */
  } finally {
    autoTicking = false;
  }
}

/// 引擎自己不该拖住进程退出（unref），服务的生命周期还是由 listen 决定
setInterval(() => void automationTick(), AUTO_TICK_MS).unref();
setTimeout(() => void automationTick(), 3000).unref();

/// ---- 接口续温 ----
/// 页面常驻时会轮询 state / health / processes，而它们的缓存分别只有 3 / 5 / 4 秒。
/// 没有续温时，用户隔十几秒回来点页面，三条读数全过期，只能一起重新等 adb。
/// 这里每 10 秒把这三条读数「摸」一遍：readMemo 命中新鲜缓存就直接返回，
/// 过期了就借这个后台调用触发真读，用户再点页面时命中的总是新鲜结果。
let warming = false;
setInterval(() => {
  if (warming) return;
  warming = true;
  void (async () => {
    try {
      const profile = loadProfile();
      const dev = deviceFor(profile);
      if (!dev.online || !dev.adb) return;
      const adb = dev.adb;
      const serial = adb.serial;
      await Promise.allSettled([
        readMemo(`${serial}|/api/state|`, 3, () => statePayload(profile, true, adb)),
        readMemo(`${serial}|/api/health|`, 5, () => deviceHealth(adb)),
        readMemo(`${serial}|/api/processes|`, 4, () => processesPayload(adb)),
      ]);
    } catch {
      /* 续温只是加速读数，任何失败都不该影响服务；下一次循环继续 */
    } finally {
      warming = false;
    }
  })();
}, 10000).unref();

/// 慢档续温：apps / device / caps / startup / home / launchables / autostart 这几条
/// ttl 都是 15 秒，而 readMemo 的「过期还回旧值」窗口只有 5 分钟。页面挂着不动超过
/// 5 分钟（或者人走开了再回来），这几条就彻底没有旧值可用，点进去必然冷读，
/// 实测 startup 冷读 560ms、caps 100ms 出头，是最容易被感知到的卡顿。
/// 快档只摸 3 条高频读数，覆盖不到它们，所以单独一档 25 秒的慢循环。
/// 这一档刻意不含 /api/picture：那个读数背后是一次截屏，后台反复截屏会和用户
/// 操作抢同一台 adb，反而更慢；前端也没有 GET 调用方。
/// 和快档各用一个标志位互不阻塞，两轮撞上时也只是排队，不会互相打断。
let warmingSlow = false;
setInterval(() => {
  if (warmingSlow) return;
  warmingSlow = true;
  void (async () => {
    try {
      const profile = loadProfile();
      const dev = deviceFor(profile);
      if (!dev.online || !dev.adb) return;
      const adb = dev.adb;
      const serial = adb.serial;
      await Promise.allSettled([
        readMemo(`${serial}|/api/apps|`, 15, () => appInventory(adb, profile)),
        readMemo(`${serial}|/api/device|`, 15, () => deviceInfo(adb, profile)),
        readMemo(`${serial}|/api/system/caps|`, 15, () => capabilities(adb, false)),
        readMemo(`${serial}|/api/system/startup|`, 15, () => startupItems(adb, profile)),
        readMemo(`${serial}|/api/system/home|`, 6, () => homeState(adb, profile)),
        readMemo(`${serial}|/api/system/launchables|`, 15, () => launchables(adb, profile)),
        readMemo(`${serial}|/api/system/autostart|`, 15, () => autostartState(adb)),
      ]);
    } catch {
      /* 同上：这一档只是让读数保持新鲜，出错就等下一轮 */
    } finally {
      warmingSlow = false;
    }
  })();
}, 25000).unref();
