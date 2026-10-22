import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Adb } from './adb.ts';

/// 语义键名 → 设备 keylayout 里可能出现的键名，按顺序取第一个命中的。
/// 扫描码从各品牌自己的 .kl 解析，不写死 evdev 码，所以换一台 Android 设备也能自适应。
export const KL_NAMES: Record<string, string[]> = {
  up: ['DPAD_UP'],
  down: ['DPAD_DOWN'],
  left: ['DPAD_LEFT'],
  right: ['DPAD_RIGHT'],
  ok: ['DPAD_CENTER', 'ENTER'],
  back: ['BACK', 'ESCAPE'],
  home: ['HOME'],
  menu: ['MENU'],
  info: ['INFO'],
  guide: ['GUIDE', 'TV'],
  apps: ['APP_LIST', 'APP_SWITCH'],
  volUp: ['VOLUME_UP'],
  volDown: ['VOLUME_DOWN'],
  mute: ['VOLUME_MUTE', 'MUTE'],
  chUp: ['CHANNEL_UP'],
  chDown: ['CHANNEL_DOWN'],
  play: ['MEDIA_PLAY'],
  pause: ['MEDIA_PAUSE'],
  playPause: ['MEDIA_PLAY_PAUSE', 'PLAY'],
  prev: ['MEDIA_PREVIOUS'],
  next: ['MEDIA_NEXT'],
  stop: ['MEDIA_STOP'],
  record: ['MEDIA_RECORD'],
  red: ['PROG_RED'],
  green: ['PROG_GREEN'],
  yellow: ['PROG_YELLOW'],
  blue: ['PROG_BLUE'],
  caption: ['SUBTITLE', 'CAPTIONS'],
  settings: ['SETTINGS'],
  power: ['POWER'],
  tvInput: ['TV_SOURCE', 'INPUT'],
};

export interface KeyTarget {
  device: string;
  name: string;
  scan: number;
}

export interface InputPath {
  via: 'evdev' | 'keyevent';
  device: string;
  keys: Record<string, KeyTarget>;
  recordSize: number;
  note: string;
  /// 输入设备的可读名字（dumpsys input 里的 "built-in keyboard" 这类）。
  /// 页面上「直写 /dev/input/event0 · 17 个键免冷启动」后面只想带这个名字，
  /// 以前把 keylayout 路径和重复的键数一起塞进 note，读起来像报错日志
  deviceLabel?: string;
}

/// 鼠标（触控板）通路。触控板要的是「相对移动」，安卓 8 的 `input` 命令没有
/// mouse move / click / scroll（实测 Unknown command），只能直写 evdev。
/// via=none 表示这台设备根本没有鼠标驱动（模拟器、纯触屏设备），
/// 页面必须退回绝对坐标点按，而不是把触控板当成能用。
export interface MousePath {
  via: 'evdev' | 'none';
  device: string;
  name: string;
  recordSize: number;
  wheel: boolean;
  hwheel: boolean;
  /// 语义键名 → evdev BTN_* 码；这台设备没有的键不会出现在这里
  buttons: Record<string, number>;
  note: string;
}

/// evdev 按键码：鼠标左中右键 + 侧键
export const BTN_CODES: Record<string, number> = { left: 272, right: 273, middle: 274, side: 275, extra: 276 };

export const REL_CODES = { x: 0, y: 1, wheel: 8, hwheel: 11 };
export const EV_SYN = 0;
export const EV_KEY = 1;
export const EV_REL = 2;

export function frame(size: number, type: number, code: number, value: number): Buffer {
  const b = Buffer.alloc(size);
  const off = size - 8;
  b.writeUInt16LE(type & 0xffff, off);
  b.writeUInt16LE(code & 0xffff, off + 2);
  b.writeInt32LE(value, off + 4);
  return b;
}

/// 按下 + SYN + 抬起 + SYN
export function pressFrame(size: number, scan: number): Buffer {
  return Buffer.concat([frame(size, 1, scan, 1), frame(size, 0, 0, 0), frame(size, 1, scan, 0), frame(size, 0, 0, 0)]);
}

const octal = (buf: Buffer) => [...buf].map((x) => `\\${x.toString(8).padStart(3, '0')}`).join('');

