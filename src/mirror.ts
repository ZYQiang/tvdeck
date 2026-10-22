import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Adb } from './adb.ts';
import type { DeviceProfile } from './profile.ts';
import { openOnDevice } from './media.ts';

export interface Frame {
  buf: Buffer;
  seq: number;
  ts: number;
  ms: number;
}

const workDir = path.join(os.tmpdir(), 'tvdeck-mirror');
const pngPath = path.join(workDir, 'frame.png');
const jpgPath = path.join(workDir, 'frame.jpg');

export interface MirrorOptions {
  fps: number;
  width: number;
  quality: number;
  display: number;
}

export const defaultOptions: MirrorOptions = { fps: 3, width: 1280, quality: 55, display: 1 };

const exec = (file: string, args: string[], ms = 8000) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, args, { timeout: ms }, (err) => (err ? reject(err) : resolve()));
  });

let seq = 0;

/// 「画面镜像」抓的是运行本服务这台电脑的桌面。抓屏工具各系统不同：
/// macOS 用内置的 screencapture，Windows/Linux 走 ffmpeg 的 gdigrab / x11grab。
/// 这里只按实际存在的工具分派，不写死某个平台 —— 换台机器跑同一个服务不用改代码。
export function capturePlan(): { tool: string; note: string } {
  if (process.platform === 'darwin') return { tool: 'screencapture', note: 'macOS screencapture' };
  if (process.platform === 'win32') return { tool: 'ffmpeg', note: 'Windows ffmpeg gdigrab' };
  if (process.platform === 'linux') return { tool: 'ffmpeg', note: 'Linux ffmpeg x11grab' };
  return { tool: '', note: `不支持的平台 ${process.platform}` };
}

/// 抓屏被拒时该去哪一步开权限。各系统路径不同，按运行平台给，换机器不用改代码。
function capturePermissionHint(): string {
  if (process.platform === 'darwin')
    return '在「系统设置 → 隐私与安全性 → 屏幕录制」里勾选运行本服务的程序，然后重启服务';
  if (process.platform === 'win32')
    return '检查是否有程序占用了桌面抓取，或需要以更高权限重启服务';
  return '检查当前用户是否有访问显示服务的权限（Wayland 需开启远程桌面授权），然后重启服务';
}

