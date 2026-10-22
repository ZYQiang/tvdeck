import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { under } from './home.ts';
import { Adb } from './adb.ts';

/// 媒体库：图片 / 视频 / 音频上传到这里，自动化脚本里的「播放图片 / 视频」步骤
/// 要么挑库里的一份，要么直接填一个网址。
///
/// 播放动作发生在目标设备上 —— 设备自己去拉这份文件、自己解码、自己渲染，
/// 服务端只是把文件按可流式（支持 Range）的方式喂出去，不做任何转码。
/// 这样做的好处是不用猜设备上装了什么播放器：http 流是 Android 最通用的通路，
/// 自带的播放器、相册、浏览器都认。坏处是服务端得开着、设备和它得在同一张网里。

const MAX_NAME = 80;

export const mediaDir = under('media');

/// 后缀 → MIME。播放端要靠 Content-Type 才知道这份东西该当图片还是视频渲染，
/// 所以清单外的后缀一律不收：认不出来就落进库、播放时再失败，用户只会看到"没反应"
export const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

export const mimeOf = (name: string): string => MEDIA_MIME[path.extname(String(name ?? '')).toLowerCase()] ?? '';

/// 文件名归一化：去掉路径、控制字符和 Windows 上的非法字符，长度封顶。
/// 库里存的是"扁平"的一层文件名，脚本里引用的也是这个名字
export function mediaName(raw: unknown): string {
  const flat = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? '';
  const clean = flat.replace(CONTROL_RE, '').replace(/[:*?"<>|]/g, '_').trim();
  /// 去掉开头的点：'.hidden.mp4' 这种进目录会在列表里"隐身"，用户以为没上传成功
  const safe = clean.replace(/^\.+/, '').slice(0, MAX_NAME);
  return mimeOf(safe) ? safe : '';
}

/// 名字 → 绝对路径。只认媒体库目录下的直接子文件：
/// 这条路径局域网里任何设备都能 GET，绝不能让 ../ 之类的东西把整个磁盘读出去
export function mediaTarget(raw: unknown): string | null {
  const name = mediaName(raw);
  return name ? path.join(mediaDir, name) : null;
}

export interface MediaItem {
  name: string;
  bytes: number;
  at: number;
  mime: string;
  kind: 'video' | 'image' | 'audio';
}

const kindOf = (mime: string): MediaItem['kind'] => (mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : 'image');

export function listMedia(): MediaItem[] {
  try {
    return fs
      .readdirSync(mediaDir, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith('.'))
      .map((d) => {
        const st = fs.statSync(path.join(mediaDir, d.name));
        const mime = mimeOf(d.name);
        return { name: d.name, bytes: st.size, at: Math.round(st.mtimeMs), mime, kind: kindOf(mime) };
      })
      .filter((m) => m.mime && m.bytes > 0)
      .sort((a, b) => b.at - a.at);
  } catch {
    /// 目录还不存在（没上传过东西）不算错误，就是"空的"
    return [];
  }
}

export function mediaExists(name: string): boolean {
  const file = mediaTarget(name);
  return !!file && fs.existsSync(file);
}

export function deleteMedia(raw: unknown): { ok: boolean; detail: string } {
  const file = mediaTarget(raw);
  if (!file || !fs.existsSync(file)) return { ok: false, detail: '这个文件已经不在了' };
  fs.rmSync(file, { force: true });
  return { ok: Boolean(!fs.existsSync(file)), detail: fs.existsSync(file) ? '文件还在' : '已删除' };
}

function lanIp(): string {
  for (const rows of Object.values(os.networkInterfaces())) {
    for (const r of rows ?? []) {
      if (r.family === 'IPv4' && !r.internal) return r.address;
    }
  }
  return '127.0.0.1';
}

/// 给目标设备用的地址。刻意用局域网 IP 而不是 localhost：
/// 这份 URL 是要发到设备上的，localhost 会指回设备自己
export const mediaUrl = (name: string): string =>
  `http://${lanIp()}:${Number(process.env.PORT ?? 8787)}/media/${encodeURIComponent(name)}`;

/// 脚本里可以直接填网址。填网址时没有服务端文件可查，只能按扩展名猜 MIME
export function guessUrlMime(url: string): string {
  try {
    return mimeOf(new URL(url).pathname) || 'video/mp4';
  } catch {
    return 'video/mp4';
  }
}

/// 流式喂文件。必须支持 Range：视频播放器几乎都会先问一下字节范围，
/// 不支持的话要么整段下载完才播、要么直接报"无法播放"
export function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, raw: unknown): void {
  const file = mediaTarget(raw);
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const st = fs.statSync(file);
  const head: Record<string, string> = {
    'Content-Type': mimeOf(file),
    'Accept-Ranges': 'bytes',
    /// no-store：改了同名文件（重新上传）之后设备拉到的不该还是旧的那一份
    'Cache-Control': 'no-store',
  };
  const range = String(req.headers.range ?? '').trim();
  if (!range) {
    res.writeHead(200, { ...head, 'Content-Length': String(st.size) });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (!m[1] && !m[2])) {
    res.writeHead(416, { ...head, 'Content-Range': `bytes */${st.size}` });
    res.end();
    return;
  }
  let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
  /// bytes=-500 这种"最后 500 字节"的写法：m[1] 为空，start 要按文件长度倒着算
  if (!m[1]) start = Math.max(0, st.size - Number(m[2]));
  start = Math.max(0, start);
  end = Math.min(end, st.size - 1);
  if (start > end || start >= st.size) {
    res.writeHead(416, { ...head, 'Content-Range': `bytes */${st.size}` });
    res.end();
    return;
  }
  res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1) });
  fs.createReadStream(file, { start, end }).pipe(res);
}