/// getevent -pl 文本 → 每个输入设备支持的 evdev 能力名
/// 鼠标设备没有 keylayout，parseEventHub 那条路查不到它，只能看能力位
export function parseGeteventCaps(text: string): { device: string; name: string; codes: Set<string> }[] {
  const rows: { device: string; name: string; codes: Set<string> }[] = [];
  let cur: { device: string; name: string; codes: Set<string> } | null = null;
  let inEvents = false;
  for (const line of text.split('\n')) {
    const dev = line.match(/^add device\s+\d+:\s+(\S+)/);
    if (dev) {
      cur = { device: dev[1], name: '', codes: new Set() };
      rows.push(cur);
      inEvents = false;
      continue;
    }
    if (!cur) continue;
    const nm = line.match(/^\s+name:\s+"?(.*?)"?\s*$/);
    if (nm) {
      cur.name = nm[1];
      continue;
    }
    if (/^\s+events:\s*$/.test(line)) {
      inEvents = true;
      continue;
    }
    /// input props / 其他段落开始，能力列表结束
    if (/^\s{2}\w/.test(line) && !inEvents) continue;
    if (/^\s+input props:/.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    /// "KEY (0001): BTN_MOUSE BTN_RIGHT ..." 以及后面续行的纯大写符号名
    const body = line.replace(/^\s+(?:KEY|REL|ABS|MSC|SW|LED|SND|FF)\s+\([0-9a-fA-F]+\):/, '');
    for (const tok of body.split(/[\s,]+/)) if (/^[A-Z][A-Z0-9_]*$/.test(tok)) cur.codes.add(tok);
  }
  return rows;
}

/// dumpsys input 的 Event Hub 段 → 带 keylayout 的 /dev/input/eventN 设备
export function parseEventHub(text: string): { device: string; name: string; kl: string }[] {
  const rows: { device: string; name: string; kl: string }[] = [];
  let cur: { device: string; name: string; kl: string } | null = null;
  const flush = () => {
    if (cur && cur.device.startsWith('/dev/input/event') && cur.kl && cur.name !== 'Virtual') {
      rows.push({ ...cur });
    }
    cur = null;
  };
  for (const line of text.split('\n')) {
    const head = line.match(/^ {4}-?\d+:\s+(\S.*?)\s*$/);
    if (head) {
      flush();
      cur = { device: '', name: head[1], kl: '' };
      continue;
    }
    if (!cur) continue;
    const path = line.match(/^ {6}Path:\s*(\S+)/);
    if (path) cur.device = path[1];
    const kl = line.match(/^ {6}KeyLayoutFile:\s*(\S+)/);
    if (kl) cur.kl = kl[1];
  }
  flush();
  return rows;
}

/// keylayout 文本 → { 键名: 扫描码 }，同名取第一条，和 InputReader 一致
export function parseKeyLayout(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*key\s+(\d+)\s+([A-Za-z][\w]*)/);
    if (!m) continue;
    const name = m[2].toUpperCase();
    if (!(name in out)) out[name] = Number(m[1]);
  }
  return out;
}

