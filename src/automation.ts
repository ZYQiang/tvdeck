import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { under } from './home.ts';
import { Adb } from './adb.ts';
import type { DeviceProfile } from './profile.ts';
import {
  KEYS,
  launchNamed,
  nightControl,
  pressKey,
  resolveKey,
  setVolumePercent,
  sleepTv,
  typeText,
  wakeTv,
} from './commands.ts';
import { openUrlOnDevice } from './mirror.ts';
import { guessUrlMime, mediaExists, mediaUrl, mimeOf, openOnDevice, playMediaOnTv, pushMediaToDevice } from './media.ts';

/// 自动化脚本：把「按键 / 启动应用 / 调音量 / 护眼 / 电源与唤醒 / 输入文字 / 打开网址 / 播放媒体 / 等待」
/// 串成一条可复用的动作序列。手动一键跑，也可以按「每天定点」或「设备上线」自动跑。
///
/// 三条刻意的设计约束：
///   1. 只执行白名单动作，绝不执行任意 shell。这条通路能远程操作设备，
///      放开成"用户自己写命令"等于把服务端变成一个远程命令执行点，
///      而这个服务默认监听 0.0.0.0，局域网里谁都够得着。
///   2. 每一步都复用页面同款的动作实现（先探测再执行、执行后回读），
///      所以脚本跑出来的结果和手点按钮完全一致，不存在"脚本专用后门"。
///   3. 脚本存在服务端数据目录（TVDECK_HOME），不下发到设备。
///      设备可以随时换一台，脚本跟着服务走，不用重新写。

export type StepKind =
  | 'key'
  | 'launch'
  | 'volume'
  | 'night'
  | 'power'
  | 'media'
  | 'text'
  | 'url'
  | 'wait';

export interface Step {
  kind: StepKind;
  /// 含义随类型走：按键名 / 应用包名或名字 / on|off / sleep|wake /
  /// 媒体库文件名或网址 / 文字 / 网址
  value?: string;
  /// 音量档位（0-100）、等待毫秒数
  n?: number;
  /// key 专用：是否长按
  long?: boolean;
  /// media 专用：是否先把文件传到设备上再播。
  /// 有些设备的自带播放器只认本地文件，只有这条路能真的全屏放出来
  local?: boolean;
}

export interface Trigger {
  kind: 'manual' | 'daily' | 'connect';
  /// daily 专用：HH:MM（服务端本机时区）
  at?: string;
  /// connect 专用：设备上线后再等这么多毫秒才跑，给设备把桌面拉起来的时间
  delayMs?: number;
}

export interface Script {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];
  createdAt: number;
  updatedAt: number;
  /// 定时触发用：记下最近一次真跑过的分钟（YYYY-MM-DDTHH:MM）。
  /// 落到盘上是为了服务在那一分钟内重启时不会把同一次定时再跑一遍。
  firedKey?: string;
  last?: RunSummary;
}

export interface RunSummary {
  at: number;
  ok: boolean;
  by: string;
  ms: number;
  detail: string;
}

export type StepState = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped';

export interface StepView {
  index: number;
  kind: StepKind;
  label: string;
  text: string;
  state: StepState;
  detail: string;
  ms: number;
  command?: string;
}

export interface RunResult {
  id: string;
  scriptId: string;
  name: string;
  by: string;
  at: number;
  ms: number;
  ok: boolean;
  detail: string;
  steps: StepView[];
}

export interface AutomationStore {
  scripts: Script[];
  history: RunResult[];
  /// 总开关：关掉之后定时与上线触发都不再自动跑，手动运行不受影响
  enabled: boolean;
  /// 上一次 tick 时设备是否在线，用来识别「刚上线」这个边沿
  lastOnline: boolean;
  lastTick: number;
}

export const storePath = under('automation.json');

const MAX_STEPS = 24;
const MAX_NAME = 40;
const MAX_HISTORY = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 元信息

