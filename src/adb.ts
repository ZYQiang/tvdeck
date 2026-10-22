import { spawn, spawnSync } from 'node:child_process';

export interface ShellOut {
  stdout: string;
  stderr: string;
  code: number;
  ok: boolean;
}

function wrap(stdout: string, stderr: string, code: number): ShellOut {
  return { stdout, stderr, code, ok: code === 0 };
}

function spawnAsync(bin: string, args: string[], timeoutMs: number): Promise<ShellOut> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve(wrap('', String((e as Error).message), 1));
      return;
    }
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve(wrap(out, String(e.message), 1));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(wrap(out, err, code ?? 1));
    });
  });
}

/// 二进制输出（screencap 等）必须按 Buffer 收集；字符串拼接会损坏 PNG 首字节
function spawnBufferAsync(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; buf: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: 1, buf: Buffer.alloc(0), stderr: String((e as Error).message) });
      return;
    }
    const chunks: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout?.on('data', (d: Buffer) => chunks.push(d));
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, buf: Buffer.concat(chunks), stderr: String(e.message) });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, buf: Buffer.concat(chunks), stderr: err });
    });
  });
}

const serialCache = new Map<string, { at: number; serial: string }>();

export class Adb {
  bin: string;
  serial: string;

  constructor(serial: string, bin = 'adb') {
    this.serial = serial;
    this.bin = bin;
  }

  /// adb 会保留 EMULATOR-5556 / emulator-5556 这类大小写不同的旧记录，
  /// 直接传 serial 有时命中不到真实设备；这里把 serial 规范化成列表里的原样值。
  /// 设备列表短时间不会变，模块级缓存避免每条命令都多跑一次 adb devices。
  private serialArgs(args: string[]): string[] {
    if (!args.length || args[0] !== '-s') return args;
    const wanted = args[1];
    if (!wanted) return args;
    const key = wanted.toLowerCase();
    const hit = serialCache.get(key);
    const now = Date.now();
    const real = hit && now - hit.at < 60000
      ? hit.serial
      : parseDevices(Adb.raw(['devices', '-l'], 10000).stdout)
          .find((x) => x.serial.toLowerCase() === key)?.serial;
    if (real) serialCache.set(key, { at: now, serial: real });
    return real ? ['-s', real, ...args.slice(2)] : args;
  }

  static raw(args: string[], timeoutMs = 20000): ShellOut {
    const r = spawnSync('adb', args, { encoding: 'utf8', timeout: timeoutMs });
    if (r.error) return wrap('', String(r.error.message), 1);
    return wrap(r.stdout ?? '', r.stderr ?? '', r.status ?? 1);
  }

  run(args: string[], timeoutMs = 20000): ShellOut {
    const serialArgs = this.serialArgs(['-s', this.serial, ...args]);
    const r = spawnSync(this.bin, serialArgs, { encoding: 'utf8', timeout: timeoutMs });
    if (r.error) return wrap('', String(r.error.message), 1);
    return wrap(r.stdout ?? '', r.stderr ?? '', r.status ?? 1);
  }

  shell(cmd: string, timeoutMs = 20000): ShellOut {
    return this.run(['shell', cmd], timeoutMs);
  }

  /// 请求路径上用异步版本：spawnSync 会卡住整个 node 进程，按键就得排在状态轮询后面
  runAsync(args: string[], timeoutMs = 20000): Promise<ShellOut> {
    return spawnAsync(this.bin, this.serialArgs(['-s', this.serial, ...args]), timeoutMs);
  }

  shellAsync(cmd: string, timeoutMs = 20000): Promise<ShellOut> {
    return this.runAsync(['shell', cmd], timeoutMs);
  }

  /// 原始二进制输出（不经过 utf8 字符串），用于 screencap / exec-out
  runBufferAsync(args: string[], timeoutMs = 20000): Promise<{ code: number; buf: Buffer; stderr: string }> {
    return spawnBufferAsync(this.bin, this.serialArgs(['-s', this.serial, ...args]), timeoutMs);
  }

  /// 实测 Wi-Fi adb：push 19.4MB/s、pull 12.1MB/s，装 30MB APK 约 2 秒 + 安装耗时
  pushAsync(local: string, remote: string, timeoutMs = 180000): Promise<ShellOut> {
    return this.runAsync(['push', local, remote], timeoutMs);
  }

  pullAsync(remote: string, local: string, timeoutMs = 180000): Promise<ShellOut> {
    return this.runAsync(['pull', remote, local], timeoutMs);
  }

  dumpsysAsync(section: string, args = '', timeoutMs = 40000): Promise<ShellOut> {
    return this.shellAsync(`dumpsys ${section}${args ? ' ' + args : ''}`, timeoutMs);
  }