export interface PlayResult {
  ok: boolean;
  verified: boolean;
  command: string;
  detail: string;
  via?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// 能接住这个地址的组件。挑组件之前先问设备，而不是猜应用名 ——
/// 实测过一台电视，图片配 http 地址时，设备报出来的清单里只有一个「下载器」，
/// 直接 am start 出来的是「下载到本地 / 保存到网络硬盘」对话框，点了半天也看不到图。
/// 而唯一能真正把图显示出来的东西，包名和名字里都没有 browser 这个词
/// （com.media.mix.app / MediaMix），只能靠 activity 的类名才认得出来。
/// 结论：认设备报出来的组件本身，不认应用叫什么。
interface Handler {
  pkg: string;
  act: string;
}

/// 下载器：名字里有 download 的组件。它不是播放器，排到最后
const DOWNLOADISH = /download/i;
/// 真正的播放器 / 相册 / 媒体库。刻意不写裸的 media 与 mx：
/// com.media.mix.app 这种包里带 media 的其实是浏览器，写宽了会把它当播放器
const PLAYERISH = /player|videoplayer|video|movie|gallery|photo|picture|multimedia|vlc|kodi|viewer/i;
/// 网页容器：图片、音频这类没有本地查看器的格式，最后都靠它内联渲染。
/// 数组顺序就是优先级：名字里带 browser 的最靠前，webview 这种通用容器排最后
const WEB_ORDER: RegExp[] = [/browser/i, /chrome/i, /firefox/i, /explore/i, /webview/i];

/// 问设备"谁能打开这个地址/这个类型"。mime 为空时只问通用 http
function queryHandlers(adb: Adb, url: string, mime: string): Handler[] {
  const type = mime ? ` -t ${JSON.stringify(mime)}` : '';
  const r = adb.shell(`cmd package query-activities -a android.intent.action.VIEW -d ${JSON.stringify(url)}${type}`, 20000);
  if (r.code !== 0) return [];
  const rows: Handler[] = [];
  let act = '';
  /// dumpsys 风格的分块输出：每个组件一块，块里 name= 在前、packageName= 在后。
  /// 严格匹配"整行就是 name=xxx"，否则会把 targetActivity=null 之类的也算进来
  for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
    const t = line.trim();
    if (t === 'ActivityInfo:') {
      act = '';
      continue;
    }
    const n = /^name=(\S+)$/.exec(t);
    if (n && !act) {
      act = n[1];
      continue;
    }
    const p = /^packageName=(\S+)$/.exec(t);
    if (p && act) {
      rows.push({ pkg: p[1], act });
      act = '';
    }
  }
  return rows;
}

/// 回读前台窗口。这是"到底有没有打开"的唯一凭据 ——
/// am start 成功只说明 Intent 被受理了，前台还在原来的应用里就等于没播
function currentFocus(adb: Adb): string {
  const r = adb.shell('dumpsys window windows | grep -m1 mCurrentFocus', 15000);
  return `${r.stdout}${r.stderr}`.trim();
}