/// 步骤类型清单。页面上的下拉框直接读这个，不另写一份 —— 前后端对"有哪些动作"的口径永远一致
export const STEP_META: { kind: StepKind; label: string; hint: string }[] = [
  { kind: 'key', label: '发送按键', hint: '设备支持的一个按键，可选择长按' },
  { kind: 'launch', label: '启动应用', hint: '按包名或应用名打开' },
  { kind: 'volume', label: '设置音量', hint: '按百分比 0 到 100，换算成设备的实际档数并回读' },
  { kind: 'night', label: '护眼模式', hint: '设备没有夜灯通路时会如实报不支持' },
  { kind: 'power', label: '电源 / 唤醒', hint: '电源走设备电源键；唤醒需要调试连接可用' },
  { kind: 'media', label: '播放图片 / 视频', hint: '挑媒体库文件或填网址，设备自己拉取播放' },
  { kind: 'text', label: '输入文字', hint: '送进设备当前聚焦的输入框' },
  { kind: 'url', label: '打开网址', hint: '在设备浏览器里打开一个网页' },
  { kind: 'wait', label: '等待', hint: '等界面或系统反应，0.2 秒到 10 分钟' },
];

const KIND_LABEL: Record<StepKind, string> = Object.fromEntries(
  STEP_META.map((m) => [m.kind, m.label]),
) as Record<StepKind, string>;

/// 按键的中文名。跟页面上那份是同一套语义，这里单独放一份是因为
/// 服务端要能自己把一条脚本描述成人话（运行记录、导出的报告都靠它）
export const KEY_LABELS: Record<string, string> = {
  up: '上',
  down: '下',
  left: '左',
  right: '右',
  ok: '确定',
  back: '返回',
  home: '主页',
  menu: '菜单',
  info: '信息',
  apps: '应用列表',
  power: '电源',
  sleep: '休眠',
  wake: '唤醒',
  volUp: '音量+',
  volDown: '音量-',
  mute: '静音',
  guide: '节目指南',
  chUp: '频道+',
  chDown: '频道-',
  play: '播放',
  pause: '暂停',
  playPause: '播放/暂停',
  prev: '上一个',
  next: '下一个',
  stop: '停止',
  record: '录制',
  red: '红色键',
  green: '绿色键',
  yellow: '黄色键',
  blue: '蓝色键',
  caption: '字幕',
  settings: '设置',
  tv: '电视',
  tvInput: '信号源',
  assist: '助手',
  mic: '语音',
};

/// 通用 Android 设备按键。遥控器、电视广播等专用键仍保留在底层映射里，
/// 供历史脚本执行，但不进入通用工作台的按键选择器，避免把设备形态带偏。
const GENERIC_KEY_IDS = new Set([
  'up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu',
  'info', 'apps', 'power', 'sleep', 'wake', 'volUp', 'volDown', 'mute',
  'play', 'pause', 'playPause', 'prev', 'next', 'stop',
  'settings', 'assist', 'mic',
]);

/// 给页面用的按键清单：和 KEYS 同一份来源，页面不必自己维护一张表
export const keyList = () =>
  Object.keys(KEYS)
    .filter((id) => GENERIC_KEY_IDS.has(id))
    .map((id) => ({ id, label: KEY_LABELS[id] || id }));

/// 设备没有 keylayout 实测结果时，标准 Android keyevent 仍可发送。
/// 这份基线只代表系统能接收的键，不代表设备一定有对应实体键。
/// 页面按键能力：有 keylayout 实测时只返回真实存在的键；否则返回标准 keyevent 基线。
export function availableKeys(inputPath: { via: string; keys: Record<string, unknown> } | null | undefined): {
  keys: string[];
  keySource: 'keylayout' | 'keyevent' | 'offline';
} {
  if (!inputPath) return { keys: [], keySource: 'offline' };
  const measured = Object.keys(inputPath.keys || {});
  if (inputPath.via === 'evdev' && measured.length) {
    const present = new Set(measured);
    return {
      keys: keyList().map((k) => k.id).filter((id) => present.has(id)),
      keySource: 'keylayout',
    };
  }
  return {
    keys: keyList().map((k) => k.id),
    keySource: 'keyevent',
  };
}

// ---------------------------------------------------------------- 存储

function emptyStore(): AutomationStore {
  return { scripts: [], history: [], enabled: true, lastOnline: false, lastTick: 0 };
}