/// dumpsys input 里的设备名带着调试后缀（"qwerty2 (aka device 0 - built-in keyboard)"），
/// 页面上只需要能认出是哪一个键盘，取 aka 后面那个名字，没有就用原名
export function prettyInputName(name: string): string {
  const raw = String(name || '').trim();
  const aka = /\(aka\s+device\s+\d+\s*-\s*(.+?)\)/i.exec(raw);
  if (aka) return aka[1].trim();
  return raw.replace(/\s*\(aka.*$/i, '').trim();
}

export class EvdevInjector {
  private shell: ChildProcessWithoutNullStreams | null = null;
  private adb: Adb;

  constructor(adb: Adb) {
    this.adb = adb;
  }

  /// 选覆盖语义键最多、且 adb 用户可写的输入设备
  async discover(): Promise<InputPath> {
    const hub = await this.adb.shellAsync('dumpsys input', 20000);
    const candidates = parseEventHub(hub.stdout);
    const bitness = (await this.adb.shellAsync('uname -m', 10000)).stdout.trim();
    const recordSize = /64/.test(bitness) ? 24 : 16;
    let best: InputPath = {
      via: 'keyevent',
      device: '',
      keys: {},
      recordSize,
      // 文案不写 evdev/keylayout 这类术语：直写不可用时用户只需要知道
      // 「按键走系统通道，功能一样」，具体原因在日志里查
      note: candidates.length ? '走系统通道，功能一致' : '没有可直写的按键设备，只能走系统通道',
    };
    for (const c of candidates) {
      const canWrite = (await this.adb.shellAsync(`test -w ${c.device} && echo yes`, 10000)).stdout.includes('yes');
      if (!canWrite) continue;
      const kl = await this.adb.shellAsync(`cat ${c.kl}`, 15000);
      if (!kl.stdout.includes('key ')) continue;
      const table = parseKeyLayout(kl.stdout);
      const keys: Record<string, KeyTarget> = {};
      for (const [action, names] of Object.entries(KL_NAMES)) {
        const hit = names.find((n) => table[n] !== undefined);
        if (hit !== undefined) keys[action] = { device: c.device, name: hit, scan: table[hit] };
      }
      const count = Object.keys(keys).length;
      if (count <= Object.keys(best.keys).length) continue;
      best = {
        via: count ? 'evdev' : 'keyevent',
        device: c.device,
        keys,
        recordSize,
        deviceLabel: prettyInputName(c.name),
        // 键数和路径页面自己会拼，这里不再重复一遍，
        // 否则「直写 /dev/input/event0 · 17 个键…（… · 17 个键可直写）」读起来像报错
        note: '',
      };
    }
    return best;
  }

  private ensureShell(): ChildProcessWithoutNullStreams | null {
    if (this.shell?.stdin.writable) return this.shell;
    this.shell?.kill('SIGKILL');
    try {
      const p = spawn('adb', ['-s', this.adb.serial, 'shell'], { stdio: ['pipe', 'ignore', 'ignore'] }) as ChildProcessWithoutNullStreams;
      p.on('close', () => {
        if (this.shell === p) this.shell = null;
      });
      p.on('error', () => {
        if (this.shell === p) this.shell = null;
      });
      this.shell = p;
      return p;
    } catch {
      this.shell = null;
      return null;
    }
  }

  /// 常驻 shell + printf 内建直写设备节点：没有 fork，也没有 app_process 冷启动
  write(buf: Buffer, device: string): boolean {
    const p = this.ensureShell();
    if (!p) return false;
    try {
      p.stdin.write(`printf '${octal(buf)}' > ${device}\n`);
      return true;
    } catch {
      this.shell = null;
      return false;
    }
  }

  press(target: KeyTarget, size: number, holdMs = 0): boolean {
    if (!holdMs) return this.write(pressFrame(size, target.scan), target.device);
    const held = this.write(frame(size, 1, target.scan, 1), target.device) && this.write(frame(size, 0, 0, 0), target.device);
    // 抬起放进后台子 shell，长按期间注入管道仍然空闲
    const p = this.ensureShell();
    if (!p || !held) return false;
    try {
      p.stdin.write(`(sleep ${(holdMs / 1000).toFixed(2)}; printf '${octal(frame(size, 1, target.scan, 0))}' > ${target.device}) &\n`);
      return true;
    } catch {
      this.shell = null;
      return false;
    }
  }

  close() {
    this.shell?.kill('SIGKILL');
    this.shell = null;
  }
}

/// 探测设备的鼠标（触控板）能力。鼠标设备没有 keylayout，
/// parseEventHub 那条键盘通路查不到它，只能看 getevent -pl 的能力位。
/// 命中条件：既能 REL_X/REL_Y 相对移动，也有 BTN_MOUSE/BTN_TOUCH 按下，
/// 且 adb 用户对节点可写。三个条件缺一个就退到 via:'none'，页面走绝对点按。
export async function discoverMouse(adb: Adb): Promise<MousePath> {
  const getevent = await adb.shellAsync('getevent -pl', 15000);
  const caps = parseGeteventCaps(getevent.stdout);
  const bitness = (await adb.shellAsync('uname -m', 10000)).stdout.trim();
  const recordSize = /64/.test(bitness) ? 24 : 16;
  /// 收集所有「可写 + REL_X/REL_Y + BTN_MOUSE」的设备再打分，不取第一个命中。
  /// 关键区分：触控屏（带 ABS_MT_POSITION_X）虽然也可能报 REL_X，但 Android 的
  /// InputReader 会把它归成 TOUCHSCREEN，写进去的 REL 事件不会产生指针移动；
  /// 真正能当鼠标用的是独立的 CURSOR 设备（无 ABS_MT）。所以带多点触摸的要降权。
  const candidates: { device: string; name: string; codes: Set<string>; score: number }[] = [];
  for (const c of caps) {
    if (!(c.codes.has('REL_X') && c.codes.has('REL_Y') && c.codes.has('BTN_MOUSE'))) continue;
    const canWrite = (await adb.shellAsync(`test -w ${c.device} && echo yes`, 10000)).stdout.includes('yes');
    if (!canWrite) continue;
    let score = 0;
    if (!c.codes.has('ABS_MT_POSITION_X')) score += 8; /// 纯光标设备，不是触控屏
    if (c.codes.has('REL_WHEEL')) score += 3;
    if (c.codes.has('BTN_RIGHT')) score += 2;
    candidates.push({ ...c, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const c = candidates[0];
  if (c) {
    const btns: Record<string, number> = {};
    if (c.codes.has('BTN_MOUSE')) btns.left = BTN_CODES.left;
    if (c.codes.has('BTN_RIGHT')) btns.right = BTN_CODES.right;
    if (c.codes.has('BTN_MIDDLE')) btns.middle = BTN_CODES.middle;
    if (c.codes.has('BTN_SIDE')) btns.side = BTN_CODES.side;
    if (c.codes.has('BTN_EXTRA')) btns.extra = BTN_CODES.extra;
    return {
      via: 'evdev',
      device: c.device,
      name: c.name,
      recordSize,
      wheel: c.codes.has('REL_WHEEL'),
      hwheel: c.codes.has('REL_HWHEEL'),
      buttons: btns,
      note: `${c.name} · 相对移动 + ${Object.keys(btns).length} 个键${c.codes.has('REL_WHEEL') ? ' + 滚轮' : ''}`,
    };
  }
  const reason = caps.length
    ? `扫到 ${caps.length} 个输入设备，没有可写的独立鼠标（REL_X/REL_Y + BTN_MOUSE）`
    : 'getevent -pl 没有输出（设备可能不支持 adb shell getevent）';
  return { via: 'none', device: '', name: '', recordSize, wheel: false, hwheel: false, buttons: {}, note: reason };
}