export interface ViewTarget extends Handler {
  /// 数字越小越优先，取值见下面的 pickTargets
  rank: number;
  /// 打开时要不要带 -t：带类型注册的组件必须带，浏览器注册的是通用 http，带上反而匹配不到
  withType: boolean;
}

/// 把设备报出来的组件排成"最该先试谁"的一张表。全是设备自己说的，没有一条是猜厂牌：
///   10 带类型、名字像播放器 / 相册的
///   20 带类型、其他能接住的（文件管理器、第三方播放器的通用入口）
///   30 通用 http、名字像浏览器的（browser / chrome / firefox / explore / webview 依次靠后）
///   35 通用 http、其他的
///   40 下载器 —— 只在实在没人接的时候才用，用的时候会把"这是下载框不是播放画面"说清楚
function pickTargets(adb: Adb, url: string, mime: string): ViewTarget[] {
  const typed = mime ? queryHandlers(adb, url, mime) : [];
  const generic = queryHandlers(adb, url, '');
  const ranked = new Map<string, ViewTarget>();

  const put = (h: Handler, rank: number, withType: boolean) => {
    const id = `${h.pkg}/${h.act}`;
    const old = ranked.get(id);
    if (!old || rank < old.rank) ranked.set(id, { ...h, rank, withType });
  };

  for (const h of typed) {
    const id = `${h.pkg}/${h.act}`;
    if (DOWNLOADISH.test(id)) put(h, 40, true);
    else put(h, PLAYERISH.test(id) ? 10 : 20, true);
  }
  for (const h of generic) {
    const id = `${h.pkg}/${h.act}`;
    if (DOWNLOADISH.test(id)) {
      put(h, 40, false);
      continue;
    }
    const w = WEB_ORDER.findIndex((re) => re.test(id));
    put(h, w < 0 ? 35 : 30 + w, false);
  }

  return [...ranked.values()].sort((a, b) => a.rank - b.rank);
}

/// 一次尝试：显式点名组件去打开，然后回读前台确认有没有真的切过去
async function tryTarget(adb: Adb, url: string, mime: string, t: ViewTarget): Promise<PlayResult | null> {
  const type = t.withType && mime ? ` -t ${JSON.stringify(mime)}` : '';
  const cmd = `am start -a android.intent.action.VIEW -d ${JSON.stringify(url)}${type} -n ${t.pkg}/${t.act}`;
  const r = adb.shell(cmd, 20000);
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code !== 0 || /error|exception|unable to resolve|does not exist/i.test(out)) return null;

  const who = `${t.pkg} 的 ${t.act.split('.').pop()}`;
  /// 下载器不算"播放"，直接给一句实话，别让用户对着下载框等画面
  if (DOWNLOADISH.test(`${t.pkg} ${t.act}`)) {
    return {
      ok: true,
      verified: false,
      command: cmd,
      via: t.pkg,
      detail: `只有「${t.pkg}」认得这类文件，但它是下载器，只会弹下载框。装一个能播这格式的应用`,
    };
  }
  /// 轮询前台，直到确认切过去或者到点为止。
  /// 不能只等一两次就下结论：实测低性能设备冷启动浏览器要三秒多才拿到前台焦点，
  /// 等太短会误判成"没打开"，然后退到下一个候选（比如消息中心的 WebView），
  /// 屏幕上出来的就不是想放的那份东西了
  for (let i = 0; i < 8; i++) {
    if (i) await sleep(600);
    if (currentFocus(adb).includes(t.pkg)) {
      return { ok: true, verified: true, command: cmd, via: t.pkg, detail: `已在设备上打开：${who}` };
    }
  }
  return {
    ok: true,
    verified: false,
    command: cmd,
    via: t.pkg,
    detail: `地址已交给「${who}」，但没确认到前台切换，看一眼设备有没有画面`,
  };
}