export function loadStore(): AutomationStore {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const s: AutomationStore = { ...emptyStore(), ...raw };
    /// 文件可能被手改过，也可能是上一个版本写的：读进来先过一遍归一化，
    /// 坏掉的条目丢掉而不是让整个面板打不开
    s.scripts = Array.isArray(s.scripts) ? s.scripts.map(normScript).filter(Boolean) as Script[] : [];
    s.history = Array.isArray(s.history) ? s.history.slice(0, MAX_HISTORY) : [];
    return s;
  } catch {
    return emptyStore();
  }
}

export function saveStore(s: AutomationStore): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({ ...s, history: s.history.slice(0, MAX_HISTORY) }, null, 2));
}

/// 读-改-写一步做完。跑脚本是异步的（中间有等待），
/// 如果先 loadStore 拿着对象慢慢改再存，中间任何一次别的写入都会被覆盖掉
function withStore<T>(fn: (s: AutomationStore) => T): T | null {
  try {
    const s = loadStore();
    const r = fn(s);
    saveStore(s);
    return r;
  } catch {
    return null;
  }
}

export function markFired(id: string, key: string): void {
  withStore((s) => {
    const t = s.scripts.find((x) => x.id === id);
    if (t) t.firedKey = key;
  });
}

export function setLastOnline(v: boolean): void {
  withStore((s) => {
    s.lastOnline = v;
    s.lastTick = Date.now();
  });
}

export function setEngineEnabled(v: boolean): void {
  withStore((s) => {
    s.enabled = v;
  });
}

/// 记一次跳过（设备不在线这类）：留痕但不占用一条完整运行记录
export function recordSkip(script: Script, detail: string, by: string): RunResult {
  const job: RunResult = {
    id: randomUUID(),
    scriptId: script.id,
    name: script.name,
    by,
    at: Date.now(),
    ms: 0,
    ok: false,
    detail,
    steps: [],
  };
  record(job);
  return job;
}

function record(job: RunResult): void {
  withStore((s) => {
    const t = s.scripts.find((x) => x.id === job.scriptId);
    if (t) t.last = { at: job.at, ok: job.ok, by: job.by, ms: job.ms, detail: job.detail };
    s.history = [job, ...s.history.filter((h) => h.id !== job.id)].slice(0, MAX_HISTORY);
  });
}

// ---------------------------------------------------------------- 校验

const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const clean = (v: unknown, max: number) => String(v ?? '').replace(CONTROL_RE, '').trim().slice(0, max);

function normStep(raw: any): Step | null {
  const kind = String(raw?.kind ?? '') as StepKind;
  if (!KIND_LABEL[kind]) return null;
  const step: Step = { kind };
  switch (kind) {
    case 'key': {
      /// 存成内部键名（home / volUp），但接受用户手打的 HOME / KEYCODE_HOME / VolUp。
      /// 以前只认内部名：脚本里写个 HOME 这一步直接被丢掉，整条脚本报「至少要有一步有效动作」，
      /// 用户根本不知道是哪一步的问题
      const v = resolveKey(clean(raw.value, 24));
      if (!v) return null;
      step.value = v;
      if (raw.long === true) step.long = true;
      return step;
    }
    case 'launch': {
      /// 包名或应用名都行（launchNamed 两个都认），只是不让它变成一条能塞进 shell 的自由文本
      const v = clean(raw.value, 80);
      if (!v || !/^[\w.\-+\u4e00-\u9fa5 ]+$/.test(v)) return null;
      step.value = v;
      return step;
    }
    case 'volume': {
      const n = Math.round(Number(raw.n));
      if (!Number.isFinite(n)) return null;
      step.n = Math.max(0, Math.min(100, n));
      return step;
    }
    case 'night': {
      step.value = raw.value === 'off' ? 'off' : 'on';
      return step;
    }
    case 'power': {
      step.value = raw.value === 'wake' ? 'wake' : 'sleep';
      return step;
    }
    case 'media': {
      /// 两种来源：媒体库里的一个文件名（必须是库里认得的媒体后缀），或者一个 http(s) 网址。
      /// 文件名校验用 media.ts 那一份，保证「能存进脚本的名字」和「库里的文件」是同一套规则
      const v = clean(raw.value, 300);
      if (/^https?:\/\/\S+$/i.test(v)) {
        step.value = v;
        return step;
      }
      const name = clean(v, 80);
      if (!name || !mimeOf(name)) return null;
      step.value = name;
      /// 网址没有"先传到设备"这个选项（那要先下载一遍，没意义），只有库里的文件才有
      if (raw.local === true) step.local = true;
      return step;
    }
    case 'text': {
      const v = clean(raw.value, 200);
      if (!v) return null;
      step.value = v;
      return step;
    }
    case 'url': {
      const v = clean(raw.value, 500);
      if (!/^https?:\/\/\S+$/i.test(v)) return null;
      step.value = v;
      return step;
    }
    case 'wait': {
      const n = Math.round(Number(raw.n));
      if (!Number.isFinite(n)) return null;
      step.n = Math.max(200, Math.min(600000, n));
      return step;
    }
  }
}

