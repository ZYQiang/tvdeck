import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './home.ts';
import { Adb, connect } from './adb.ts';
import { readNames, usableLabel } from './names.ts';
import { describe } from './dial.ts';
import { findAdbDevices } from './discover.ts';
import {
  loadProfile,
  newEvidenceDir,
  friendlyModel,
  saveProfile,
  writeEvidence,
  type DeviceProfile,
} from './profile.ts';

const PICTURE_KEY_RE = /(bright|contrast|colou?r|gamma|sharp|hue|picture|display|backlight)/i;

/// 异步版取证落盘：完整探测和轻快照都跑在请求路径上，
/// 用同步 shell 会把整个服务进程卡住（这期间按键、镜像、状态轮询全部排队）
async function captureAsync(adb: Adb, dir: string, file: string, run: () => Promise<{ stdout: string; stderr: string; code: number }>): Promise<string> {
  let r: { stdout: string; stderr: string; code: number };
  try {
    r = await run();
  } catch (e) {
    r = { stdout: '', stderr: (e as Error).message, code: 1 };
  }
  const text = r.stdout || `# command failed (code ${r.code})\n${r.stderr}`;
  writeEvidence(dir, file, text);
  return text;
}

function parseProps(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
    if (m) props[m[1]] = m[2];
  }
  return props;
}

function parsePicture(settings: Record<string, string>, table: 'system' | 'secure' | 'global') {
  return Object.entries(settings)
    .filter(([k]) => PICTURE_KEY_RE.test(k))
    .map(([key, value]) => ({ key, table, value }));
}

/// 完整探测一台设备：把关键系统输出全部落到取证目录，再写回档案。
/// 入参是 adb serial（`ip:port`、`emulator-5554`、USB 序列号都行），
/// 所以模拟器和 USB 设备也能走这条路，不再只有网络 adb 可以被完整探测。
export async function probeDevice(serial: string): Promise<DeviceProfile> {
  const adb = new Adb(serial);
  if (!(await adb.getPropAsync('ro.product.model'))) {
    throw new Error(
      `读不到 ${serial} 的型号。确认设备在线，并在 设置 → 开发者选项 → 网络 ADB 调试 开启后点允许。`,
    );
  }
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(serial.split(':')[0]) ? serial.split(':')[0] : '';
  const dir = newEvidenceDir(serial.replace(/[^\w.-]/g, '_'));
  console.log(`取证目录 ${dir}`);

  /// 二十来条 adb 往返并发跑：同步串行的话每条都要等设备端起一次 shell，
  /// 真机上轻松堆到十几秒，而且这期间整个服务进程被 spawnSync 卡住（按键、镜像全在排队）。
  /// 取证文件本身互相独立，并发落盘不改变内容。
  const [
    propsText,
    ,
    ,
    sysSettings,
    secureSettings,
    globalSettings,
    launcherText,
  ] = await Promise.all([
    captureAsync(adb, dir, 'getprop.txt', () => adb.shellAsync('getprop', 20000)),
    captureAsync(adb, dir, 'packages.txt', () => adb.shellAsync('pm list packages', 40000)),
    captureAsync(adb, dir, 'features.txt', () => adb.shellAsync('pm list features', 20000)),
    adb.settingsListAsync('system'),
    adb.settingsListAsync('secure'),
    adb.settingsListAsync('global'),
    captureAsync(adb, dir, 'launcher-activities.txt', () =>
      adb.shellAsync(
        'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER',
        40000,
      ),
    ),
  ]);
  writeEvidence(dir, 'settings-system.txt', JSON.stringify(sysSettings, null, 2));
  writeEvidence(dir, 'settings-secure.txt', JSON.stringify(secureSettings, null, 2));
  writeEvidence(dir, 'settings-global.txt', JSON.stringify(globalSettings, null, 2));
  const props = parseProps(propsText);
  const launcher = Adb.parseLauncher(launcherText);

  /// 重探测（media_audio / audio / power / display / window / usagestats）随后台跑完：
  /// usagestats 在日志多的机器上要几十秒，把它放在响应前面等于让按钮转半分钟
  void Promise.all([
    captureAsync(adb, dir, 'media_audio.txt', () => adb.dumpsysAsync('media_audio', '', 20000)),
    captureAsync(adb, dir, 'audio.txt', () => adb.dumpsysAsync('audio', '', 20000)),
    captureAsync(adb, dir, 'power.txt', () => adb.dumpsysAsync('power', '', 20000)),
    captureAsync(adb, dir, 'display.txt', () => adb.dumpsysAsync('display', '', 20000)),
    captureAsync(adb, dir, 'window.txt', () => adb.dumpsysAsync('window', 'windows', 20000)),
    captureAsync(adb, dir, 'usagestats.txt', () => adb.dumpsysAsync('usagestats', '', 120000)),
  ]).catch((e) => console.log(`取证补充失败: ${(e as Error).message}`));

  /// 应用名走 names.json 那套缓存，不再逐包 dumpsys package：
  /// 后者在几十包的机器上要几十次 adb 往返，是「读取太慢」的主要来源之一。
  /// 当场解不出名字的先留空，由 /api/apps 与后台补名队列负责填。
  const cachedNames = readNames();
  const apps = launcher.map((a) => ({
    label: usableLabel(cachedNames[a.package] ?? '', a.package) || a.package,
    component: a.component,
    package: a.package,
  }));

  let dialApps: string[] = [];
  if (ip) {
    try {
      const info = await describe(ip);
      dialApps = info.apps.map((a) => a.name);
      writeEvidence(dir, 'dial-description.xml', info.rawDescription);
      writeEvidence(dir, 'dial-summary.json', JSON.stringify(info, null, 2));
      console.log(`DIAL: ${info.friendlyName || info.modelName} / ${dialApps.length} 个可启动 app`);
    } catch (e) {
      console.log(`DIAL 不可用: ${(e as Error).message}`);
    }
  }

  const profile: DeviceProfile = {
    ...loadProfile(),
    serial,
    ip: ip || loadProfile().ip,
    model: props['ro.product.model'] ?? '',
    modelFriendly: friendlyModel(props),
    brand: props['ro.product.brand'] ?? props['ro.product.manufacturer'] ?? '',
    androidVersion: props['ro.build.version.release'] ?? '',
    buildFingerprint: props['ro.build.fingerprint'] ?? '',
    apps,
    dialApps,
    picture: [
      ...parsePicture(sysSettings, 'system'),
      ...parsePicture(secureSettings, 'secure'),
      ...parsePicture(globalSettings, 'global'),
    ],
    capturedAt: new Date().toISOString(),
    evidenceDir: path.relative(APP_ROOT, dir),
  };

  writeEvidence(dir, 'profile.json', JSON.stringify(profile, null, 2));
  saveProfile(profile);

  console.log(`\n${profile.brand} ${profile.model} · Android ${profile.androidVersion}`);
  console.log(`app ${apps.length} 个 · 画面相关 settings ${profile.picture.length} 个`);
  if (!profile.picture.some((p) => /contrast/i.test(p.key))) {
    console.log('画面设置: 未在 settings 里找到对比度键，亮度可走 screen_brightness；对比度需继续挖厂商服务');
  }
  return profile;
}