  topActivityAsync(): Promise<string> {
    return (async () => {
      const rows = await Promise.all([
        this.dumpsysAsync('window', 'windows'),
        this.dumpsysAsync('activity', 'activities'),
      ]);
      for (const r of rows) {
        const m = r.stdout.match(/(?:mCurrentFocus|mFocusedApp|mResumedActivity|topResumedActivity)=.*?\b([a-zA-Z][\w.]+\/[^\s}]+)/);
        if (m) return m[1];
      }
      return '';
    })();
  }

  dumpsys(section: string, args = '', timeoutMs = 40000): ShellOut {
    return this.shell(`dumpsys ${section}${args ? ' ' + args : ''}`, timeoutMs);
  }

  getProp(key: string): string {
    return this.shell(`getprop ${key}`).stdout.trim();
  }

  getPropAsync(key: string, timeoutMs = 5000): Promise<string> {
    return this.shellAsync(`getprop ${key}`, timeoutMs).then((r) => r.stdout.trim());
  }

  props(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of this.shell('getprop').stdout.split('\n')) {
      const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }

  /// 解析 `settings list <表>` 的输出，供同步/异步两条路复用
  static parseSettings(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  }

  settingsList(table: 'system' | 'secure' | 'global'): Record<string, string> {
    return Adb.parseSettings(this.shell(`settings list ${table}`).stdout);
  }

  settingsListAsync(table: 'system' | 'secure' | 'global', timeoutMs = 8000): Promise<Record<string, string>> {
    return this.shellAsync(`settings list ${table}`, timeoutMs).then((r) => Adb.parseSettings(r.stdout));
  }

  /// 可启动应用清单（异步版）：完整探测和轻快照都走这条，
  /// 同步 shell 会在请求路径上卡住整个进程，按键就得排队等它
  static parseLauncher(text: string): { component: string; package: string }[] {
    const seen = new Set<string>();
    const apps: { component: string; package: string }[] = [];
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^(?:\d+:\s*)?([\w.]+\/[\w.$]+)$/);
      if (!m || m[1].startsWith('android/')) continue;
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      apps.push({ component: m[1], package: m[1].split('/')[0] });
    }
    return apps;
  }

  static LAUNCHER_QUERY =
    'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER';

  launcherActivitiesAsync(timeoutMs = 30000): Promise<{ component: string; package: string }[]> {
    return this.shellAsync(Adb.LAUNCHER_QUERY, timeoutMs).then((r) => Adb.parseLauncher(r.stdout));
  }

  topActivity(): string {
    for (const section of ['window', 'activity']) {
      const r = this.dumpsys(section, section === 'window' ? 'windows' : 'activities');
      const m = r.stdout.match(/(?:mCurrentFocus|mFocusedApp|mResumedActivity|topResumedActivity)=.*?\b([a-zA-Z][\w.]+\/[^\s}]+)/);
      if (m) return m[1];
    }
    return '';
  }

  packages(): string[] {
    return this.shell('pm list packages', 30000).stdout
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter(Boolean);
  }

  labelFor(component: string): string {
    const pkg = component.split('/')[0];
    const r = this.dumpsys('package', pkg);
    const m = r.stdout.match(/activity Label:\s*(.+)/);
    return m ? m[1].trim() : pkg;
  }

  keyevent(code: number | string, longPress = false): ShellOut {
    return this.shell(`input keyevent ${code}${longPress ? ' --longpress' : ''}`);
  }

  installApk(path: string): ShellOut {
    return this.run(['install', '-r', '-t', path], 120000);
  }
}

export interface AdbDevice {
  serial: string;
  state: string;
  model: string;
}

function parseDevices(text: string): AdbDevice[] {
  const rows: AdbDevice[] = [];
  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const model = parts.find((p) => p.startsWith('model:'))?.slice(6) ?? '';
    rows.push({ serial: parts[0], state: parts[1], model });
  }
  return rows;
}

export function connectedDevices(): AdbDevice[] {
  return parseDevices(Adb.raw(['devices', '-l'], 10000).stdout);
}

/// 唤醒循环里要边等边轮询，同步 spawnSync 会把这段时间里的按键请求全卡住
export async function connectedDevicesAsync(): Promise<AdbDevice[]> {
  return parseDevices((await spawnAsync('adb', ['devices', '-l'], 10000)).stdout);
}

export function connect(host: string, port = 5555): ShellOut {
  return Adb.raw(['connect', `${host}:${port}`], 20000);
}

export async function connectAsync(host: string, port = 5555, timeoutMs = 8000): Promise<ShellOut> {
  return spawnAsync('adb', ['connect', `${host}:${port}`], timeoutMs);
}

/// 待机后设备会以 offline 卡在列表里，adb 不再重握手；必须先 disconnect 再 connect
export function disconnectAsync(serial = '', timeoutMs = 6000): Promise<ShellOut> {
  return spawnAsync('adb', serial ? ['disconnect', serial] : ['disconnect'], timeoutMs);
}