function normTrigger(raw: any): Trigger {
  const kind = raw?.kind === 'daily' || raw?.kind === 'connect' ? raw.kind : 'manual';
  const t: Trigger = { kind };
  if (kind === 'daily') {
    const at = clean(raw?.at, 5);
    t.at = /^([01]\d|2[0-3]):[0-5]\d$/.test(at) ? at : '08:00';
  }
  if (kind === 'connect') {
    const n = Math.round(Number(raw?.delayMs ?? 8000));
    t.delayMs = Math.max(0, Math.min(120000, Number.isFinite(n) ? n : 8000));
  }
  return t;
}

/// 存盘与新建都要过的同一道归一化：坏步骤直接丢掉，而不是让整条脚本存不进来
function normScript(raw: any): Script | null {
  const name = clean(raw?.name, MAX_NAME);
  if (!name) return null;
  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).map(normStep).filter(Boolean).slice(0, MAX_STEPS);
  if (!steps.length) return null;
  const now = Date.now();
  return {
    id: clean(raw?.id, 40) || randomUUID(),
    name,
    enabled: raw?.enabled !== false,
    trigger: normTrigger(raw?.trigger),
    steps: steps as Step[],
    createdAt: Number(raw?.createdAt) || now,
    updatedAt: Number(raw?.updatedAt) || now,
    firedKey: raw?.firedKey ? clean(raw.firedKey, 24) : undefined,
    last: raw?.last,
  };
}

/// 页面提交的脚本按 id 覆盖，没有 id 就当新建。返回归一化之后的成品，
/// 页面拿它直接回填，所见即所存
export function upsertScript(raw: any): { ok: boolean; script?: Script; detail: string } {
  const norm = normScript(raw);
  if (!norm) {
    const why = !clean(raw?.name, MAX_NAME) ? '脚本名不能为空' : '至少要有一步有效动作';
    return { ok: false, detail: why };
  }
  const existed = loadStore().scripts.some((s) => s.id === norm.id);
  norm.updatedAt = Date.now();
  withStore((s) => {
    const i = s.scripts.findIndex((x) => x.id === norm.id);
    if (i >= 0) s.scripts[i] = { ...norm, createdAt: s.scripts[i].createdAt, last: s.scripts[i].last };
    else s.scripts.push(norm);
  });
  return { ok: true, script: norm, detail: existed ? `已更新「${norm.name}」` : `已保存「${norm.name}」` };
}

export function deleteScript(id: string): { ok: boolean; detail: string } {
  const had = loadStore().scripts.some((s) => s.id === id);
  if (!had) return { ok: false, detail: '这条脚本已经不在了' };
  withStore((s) => {
    s.scripts = s.scripts.filter((x) => x.id !== id);
    /// 运行记录跟着删：留着一条指向已删脚本的历史，点进去只会是空的，反而让人以为是 bug
    s.history = s.history.filter((h) => h.scriptId !== id);
  });
  return { ok: true, detail: '已删除' };
}

export function clearHistory(): { ok: boolean; detail: string } {
  withStore((s) => {
    s.history = [];
    for (const t of s.scripts) t.last = undefined;
  });
  return { ok: true, detail: '运行记录已清空' };
}

// ---------------------------------------------------------------- 描述