/// 命令行入口：先发现设备（或接受指定 IP），再做完整探测。
export async function probe(explicitIp?: string, opts: { full?: boolean } = {}): Promise<DeviceProfile> {
  let ip = explicitIp;
  let port = 5555;
  if (ip?.includes(':')) {
    const [host, rawPort] = ip.split(':');
    ip = host;
    port = Math.min(65535, Math.max(1, Number(rawPort) || 5555));
  }
  if (!ip) {
    console.log('发现设备中…');
    const cands = await findAdbDevices({ full: opts.full });
    if (!cands.length) throw new Error('局域网内没有发现开放网络 ADB 的设备。确认设备已开机并开启无线调试，或用 probe <ip> 指定地址，加 --full 扫整段 /24');
    cands.forEach((c) => console.log(`  ${c.ip}  ${c.ports.join(',')}  (${c.reason})`));
    const chosen = cands.find((c) => c.ports.includes(5555)) ?? cands[0];
    ip = chosen.ip;
    port = chosen.ports.includes(5555) ? 5555 : chosen.ports[0];
  }

  console.log(`adb connect ${ip}:${port}`);
  const c = connect(ip, port);
  console.log(`  ${c.stdout.trim() || c.stderr.trim()}`);
  return probeDevice(`${ip}:${port}`);
}

/// 切换设备后的轻量快照：只读 getprop、launcher 和 settings，
/// 不跑 usagestats、DIAL 这些重探测，几秒内把旧设备残留的字段换成当前设备的。
export async function refreshProfileSnapshot(serial: string): Promise<DeviceProfile> {
  const adb = new Adb(serial);
  const ip = serial.split(':')[0];
  /// 轻快照同样全异步并发：这几条同步 shell 以前会卡住事件循环，
  /// 换设备那一刻正好是用户最早开始按键的时候
  const [propsText, launcherText, sysSettingsRaw, secureSettingsRaw, globalSettingsRaw] =
    await Promise.all([
      adb.shellAsync('getprop', 8000).then((r) => r.stdout),
      adb.shellAsync(
        'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER',
        30000,
      ).then((r) => r.stdout),
      adb.settingsListAsync('system', 8000),
      adb.settingsListAsync('secure', 8000),
      adb.settingsListAsync('global', 8000),
    ]);
  const props = parseProps(propsText);

  /// 逐包 labelFor 会敲几十次 dumpsys package，是轻快照最慢的一段；
  /// 改名走 names.json 缓存，真名由 /api/apps 和后台补名队列填
  const launcher = Adb.parseLauncher(launcherText);
  const cachedNames = readNames();
  const apps = launcher.map((a) => ({
    label: usableLabel(cachedNames[a.package] ?? '', a.package) || a.package,
    component: a.component,
    package: a.package,
  }));
  const prevSnapshot = loadProfile();
  const prev = prevSnapshot;
  /// 换设备时旧档案的证据目录和音量通路不可继承：前者会指向上一台设备的取证文件，
  /// 后者可能是上一台独有的 binder 通路，留着会干扰当前设备的音量策略
  const switched = prev.serial !== serial;
  const profile: DeviceProfile = {
    ...prev,
    serial,
    ip,
    model: props['ro.product.model'] ?? '',
    modelFriendly: friendlyModel(props),
    brand: props['ro.product.brand'] ?? props['ro.product.manufacturer'] ?? '',
    androidVersion: props['ro.build.version.release'] ?? '',
    buildFingerprint: props['ro.build.fingerprint'] ?? '',
    apps,
    dialApps: [],
    picture: [
      ...parsePicture(sysSettingsRaw, 'system'),
      ...parsePicture(secureSettingsRaw, 'secure'),
      ...parsePicture(globalSettingsRaw, 'global'),
    ],
    capturedAt: new Date().toISOString(),
    ...(switched ? { evidenceDir: '', volumeStrategy: null } : {}),
  };
  saveProfile(profile);
  console.log(`已刷新设备快照 → ${profile.brand || '?'} ${profile.model || '?'}（${serial}），app ${apps.length} 个`);
  return profile;
}
