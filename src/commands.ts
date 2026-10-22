import { Adb, connectAsync, connectedDevicesAsync, disconnectAsync, type ShellOut } from './adb.ts';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp as dialLaunch } from './dial.ts';
import {
  EvdevInjector,
  KL_NAMES,
  type InputPath,
  type MousePath,
  discoverMouse,
  REL_CODES,
  EV_SYN,
  EV_REL,
  EV_KEY,
  frame,
  pressFrame,
} from './input.ts';
import { type DeviceProfile, type TvApp } from './profile.ts';
import { appInventory, launchPackage } from './manage.ts';
import { synonymTerms } from './names.ts';

export const KEYS: Record<string, number> = {
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  ok: 23,
  back: 4,
  home: 3,
  menu: 82,
  info: 165,
  guide: 8,
  apps: 219,
  power: 26,
  sleep: 223,
  wake: 767,
  volUp: 24,
  volDown: 25,
  mute: 164,
  chUp: 166,
  chDown: 167,
  play: 126,
  pause: 85,
  playPause: 127,
  prev: 88,
  next: 87,
  stop: 86,
  record: 191,
  red: 184,
  green: 185,
  yellow: 186,
  blue: 187,
  caption: 175,
  settings: 176,
  tv: 378,
  tvInput: 178,
  assist: 219,
  mic: 226,
};

/// 标准 KEYCODE_WAKEUP。KEYS.wake（767）是部分设备认的厂商唤醒键，
/// 模拟器 / 手机 / 机顶盒只认标准值，所以唤醒时两个都发，谁把 mWakefulness 变成 Awake 算谁
const STD_WAKE_KEY = 224;

export interface ActionResult {
  ok: boolean;
  command: string;
  detail: string;
  verified?: boolean;
  levels?: { stream: string; level: number; max: number }[];
}

const FAIL_RE = /Error|Exception|INACTIVE|not found|Unknown|requires root|No shell command implementation/i;

const run = (adb: Adb, command: string, ms = 20000) => {
  const r = adb.shell(command, ms);
  return {
    ok: r.code === 0 && !FAIL_RE.test(r.stderr + r.stdout),
    command,
    detail: (r.stdout + r.stderr).trim().slice(0, 400),
  };
};

/// run 的异步版：同样判定，但不占用事件循环
const runAsync = async (adb: Adb, command: string, ms = 20000) => {
  const r = await adb.shellAsync(command, ms).catch((e: Error) => ({ stdout: '', stderr: String(e?.message || e), code: 1 }));
  return {
    ok: r.code === 0 && !FAIL_RE.test(r.stderr + r.stdout),
    command,
    detail: (r.stdout + r.stderr).trim().slice(0, 400),
  };
};

/// 每台设备只做一次 evdev 探测（dumpsys input + keylayout 解析），之后按键走常驻 shell
const injectors = new Map<string, { inj: EvdevInjector; path: Promise<InputPath> }>();

export function injectorFor(adb: Adb) {
  let e = injectors.get(adb.serial);
  if (!e) {
    const inj = new EvdevInjector(adb);
    e = { inj, path: inj.discover() };
    injectors.set(adb.serial, e);
  }
  return e;
}

export async function inputPathOf(adb: Adb): Promise<InputPath> {
  return injectorFor(adb).path;
}

/// 键名归一化：去掉 KEYCODE_ 前缀、下划线、空格、连字符，再转小写。
/// 这样 home / HOME / Keycode_HOME / KEYCODE_HOME 是同一个东西
const normKey = (k: string) =>
  k.replace(/^KEYCODE_/i, '').replace(/[\s_\-]/g, '').toLowerCase();

/// 语义键名表 + keylayout 键名反查表，都按归一化名索引。
/// 页面和键盘只认 KEYS 里的 camelCase（volUp / playPause），但自动化脚本存的是
/// 用户手打的字符串，未来跨平台客户端更可能直接发 Android 标准的 KEYCODE_*。
/// 以前这些一律报「未知按键」，等于脚本里写个 HOME 就整条静默失败
const BY_NORM: Record<string, string> = {};
for (const name of Object.keys(KEYS)) BY_NORM[normKey(name)] = name;
for (const [action, klNames] of Object.entries(KL_NAMES)) {
  for (const kl of klNames) {
    const n = normKey(kl);
    if (!BY_NORM[n]) BY_NORM[n] = action;
  }
}

/// 归一化后的键名；认不出来返回空串
export function resolveKey(key: string | number): string {
  if (typeof key === 'number') return Object.keys(KL_NAMES).find((k) => KEYS[k] === key) ?? '';
  const exact = KEYS[key] !== undefined ? key : '';
  if (exact) return exact;
  return BY_NORM[normKey(String(key))] ?? '';
}

export async function pressKey(adb: Adb, key: string | number, longPress = false): Promise<ActionResult> {
  const action = resolveKey(key);
  const code = typeof key === 'number' ? key : KEYS[action];
  if (code === undefined) {
    return { ok: false, command: `keyevent ${key}`, detail: `未知按键 ${key}（可用：${Object.keys(KEYS).join(' / ')}）` };
  }
  const entry = injectorFor(adb);
  const path = await entry.path;
  const target = path.keys[action];
  if (target && entry.inj.press(target, path.recordSize, longPress ? 700 : 0)) {
    return {
      ok: true,
      command: `evdev ${target.device} ${target.name}=${target.scan}`,
      /// 每次按键都会弹这条提示，所以只说人话：设备路径、keyevent 这类细节留在 command 里，
      /// 需要排查时在诊断面板看
      detail: `${longPress ? '长按' : '按下'} ${action}（直写输入设备，响应更快）`,
    };
  }
  const r = await adb.shellAsync(`input keyevent ${code}${longPress ? ' --longpress' : ''}`, 10000);
  /// 这台设备本来就没有可直写的按键设备时，系统按键通道就是它的正常通路，不是「退而求其次」。
  /// 以前每次按键都打「回退 keyevent：keylayout 里没有 xxx 对应的键名」，
  /// 用户看到的是「明明成功了却在报故障」。只有直写通道确实掉了才值得提一句
  const why = target ? '（直写通道此刻不可用，改走系统按键）' : '';
  return {
    ok: r.code === 0 && !FAIL_RE.test(r.stderr + r.stdout),
    command: `input keyevent ${code}`,
    detail: `${r.detail || '已发送'}${why}`,
  };
}