/// 一步的人话描述。编辑器和运行记录共用同一份，改一处两边都对
export function stepText(s: Step): string {
  switch (s.kind) {
    case 'key':
      return `${s.long ? '长按 ' : '按 '}${KEY_LABELS[s.value || ''] || s.value}`;
    case 'launch':
      return `启动 ${s.value}`;
    case 'volume':
      return `音量设为 ${s.n}%`;
    case 'night':
      return s.value === 'off' ? '关护眼' : '开护眼';
    case 'power':
      return s.value === 'wake' ? '唤醒设备' : '发送电源键';
    case 'media': {
      const v = String(s.value || '');
      if (/^https?:\/\//i.test(v)) return `播放 ${v.slice(0, 48)}`;
      return s.local ? `播放媒体库里的「${v}」（先传到设备）` : `播放媒体库里的「${v}」`;
    }
    case 'text':
      return `输入文字「${(s.value || '').slice(0, 20)}」`;
    case 'url':
      return `打开网址 ${(s.value || '').slice(0, 48)}`;
    case 'wait':
      return `等待 ${(Number(s.n ?? 0) / 1000).toFixed(1)} 秒`;
  }
}

export const triggerText = (t: Trigger): string =>
  t.kind === 'daily'
    ? `每天 ${t.at}`
    : t.kind === 'connect'
      ? `设备上线 ${Math.round((t.delayMs ?? 0) / 1000)} 秒后`
      : '手动';

// ---------------------------------------------------------------- 执行

interface OneResult {
  ok: boolean;
  command: string;
  detail: string;
  verified: boolean;
}

/// 单步执行。全部复用页面手点的那套实现，这里只做"调用 + 归一化结果"
async function runOne(adb: Adb, profile: DeviceProfile, s: Step): Promise<OneResult> {
  const wrap = (r: { ok: boolean; command: string; detail: string; verified?: boolean }): OneResult => ({
    ok: r.ok,
    command: r.command,
    detail: r.detail,
    verified: r.verified ?? r.ok,
  });
  switch (s.kind) {
    case 'key':
      return wrap(await pressKey(adb, String(s.value), s.long === true));
    case 'launch':
      return wrap(await launchNamed(adb, profile, String(s.value)));
    case 'volume':
      return wrap(await setVolumePercent(adb, Number(s.n ?? 0)));
    case 'night':
      return wrap(nightControl(adb, s.value === 'off' ? 'off' : 'on'));
    case 'power':
      return wrap(s.value === 'wake' ? await wakeTv(profile.ip, profile.serial, 25000) : await sleepTv(adb));
    case 'media': {
      const v = String(s.value ?? '');
      if (/^https?:\/\//i.test(v)) return wrap(await playMediaOnTv(adb, v, guessUrlMime(v)));
  /// 库里的文件要先确认还在：文件被删了却照样把地址递给设备，
  /// 设备上只会看到播放器转圈或黑屏，用户根本不知道是服务端这边少了文件
      if (!mediaExists(v)) {
        return { ok: false, command: `播放 ${v}`, detail: `媒体库里没有「${v}」了，重新上传一份或换成别的文件`, verified: false };
      }
      const mime = mimeOf(v);
      /// 先传到设备再播：设备自带播放器只认本地文件的机型，只有这条路能真的放出来。
      /// 传不动、或者设备上没人认这个本地文件，就退回"推地址"，不让这一步彻底跑不起来
      if (s.local === true) {
        const up = await pushMediaToDevice(adb, v);
        if (up.ok) {
          const fileUrl = `file://${up.path.split('/').map(encodeURIComponent).join('/')}`;
          const r = await openOnDevice(adb, fileUrl, mime);
          if (r.ok && r.verified) {
            return wrap({ ...r, command: `adb push → ${up.path}\n${r.command}`, detail: `${up.detail}；${r.detail}` });
          }
          const fb = await playMediaOnTv(adb, mediaUrl(v), mime);
          const why = r.detail;
          return wrap({ ...fb, command: `adb push → ${up.path}\n${fb.command}`, detail: `${up.detail}，但设备上没人能打开这份本地文件（${why}），改成推地址播放：${fb.detail}` });
        }
        const fb = await playMediaOnTv(adb, mediaUrl(v), mime);
        return wrap({ ...fb, command: fb.command, detail: `传到设备这一步没成（${up.detail}），改成推地址播放：${fb.detail}` });
      }
      return wrap(await playMediaOnTv(adb, mediaUrl(v), mime));
    }
    case 'text':
      return wrap(await typeText(adb, String(s.value ?? ''), false));
    case 'url':
      return wrap(await openUrlOnDevice(adb, profile, String(s.value ?? '')));
    case 'wait': {
      const ms = Number(s.n ?? 1000);
      await sleep(ms);
      const t = `${(ms / 1000).toFixed(1)} 秒`;
      return { ok: true, command: `等待 ${t}`, detail: `已等待 ${t}`, verified: true };
    }
  }
}

/// 正在跑的作业：页面按 jobId 轮询，刷新回来还能接上（和录屏同一种做法）
const runs = new Map<string, RunResult>();
/// 一条脚本同时只跑一次：定时和手动撞上时，第二条直接复用第一条的作业
const running = new Map<string, string>();

export const runView = (id: string): RunResult | undefined => runs.get(id);
export const activeRunOf = (scriptId: string): RunResult | undefined => {
  const id = running.get(scriptId);
  return id ? runs.get(id) : undefined;
};

export function startRun(adb: Adb | null, profile: DeviceProfile, script: Script, by: string, skipReason = ''): RunResult {
  const live = activeRunOf(script.id);
  if (live) return live;
  const job: RunResult = {
    id: randomUUID(),
    scriptId: script.id,
    name: script.name,
    by,
    at: Date.now(),
    ms: 0,
    ok: false,
    detail: skipReason || '执行中…',
    steps: script.steps.map((s, i) => ({
      index: i,
      kind: s.kind,
      label: KIND_LABEL[s.kind],
      text: stepText(s),
      state: skipReason ? 'skipped' : 'pending',
      detail: '',
      ms: 0,
    })),
  };
  if (skipReason || !adb) {
    job.detail = skipReason || '设备不在线，这次没跑';
    runs.set(job.id, job);
    record(job);
    setTimeout(() => runs.delete(job.id), 600000).unref?.();
    return job;
  }
  runs.set(job.id, job);
  running.set(script.id, job.id);
  void execute(adb, profile, script, job).catch((e: Error) => {
    job.ok = false;
    job.detail = `执行中断：${e.message}`;
    record(job);
  });
  return job;
}

async function execute(adb: Adb, profile: DeviceProfile, script: Script, job: RunResult): Promise<void> {
  const t0 = Date.now();
  let failed = '';
  let warned = 0;
  /// 上线触发带的延迟：让设备先把桌面拉起来再发按键，否则按键会打在开机画面上
  if (script.trigger.kind === 'connect' && job.by.startsWith('上线')) {
    const wait = Math.max(0, script.trigger.delayMs ?? 0);
    if (wait > 600) await sleep(Math.min(wait, 120000));
  }
  for (let i = 0; i < script.steps.length; i++) {
    const view = job.steps[i];
    view.state = 'running';
    const s0 = Date.now();
    try {
      const r = await runOne(adb, profile, script.steps[i]);
      view.ms = Date.now() - s0;
      view.command = r.command;
      view.detail = r.detail;
      view.state = r.ok ? (r.verified ? 'ok' : 'warn') : 'failed';
      if (!r.ok) {
        failed = `第 ${i + 1} 步「${view.text}」没成功：${r.detail}`;
      } else if (!r.verified) {
        warned += 1;
      }
    } catch (e) {
      view.ms = Date.now() - s0;
      view.state = 'failed';
      view.detail = (e as Error).message;
      failed = `第 ${i + 1} 步「${view.text}」出错：${view.detail}`;
    }
    if (failed) {
      /// 后面的步骤不再跑：脚本多数是「先开应用再按键」这种前后依赖，
      /// 硬着头皮往下走只会在错的界面上乱发按键，还会把失败原因埋掉
      for (let k = i + 1; k < job.steps.length; k++) job.steps[k].state = 'skipped';
      break;
    }
  }
  job.ms = Date.now() - t0;
  job.ok = !failed;
  job.detail = failed || (warned ? `${script.steps.length} 步都跑完了，其中 ${warned} 步没能回读确认` : `${script.steps.length} 步都跑完了`);
  running.delete(script.id);
  record(job);
  setTimeout(() => runs.delete(job.id), 600000).unref?.();
}

/// 定时触发到点没到点：以「分钟」为粒度，firedKey 保证一分钟只跑一次
export function dueDaily(s: Script, now: Date): string | null {
  if (s.trigger.kind !== 'daily' || !s.enabled) return null;
  const at = s.trigger.at || '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (hhmm !== at) return null;
  const key = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${at}`;
  return s.firedKey === key ? null : key;
}