export async function grabFrame(o: MirrorOptions): Promise<Frame> {
  fs.mkdirSync(workDir, { recursive: true });
  const t0 = Date.now();
  try {
    const plan = capturePlan();
    if (plan.tool === 'screencapture') {
      /// macOS：screencapture 抓整屏 PNG，再交给 sips 缩放 + 转 JPEG
      await exec('screencapture', ['-x', '-D', String(o.display), pngPath]).catch(() => exec('screencapture', ['-x', pngPath]));
      await exec('sips', ['-Z', String(o.width), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(o.quality), pngPath, '--out', jpgPath]);
    } else if (plan.tool === 'ffmpeg') {
      /// Windows / Linux：ffmpeg 抓一帧，缩放到目标宽度并直接编码成 JPEG。
      /// q:v 是 2(最好)~31(最差) 的量化尺度，把页面上的 JPEG 质量数换算过来
      const input = process.platform === 'win32'
        ? ['-f', 'gdigrab', '-i', 'desktop']
        : ['-f', 'x11grab', '-i', `:0.${Math.max(0, o.display - 1)}`];
      const q = Math.min(31, Math.max(2, Math.round(((100 - o.quality) / 100) * 29) + 2));
      await exec('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', ...input,
        '-frames:v', '1', '-vf', `scale=${o.width}:-2`, '-q:v', String(q), jpgPath,
      ], 12000);
    } else {
    throw new Error(`服务端（${plan.note}）没有可用的抓屏通路，无法发送服务端画面`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (/could not create image|StreamError|not authorized|Operation not permitted/i.test(msg)) {
      throw new Error(`抓屏被系统拒绝：${capturePermissionHint()}`);
    }
    throw e;
  }
  const buf = fs.readFileSync(jpgPath);
  return { buf, seq: ++seq, ts: Date.now(), ms: Date.now() - t0 };
}

export class MirrorHub {
  private listeners = new Set<(f: Frame) => void>();
  /// 观看端挂断的回调：stop() 要把已经在放的流真正结束掉，
  /// 否则设备上只是不再来新帧、停在最后一帧上，看着像「停止画面镜像没反应」
  private ends = new Map<(f: Frame) => void, () => void>();
  private timer: NodeJS.Timeout | null = null;
  private latest: Frame | null = null;
  private busy = false;
  // 拉帧（/mirror.jpg）和 MJPEG 定时采集写同一组临时文件，并发会读出半张 JPEG，所以串行
  private queue: Promise<unknown> = Promise.resolve();
  opts: MirrorOptions = { ...defaultOptions };
  lastError = '';

  subscribers(): number {
    return this.listeners.size;
  }

  status() {
    return {
      running: this.timer !== null,
      fps: this.opts.fps,
      width: this.opts.width,
      subs: this.listeners.size,
      lastFrameMs: this.latest?.ms ?? null,
      lastError: this.lastError,
    };
  }

  private capture(): Promise<Frame> {
    const run = () =>
      grabFrame(this.opts).then((f) => {
        this.latest = f;
        return f;
      });
    const out = this.queue.then(run, run);
    this.queue = out.catch(() => undefined);
    return out;
  }

  start(opts: Partial<MirrorOptions> = {}): void {
    this.opts = { ...this.opts, ...opts };
    if (this.timer) return;
    const loop = async () => {
      if (this.busy || !this.listeners.size) return;
      this.busy = true;
      try {
        const f = await this.capture();
        for (const l of this.listeners) l(f);
      } catch (e) {
        this.lastError = (e as Error).message;
      } finally {
        this.busy = false;
      }
    };
    this.timer = setInterval(loop, Math.round(1000 / Math.max(0.5, this.opts.fps)));
    loop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    /// 先摘干净再关响应：res.end() 会触发 close → off() → stop()，
    /// 边遍历边清集合会漏关，也很容易在这个回调里再绕回来一次
    const ends = [...this.ends.values()];
    this.ends.clear();
    this.listeners.clear();
    for (const end of ends) {
      try {
        end();
      } catch {
        /* 观看端已经走了，忽略 */
      }
    }
  }

  addListener(l: (f: Frame) => void, onEnd?: () => void): () => void {
    this.listeners.add(l);
    if (onEnd) this.ends.set(l, onEnd);
    this.start();
    return () => {
      this.listeners.delete(l);
      this.ends.delete(l);
      if (!this.listeners.size) this.stop();
    };
  }

  snapshot(): Promise<Frame> {
    return this.capture();
  }
}

/// 在目标 ADB 设备上打开一个网址。谁去打开交给 openOnDevice 决定 —— 它问设备自己报
/// 出来的组件清单，而不是按应用名猜浏览器：有的设备唯一能渲染网页的应用包名和名字里
/// 都没有 browser 这个词，凭名字永远找不到它。
/// 这里只把结果翻译成调用方一直在用的 { command, ok, detail, pkg } 形状
export async function openUrlOnDevice(adb: Adb, profile: DeviceProfile, url: string) {
  void profile;
  const r = await openOnDevice(adb, url, '');
  return { command: r.command, ok: r.ok, detail: r.detail, pkg: r.via ?? '' };
}

/// 旧的内部命名保留一个别名，避免其它调用方在升级服务时找不到函数
export const openUrlOnTv = openUrlOnDevice;

// ---------------------------------------------------------------- 设备屏幕直播

export interface DeviceFrame {
  buf: Buffer;
  seq: number;
  ts: Date;
  ms: number;
  /// 帧来自哪台设备。设备切换或重连后，旧帧不能继续冒充当前画面。
  serial: string;
}

export interface DeviceLiveOptions {
  fps: number;
  width: number;
  quality: number;
}

/// 5 帧/秒是「看着像在动」和「不把设备抓屏占满」的折中。
/// 单帧实测：screencap 约 95ms，缩放编码约 20ms，所以 5fps 的预算很宽松；
/// 真实设备走无线 adb 时 screencap 会慢到几百毫秒，这时循环会自己少发帧，
/// 不会像逐帧轮询那样把请求排成一串。
export const deviceLiveDefaults: DeviceLiveOptions = { fps: 5, width: 1280, quality: 65 };

/// 每帧之间至少留这么久的空档。抓屏把 adb 占满时，这一页别的请求（读状态、
/// 按遥控键）全得排队，表现出来就是「点了没反应」。留一条缝，按键最多等一帧
const DEVICE_LIVE_GAP_MS = 50;

/// PNG → JPEG 用什么工具，按本机实际存在的分派，不写死平台。
/// MJPEG 的多段流只能推 JPEG，所以这一条是直播流的硬前提；
/// 没有可用工具时如实报出来，页面退回逐帧轮询（那条路只用 PNG，不依赖编码器）。
export function jpegPlan(): { tool: string; note: string } {
  if (process.platform === 'darwin') return { tool: 'sips', note: 'macOS sips' };
  if (process.platform === 'win32') return { tool: 'ffmpeg', note: 'Windows ffmpeg' };
  if (process.platform === 'linux') return { tool: 'ffmpeg', note: 'Linux ffmpeg' };
  return { tool: '', note: `不支持的平台 ${process.platform}` };
}

export async function encodeJpeg(png: Buffer, o: { width: number; quality: number }): Promise<Buffer> {
  const plan = jpegPlan();
  if (!plan.tool) throw new Error(`服务端（${plan.note}）没有可用的 JPEG 编码器，设备直播流不可用`);
  /// 直播循环和单帧预览都可能同时进到这里。共用一个 in/out 文件名时，
  /// 两边会互相读到半张图、甚至让 sips 直接失败（预览偶发 500）。
  /// 每次编码用独立临时文件，谁先谁后互不影响，结束后当场清掉。
  const dir = path.join(os.tmpdir(), `tvdeck-live-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const src = path.join(dir, `${id}.png`);
  const dst = path.join(dir, `${id}.jpg`);
  fs.writeFileSync(src, png);
  try {
    if (plan.tool === 'sips') {
      await exec('sips', ['-Z', String(o.width), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(o.quality), src, '--out', dst]);
    } else {
      /// q:v 是 2(最好)~31(最差) 的量化尺度，把页面上的质量数换算过来
      const q = Math.min(31, Math.max(2, Math.round(((100 - o.quality) / 100) * 29) + 2));
      await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', `scale=${o.width}:-2`, '-q:v', String(q), dst], 12000);
    }
    return fs.readFileSync(dst);
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(dst, { force: true });
  }
}

export interface DeviceLike {
  online: boolean;
  adb: Adb | null;
}

/// 设备自己的屏幕，「直播」那一路：一条抓屏循环、多个观看端共用。
/// 和上面投屏 hub 的结构一样，区别只在帧从哪儿来 —— 投屏抓本机桌面，
/// 这里抓设备屏幕。共用的意义：三个标签页开着也只是一份 screencap 的开销，
/// 谁都不看时循环停掉，adb 立刻还回去给别的请求
export class DeviceLiveHub {
  private listeners = new Set<(f: DeviceFrame) => void>();
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private busy = false;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private recent: number[] = [];
  latest: DeviceFrame | null = null;
  lastError = '';
  opts: DeviceLiveOptions = { ...deviceLiveDefaults };
  /// 每帧现问一次「现在连的是哪台设备」：重连 / 换 IP 之后直播流要跟着换，
  /// 所以这里存的是一个取值函数，不是某一刻的 adb 句柄
  private device: () => DeviceLike;

  constructor(device: () => DeviceLike) {
    this.device = device;
  }

  subscribers(): number {
    return this.listeners.size;
  }

  /// 实测帧率：数最近 2 秒落地了几帧。配置里写 5fps 不等于真的到 5 帧，
  /// 无线 adb 上这两者经常差一倍，报实测值才不会被自己的配置骗
  actualFps(): number {
    const now = Date.now();
    const win = this.recent.filter((t) => now - t <= 2000);
    if (win.length < 2) return 0;
    const span = (win[win.length - 1]! - win[0]!) / 1000;
    return span > 0 ? Math.round(((win.length - 1) / span) * 10) / 10 : 0;
  }

  status() {
    const plan = jpegPlan();
    return {
      running: this.active,
      subs: this.listeners.size,
      fps: this.opts.fps,
      actualFps: this.actualFps(),
      width: this.opts.width,
      quality: this.opts.quality,
      lastFrameMs: this.latest?.ms ?? null,
      frames: this.seq,
      encoder: plan.tool,
      encoderNote: plan.note,
      available: Boolean(plan.tool),
      deviceSerial: this.latest?.serial ?? '',
      lastError: this.lastError,
    };
  }

  /// 只返回“当前设备”的新鲜帧。直播循环停掉后 latest 会一直留在内存里，
  /// 如果直接复用，用户重新打开预览时就会先看到上一次会话的过期画面。
  latestFor(serial: string, maxAgeMs = 1800): DeviceFrame | null {
    const f = this.latest;
    if (!f || !serial || f.serial !== serial) return null;
    if (Date.now() - f.ts.getTime() > maxAgeMs) return null;
    return f;
  }

  private capture(): Promise<DeviceFrame> {
    const run = async () => {
      const d = this.device();
      if (!d.online || !d.adb) throw new Error('设备离线，无法抓取屏幕');
      const serial = d.adb.serial;
      const t0 = Date.now();
      const r = await d.adb.runBufferAsync(['exec-out', 'screencap -p'], 15000);
      if (r.code !== 0 || !r.buf.length) throw new Error(`screencap 失败：${r.stderr || '空输出'}`);
      const buf = await encodeJpeg(r.buf, { width: this.opts.width, quality: this.opts.quality });
      const f: DeviceFrame = { buf, seq: ++this.seq, ts: new Date(), ms: Date.now() - t0, serial };
      this.latest = f;
      this.recent.push(Date.now());
      if (this.recent.length > 60) this.recent.splice(0, this.recent.length - 60);
      this.lastError = '';
      return f;
    };
    /// 同一时刻只跑一次抓屏：两个观看端同时来也不能并发起两条 adb
    const out = this.queue.then(run, run);
    this.queue = out.catch(() => undefined);
    return out;
  }

  /// 抓一帧、发给所有观看端、再排下一帧。
  /// 不用 setInterval：抓一帧本身要 100~200ms（设备越慢越久），固定周期只会在慢设备上
  /// 把请求堆起来 —— 这页别处还要读状态，adb 一直占着就会「点了没反应」。
  /// 排下一拍时才决定间隔，并且永远留道缝给别的请求插进来
  private loop = async (): Promise<void> => {
    this.timer = null;
    if (!this.listeners.size) {
      this.active = false;
      return;
    }
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      const f = await this.capture();
      for (const l of this.listeners) l(f);
    } catch (e) {
      this.lastError = (e as Error).message;
      /// 抓屏失败没能出帧：等下一拍重试，不在这里把观看端踢掉
    } finally {
      this.busy = false;
    }
    if (!this.listeners.size) {
      this.active = false;
      return;
    }
    const period = 1000 / Math.max(0.5, this.opts.fps);
    const wait = Math.max(DEVICE_LIVE_GAP_MS, Math.round(period - (Date.now() - t0)));
    this.timer = setTimeout(this.loop, wait);
  };

  start(opts: Partial<DeviceLiveOptions> = {}): void {
    this.opts = { ...this.opts, ...opts };
    if (this.active) return;
    this.active = true;
    void this.loop();
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /// 改帧率/宽度立刻生效：重排下一拍就行，正在跑的那一帧不用打断
  setOpts(o: Partial<DeviceLiveOptions>): void {
    this.opts = { ...this.opts, ...o };
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.loop, 0);
  }

  addListener(l: (f: DeviceFrame) => void): () => void {
    this.listeners.add(l);
    this.start();
    return () => {
      this.listeners.delete(l);
      if (!this.listeners.size) this.stop();
    };
  }

  snapshot(): Promise<DeviceFrame> {
    return this.capture();
  }
}