/// 在设备上打开一个地址。动作全部发生在设备端：服务端只递一个 http 地址过去，
/// 设备自己去拉、自己解码渲染。最多试前三个候选，谁先把前台切过去就算谁成功。
export async function openOnDevice(adb: Adb, url: string, mime: string): Promise<PlayResult> {
  const targets = pickTargets(adb, url, mime);
  const plain = `am start -a android.intent.action.VIEW -d ${JSON.stringify(url)}${mime ? ` -t ${JSON.stringify(mime)}` : ''}`;
  if (!targets.length) {
    return { ok: false, verified: false, command: plain, detail: `设备上没有应用认领这个地址（${mime || 'http'}），也没找到浏览器` };
  }

  let soft: PlayResult | null = null;
  for (const t of targets.slice(0, 3)) {
    const r = await tryTarget(adb, url, mime, t);
    if (!r) continue;
    if (r.verified) return r;
    /// 记下第一次"送出去了但没确认"的结果，全都试完还没确认就拿它回报
    soft ??= r;
    if (DOWNLOADISH.test(`${t.pkg} ${t.act}`)) return r;
  }
  return soft ?? { ok: false, verified: false, command: plain, detail: `设备报了组件但一个都没能起来，看一眼设备上的提示` };
}

/// 在设备上播放一份媒体。和 openOnDevice 是同一条通路，
/// 只是把话说成"播放"，以及媒体特有的失败提示
export async function playMediaOnTv(adb: Adb, url: string, mime: string): Promise<PlayResult> {
  const r = await openOnDevice(adb, url, mime);
  return r.ok ? r : { ...r, detail: `没能在设备上播放这个文件：${r.detail}` };
}

// ---------------------------------------------------------------- 推到设备上播

/// 设备上放临时媒体的位置。优先外部存储的 Download 子目录（用户能在文件管理器里看到），
/// 其次存储根目录。刻意不写 /data/local/tmp：那儿普通应用读不到，推过去也放不出来
const DEVICE_DIRS = ['/sdcard/Download/tvdeck', '/sdcard/tvdeck'];

/// shell 单引号转义。文件名里可能有空格、括号、中文，直接拼进命令会被拆开
const shq = (p: string) => `'${String(p).replace(/'/g, `'\\''`)}'`;

function sizeText(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export interface PushedMedia {
  ok: boolean;
  /// 设备上的绝对路径，ok 时才有意义
  path: string;
  bytes: number;
  detail: string;
}

/// 把媒体库里的文件传到设备上，再让设备用它自带的播放器/相册打开。
///
/// 为什么还留这条路：不少大屏设备的自带播放器只认本地文件，不认 http 地址；
/// 而"推一个地址过去"虽然零拷贝，最后打开的可能只是一个网页、一个下载框，
/// 或者第三方播放器的预览小窗。想真的全屏放出来，把文件放到设备上让系统播放器接手最稳。
/// 代价是文件要占设备的存储，而且每次跑都会重新推一遍（同名覆盖，不会越堆越多）
export async function pushMediaToDevice(adb: Adb, raw: unknown): Promise<PushedMedia> {
  const name = mediaName(raw);
  const file = mediaTarget(name);
  if (!name || !file || !fs.existsSync(file)) {
    return { ok: false, path: '', bytes: 0, detail: `媒体库里没有「${String(raw ?? '').slice(0, 40)}」了，重新上传一份再试` };
  }
  const size = fs.statSync(file).size;
  let last = '';
  for (const dir of DEVICE_DIRS) {
    const mk = await adb.shellAsync(`mkdir -p ${shq(dir)}`, 15000);
    if (mk.code !== 0) {
      last = `${dir} 建不了：${(mk.stdout + mk.stderr).trim().slice(0, 80)}`;
      continue;
    }
    const remote = `${dir}/${name}`;
    const r = await adb.pushAsync(file, remote, 600000);
    const text = `${r.stdout}${r.stderr}`;
    if (!/pushed/i.test(text)) {
      last = text.trim().slice(0, 120);
      continue;
    }
    /// 回读：设备上那份的字节数要和本机一致才算传成功。
    /// 只信 adb 自己打的"成功"是不够的（存储满、权限不足都可能报成功）
    const check = await adb.shellAsync(`ls -l ${shq(remote)}`, 20000);
    const bytes = Number((check.stdout.match(/\s(\d+)\s+\d{4}-/) ?? [])[1] ?? 0);
    if (bytes === size) return { ok: true, path: remote, bytes, detail: `已传到设备 ${remote}（${sizeText(bytes)}）` };
    last = `推过去但对不上：设备端 ${bytes || '读不到'} / 服务端 ${size}`;
  }
  return { ok: false, path: '', bytes: 0, detail: `没能把文件传到设备上：${last || '设备上的目录都写不进去'}` };
}