/// 音量写入候选：各品牌/安卓版本认的不一样，而且退出码不可信 ——
/// Android 8 上 `cmd media_session volume --set` 打印 "No shell command implementation" 仍返回 0，
/// 所以每条候选都以回读到的实际音量论成败（滑杆"不起作用"就是这么来的）。
const VOLUME_SETTERS: { name: string; cmd: string }[] = [
  { name: 'media volume', cmd: 'media volume --stream 3 --set {n}' },
  { name: 'cmd media_session', cmd: 'cmd media_session volume --stream 3 --set {n}' },
  { name: 'audio binder', cmd: 'service call audio 8 i32 3 i32 {n} i32 0' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// 拖动滑杆会连着发多次，串行执行避免两条步进互相拉扯
let volumeChain: Promise<unknown> = Promise.resolve();

const musicRow = (rows: { stream: string; level: number; max: number }[]) =>
  rows.find((v) => v.stream === 'STREAM_MUSIC');

async function readMusic(adb: Adb, target: number, tries = 3) {
  let rows: { stream: string; level: number; max: number }[] = [];
  for (let i = 0; i < tries; i++) {
    rows = await volumeReadoutAsync(adb);
    const m = musicRow(rows);
    if (m && m.level === target) return { rows, level: m.level };
    if (i < tries - 1) await sleep(140);
  }
  return { rows, level: musicRow(rows)?.level ?? -1 };
}

export function setVolume(adb: Adb, level: number, tries = 3): Promise<ActionResult> {
  const apply = async (): Promise<ActionResult> => {
    // level 一律按「这台设备的音量档」理解（页面滑杆的 max 就是设备档数）。
    // 超出设备上限时先收敛到上限，否则请求一个永远达不到的值，回读必然失败，
    // 看起来像是滑杆坏了。
    const probe = musicRow(await volumeReadoutAsync(adb));
    const cap = probe && probe.max > 0 ? probe.max : 100;
    const target = Math.max(0, Math.min(cap, Math.round(level)));
    const clamped = target !== Math.round(level) ? `（上限 ${cap} 档）` : '';
    for (const s of VOLUME_SETTERS) {
      const cmd = s.cmd.replaceAll('{n}', String(target));
      const r = await adb.shellAsync(cmd, 12000);
      if (r.code !== 0 || FAIL_RE.test(r.stdout + r.stderr)) continue;
      const got = await readMusic(adb, target, tries);
      if (got.level === target) {
        return { ok: true, command: cmd, verified: true, levels: got.rows, detail: `音量 ${target}/${cap}${clamped}（${s.name} 已回读确认）` };
      }
      // 拖动中的软请求只要发出就够了，最终值由松手那次确认
      if (tries === 1) {
        return { ok: true, command: cmd, verified: false, levels: got.rows, detail: `设为 ${target}/${cap}，回读 ${got.level}` };
      }
    }
    // 都写不进就用音量键步进，目标值仍然由回读判定
    const cur = await volumeReadoutAsync(adb);
    const m = musicRow(cur);
    if (!m) return { ok: false, command: `volume ${target}`, detail: '读不到 STREAM_MUSIC，无法设置音量' };
    const step = target > m.level ? 'volUp' : 'volDown';
    const times = Math.min(Math.abs(target - m.level), m.max, 40);
    for (let i = 0; i < times; i++) await pressKey(adb, step);
    const got = await readMusic(adb, target, 2);
    // 步进兜底也可能停在半路（设备按键丢帧、已经到顶），说法要区分开：
    // 「到顶了」和「命令没被接受」是两件完全不同的事
    const atCap = target >= cap && got.level >= cap;
    return {
      ok: got.level === target || atCap,
      command: `${times}× keyevent ${KEYS[step]}（步进兜底）`,
      verified: got.level === target || atCap,
      levels: got.rows,
      detail: atCap
        ? `音量已到最大 ${got.level}/${cap}`
        : got.level === target
        ? `音量 ${target}/${cap}（按键步进 ${times} 次）`
        : `目标 ${target}/${cap}，实际 ${got.level} · 直写命令均未被设备接受`,
    };
  };
  const next = volumeChain.then(apply, apply);
  volumeChain = next.catch(() => undefined);
  return next;
}

/// 脚本里的音量步骤用百分比表达（0-100），因为写脚本的人记不住这台设备有几档。
/// 这里负责按设备实际档数换算，换算后的值再走 setVolume 的回读确认。
export async function setVolumePercent(adb: Adb, percent: number): Promise<ActionResult> {
  const m = musicRow(await volumeReadoutAsync(adb));
  const cap = m && m.max > 0 ? m.max : 100;
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const r = await setVolume(adb, Math.round((p / 100) * cap));
  return { ...r, detail: `${r.detail}（按 ${p}% / 上限 ${cap} 档换算）` };
}

export async function volumeStep(adb: Adb, dir: 'up' | 'down' | 'mute'): Promise<ActionResult> {
  const key = dir === 'up' ? 'volUp' : dir === 'down' ? 'volDown' : 'mute';
  const before = musicRow(await volumeReadoutAsync(adb))?.level ?? -1;
  const r = await pressKey(adb, key);
  await sleep(160);
  const rows = await volumeReadoutAsync(adb);
  const m = musicRow(rows);
  const after = m?.level ?? -1;
  return {
    ...r,
    verified: m ? after !== before || dir === 'mute' : false,
    levels: rows,
    detail: m ? `音量 ${after}/${m.max}` : r.detail,
  };
}

export async function volumeReadoutAsync(adb: Adb) {
  return parseVolume((await adb.dumpsysAsync('audio')).stdout);
}

function parseVolume(dump: string): { stream: string; level: number; max: number }[] {
  const rows: { stream: string; level: number; max: number }[] = [];
  for (const block of dump.split(/-\s+STREAM_/).slice(1)) {
    const stream = block.match(/^([A-Z_]+)/)?.[1] ?? '';
    const max = Number(block.match(/Max:\s*(\d+)/)?.[1] ?? 0);
    const level = Number(block.match(/Current:\s*\d+[^:]*:\s*(\d+)/)?.[1] ?? block.match(/Current:.*?(\d+)/)?.[1] ?? 0);
    const muted = /Muted:\s*true/.test(block);
    if (stream && max) rows.push({ stream: `STREAM_${stream}`, level: muted ? 0 : level, max });
  }
  return rows;
}

/// 鼠标/触控板通路（每台设备单独缓存注入器 + 一次探测结果）。
/// 注入器和能力必须成对：能力（device/recordSize/buttons）来自 discoverMouse，
/// 实际写入靠 EvdevInjector 的常驻 shell。二者分开缓存会出现「探到设备却写不进去」。
const mouseEntries = new Map<string, { inj: EvdevInjector; path: Promise<MousePath> }>();

function mouseEntry(adb: Adb) {
  let e = mouseEntries.get(adb.serial);
  if (!e) {
    const inj = new EvdevInjector(adb);
    e = { inj, path: discoverMouse(adb) };
    mouseEntries.set(adb.serial, e);
  }
  return e;
}

export async function mousePathOf(adb: Adb): Promise<MousePath> {
  return mouseEntry(adb).path;
}

export function volumeReadout(adb: Adb): { stream: string; level: number; max: number }[] {
  return parseVolume(adb.dumpsys('audio').stdout);
}


/// 启动的统一出口。monkey 的 stdout 是一大串 `bash arg:` 回显，以前直接当成
/// detail 返回，用户点成功却看到一堆命令噪音；现在一律走 manage.launchPackage，
/// 它用进程表回读确认，文案也是人话。
async function launchByPackage(adb: Adb, pkg: string): Promise<ActionResult> {
  return launchPackage(adb, pkg);
}

export async function launchComponent(adb: Adb, app: TvApp): Promise<ActionResult> {
  const who = app.name || app.label || app.package;
  const direct = run(adb, `am start -n ${app.component}`);
  if (direct.ok) return { ok: true, command: `am start -n ${app.component}`, detail: `已启动 ${who}` };
  return launchByPackage(adb, app.package);
}

/// 档案里的 apps 只有探测时抓到的那几个，设备上大量预装应用不在里面，
/// 按名字启动就会「找不到」。这里补一次实时清单查询，并按 serial 缓存一小会儿，
/// 让批量脚本连续启动多个应用时不用每次都重新扫包。
type LaunchRow = { pkg: string; label: string; launchable: boolean; system: boolean };
/// known: 这台设备支持查启动入口（见 Inventory.launchKnown）
const inventoryMemo = new Map<string, { at: number; rows: LaunchRow[]; known: boolean }>();

async function liveApps(adb: Adb, profile: DeviceProfile) {
  const hit = inventoryMemo.get(adb.serial);
  if (hit && Date.now() - hit.at < 20000) return hit;
  try {
    const inv = await appInventory(adb, profile);
    const rows: LaunchRow[] = inv.rows.map((r) => ({
      pkg: r.pkg,
      label: r.label,
      launchable: r.launchable,
      system: r.system,
    }));
    const memo = { at: Date.now(), rows, known: inv.launchKnown };
    inventoryMemo.set(adb.serial, memo);
    return memo;
  } catch {
    /// 清单读不出来时给「未知」，让调用方退回逐个试启动，不要凭空清单下结论
    return { at: 0, rows: [] as LaunchRow[], known: false };
  }
}

/// 匹配按「精确 → 前缀 → 包含」三级打分，同名多包时优先有启动入口的那个
/// （Settings 既是 com.android.tv.settings 也是 com.android.providers.settings）。
/// 清单里的 named 是「解析来源」（APK 解析 / 包名（未解析）），不是应用名，不参与匹配。
function findInApps(rows: LaunchRow[], lower: string, want: string): { hit?: LaunchRow; options: LaunchRow[] } {
  /// 两边都去掉空格再比：清单里的 label 常带空格（Android TV Home），
  /// 用户手打时空格最容易多一个少一个
  const flat = (s: string) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
  const q = flat(lower);
  const terms = [q, ...synonymTerms(want)].filter(Boolean);
  const score = (r: LaunchRow) => {
    const label = flat(r.label);
    /// 包名按「点」切段后逐段比，不能整串 includes：
    /// 「multidisplay」里含 play、「backuprestore」里含 store，
    /// 整串比会让这些框架包排在真正的应用前面
    const segs = flat(r.pkg).split('.');
    let best = 0;
    for (const t of terms) {
      if (!t) continue;
      if (label === t) best = Math.max(best, 5);
      else if (r.pkg === want) best = Math.max(best, 4);
      else if (t.length >= 3 && label.startsWith(t)) best = Math.max(best, 3);
      else if (t.length >= 3 && label.includes(t)) best = Math.max(best, 2);
      else if (t.length >= 3 && segs.some((x) => x === t || x.startsWith(t))) best = Math.max(best, 1);
    }
    return best;
  };
  const scored = rows
    .map((r) => ({ r, s: score(r) }))
    .filter((x) => x.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        Number(b.r.launchable) - Number(a.r.launchable) ||
        Number(a.r.system) - Number(b.r.system) ||
        a.r.label.length - b.r.label.length,
    );
  /// 只有「名字本身对得上」（精确 / 前缀 / 包含）才直接启动。仅凭包名某一段像，
  /// 比如输 media 命中一堆 com.android.media.* 框架包，启动了也不是用户要的，
  /// 这种情况退回来给出相近名单让用户挑
  const strong = (scored[0]?.s ?? 0) >= 2 ? scored[0].r : undefined;
  return { hit: strong, options: scored.slice(0, 5).map((x) => x.r) };
}

export async function launchNamed(adb: Adb, profile: DeviceProfile, name: string): Promise<ActionResult> {
  const want = name.trim();
  if (!want) return { ok: false, command: 'launch', detail: '没有要启动的应用名' };
  const lower = want.toLowerCase();
  const app =
    profile.apps.find((a) => a.component === want || a.package === want || a.label === want) ??
    /// 档案里的 label 有些其实是包名，用户手打时大小写也容易错，兜一次不区分大小写
    profile.apps.find(
      (a) =>
        a.component.toLowerCase() === lower ||
        a.package.toLowerCase() === lower ||
        (a.label ?? '').toLowerCase() === lower ||
        (a.name ?? '').toLowerCase() === lower,
    );
  if (app) return launchComponent(adb, app);
  /// 档案没命中就先查设备上的实时清单，绝大多数「按名字启动」应该在这一步成功
  const inv = await liveApps(adb, profile);
  const { hit, options } = findInApps(inv.rows, lower, want);
  if (hit) {
    /// 清单早就知道这个包没有任何启动入口（Media、Providers 这类）。
    /// 直接说明白，不用再发三轮 monkey 才知道失败，也省掉一次跨进程等待。
    /// 前提是这台设备支持查启动入口，否则 launchable 全是 false，
    /// 拿它拒绝会让所有按名字启动都失败
    if (inv.known && !hit.launchable) {
      return {
        ok: false,
        command: `launch ${hit.pkg}`,
        detail: `「${hit.label}」没有可启动入口（系统组件），只能在设备上点图标打开`,
      };
    }
    return launchByPackage(adb, hit.pkg);
  }
  if (profile.dialApps.includes(want) && profile.ip) {
    const r = await dialLaunch(profile.ip, want).catch((e: Error) => null);
    const res = { ok: !!r && r.status < 300, command: `DIAL POST /apps/${name}`, detail: `HTTP ${r?.status ?? 'n/a'}` };
    if (res.ok) return res;
  }
  /// 只有带点号的才当包名直接试。以前「Home」「Play」这类单词也被塞给 monkey，
  /// 设备回一句没装，页面就报「设备上没装这个应用」，用户以为真的没装
  if (/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(want)) {
    return launchByPackage(adb, want);
  }
  const near = options.length ? `，相近的有：${options.map((r) => r.label).join(' / ')}` : '';
  return {
    ok: false,
    command: `launch ${want}`,
    detail: `设备上找不到「${want}」${near}。可以在应用列表里点它的名字，或者填完整包名`,
  };
}

/// 护眼（夜间模式）两条通路，按设备实际有的走：
///   1. 厂商 binder（康佳实测：KonkaNightDisplayService 用全屏琥珀遮罩实现，
///      service call konka_night_display，状态同步到 secure/night_display_activated）
///   2. AOSP 标准：color_display 服务 + settings secure/night_display_activated
/// 关键点：光写 settings 不算成功 —— 没有 color_display 服务的设备上
/// 这个键写进去也没人读，界面不会有任何变化。必须查服务可用性。
const NIGHT_RGB = 0xff6f00;

function nightArgb(level: number): number {
  const alpha = Math.max(1, Math.min(127, Math.round(level * 2.5)));
  return (alpha << 24) | NIGHT_RGB;
}

export interface NightSupport {
  supported: boolean;
  /// vendor = 厂商 binder；aosp = 标准 color_display；none = 这台设备没有护眼
  path: 'vendor' | 'aosp' | 'none';
  detail: string;
}

/// 探测护眼能不能真的生效。只看服务，不看厂商名。
/// 这条要跑 service list + dumpsys color_display 两条 shell，而且都是同步 spawn，
/// 而 /api/state 每轮都要它。通路本身是硬件/固件事实，不会中途变，缓存 60 秒足够；
/// 真正要切护眼前夜 nightControl 会用 fresh=true 再探一次，不拿旧结论去写设置。
const nightSupCache = new Map<string, { at: number; sup: NightSupport }>();

export function nightSupport(adb: Adb, fresh = false): NightSupport {
  const hit = nightSupCache.get(adb.serial);
  if (!fresh && hit && Date.now() - hit.at < 60000) return hit.sup;
  const sup = probeNightSupport(adb);
  nightSupCache.set(adb.serial, { at: Date.now(), sup });
  return sup;
}

function probeNightSupport(adb: Adb): NightSupport {
  const svc = adb.shell('service list', 20000).stdout;
  if (/konka_night_display/.test(svc)) {
    return { supported: true, path: 'vendor', detail: '厂商护眼服务（遮罩实现）' };
  }
  const dump = adb.shell('dumpsys color_display', 20000).stdout;
  if (!dump || /Can't find service/i.test(dump)) {
    return { supported: false, path: 'none', detail: '设备没有系统护眼服务，开不了' };
  }
  /// AOSP 不支持时这一行下面写的是 "Not available"；支持时跟着完整状态
  const m = dump.match(/Night display:\s*\n\s*(.+)/);
  const line = m?.[1]?.trim() ?? '';
  if (!line || /not available/i.test(line)) {
    return { supported: false, path: 'none', detail: '设备没有夜灯硬件，开不了' };
  }
  return { supported: true, path: 'aosp', detail: '系统标准夜灯' };
}

export function nightStatus(adb: Adb): { activated: boolean; detail: string } {
  const read = adb.shell('settings get secure night_display_activated').stdout.trim();
  return { activated: read === '1', detail: `护眼开关 ${read === '1' ? '已开' : '已关'}` };
}

/// 遮罩 View 常驻（关闭时动画成全透明），窗口挂载只作为切换证据
const maskWindowUp = (adb: Adb): boolean => /ty=2006/.test(adb.shell('dumpsys window windows', 30000).stdout);

export function nightControl(adb: Adb, action: 'on' | 'off' | 'level', level = ''): ActionResult {
  const sup = nightSupport(adb, true);
  /// 不支持就直说，不要写一个没人读的 settings 键然后回读说"已开"——
  /// 用户会盯着毫无变化的屏幕以为软件坏了
  if (!sup.supported) {
    return {
      ok: false,
      verified: false,
      command: '护眼探测',
      detail: `${sup.detail}。护眼需要夜灯或厂商护眼服务，设备没有可用通路`,
    };
  }

  if (sup.path === 'vendor' && action === 'level') {
    const argb = nightArgb(Number(level) || 12);
    const r = run(adb, `service call konka_night_display 3 i32 ${argb}`);
    return { ...r, verified: nightStatus(adb).activated, detail: `遮罩 0x${(argb >>> 0).toString(16).padStart(8, '0')} alpha=${argb >>> 24} · ${nightStatus(adb).detail}` };
  }

  const want = action === 'off' ? '0' : '1';
  const command = `settings put secure night_display_activated ${want}`;
  adb.shell(command);
  const st = nightStatus(adb);
  const ok = st.activated === (want === '1');
  return {
    ok,
    command,
    verified: ok,
    detail: ok
      ? `${action === 'off' ? '护眼已关' : '护眼已开'} · ${st.detail} · ${sup.detail}${sup.path === 'vendor' ? ` · 遮罩窗口${maskWindowUp(adb) ? '已挂载' : '未挂载'}` : ''}`
      : `回读失败 · ${st.detail}`,
  };
}

/// 待机/唤醒单独建模：这两种状态里设备的 Wi-Fi 会掉，普通按键路径不适用
export interface PowerResult extends ActionResult {
  waitedMs?: number;
  steps?: string[];
}

async function wakefulnessOf(adb: Adb): Promise<string> {
  const r = await adb.shellAsync('dumpsys power | grep -m1 mWakefulness', 20000);
  return /mWakefulness=(\w+)/.exec(r.stdout)?.[1] ?? '';
}

/// dumpsys 的电源状态是英文枚举，页面上不能直接甩给用户看
const WAKE_CN: Record<string, string> = {
  Awake: '亮屏',
  Asleep: '息屏',
  Dozing: '浅休眠',
  Doze: '浅休眠',
};
function wakeCn(v: string): string {
  return v ? WAKE_CN[v] ?? v : '未知';
}

/// 熄屏 / 休眠：确认醒着才发电源键。键一发 adb 可能立刻掉线，返回码不可信，
/// 所以随后两边一起看：掉线算熄屏，回读 mWakefulness 变成非 Awake 也算熄屏，谁先给结论就停。
/// 模拟器 / 手机 / 部分盒子熄屏后 adb 照样连着，只看掉没掉线会误报「没熄屏」
export async function sleepTv(adb: Adb): Promise<PowerResult> {
  const before = await wakefulnessOf(adb);
  if (before && before !== 'Awake') {
    return { ok: false, verified: false, command: '发送电源键', detail: `设备现在是「${wakeCn(before)}」，本来就没在亮屏` };
  }
  await adb.shellAsync(`input keyevent ${KEYS.power}`, 20000);
  let after = '';
  let stillState = '';
  let gone = false;
  for (let i = 0; i < 6; i++) {
    await sleep(700);
    const still = (await connectedDevicesAsync()).find((d) => d.serial === adb.serial);
    stillState = still?.state ?? '';
    gone = !still || still.state !== 'device';
    if (gone) break;
    after = await wakefulnessOf(adb);
    if (after && after !== 'Awake') break;
  }
  const asleep = !!after && after !== 'Awake';
  if (!gone && !asleep) {
    return {
      ok: false,
      verified: false,
      command: `input keyevent ${KEYS.power}`,
      detail: `调试连接还在线，电源状态回读也还是「${wakeCn(after || before)}」，电源状态仍为亮屏`,
    };
  }
  return {
    ok: true,
    verified: true,
    command: `input keyevent ${KEYS.power}`,
    detail: asleep
      ? `已发送电源键：电源 ${wakeCn(before)} → ${wakeCn(after)}${gone ? `，${stillState === 'offline' ? '调试连接离线' : '调试连接已断开'}` : '，调试连接还在线'}`
      : `已发送电源键，设备进入熄屏或休眠：${stillState === 'offline' ? '调试连接离线' : '调试连接已断开'}。设备休眠时可能断网，需按机身键或手动唤醒`,
  };
}

/// 唤醒：待机后 adb 可能先掉线，得反复 connect 等它回来；连上再发唤醒键，回读 mWakefulness 才算数。
/// 唤醒键按设备而异：767 是部分设备的厂商键，模拟器 / 手机 / 盒子只认标准 KEYCODE_WAKEUP，所以两个都试
export async function wakeTv(ip: string, preferSerial = '', budgetMs = 25000): Promise<PowerResult> {
  const t0 = Date.now();
  const steps: string[] = [];
  /// 没有 IP 就没有「等网络回来后 adb connect」这条路（模拟器 / USB 设备待机后 adb 也不掉线），
  /// 只在 adb 列表里短等几秒，等不到就如实说明缺什么
  const hasIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
  const budget = hasIp ? budgetMs : Math.min(budgetMs, 6000);
  let adb: Adb | null = null;
  for (;;) {
    const devs = await connectedDevicesAsync();
    const online = devs.filter((d) => d.state === 'device');
    /// 点名优先：认 serial，再认 IP。最后那条「随便挑一台」只在只有一台设备时成立，
    /// 同时挂着多台设备时，把另一台唤醒是错误行为
    const hit =
      online.find((d) => d.serial === preferSerial) ??
      online.find((d) => d.serial.startsWith(`${ip}:`)) ??
      (online.length === 1 ? online[0] : undefined);
    if (hit) {
      adb = new Adb(hit.serial);
      break;
    }
    if (online.length > 1 && Date.now() - t0 >= budget) {
      return {
        ok: false,
        verified: false,
        command: `等 ${preferSerial || ip || '设备'} 上线`,
        detail: `当前连着 ${online.length} 台（${online.map((d) => d.serial).join('、')}），没有点名要唤醒的那台。为避免误唤醒，这次没发唤醒键`,
        waitedMs: Date.now() - t0,
        steps,
      };
    }
    if (Date.now() - t0 >= budget) break;
    // 待机留下的 offline 条目会挡住重新握手，得先摘掉
    const stale = devs.filter((d) => d.state !== 'device' && (d.serial === preferSerial || d.serial.startsWith(`${ip}:`)));
    for (const d of stale) {
      await disconnectAsync(d.serial);
      steps.push(`${((Date.now() - t0) / 1000).toFixed(1)}s 摘掉 ${d.serial}（${d.state}）`);
    }
    if (!hasIp) {
      await sleep(700);
      continue;
    }
    const c = await connectAsync(ip, 5555, 8000);
    const raw = [c.stdout, c.stderr].join(' ').trim().replace(/\s+/g, ' ');
    steps.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${raw.slice(0, 70) || 'adb 无输出'}`);
    await sleep(700);
  }
  const waitedMs = Date.now() - t0;
  const waited = `${(waitedMs / 1000).toFixed(1)} 秒`;
  /// 设备根本没掉线时（模拟器 / USB），「等了 0.0 秒回来」是噪音
  const waitedNote = waitedMs > 1500 ? `等了 ${waited}才连上，` : '';
  if (!adb) {
    return {
      ok: false,
      verified: false,
      command: hasIp
        ? `等 ${ip}:5555 上线（预算 ${Math.round(budget / 1000)} 秒）`
        : `等 ${preferSerial || '设备'} 回到 adb 列表（预算 ${Math.round(budget / 1000)} 秒）`,
      detail: hasIp
        ? `等了 ${waited}，设备网络没回来。休眠后断网的机型先手动唤醒设备，亮屏后这里点一次连回`
        : `等了 ${waited}，列表里没有这台（${preferSerial || '未知'}）。没有可用 IP 时唤醒走不了：请先重新连接`,
      waitedMs,
      steps,
    };
  }
  const before = await wakefulnessOf(adb);
  if (before === 'Awake') {
    return {
      ok: true,
      verified: true,
      command: hasIp ? `adb connect ${ip}:5555` : `adb ${adb.serial}`,
      detail: `${waitedNote}设备已经是亮屏状态，不用发唤醒键`,
      waitedMs,
      steps,
    };
  }
  let after = before;
  const sentKeys: number[] = [];
  for (const key of [KEYS.wake, STD_WAKE_KEY]) {
    await adb.shellAsync(`input keyevent ${key}`, 15000);
    sentKeys.push(key);
    await sleep(900);
    after = await wakefulnessOf(adb);
    if (after === 'Awake') break;
  }
  const ok = after === 'Awake';
  const cmdKeys = sentKeys.map((k) => `input keyevent ${k}`).join(' → ');
  return {
    ok,
    verified: ok,
    command: `${hasIp ? `adb 回来（${waited}）` : `adb ${adb.serial}`} + ${cmdKeys}`,
    detail:
      ok
        ? `已唤醒：电源状态 ${wakeCn(before)} → 亮屏（${waitedNote}${sentKeys[sentKeys.length - 1]} 生效）`
        : `调试连接已恢复，但电源仍是「${wakeCn(after)}」：唤醒键都没起作用，需要先按设备机身键唤醒或开机`,
    waitedMs,
    steps,
  };
}

export interface ScreenTimeRow {
  package: string;
  minutes: number;
}

/// Android 8 等旧机型 --checkin 不输出事件，文本 dump 的 daily 块直接给出 totalTime
function dailyTotals(dump: string): {
  range: string;
  totals: Map<string, number>;
  events: { time: Date; type: string; package: string }[];
} {
  const lines = dump.split('\n');
  const start = lines.findIndex((l) => /daily stats/i.test(l));
  const totals = new Map<string, number>();
  const events: { time: Date; type: string; package: string }[] = [];
  if (start < 0) return { range: '', totals, events };
  let range = '';
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/weekly|monthly|yearly/i.test(l)) break;
    if (!range) range = l.match(/timeRange="([^"]+)"/)?.[1] ?? '';
    const m = l.match(/package=(\S+)\s+totalTime="([^"]+)"/);
    if (m) totals.set(m[1], durationMs(m[2]));
    // MOVE_TO_FOREGROUND / BACKGROUND 成对出现：两条之间的时长就是这次前台会话
    const ev = l.match(/time="([^"]+)"\s+type=(\S+)\s+package=(\S+)/);
    if (ev) {
      const d = new Date(ev[1].replace(/,/, ''));
      if (!Number.isNaN(d.getTime())) events.push({ time: d, type: ev[2], package: ev[3] });
    }
  }
  return { range, totals, events };
}

function durationMs(text: string): number {
  const parts = text.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  return ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
}

/// 设备给的统计区间是它自己 locale 的形状（"10/19/2026, 12:03 – 8:57 AM"），
/// 月日顺序和 AM/PM 对中文页面没有意义，能认出来就换成「10/19 12:03 至 08:57」，认不出就原样给
/// 设备 locale 是英文时，时间戳会写成「8:57 AM」这种 12 小时制。
/// 中文页面上混 AM/PM 既不像话也没法扫读，统一换成 24 小时
function to24(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M?\.?$/i);
  if (!m) return t;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function cnRange(text: string): string {
  const raw = String(text || '').trim();
  if (!raw) return '（设备未给出区间）';
  const m = raw.match(/^(\d{1,2}\/\d{1,2})\/\d{2,4},\s*(.+)$/);
  if (!m) return raw;
  /// 设备常把 AM/PM 只写在整段末尾：「2:53 – 2:55 PM」。
  /// 先把后缀摘下来给两段共用，再逐段转 24 小时，否则前半段会漏转、中文页里留下 PM
  const tail = m[2].match(/\s*([AP])\.?M?\.?$/i);
  const meridiem = tail ? tail[1].toUpperCase() : '';
  const body = tail ? m[2].slice(0, m[2].length - tail[0].length) : m[2];
  const to24Shared = (x: string): string => {
    const t = x.trim();
    if (/\s*[AP]\.?M?\.?$/i.test(t)) return to24(t);
    return meridiem ? to24(`${t} ${meridiem}M`) : t;
  };
  const parts = body
    .split(/\s*[–—-]\s*/)
    .map(to24Shared)
    .filter(Boolean);
  return parts.length === 2 ? `${m[1]} ${parts[0]}–${parts[1]}` : `${m[1]} ${body.trim()}`;
}

export function screenTime(
  adb: Adb,
  hours = 24,
): { rows: ScreenTimeRow[]; windowHours: number; source: string; hourly?: { hour: number; minutes: number }[] } {
  const checkin = adb.dumpsys('usagestats', '--checkin', 120000).stdout;
  const from = Date.now() - hours * 3600_000;
  const totals = new Map<string, number>();
  const hourly = new Map<number, number>();
  let buckets = 0;
  let end = 0;

  for (const line of checkin.split('\n')) {
    const b = line.match(/beginTime=(\d+)\s+endTime=(\d+)/);
    if (b) {
      end = Number(b[2]);
      if (end >= from) buckets++;
      continue;
    }
    if (end < from) continue;
    const p = line.match(/package=(\S+)\s+totalTime=(\d+)/);
    if (p) {
      totals.set(p[1], (totals.get(p[1]) ?? 0) + Number(p[2]));
      // checkin 的桶本身就不长，归到 endTime 那个小时足够画分布了
      if (end >= from) hourly.set(new Date(end).getHours(), (hourly.get(new Date(end).getHours()) ?? 0) + Number(p[2]));
    }
  }

  const hourlyRows = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    minutes: Math.round((hourly.get(hour) ?? 0) / 60000),
  })).filter((r) => r.minutes > 0);

  const rows = [...totals.entries()]
    .filter(([, ms]) => ms > 30_000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([pkg, ms]) => ({ package: pkg, minutes: Math.round(ms / 60000) }));

  if (rows.length) return { rows, windowHours: hours, source: `dumpsys usagestats --checkin · ${buckets} 个时间桶`, hourly: hourlyRows };

  const daily = dailyTotals(adb.dumpsys('usagestats', '', 120000).stdout);
  const fallback = [...daily.totals.entries()]
    .filter(([, ms]) => ms > 30_000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([pkg, ms]) => ({ package: pkg, minutes: Math.round(ms / 60000) }));

  // Android 8 等没有 --checkin 的机型：用 daily 块里的前台事件对推逐小时分布，
  // 两次 FOREGROUND 之间的时长记到后一条事件的小时上，拿不到就让前端不画这块
  const hourlyEv = new Map<number, number>();
  for (let i = 0; i < daily.events.length - 1; i++) {
    const a = daily.events[i];
    const b = daily.events[i + 1];
    if (a.type !== 'MOVE_TO_FOREGROUND' || b.type !== 'MOVE_TO_BACKGROUND') continue;
    if (a.package !== b.package) continue;
    const ms = Math.min(b.time.getTime() - a.time.getTime(), hours * 3600_000);
    if (ms <= 0 || b.time.getTime() < from) continue;
    const h = b.time.getHours();
    hourlyEv.set(h, (hourlyEv.get(h) ?? 0) + ms);
  }
  const hourlyEvRows = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    minutes: Math.round((hourlyEv.get(hour) ?? 0) / 60000),
  })).filter((r) => r.minutes > 0);

  return {
    rows: fallback,
    windowHours: hours,
    source: fallback.length ? `统计 ${cnRange(daily.range)}` : `统计 ${cnRange(daily.range)} · 无 30 秒以上应用`,
    hourly: hourlyEvRows.length ? hourlyEvRows : undefined,
  };
}

/// 海思 MSP 驱动节点（需要 adb 有 root）：/proc/hisi/msp/pq 直接给出面板画质值
const PQ_KEYS = ['Brightness', 'Contrast', 'Hue', 'Saturation'] as const;

export interface PqState {
  ok: boolean;
  attrs: Partial<Record<(typeof PQ_KEYS)[number], number>>;
  panel: string;
  note: string;
}

/// 这条是 /api/state 里最贵的单项：每轮都要 dd 读两个 /proc/hisi 节点，而且是同步 spawn，
/// 设备不认这些节点时还要把 timeout 跑满。画质值不会几秒一变，缓存 30 秒；
/// 需要真值的地方（用户手点「重新读取」）可以由上层带 fresh 绕开。
const pqCache = new Map<string, { at: number; pq: PqState }>();

export function pqReadout(adb: Adb, fresh = false): PqState {
  const hit = pqCache.get(adb.serial);
  if (!fresh && hit && Date.now() - hit.at < 30000) return hit.pq;
  const pq = readPq(adb);
  pqCache.set(adb.serial, { at: Date.now(), pq });
  return pq;
}

function readPq(adb: Adb): PqState {
  const out: PqState = { ok: false, attrs: {}, panel: '', note: '' };
  const dump = adb.shell('timeout 8 dd if=/proc/hisi/msp/pq bs=512 count=20 2>/dev/null', 20000).stdout;
  if (!dump) {
    out.note = '读不到面板画质参数（需 root，且仅部分平台支持）';
    return out;
  }
  for (const key of PQ_KEYS) {
    const m = dump.match(new RegExp(`${key}\\s*:\\s*(\\d+)`));
    if (m) out.attrs[key] = Number(m[1]);
  }
  out.ok = Object.keys(out.attrs).length > 0;
  out.panel = adb.shell('timeout 6 dd if=/proc/hisi/msp/panel bs=512 count=1 2>/dev/null', 20000).stdout.match(/PanelName\s*:\s*(\S+)/)?.[1] ?? '';
  out.note = out.ok
    ? `面板直读 · 锐度级别 ${dump.match(/SHARP LVL\s*:\s*(\d+)/)?.[1] ?? '未知'}`
    : '面板画质节点没有可读参数';
  return out;
}

/// 画质/显示相关设置的当前值。
/// 以前是 7 次同步 adb.shell 串行跑：一次 150ms，而且 spawnSync 会把整个服务卡住，
/// 期间按键和状态轮询都得排队。现在合成一条 shell 一次拿完，读不到就退回 null，
/// 页面自己决定显示「未知」而不是整块面板转圈。
export async function readPicture(adb: Adb, profile: DeviceProfile) {
  const items = profile.picture ?? [];
  if (!items.length) return [];
  /// 表名/键名来自 profile 配置，仍按白名单字符过滤，避免拼出任意命令
  const safe = (s: string) => /^[A-Za-z0-9_.]+$/.test(String(s ?? ''));
  const parts: string[] = [];
  items.forEach((p, i) => {
    if (!safe(p.table) || !safe(p.key)) return;
    parts.push(`echo @${i}; settings get ${p.table} ${p.key} 2>/dev/null`);
  });
  const live = new Map<number, string>();
  if (parts.length) {
    const r = await adb.shellAsync(parts.join('; '), 20000).catch(() => null);
    let cur = -1;
    for (const line of (r?.stdout ?? '').split('\n')) {
      const m = line.trim().match(/^@(\d+)$/);
      if (m) {
        cur = Number(m[1]);
        live.set(cur, '');
        continue;
      }
      if (cur >= 0) live.set(cur, line.trim());
    }
  }
  /// 读不到给空串，和以前逐条 shell 失败时的结果一致，页面按「未知」处理
  return items.map((p, i) => ({ ...p, live: live.get(i) ?? '' }));
}

export function writePicture(adb: Adb, key: string, table: 'system' | 'secure' | 'global', value: string): ActionResult {
  const w = run(adb, `settings put ${table} ${key} ${JSON.stringify(value)}`);
  if (!w.ok) return w;
  const read = adb.shell(`settings get ${table} ${key}`).stdout.trim();
  return { ...w, verified: read === String(value), detail: `写回 ${read}` };
}

/// 滑杆连发时走异步，避免 spawnSync 卡住整个服务（按键就得排队）
export async function writePictureAsync(
  adb: Adb,
  key: string,
  table: 'system' | 'secure' | 'global',
  value: string,
): Promise<ActionResult> {
  const w = await adb.shellAsync(`settings put ${table} ${key} ${JSON.stringify(value)}`, 10000);
  if (w.code !== 0 || FAIL_RE.test(w.stdout + w.stderr)) {
    return { ok: false, command: `settings put ${table} ${key}`, detail: (w.stdout + w.stderr).trim().slice(0, 200) || '写入失败' };
  }
  const read = (await adb.shellAsync(`settings get ${table} ${key}`, 10000)).stdout.trim();
  return { ok: true, command: `settings put ${table} ${key} ${value}`, verified: read === String(value), detail: `写回 ${read}` };
}

export async function settingValue(adb: Adb, table: 'system' | 'secure' | 'global', key: string): Promise<string> {
  return (await adb.shellAsync(`settings get ${table} ${key}`, 10000)).stdout.trim();
}

export function currentFocus(adb: Adb): string {
  return adb.topActivity();
}

// ---------------------------------------------------------------- 文字输入

/// 设备端能收文字的两种通路。都靠实测探测，不猜厂商、不猜版本：
///   input text —— AOSP 标配，但只吃 ASCII，中文/emoji 会被设备静默丢掉
///   ADBKeyboard 广播 —— 装了这个输入法才能收中文，走 am broadcast
export interface TextPaths {
  input: boolean;
  adbKeyboard: boolean;
}

const textPathCache = new Map<string, { at: number; paths: TextPaths }>();

export async function textPaths(adb: Adb, fresh = false): Promise<TextPaths> {
  const hit = textPathCache.get(adb.serial);
  if (!fresh && hit && Date.now() - hit.at < 60000) return hit.paths;
  const [use, kb] = await Promise.all([
    adb.shellAsync('input 2>&1 | head -3', 8000),
    adb.shellAsync('pm list packages com.android.adbkeyboard', 10000),
  ]);
  const paths: TextPaths = {
    input: /Usage:\s*input|\bkeyevent\b/i.test(use.stdout + use.stderr),
    adbKeyboard: /^package:com\.android\.adbkeyboard\s*$/m.test(kb.stdout),
  };
  textPathCache.set(adb.serial, { at: Date.now(), paths });
  return paths;
}

/// 纯 ASCII 才走 input text：非 ASCII 在多数设备上会无声丢掉，
/// 用户看到的只有「按了发送但设备上什么都没出现」
const isAscii = (s: string) => !/[^\x20-\x7e]/.test(s);

export interface TextResult extends ActionResult {
  via: string;
  ascii: boolean;
}

/// 把一段文字送进设备当前聚焦的输入框。
/// 两条通路都不通时如实说明是「缺输入法」还是「缺 input 命令」，而不是假装成功
export async function typeText(adb: Adb, text: string, submit = false): Promise<TextResult> {
  const value = String(text ?? '');
  if (!value) return { ok: false, command: 'input text', detail: '没有要发送的文字', via: '无', ascii: true };
  const paths = await textPaths(adb);
  const ascii = isAscii(value);
  let command = '';
  let via = '';
  let r: ShellOut;
  if (ascii && paths.input) {
    command = `input text ${shqText(value)}`;
    via = 'input text';
    r = await adb.shellAsync(command, 15000);
  } else if (paths.adbKeyboard) {
    command = `am broadcast -a ADB_INPUT_TEXT --es msg ${shqText(value)}`;
    via = 'ADBKeyboard 广播';
    r = await adb.shellAsync(command, 15000);
  } else {
    return {
      ok: false,
      command: 'input text',
      via: '无',
      ascii,
      verified: false,
      detail: ascii
        ? '设备的 input 命令用不了，文字发不出去'
        : '没有能收中文的输入法：装上 ADBKeyboard 再发，或先改用英文',
    };
  }
  const ok = r.code === 0 && !FAIL_RE.test(r.stdout + r.stderr);
  let detail = (r.stdout + r.stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ')
    .slice(0, 200);
  if (!ok && !detail) detail = '设备拒绝了这次输入';
  if (ok && submit) {
    const ent = await adb.shellAsync('input keyevent 66', 8000);
    detail = `${detail ? `${detail} · ` : ''}${ent.code === 0 ? '已回车' : '回车没发出去'}`;
  }
  if (ok && !detail) detail = `已发送 ${value.length} 个字符`;
  return { ok, command, via, ascii, detail, verified: ok };
}

/// 输入框里的编辑动作。清空不是「按 40 次退格」这么糙：
/// 先用 MOVE_END 把光标顶到末尾，再让 input keyevent 一次带多个 keycode 连发。
export type EditAction = 'enter' | 'backspace' | 'clear';

export async function editText(adb: Adb, action: EditAction): Promise<ActionResult> {
  const steps: { code: number; times: number }[] =
    action === 'enter'
      ? [{ code: 66, times: 1 }]
      : action === 'backspace'
        ? [{ code: 67, times: 1 }]
        : [
            { code: 123, times: 1 },
            { code: 67, times: 60 },
          ];
  const cmds = steps.map(({ code, times }) => `input keyevent ${Array(times).fill(code).join(' ')}`);
  const command = cmds.join(' ; ');
  const outs: ShellOut[] = [];
  for (const cmd of cmds) outs.push(await adb.shellAsync(cmd, 12000));
  const bad = outs.find((o) => o.code !== 0 || FAIL_RE.test(o.stdout + o.stderr));
  const label = action === 'enter' ? '已回车' : action === 'backspace' ? '已退格' : '已清空输入框';
  return {
    ok: !bad,
    command,
    verified: !bad,
    detail: bad ? (bad.stdout + bad.stderr).trim().split('\n')[0] || '设备拒绝了这次按键' : label,
  };
}

/// 屏幕像素尺寸。开发者选项里改过分辨率（Override size）时以它为准 —— 设备真正渲染的是这个，
/// 手势按 Physical size 算就会偏。缓存 60 秒，状态轮询不会反复问 wm size
const screenCache = new Map<string, { at: number; w: number; h: number }>();

export async function screenSize(adb: Adb): Promise<{ w: number; h: number }> {
  const hit = screenCache.get(adb.serial);
  if (hit && Date.now() - hit.at < 60000) return { w: hit.w, h: hit.h };
  const r = await adb.shellAsync('wm size', 8000);
  const m = /Override size:\s*(\d+)x(\d+)/.exec(r.stdout) || /Physical size:\s*(\d+)x(\d+)/.exec(r.stdout);
  const w = Number(m?.[1] ?? 0);
  const h = Number(m?.[2] ?? 0);
  if (w && h) screenCache.set(adb.serial, { at: Date.now(), w, h });
  return { w, h };
}

/// device shell 的单引号转义（与 manage.ts / system.ts 里同名工具一致）
function shqText(p: string): string {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- 设备健康

/// 一次探测拍下的设备资源快照。全部来自 /proc 与 df ——
/// 不认厂牌、不认 Android 版本、不需要 root：手机、平板、电视、模拟器都走同一条路。
/// 读不到的项给 -1 / null，页面照着写「读不到」，不拿 0 冒充
export interface HealthState {
  ok: boolean;
  cpu: number;
  cores: number;
  load: number[];
  memTotalKb: number;
  memUsedKb: number;
  disk: { mount: string; totalKb: number; usedKb: number; availKb: number } | null;
  uptimeSec: number;
  tempC: number | null;
  tempZone: string;
  procs: number;
  battery: BatteryInfo;
  detail: string;
}

/// 电池：手机能给出电量、温度、充电状态；大屏设备和一部分盒子根本没有电池服务，
/// 这时 supported 为 false，页面整块不渲染 —— 而不是画一个 0% 的假电量出来
export interface BatteryInfo {
  supported: boolean;
  level: number | null;
  tempC: number | null;
  status: string;
  charging: boolean;
  voltageMv: number | null;
}

const BAT_STATUS: Record<number, string> = { 1: '未知', 2: '充电中', 3: '放电中', 4: '未充电', 5: '已充满' };

/// dumpsys battery 的字段各家一致，但「有没有电池」不一致：
/// 这类设备会直接回一句 Can't find service，那就当作不支持
function parseBattery(raw: string): BatteryInfo {
  const none: BatteryInfo = { supported: false, level: null, tempC: null, status: '', charging: false, voltageMv: null };
  const num = (k: string) => {
    const m = new RegExp(`^\\s*${k}:\\s*(-?\\d+)`, 'm').exec(raw);
    return m ? Number(m[1]) : null;
  };
  const powered = (k: string) => new RegExp(`^\\s*${k}:\\s*true\\s*$`, 'm').test(raw);
  const level = num('level');
  const status = num('status');
  /// 认「有电池服务」的信号：level / status 任一出得来，或 dumpsys 回了一段状态体。
  /// 「Can't find service」这类错误串不会命中
  if (level === null && status === null && !/Battery Service state|^\s*present:/m.test(raw)) return none;
  /// 模拟器、机顶盒的电池服务是桩：present:false 说明这台设备根本没有电池，
  /// 此时 level 恒为 0，画成「电量 0%」是误导，按读不到处理
  if (/^\s*present:\s*(false|0)\s*$/m.test(raw)) return none;
  const scale = num('scale') || 100;
  const ac = powered('AC powered');
  const usb = powered('USB powered');
  const wireless = powered('Wireless powered');
  /// 有的设备 status 停在 4（未充电）但 AC/USB 明明插着，所以充电来源也算充电态
  const charging = status === 2 || status === 5 || ac || usb || wireless;
  const tempRaw = num('temperature');
  const mv = num('voltage');
  return {
    supported: true,
    level: level === null ? null : Math.max(0, Math.min(100, Math.round((level / scale) * 100))),
    /// dumpsys 的温度是摄氏度的十倍（281 = 28.1℃）
    tempC: tempRaw === null ? null : Math.round(tempRaw) / 10,
    status: BAT_STATUS[status ?? 0] ?? (charging ? '充电中' : ''),
    charging,
    /// 大屏设备的电池服务是桩，常见 voltage 恒为 0：0 不算读数，按读不到处理
    voltageMv: mv && mv > 0 ? mv : null,
  };
}

/// /proc/stat 的聚合行（cpu user nice system idle iowait irq softirq steal…）。
/// 两次采样求差才是「此刻」的占用，直接读一次拿到的是开机至今的平均值
function cpuTotal(line: string): { total: number; idle: number } | null {
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
  const total = nums.reduce((a, b) => a + b, 0);
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait 都算「没在算」
  return total > 0 ? { total, idle } : null;
}

type CpuSample = { total: number; idle: number };

/// 从一段 /proc/stat 文本里取聚合行 cpu
/// at 必须由调用方给出「这一拍是什么时候发起的」：/proc/stat 是一趟 shell 的第一条命令，
/// 等整趟跑完（真机上 1 秒以上）再打时间戳，会把窗口算得比实际宽，
/// 于是刚采过一次的请求也被判成「间隔够了」，读回一个被稀释的占用率
function statSample(text: string, at: number): (CpuSample & { at: number }) | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  const s = line ? cpuTotal(line) : null;
  return s ? { ...s, at } : null;
}

/// 两拍求差得到这一段时间窗内的占用率；分母非正说明读数没往前走（时钟异常、
/// 设备刚重启把计数清零），一律给「读不到」而不是编一个数
function cpuPct(prev: CpuSample, cur: CpuSample): number {
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return -1;
  return Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
}

/// CPU 占用的上一拍。原先每次读 health 都在设备端 sleep 0.4 秒再读第二拍，
/// 光这一下就要 ~500ms。健康页是常驻轮询的，两拍之间本来就有真实间隔，
/// 所以把上一拍按序列号存下来即可；设备换过、重启过（计数倒退）会自动走兜底采样。
const cpuBaseline = new Map<string, CpuSample & { at: number }>();
/// 最近一次算出来的占用率：上一拍太新（窗口还不够宽）时直接复用这个值，
/// 而不是为了凑窗口再等半秒。CPU 占用本来就是「这几秒的平均」，
/// 2 秒内的重复值对页面读数没有影响，页面自己也是几秒一轮询。
const cpuRecent = new Map<string, { pct: number; at: number }>();
const CPU_REUSE_MAX_AGE_MS = 2_000;
/// 基线太旧的话求出来的「占用」其实是几分钟前的平均，没有意义，宁可重新采两拍
const BASELINE_MAX_AGE_MS = 60_000;
/// 反过来太新也不行：窗口只有一两百毫秒时，开机/切应用那一下会被放大成 98%，
/// 这种瞬时值既不可信也解释不了。
const BASELINE_MIN_GAP_MS = 500;

function humanUptime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

export async function deviceHealth(adb: Adb): Promise<HealthState> {
  let cpu = -1;

  const SEP = '@@tvdeck@@';
  const thermalLoop =
    'for z in /sys/class/thermal/thermal_zone*; do t=$(cat "$z/temp" 2>/dev/null); ' +
    'if [ -n "$t" ]; then echo "$(cat "$z/type" 2>/dev/null) $t"; fi; done; true';
  /// 这一拍的发起时刻：stat 是这趟 shell 的第一条命令，所以近似等于它的读取时刻
  const startedAt = Date.now();
  const probe = await adb.shellAsync(
    [
      /// /proc/stat 跟着这趟一起读：CPU 占用要两次采样求差，基线存在上一次请求里，
      /// 所以这一趟只要读「现在」这一次
      'cat /proc/stat',
      `echo "${SEP}"`,
      'cat /proc/meminfo',
      `echo "${SEP}"`,
      'df -k /data 2>/dev/null || df -k /storage/emulated/0 2>/dev/null || df -k /',
      `echo "${SEP}"`,
      'cat /proc/uptime',
      `echo "${SEP}"`,
      'nproc 2>/dev/null || grep -c "^processor" /proc/cpuinfo',
      `echo "${SEP}"`,
      'cat /proc/loadavg',
      `echo "${SEP}"`,
      'ps -A 2>/dev/null | wc -l',
      `echo "${SEP}"`,
      thermalLoop,
      `echo "${SEP}"`,
  /// 电池和上面几项塞进同一趟 shell：少一次 adb 往返，真机上这趟本来就要 1 秒多
      'dumpsys battery 2>/dev/null || true',
      `echo "${SEP}"`,
      /// thermal_zone 常是空目录或读不出数字（模拟器、被裁过的系统），
      /// 同一趟里再问一次 Thermal HAL，两边都没有才说「读不到温度」
      'dumpsys thermalservice 2>/dev/null | head -80 || true',
    ].join('; '),
    15000,
  );
  const [
    statRaw = '',
    memRaw = '',
    dfRaw = '',
    upRaw = '',
    coreRaw = '',
    loadRaw = '',
    procRaw = '',
    tempRaw = '',
    batRaw = '',
    thermalSvcRaw = '',
  ] = probe.stdout.split(SEP);

  /// CPU：先拿这一拍和上一拍求差。间隔不够（服务刚起来、刚换设备、设备重启过、
  /// 上一次读数太新）才现场补采第二拍，保证第一次也有值而不是空着
  const cur = statSample(statRaw, startedAt);
  const prev = cpuBaseline.get(adb.serial);
  /// 窗口宽度按「上一拍 → 这一拍的读取时刻」算，不能拿 now 去减：这一拍是在
  /// startedAt 读的，整趟 shell 跑掉的那段时间不算进窗口，否则真机上（一趟 1 秒）
  /// 会把窗口算宽，读回一个被稀释的占用率
  const gap = cur && prev ? startedAt - prev.at : -1;
  if (cur && prev && gap >= BASELINE_MIN_GAP_MS && gap <= BASELINE_MAX_AGE_MS)
    cpu = cpuPct(prev, cur);
  if (cur) cpuBaseline.set(adb.serial, { total: cur.total, idle: cur.idle, at: startedAt });
  /// 窗口不够宽但刚算过：沿用那一拍，不为凑窗口白等半秒
  if (cpu < 0) {
    const last = cpuRecent.get(adb.serial);
    if (last && Date.now() - last.at <= CPU_REUSE_MAX_AGE_MS) cpu = last.pct;
  }
  if (cpu < 0 && cur) {
    /// 走到这里说明没有可用基线（服务刚起来、刚换设备、设备重启过、上一拍太旧或计数倒退）。
    /// 补采一拍，等的是「窗口够宽」而不是固定的 0.4 秒：这一拍到现在已经花掉的时间算进去。
    /// 等待放在服务端而不是设备端，因为有些设备的 sh 不认 `sleep 0.4` 小数秒，
    /// 会直接报错返回，窗口塌成零，读出来的占用率全是噪声
    const wait = Math.max(0, BASELINE_MIN_GAP_MS - (Date.now() - startedAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const later = statSample((await adb.shellAsync('cat /proc/stat', 12000)).stdout, Date.now());
    if (later) {
      cpu = cpuPct(cur, later);
      cpuBaseline.set(adb.serial, { total: later.total, idle: later.idle, at: later.at });
    }
  }
  if (cpu >= 0) cpuRecent.set(adb.serial, { pct: cpu, at: Date.now() });

  const mem = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(memRaw)?.[1] ?? 0);
  const memTotalKb = mem('MemTotal');
  const memAvail = mem('MemAvailable') || mem('MemFree') + mem('Buffers') + mem('Cached');
  const memUsedKb = memTotalKb && memAvail ? Math.max(0, memTotalKb - memAvail) : -1;

  /// df 的第一行是表头，第二行才是数据；某些设备把 /data 挂到带空格的名字上，
  /// 所以挂载点取最后一个字段
  let disk: HealthState['disk'] = null;
  const MIN_USEFUL_KB = 1024 * 512;
  for (const line of dfRaw.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const totalKb = Number(cols[1]);
    const usedKb = Number(cols[2]);
    const availKb = Number(cols[3]);
    if (!Number.isFinite(totalKb) || totalKb < MIN_USEFUL_KB) continue;
    disk = { mount: cols[cols.length - 1], totalKb, usedKb, availKb };
    break;
  }

  const uptimeSec = Number(upRaw.trim().split(/\s+/)[0]) || 0;
  const cores = Number(coreRaw.trim()) || 0;
  const load = loadRaw
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const procs = Math.max(0, Number(procRaw.trim()) - 1);

  /// 温度节点各家命名不一样，值也有毫摄氏度与摄氏度两种。
  /// 先挑 CPU / SoC 这类节点，没有才退回最大的那个合理值
  const zonePref = /(cpu|soc|tsens|gpu|core|ap|board|battery|thermal)/i;
  const zones = tempRaw
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^(.*?)\s+(-?\d+)$/);
      if (!m) return null;
      const raw = Number(m[2]);
      const c = raw > 1000 ? raw / 1000 : raw;
      if (!Number.isFinite(c) || c <= 0 || c > 150) return null;
      return { name: m[1] || 'thermal', c: Math.round(c * 10) / 10, pref: zonePref.test(m[1]) };
    })
    .filter((x): x is { name: string; c: number; pref: boolean } => !!x);
  /// Thermal HAL 的行形如 Temperature{mValue=30.8, ... mName=xx, ...}，量纲已是摄氏度
  const halZones = [...thermalSvcRaw.matchAll(/Temperature\{mValue=(-?[\d.]+),.*?mName=([^,]+)/g)]
    .map((m) => {
      const c = Math.round(Number(m[1]) * 10) / 10;
      const name = (m[2] || 'thermal').trim();
      if (!Number.isFinite(c) || c <= 0 || c > 150) return null;
      return { name, c, pref: zonePref.test(name) };
    })
    .filter((x): x is { name: string; c: number; pref: boolean } => !!x);
  zones.push(...halZones);
  zones.sort((a, b) => Number(b.pref) - Number(a.pref) || b.c - a.c);

  const bits: string[] = [];
  if (cores) bits.push(`${cores} 核`);
  if (load.length) bits.push(`负载 ${load.join(' ')}`);
  if (procs) bits.push(`${procs} 个进程`);
  if (uptimeSec) bits.push(`已运行 ${humanUptime(uptimeSec)}`);
  if (zones.length) bits.push(`温度传感器 ${zones.length} 个`);
  const battery = parseBattery(batRaw);
  if (battery.supported && battery.level !== null) bits.push(`电量 ${battery.level}%`);
  const ok = memTotalKb > 0 || cpu >= 0 || !!disk;
  return {
    ok,
    cpu,
    cores,
    load,
    memTotalKb,
    memUsedKb,
    disk,
    uptimeSec,
    tempC: zones[0]?.c ?? null,
    tempZone: zones[0]?.name ?? '',
    procs,
    battery,
    detail: ok ? bits.join(' · ') : '设备没给出 /proc 读数（可能是精简过的系统）',
  };
}

// ---------------------------------------------------------------- 电源动作

/// 重启家族是 Android 都认的出口，不需要 root：reboot / recovery / bootloader 都是标准行为，
/// 关机走 reboot -p（等价 poweroff）。动作发出去之后 adb 连接就会断，
/// 所以「执行成功」只能确认到「命令已送达」，设备什么时候回来由连接页去重认。
export async function powerAction(adb: Adb, action: string): Promise<ActionResult> {
  const map: Record<string, { cmd: string; what: string }> = {
    reboot: { cmd: 'reboot', what: '重启' },
    recovery: { cmd: 'reboot recovery', what: '重启到恢复模式' },
    bootloader: { cmd: 'reboot bootloader', what: '重启到引导模式' },
    shutdown: { cmd: 'reboot -p', what: '关机' },
  };
  const it = map[action];
  if (!it) return { ok: false, command: `power ${action}`, detail: `不认识的电源动作：${action}` };
  const r = await adb.shellAsync(it.cmd, 12000);
  /// 设备一收到 reboot 就切走，shell 多半以「连接被断开 / device offline」收场，
  /// 这恰恰说明命令生效了。真正的失败是「permission denied」「not found」这类明确拒绝
  const blob = `${r.stderr || ''}\n${r.stdout || ''}`.trim();
  const wentAway = /closed|offline|device not found|broken pipe|EOF|reset by peer/i.test(blob);
  const refused = r.code !== 0 && !wentAway && blob.length > 0;
  if (refused) {
    return { ok: false, command: `adb shell ${it.cmd}`, verified: false, detail: blob.split('\n')[0].trim() || '设备拒绝了这条命令' };
  }
  return {
    ok: true,
    command: `adb shell ${it.cmd}`,
    /// 连接断掉时无法再回读状态，所以是「已送达」而不是「已确认完成」，页面照这个措辞说
    verified: false,
    detail:
      action === 'shutdown'
        ? '关机已送达，设备会断开连接；再开机请按设备机身键或手动唤醒'
        : `${it.what}已送达，设备正在切换，回来后连接页会重新认到`,
  };
}

// ---------------------------------------------------------------- 屏幕录制

export interface RecordResult extends ActionResult {
  name?: string;
  bytes?: number;
  seconds?: number;
  size?: string;
}

/// 录屏 = 在设备上跑 screenrecord，跑完把 mp4 拉回本机。
/// 分辨率默认跟着设备走；选了清晰度就按设备的实际宽高比折算并凑成偶数，
/// 免得给一台 16:9 的设备塞 1280x719 这种编码器不接受的尺寸。
/// 录制用的临时文件写在 /data/local/tmp（shell 用户可写），拉回本地后立即删掉。
export async function recordScreen(
  adb: Adb,
  opts: {
    seconds: number;
    height?: number;
    bitrate?: number;
    dir: string;
    /// 阶段回调。录屏在服务端变成了后台任务，请求不再挂着等结果，
    /// 页面只能靠这两个阶段知道「现在是在设备上录，还是已经在往本机拉」。
    /// record = screenrecord 已下发，pull = 已录完、正在 adb pull 回本机
    onPhase?: (phase: 'record' | 'pull') => void;
  },
): Promise<RecordResult> {
  const seconds = Math.min(30, Math.max(3, Math.round(opts.seconds || 10)));
  const bitrate = Math.min(20000000, Math.max(500000, Math.round(opts.bitrate || 4000000)));
  let sizeArg = '';
  let sizeLabel = '设备原生分辨率';
  if (opts.height && opts.height > 0) {
    const { w, h } = await screenSize(adb);
    if (w && h) {
      const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
      const tw = even((opts.height * w) / h);
      const th = even(opts.height);
      sizeArg = ` --size ${tw}x${th}`;
      sizeLabel = `${tw}x${th}`;
    }
  }
  const remote = `/data/local/tmp/tvdeck-rec-${Date.now()}.mp4`;
  const command = `screenrecord --time-limit ${seconds} --bit-rate ${bitrate}${sizeArg} ${remote}`;
  /// 录多久就等多久：命令本身仍是阻塞的，只是它现在跑在服务端的后台任务里，
  /// 请求早已返回，页面按 jobId 轮询进度
  opts.onPhase?.('record');
  const run = await adb.shellAsync(command, seconds * 1000 + 15000);
  const probe = await adb.shellAsync(`[ -s ${remote} ] && echo TVDECK_YES || echo TVDECK_NO`, 8000);
  if (!/TVDECK_YES/.test(probe.stdout)) {
    await adb.shellAsync(`rm -f ${remote}`, 8000);
    const why = (run.stderr + run.stdout)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' · ');
    return {
      ok: false,
      command,
      verified: false,
      seconds,
      size: sizeLabel,
      detail: why || '设备没有产出录像：可能裁掉了 screenrecord，或编码器不接受所选分辨率',
    };
  }
  fs.mkdirSync(opts.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const name = `tvdeck-${adb.serial.replace(/[^\w.-]+/g, '-')}-${stamp}.mp4`;
  const local = path.join(opts.dir, name);
  opts.onPhase?.('pull');
  const pull = await adb.pullAsync(remote, local, 90000);
  await adb.shellAsync(`rm -f ${remote}`, 8000);
  if (pull.code !== 0 || !fs.existsSync(local)) {
    return {
      ok: false,
      command: `${command} && adb pull`,
      verified: false,
      seconds,
      size: sizeLabel,
      detail: `录像拉回服务端失败：${(pull.stderr || '').trim().split('\n')[0] || '拉取命令没有任何输出'}`,
    };
  }
  const bytes = fs.statSync(local).size;
  return {
    ok: bytes > 0,
    command,
    verified: bytes > 0,
    seconds,
    name,
    bytes,
    size: sizeLabel,
    detail: `已录制 ${seconds} 秒 · ${sizeLabel} · ${(bytes / 1048576).toFixed(1)}MB`,
  };
}

// ---------------------------------------------------------------- 设备日志（logcat）

export interface LogLine {
  /// 时间用设备给的原文，不换算成本机时区。设备的时区多半和这台电脑一样，
  /// 但部分 Android 设备经常是出厂默认 UTC，一换算就会出现"日志比现实早 8 小时"的假象
  time: string;
  pid: number;
  tid: number;
  level: string;
  tag: string;
  msg: string;
}

export interface LogSnapshot extends ActionResult {
  rows: LogLine[];
  /// 实际跑成的那条命令 + 降级说明：老设备不认 -t / --pid 时会退到别的写法，
  /// 页面必须写清楚读到的是什么，而不是假装请求的参数都生效了
  read: string;
}

/// logcat -v threadtime 的普通行：
/// `06-14 10:12:33.456  1234  1300 I ActivityManager: 消息正文`
/// 多行消息（栈、长 JSON）在第 2 行起没有这层前缀，要并回上一条
const LOG_RE = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3,})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?):\s?([\s\S]*)$/;

function parseLog(text: string): LogLine[] {
  const rows: LogLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = LOG_RE.exec(line);
    if (!m) {
      /// `--------- beginning of main` 这类分隔行直接丢；其余当上一条的续行
      if (!/^-+ beginning of /.test(line.trim()) && rows.length) rows[rows.length - 1].msg += `\n${line.trimEnd()}`;
      continue;
    }
    rows.push({ time: m[1], pid: Number(m[2]), tid: Number(m[3]), level: m[4], tag: m[5].trim(), msg: m[6] });
  }
  return rows;
}

/// 前台应用的 pid。Android 6 起才有 pidof；没有（或没匹配到）就回 0，
/// 调用方据此退回"全量读 + 本机筛"，而不是拿一个 0 去 --pid=0 过滤成空列表
export async function pidOf(adb: Adb, name: string): Promise<number> {
  const want = name.trim();
  if (!want) return 0;
  const r = await adb.shellAsync(`pidof ${want}`, 8000);
  const first = r.stdout.trim().split(/\s+/)[0] ?? '';
  if (/^\d+$/.test(first)) return Number(first);
  /// pidof 被裁掉的老系统：ps 还在，按进程名兜一遍
  const ps = await adb.shellAsync(`ps -A -o PID,NAME | grep -w ${want}`, 8000);
  const hit = ps.stdout.split('\n').map((l) => l.trim()).find((l) => /^\d+\s/.test(l));
  return hit ? Number(hit.split(/\s+/)[0]) : 0;
}

/// 每台设备记住"第几档读法能出内容"。logcat 认不认 -t / --pid 是这台 ROM 的固定属性，
/// 不该每读一次就把三档全试一遍 —— 没有这个缓存的话，在这台 HyperOS 手机上读 100 行
/// 要跑三次 adb（2~3 秒），有了之后第二次起就只要一次。键是序列号，换设备各记各的
const logModes = new Map<string, number>();

/// 读一次日志快照（不挂住、不流式）：读多少、按什么等级、要不要只看某个 pid，
/// 全走 logcat 自己的参数。老设备不认的参数会自动降级重试，降级了什么写在 read 里
export async function logSnapshot(
  adb: Adb,
  opts: { lines?: number; level?: string; pid?: number },
): Promise<LogSnapshot> {
  const lines = Math.min(2000, Math.max(50, Math.round(opts.lines || 400)));
  const level = /^[VDIWEFS]$/.test(String(opts.level ?? '')) ? String(opts.level) : '';
  const filter = level ? ` *:${level}` : '';
  const pid = opts.pid && opts.pid > 0 ? opts.pid : 0;

  /// 从"参数最全"一路退到"最保守"：--pid 是 Android 7 才有的，-t 更老但也有被裁掉的。
  /// 除了"不认识的参数"这种一眼能看出来的降级，还有一类更阴的：参数照收、退出码 0，但什么都不输出
  /// ——HyperOS 上 `logcat -d -t 30` 就是空的。所以不能拿到第一个"没报错"的结果就交差，
  /// 必须一直试到某一档真读出行为止，全部为空时才回那个空结果
  const ladder: { cmd: string; pidFilter: boolean; tail: boolean }[] = [];
  ladder.push({ cmd: `logcat -d -v threadtime -t ${lines}${filter}${pid ? ` --pid=${pid}` : ''}`, pidFilter: false, tail: false });
  if (pid) {
    /// -t 还在但 --pid 被裁了：行数仍交给设备，pid 退回本机筛
    ladder.push({ cmd: `logcat -d -v threadtime -t ${lines}${filter}`, pidFilter: true, tail: false });
    /// 反过来 --pid 还在但 -t 被裁了：pid 仍交给设备，行数退回本机截
    ladder.push({ cmd: `logcat -d -v threadtime${filter} --pid=${pid}`, pidFilter: false, tail: true });
  }
  /// 最后一档谁的筛选都不信：整段读回来，pid 和行数全在本机处理
  ladder.push({ cmd: `logcat -d -v threadtime${filter}`, pidFilter: !!pid, tail: true });

  /// 上次这台设备是哪一档读出的内容，就把它排到最前面先试；没记过就按原顺序
  const known = logModes.get(adb.serial);
  const order = ladder.map((_, i) => i);
  if (known !== undefined && ladder[known]) order.sort((a, b) => (a === known ? -1 : b === known ? 1 : a - b));

  /// "跑通了但一行没有"里最先出现的那个。所有档都空时回它：至少它带着读法说明，
  /// 而不是一句笼统的失败
  let empty: LogSnapshot | null = null;

  for (const idx of order) {
    const step = ladder[idx];
    const r = await adb.shellAsync(step.cmd, 15000);
    const blob = `${r.stderr}\n${r.stdout}`;
    /// logcat 把"不认识的参数"写在 stderr 里并以 1 退出；只有这种才值得换下一档，
    /// 权限/SELinux 拒绝这类硬失败换写法也没用，直接如实报出去
    const unknownOpt = /unknown option|invalid option|usage:/i.test(blob);
    if (r.code !== 0 && unknownOpt) continue;
    if (r.code !== 0 && !r.stdout.trim()) return logDenied(step.cmd, r.stderr || r.stdout);

    let rows = parseLog(r.stdout);
    const notes: string[] = [];
    if (step.pidFilter) {
      rows = rows.filter((x) => x.pid === pid);
      notes.push('logcat 不认 --pid，改成读全量再按 pid 筛');
    }
    if (step.tail) {
      rows = rows.slice(-lines);
      notes.push(`logcat 不认 -t，改成读整段再截最后 ${lines} 行`);
    }
    const errCount = rows.filter((x) => x.level === 'E' || x.level === 'F').length;
    /// 「等级 全部」是默认档，念出来等于没筛；只有用户真的选了等级才值得占这一句
    const bits = [`读到 ${rows.length} 行`, level ? `等级 ${level}` : '', pid ? `pid ${pid}` : ''].filter(Boolean);
    if (errCount) bits.push(`其中 ${errCount} 行是 E/F 级`);
    const snap: LogSnapshot = {
      ok: true,
      command: `adb shell ${step.cmd}`,
      verified: true,
      rows,
      read: step.cmd,
      detail: `${bits.join(' · ')}${notes.length ? ` · ${notes.join('；')}` : ''}`,
    };
    /// 这一档真读到东西了就交差；一行都没有就先记下，继续往下试更保守的写法
    if (rows.length) {
      logModes.set(adb.serial, idx);
      return snap;
    }
    if (!empty) empty = snap;
  }

  /// 每一档都跑通了、但都是空的：这台设备的缓冲刚被清过，或者当前根本没有日志在写。
  /// 不编造内容，如实回 0 行，并保留最后用的是哪种读法
  if (empty) return empty;
  return { ok: false, command: 'adb shell logcat', verified: false, rows: [], read: '', detail: '设备的日志读法全都不通' };
}

/// logcat 报的硬错（不是"不认参数"那种能靠换写法绕开的）。最常见的是 read failure ——
/// 设备压根没有可读的日志缓冲（厂商把 logd 关了，或者缓冲大小是 0）。
/// 设备原文照抄进括号，前面补一句人话，别让用户对着一句英文干瞪眼
function logDenied(cmd: string, msg: string): LogSnapshot {
  const raw = msg.trim().split('\n').filter(Boolean).slice(0, 2).join(' · ') || '设备拒绝了日志读取';
  const human = /read failure|failed to get the readable/i.test(raw) ? `设备没有可读的日志缓冲（原文：${raw}）` : raw;
  return { ok: false, command: `adb shell ${cmd}`, verified: false, rows: [], read: '', detail: human };
}

/// 清空设备上的 logcat 环形缓冲。只动日志缓冲，不碰系统文件；
/// 有的设备给 shell 关了 log 读取权限，那就如实回"设备拒绝了"
export async function logClear(adb: Adb): Promise<ActionResult> {
  const r = await adb.shellAsync('logcat -c', 10000);
  const blob = (r.stderr + r.stdout).trim();
  const ok = r.code === 0 && !/denied|permission/i.test(blob);
  return {
    ok,
    command: 'adb shell logcat -c',
    verified: ok,
    detail: ok ? '设备日志缓冲已清空（只清缓冲，不删文件）' : blob.split('\n').filter(Boolean)[0] || '设备拒绝了这条命令',
  };
}

/// 触控板动作。move/click/down/up/scroll 都先确认这台设备真的有鼠标驱动：
/// 安卓 8 的 `input` 命令没有 mouse move/click/scroll（实测 Unknown command），只能 evdev 直写。
/// 没有鼠标驱动时（模拟器、纯触屏设备）move/scroll 直接说明不可用，
/// click 允许带绝对坐标回退成 `input tap`，这样触控板在触屏上还能点得动。
/// down/up 是按住与松开：选中文字、拖动图标必须有它们，只有 click 的话触控板永远只能点不能拖。
type MouseButton = 'left' | 'right' | 'middle' | 'side' | 'extra';
const BTN_CN: Record<MouseButton, string> = { left: '左键', right: '右键', middle: '中键', side: '侧键', extra: '前进键' };

/// 单次 REL 增量上限。内核与 Android InputReader 会把一次超大位移当成"甩动"，
/// 指针还会被屏幕边界夹住导致丢距离，所以长距离要分多帧写。
const REL_STEP = 240;

export async function mouseAction(
  adb: Adb,
  mode: 'move' | 'click' | 'down' | 'up' | 'scroll',
  opts: { dx?: number; dy?: number; btn?: MouseButton; dir?: 'up' | 'down' | 'left' | 'right'; amount?: number; x?: number; y?: number },
): Promise<ActionResult> {
  const e = mouseEntry(adb);
  const path = await e.path;
  if (path.via !== 'evdev') {
    /// 触屏回退：点击带绝对坐标时走 input tap，其余动作这台设备没有通路
    if (mode === 'click' && Number.isFinite(opts.x) && Number.isFinite(opts.y) && (opts.btn ?? 'left') === 'left') {
      const x = Math.round(Number(opts.x));
      const y = Math.round(Number(opts.y));
      const r = await adb.shellAsync(`input tap ${x} ${y}`, 8000);
      return { ok: r.code === 0, command: `input tap ${x} ${y}`, detail: `设备无鼠标驱动 · 绝对点按 ${x},${y}` };
    }
    const what = mode === 'click' ? '只能绝对点按' : mode === 'down' || mode === 'up' ? '按住与拖动不可用' : '不可用';
    return { ok: false, command: `mouse ${mode}`, detail: `设备没有鼠标驱动，触控板${what}` };
  }

  if (mode === 'move') {
    const dx = Math.round(Number(opts.dx) || 0);
    const dy = Math.round(Number(opts.dy) || 0);
    if (!dx && !dy) return { ok: true, command: 'mouse move', detail: '没有位移' };
    const parts: Buffer[] = [];
    for (let rx = dx, ry = dy; rx !== 0 || ry !== 0; ) {
      const sx = Math.max(-REL_STEP, Math.min(REL_STEP, rx));
      const sy = Math.max(-REL_STEP, Math.min(REL_STEP, ry));
      parts.push(
        Buffer.concat([
          frame(path.recordSize, EV_REL, REL_CODES.x, sx),
          frame(path.recordSize, EV_REL, REL_CODES.y, sy),
          frame(path.recordSize, EV_SYN, 0, 0),
        ]),
      );
      rx -= sx;
      ry -= sy;
    }
    if (!e.inj.write(Buffer.concat(parts), path.device)) {
      return { ok: false, command: `evdev ${path.device}`, detail: '注入管道不可用（与设备的连接断开）' };
    }
    return { ok: true, command: `evdev ${path.device} move ${dx},${dy}`, detail: `已移动 ${dx},${dy}` };
  }

  /// 按住 / 松开。页面必须成对调用：只 down 不 up 会把按键永远留在按下状态
  if (mode === 'down' || mode === 'up') {
    const btn = opts.btn ?? 'left';
    const code = path.buttons[btn];
    if (code === undefined) return { ok: false, command: `mouse ${mode} ${btn}`, detail: `${path.name} 没有${BTN_CN[btn]}` };
    const buf = Buffer.concat([frame(path.recordSize, EV_KEY, code, mode === 'down' ? 1 : 0), frame(path.recordSize, EV_SYN, 0, 0)]);
    if (!e.inj.write(buf, path.device)) return { ok: false, command: `evdev ${path.device}`, detail: '注入管道不可用（与设备的连接断开）' };
    return { ok: true, command: `evdev ${path.device} ${mode} ${btn}`, detail: mode === 'down' ? `已按住${BTN_CN[btn]}` : `已松开${BTN_CN[btn]}` };
  }

  if (mode === 'click') {
    const btn = opts.btn ?? 'left';
    const code = path.buttons[btn];
    if (code === undefined) {
      /// 该设备没有这个按键；左键仍尽量用绝对点按救回来
      if (btn === 'left' && Number.isFinite(opts.x) && Number.isFinite(opts.y)) {
        const x = Math.round(Number(opts.x));
        const y = Math.round(Number(opts.y));
        const r = await adb.shellAsync(`input tap ${x} ${y}`, 8000);
        return { ok: r.code === 0, command: `input tap ${x} ${y}`, detail: `设备无 ${BTN_CN[btn]} · 绝对点按 ${x},${y}` };
      }
      return { ok: false, command: `mouse click ${btn}`, detail: `${path.name} 没有${BTN_CN[btn]}` };
    }
    if (!e.inj.write(pressFrame(path.recordSize, code), path.device)) {
      return { ok: false, command: `evdev ${path.device}`, detail: '注入管道不可用（与设备的连接断开）' };
    }
    return { ok: true, command: `evdev ${path.device} click ${btn}`, detail: `已${BTN_CN[btn]}点击` };
  }

  /// scroll：向上推 = 看上面的内容 = REL_WHEEL 负值（和真实滚轮方向一致）
  const dir = opts.dir ?? 'down';
  const vertical = dir === 'up' || dir === 'down';
  const code = vertical ? (path.wheel ? REL_CODES.wheel : undefined) : (path.hwheel ? REL_CODES.hwheel : undefined);
  if (code === undefined) {
    return { ok: false, command: `mouse scroll ${dir}`, detail: `${path.name} 没有${vertical ? '垂直滚轮' : '水平滚轮'}` };
  }
  const amount = Math.max(1, Math.round(Number(opts.amount) || 1));
  const val = dir === 'up' || dir === 'left' ? -amount : amount;
  const buf = Buffer.concat([frame(path.recordSize, EV_REL, code, val), frame(path.recordSize, EV_SYN, 0, 0)]);
  if (!e.inj.write(buf, path.device)) return { ok: false, command: `evdev ${path.device}`, detail: '注入管道不可用（与设备的连接断开）' };
  return { ok: true, command: `evdev ${path.device} scroll ${dir}`, detail: `已滚轮 ${dir} ${amount}` };
}
