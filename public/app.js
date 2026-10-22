const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/// 内置浏览器的标签页常年不硬刷新：新代码在服务器上，用户手里还是旧的，
/// 表现出来就是「明明改了，怎么还是老样子」。这个标记由发布时手改，
/// 页面会定期比对，不一致就在角落挂一个刷新入口
const BUILD = '20261021-2146-adb';

/// 手里这份页面是哪个版本，直接写进 <html data-build>：
/// 用户说「我打开还是老样子」时，先看他那一份报的版本号，一眼就能分清
/// 是「真的没改」还是「他看到的是旧页面」，不用靠猜
document.documentElement.dataset.build = BUILD;

/// 服务器基地址。浏览器直接打开本服务时就是「同源」，这里留空、行为跟以前完全一样；
/// 以后把前端打包成桌面/移动客户端（前端在本地、后端跑在别处）时，用一次
/// ?server=http://192.168.1.6:8787 打开，值会记进 localStorage，之后都指那边。
/// 这样同一份 public/ 既能在服务端跑，也能塞进 Tauri / Capacitor 的壳里。
const SRV_KEY = 'tvdeck.server';
const SRV = (() => {
  try {
    const q = new URLSearchParams(location.search).get('server');
    if (q !== null) {
      const v = q.trim().replace(/\/+$/, '');
      if (v) localStorage.setItem(SRV_KEY, v);
      else localStorage.removeItem(SRV_KEY);
      return v;
    }
    return (localStorage.getItem(SRV_KEY) || '').trim().replace(/\/+$/, '');
  } catch {
    return '';
  }
})();

/// 只给「后端产出的东西」拼基地址：/api/*、设备画面、录像回放。
/// /icons/*、/app.js、/style.css 是跟着前端包走的本地资源，拼上反而打不开。
const srv = (p) => SRV + p;

/// 外观：auto 跟随系统，light/dark 是手动钉死。真正的配色在 style.css 的两套 token 里，
/// 这里只负责把 data-theme 落到 <html> 上，并同步移动端地址栏颜色。
/// index.html 头部还有一段同样逻辑的内联脚本，用来避免首屏闪深色 —— 改这里时记得一起改。
const THEME_KEY = 'tvdeck.theme';
const sysDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

function applyTheme(pref) {
  const mode = ['auto', 'light', 'dark'].includes(pref) ? pref : 'auto';
  const dark = mode === 'dark' || (mode === 'auto' && sysDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#meta-theme').content = dark ? '#0e0e11' : '#ffffff';
  $$('#theme-seg button').forEach((b) => {
    const on = b.dataset.theme === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

$('#theme-seg').onclick = (e) => {
  const b = e.target.closest('button[data-theme]');
  if (!b) return;
  try {
    localStorage.setItem(THEME_KEY, b.dataset.theme);
  } catch {
    /* 隐私模式下存不住，本次会话仍然生效 */
  }
  applyTheme(b.dataset.theme);
};

/// 选了「跟随系统」时，系统在白天/黑夜之间切换要立刻跟上
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  let pref = 'auto';
  try {
    pref = localStorage.getItem(THEME_KEY) || 'auto';
  } catch {}
  if (pref === 'auto') applyTheme('auto');
});

applyTheme(localStorage.getItem(THEME_KEY) || 'auto');

/// 操作日志：每次写动作（POST）都留一条，存在 localStorage 里，重启页面还在
const OPS_KEY = 'tvdeck.ops';
let ops = (() => {
  try {
    const a = JSON.parse(localStorage.getItem(OPS_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
})();

function saveOps() {
  try {
    localStorage.setItem(OPS_KEY, JSON.stringify(ops.slice(-200)));
  } catch {
    /* 隐私模式或配额满时日志只留在内存里，不影响动作本身 */
  }
}

const hhmm = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

/* 状态行的数据新鲜度：/api/state 回来之后记一笔「刚刚读取」，
   之后每秒让它自己往「N 秒前」走，用户不点按钮也能知道数据有没有在动。 */
let stateReadAt = 0;
let stateFreshTick = 0;

function renderStateFreshness() {
  const el = $('#pupdated');
  const sub = $('#psub');
  if (!el || !sub) return;
  sub.classList.remove('loading');
  if (!stateReadAt) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.classList.remove('warn');
  el.hidden = false;
  const ago = Math.max(0, Math.round((Date.now() - stateReadAt) / 1000));
  el.textContent = ago === 0 ? '· 刚刚读取' : `· ${ago} 秒前`;
  el.title = `设备状态读取于 ${hhmm(stateReadAt)}，页面每 20 秒自动刷新`;
}

function startStateFreshTick() {
  stopStateFreshTick();
  stateFreshTick = setInterval(() => {
    if (document.hidden) return;
    renderStateFreshness();
  }, 1000);
}

function stopStateFreshTick() {
  clearInterval(stateFreshTick);
  stateFreshTick = 0;
}

function recordOp(entry) {
  ops.push(entry);
  ops = ops.slice(-200);
  saveOps();
  if (!$('#opsheet').hidden) renderOps();
}

function renderOps() {
  const rows = ops.slice().reverse();
  $('#opcount').textContent = `${rows.length} 条`;
  $('#oplist').replaceChildren(
    ...(rows.length
      ? rows.map((o) => {
          const d = document.createElement('div');
          d.className = `oprow ${o.kind}`;
          const head = document.createElement('div');
          head.className = 'oph';
          const time = document.createElement('em');
          time.textContent = hhmm(o.t);
          const text = document.createElement('b');
          text.textContent = o.text;
          head.append(time, text);
          if (o.ms !== undefined) {
            const ms = document.createElement('i');
            ms.textContent = `${o.ms}ms`;
            head.append(ms);
          }
          const body = document.createElement('div');
          body.className = 'odb';
          body.textContent = o.detail || '';
          if (o.cmd) body.title = o.cmd;
          d.append(head, body);
          return d;
        })
      : [Object.assign(document.createElement('p'), { className: 'caption', textContent: '还没有操作记录。按键、切源、安装、卸载、文件推送都会记在这里。' })]),
  );
}

const log = (msg, kind = '') => {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#log').append(el);
  /// 同一个状态反复刷（例如每 20 秒轮询后发现预览没开、又自动拉起）
  /// 不该每次都再叠一条同样的提示：屏幕上只留一条，3 秒后照常淡出
  const siblings = [...$('#log').children];
  siblings.slice(0, -1).forEach((old) => {
    if (old.textContent === msg && !old.classList.contains('out')) old.remove();
  });
  /// 出场用渐隐而不是瞬间 remove：和进场动画对称，也不让提示条
  /// 长时间压在列表底部内容上
  setTimeout(() => el.classList.add('out'), 3000);
  setTimeout(() => el.remove(), 3400);
};

/// 通用「慢操作执行中」提示：安装在设备上的操作可能几秒到几十秒，
/// 单靠按钮转圈看不出来是哪一步、也容易被一组按钮的 busy 状态盖掉。
/// 用一条固定在顶部中央的细条代替「点到一半没反应」的空白等待，
/// 只保留一条，请求兜底超时时也会被清掉。
let opBusyEl = null;
/// 同时可能有两条慢请求（例如安装包和上传素材），先结束的那条不能把
/// 仍在执行的操作提示一起收掉，所以用计数而不是单布尔
let opBusyN = 0;
let opBusyTick = 0;
let opBusyStart = 0;
let opBusyLabel = '';

function opBusyPaint() {
  if (!opBusyEl) return;
  const sec = Math.max(0, Math.round((Date.now() - opBusyStart) / 1000));
  opBusyEl.textContent = `正在执行：${opBusyLabel}${sec ? ` · 已 ${sec}s` : ''}`;
}

function opBusy(label, on) {
  const host = $('#log');
  if (!host) return;
  if (!on) {
    opBusyN = Math.max(0, opBusyN - 1);
    if (opBusyN) return;
    clearInterval(opBusyTick);
    opBusyTick = 0;
    opBusyEl?.remove();
    opBusyEl = null;
    return;
  }
  opBusyN += 1;
  if (!opBusyEl) {
    opBusyLabel = label;
    opBusyStart = Date.now();
    opBusyEl = document.createElement('div');
    opBusyEl.className = 'toast opbusy';
    opBusyEl.setAttribute('role', 'status');
    host.prepend(opBusyEl);
    clearInterval(opBusyTick);
    opBusyTick = setInterval(opBusyPaint, 1000);
  }
  opBusyPaint();
}

/// 自定义确认/输入弹层：系统 confirm/prompt 在一部分内嵌 WebView 和大屏浏览器里
/// 会被吞掉或样式突兀，统一换成页内弹层，触屏、键盘和 Escape 都能操作。
let dialogEl = null;

function buildDialog() {
  const d = document.createElement('div');
  d.className = 'dlg';
  d.hidden = true;
  d.innerHTML = `
    <div class="dlg-mask"></div>
    <div class="dlg-card" role="dialog" aria-modal="true">
      <p class="dlg-msg"></p>
      <input class="dlg-input" type="text" hidden>
      <div class="dlg-acts">
        <button type="button" class="dlg-cancel">取消</button>
        <button type="button" class="dlg-ok">确定</button>
      </div>
    </div>`;
  document.body.append(d);
  return d;
}

function askDialog({ message, defaultValue = '', input = false, okText = '确定', danger = false }) {
  dialogEl = dialogEl || buildDialog();
  const card = dialogEl.querySelector('.dlg-card');
  const msg = dialogEl.querySelector('.dlg-msg');
  const field = dialogEl.querySelector('.dlg-input');
  const cancel = dialogEl.querySelector('.dlg-cancel');
  const ok = dialogEl.querySelector('.dlg-ok');
  msg.textContent = message;
  field.hidden = !input;
  if (input) {
    field.value = defaultValue;
    field.placeholder = defaultValue;
  }
  ok.textContent = okText;
  ok.classList.toggle('danger', danger);
  dialogEl.hidden = false;
  const prevFocus = document.activeElement;

  return new Promise((resolve) => {
    const close = (val) => {
      dialogEl.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus instanceof HTMLElement) prevFocus.focus();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && !field.hidden && e.target === field) {
        e.preventDefault();
        close(field.value);
      }
    };
    cancel.onclick = () => close(null);
    ok.onclick = () => close(field.hidden ? true : field.value);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => {
      /// 输入弹窗必须聚焦输入框；确认类弹窗默认聚焦取消，
      /// 空格/回车误触发时会先落到「取消」而不是危险的「确定」
      if (!field.hidden) {
        field.focus();
        field.select();
      } else cancel.focus();
    });
  });
}

/// 请求超时：无线 ADB 掉线或服务卡住时，fetch 默认能挂到浏览器自己放弃，
/// 用户看到的就是按钮一直转、点了像没反应。除安装/录屏这类本来就该长跑的
/// 接口外，统一 20 秒收口，让调用方拿到明确失败并能重试。
const API_TIMEOUT_MS = 20000;
const API_SLOW_MS = 70000;
const API_LONG = /^\/api\/(install|record|wake|upload|download)/;

async function api(p, body, label, quiet) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const limit = API_LONG.test(p) ? API_SLOW_MS : API_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), limit);
  /// 慢请求提示：2 秒后仍在跑就给一条「正在执行」，而不是让按钮在角落里转圈。
  /// 快请求不显示，慢请求返回或超时后自动收掉。
  let busyShown = false;
  const busyTimer = setTimeout(() => {
    busyShown = true;
    opBusy(label || p);
  }, 2000);
  let res;
  try {
    res = await fetch(
      srv(p),
      body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal }
        : { signal: ctrl.signal },
    );
  } catch (e) {
    if (e.name === 'AbortError') {
      const msg = `设备响应超时（${Math.round(limit / 1000)} 秒），请检查连接后重试`;
      if (body) recordOp({ t: Date.now(), text: label || p, detail: msg, cmd: p, kind: 'err', ms: Math.round(performance.now() - t0) });
      throw new Error(msg);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    clearTimeout(busyTimer);
    /// 只有真的显示过这条提示才减计数，否则快请求会把别的慢操作提示一并收掉
    if (busyShown) opBusy(null, false);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    if (body) recordOp({ t: Date.now(), text: label || p, detail: data.error || `HTTP ${res.status}`, cmd: p, kind: 'err', ms: Math.round(performance.now() - t0) });
    throw new Error(data.error || data.detail || `HTTP ${res.status}`);
  }
  if (body && !quiet) {
    const ok = data.ok !== false;
    const detail = Array.isArray(data) ? `${data.length} 条结果` : data.detail || (ok ? '已执行' : '未确认');
    recordOp({ t: Date.now(), text: label || p, detail, cmd: `${p} ${JSON.stringify(body)}`, kind: ok ? (data.verified === false ? 'warn' : 'ok') : 'err', ms: Math.round(performance.now() - t0) });
  }
  return data;
}

const initial = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

/// 缺图标时的首字：剥掉厂牌前缀取真正区分应用的字（康佳消息→消、康佳桌面→桌）
const BRAND_PREFIX = /^(康佳|长虹|海信|创维|TCL|小米|Konka|Changhong|Hisense|Skyworth|Xiaomi)\s*/i;
const monogram = (name) => {
  const s = (name || '?').trim();
  return (s.replace(BRAND_PREFIX, '').trim() || s).slice(0, 1);
};

/// 显示名优先级：APK manifest 解出的真实名（npm run icons）> 人工确认的公开名 > probe 的 label > 包名派生
/// （这台机器的 dumpsys package 不输出 applicationLabel，副行始终保留真实包名）
const KNOWN_NAMES = {
  'com.dangbeimarket': '当贝市场',
  'com.estrongs.android.pop': 'ES 文件浏览器',
  'org.smarttube.stable': 'SmartTube',
  'com.devolutions.remotedesktopmanager': 'Remote Desktop Manager',
  'com.fongmi.android.tv': 'FongMi TV',
  'com.konka.message': '康佳消息',
  'com.oversea.aslauncher': '康佳桌面',
  'com.konka.multimedia': '康佳多媒体',
  'com.konka.applist': '应用列表',
};

/// 系统编译类型的中文名，页面上不再露出 user / userdebug 这种原始值
const BUILD_TYPE_CN = { user: '正式版', userdebug: '调试版', eng: '工程版' };

const GENERIC_SEG = new Set(['com', 'org', 'net', 'io', 'cn', 'app', 'apps', 'android', 'tv', 'stable', 'release', 'konka', 'oversea', 'overseas', 'google', 'services', 'service', 'market']);

/// probe 从设备读到的画面相关 settings key → 人话名称，原始 table/key 收进 tooltip
const PICTURE_NAMES = {
  screen_brightness: '屏幕亮度',
  screen_brightness_mode: '自动亮度',
  night_display_activated: '护眼模式',
  accessibility_display_magnification_enabled: '放大镜',
  accessibility_display_magnification_scale: '放大镜倍率',
  wifi_display_on: '无线显示',
  accessibility_display_inversion_enabled: '色彩反转',
  ambient_tilt_to_bright: '抬起提亮',
};

/// 各家系统扫出来的画面 key 千奇百怪，已知名单不可能穷举。
/// 这里按英文词根拼中文，未知设备的新字段也能直接读，不用回来改代码
const PICTURE_WORDS = {
  accessibility: '无障碍',
  activated: '已启用',
  adaptive: '自适应',
  ambient: '环境光',
  auto: '自动',
  backlight: '背光',
  balance: '平衡',
  bright: '提亮',
  brightness: '亮度',
  care: '护眼',
  coloscal: '色彩',
  color: '色彩',
  colors: '色彩',
  colour: '色彩',
  colours: '色彩',
  contrast: '对比度',
  default: '默认',
  delay: '延迟',
  density: '密度',
  dimming: '调光',
  display: '显示',
  dolby: '杜比',
  double: '双倍',
  duration: '时长',
  eco: '节能',
  enable: '启用',
  enabled: '已启用',
  extra: '',
  eye: '护眼',
  false: '否',
  flag: '标记',
  font: '字体',
  four: '四',
  forced: '强制',
  high: '高',
  gamma: '伽马',
  hdr: 'HDR',
  hdmi: 'HDMI',
  hue: '色调',
  index: '序号',
  inversion: '反色',
  invert: '反色',
  kind: '类型',
  level: '级别',
  limit: '上限',
  low: '低',
  max: '最大',
  medium: '中',
  min: '最小',
  luminance: '亮度',
  magnification: '放大',
  mode: '模式',
  motion: '动效',
  night: '夜间',
  off: '关闭',
  on: '开关',
  panel: '面板',
  picture: '画面',
  point: '点',
  power: '电源',
  protection: '保护',
  range: '范围',
  reduction: '减弱',
  refresh: '刷新率',
  resolution: '分辨率',
  saving: '省电',
  scale: '倍率',
  scaling: '缩放',
  sensitivity: '灵敏度',
  sharp: '锐度',
  sharpness: '锐度',
  shield: '护眼',
  size: '尺寸',
  screen: '屏幕',
  smoothing: '平滑',
  state: '状态',
  status: '状态',
  support: '支持',
  switch: '开关',
  width: '宽',
  height: '高',
  pixel: '像素',
  dpi: 'DPI',
  override: '覆盖',
  current: '当前',
  actual: '实际',
  target: '目标',
  virtual: '虚拟',
  physical: '物理',
  saturation: '饱和度',
  temperature: '色温',
  threshold: '阈值',
  three: '三',
  tilt: '倾斜',
  time: '时间',
  timeout: '超时',
  to: '',
  true: '是',
  tv: '视频',
  two: '双',
  type: '类型',
  unknown: '',
  use: '使用',
  value: '数值',
  vendor: '',
  version: '版本',
  vibrance: '鲜艳度',
  white: '白',
  wifi: '无线',
  zoom: '缩放',
  input: '输入',
  source: '输入',
  signal: '信号',
  select: '选择',
  setting: '设置',
};

/// 厂商命名里常见的噪声段，拼中文时直接丢掉，避免出现「comvendor背光调光」
const PICTURE_DROP = new Set(['com', 'android', 'settings', 'setting', 'system', 'global', 'secure', 'extra', 'def', 'qka', 'mtk', 'amlogic', 'rockchip', 'novatek', 'hisense', 'tcl', 'xiaomi', 'konka']);

/// 单条画面的显示名：先查已知名单，再按词根拼，全都不认识才退回原始字段名
function pictureName(key) {
  if (PICTURE_NAMES[key]) return PICTURE_NAMES[key];
  const segs = String(key).split(/[^A-Za-z0-9]+/).filter(Boolean);
  let known = 0;
  const parts = [];
  for (const seg of segs) {
    if (PICTURE_DROP.has(seg.toLowerCase())) continue;
    const low = seg.toLowerCase();
    const hit = PICTURE_WORDS[low] ?? PICTURE_WORDS[low.replace(/s$/, '')];
    if (hit) known += 1;
    const text = hit ?? seg;
    // 同义词根重复出现（eye_shield 都是「护眼」）只留一次
    if (text && parts[parts.length - 1] !== text) parts.push(text);
  }
  if (!known || !parts.length) return key;
  /// 「色彩」+「色温」拼起来是「色彩色温」：后一个词已经含了色彩的意思，前一个就多余
  if (parts.includes('色温')) {
    const i = parts.indexOf('色彩');
    if (i >= 0 && parts.length > 1) parts.splice(i, 1);
  }
  /// 中文里「强制」是修饰语，落在结尾读着别扭：显示尺寸强制 → 强制显示尺寸
  const force = parts.indexOf('强制');
  if (force > 0) {
    parts.splice(force, 1);
    parts.unshift('强制');
  }
  /// 近义词连着出现只留一个：输入信号 → 输入
  const SAME = [
    ['输入', '信号'],
    ['画面', '显示'],
    ['亮度', '提亮'],
  ];
  for (const group of SAME) {
    const hit = parts.filter((p) => group.includes(p));
    if (hit.length > 1) {
      const keep = hit[0];
      for (const p of hit.slice(1)) parts.splice(parts.indexOf(p), 1);
      if (!parts.includes(keep)) parts.push(keep);
    }
  }
  return parts.join('');
}


const TABLE_CN = { system: '系统设置', secure: '安全设置', global: '全局设置' };

/// 海思面板直读出来的属性名，页面上同样只显示中文
const PQ_NAMES = { Brightness: '亮度', Contrast: '对比度', Hue: '色调', Saturation: '饱和度' };

/// 设备按键 → 人话，操作日志里不出现 volUp / playPause 这种英文字段
const KEY_CN = {
  up: '上',
  down: '下',
  left: '左',
  right: '右',
  ok: '确定',
  back: '返回',
  home: '主页',
  menu: '菜单',
  apps: '应用列表',
  info: '信息',
  mic: '语音',
  prev: '上一个',
  next: '下一个',
  playPause: '播放/暂停',
  stop: '停止',
  play: '播放',
  pause: '暂停',
  guide: '节目指南',
  chUp: '频道+',
  chDown: '频道-',
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
  sleep: '休眠',
  wake: '唤醒',
  mute: '静音',
  power: '电源',
  volUp: '音量+',
  volDown: '音量-',
};

/// 已知名表只兜通用包。厂商私有包必须确认真的装在当前设备上才用本地补名，
/// 否则换一台非康佳设备时，残留的康佳包名映射会把界面名带跑偏
const PRIVATE_VENDOR = /^com\.(konka|oversea)\./i;
function deviceHas(pkg) {
  return !!state?.profile?.apps?.some?.((x) => x.package === pkg);
}
function knownName(pkg) {
  const n = KNOWN_NAMES[pkg];
  if (!n) return null;
  if (PRIVATE_VENDOR.test(pkg) && !deviceHas(pkg)) return null;
  return n;
}
function displayName(a) {
  // appLabel 比 a.label 可信：它是「图标清单 → 已知包名表 → 系统组件表」的合并结果，
  // 而 profile 里的 label 有可能是 probe 当年取不到名字时写进去的包名本身
  const raw = a.name || knownName(a.package) || appLabel(a.package) || (a.label && a.label !== a.package ? a.label : null);
  if (raw) return raw.trim();
  const segs = a.package.split('.').filter((s) => !GENERIC_SEG.has(s));
  const s = segs.at(-1) ?? a.package;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/// 这些容器 Activity 的名字（SubSettings 之类）对用户没有信息量，
/// 带上只会变成「系统设置 · SubSettings」，不如只留应用名
const GENERIC_ACT = new Set([
  'SubSettings', 'Activity', 'MainActivity', 'BaseActivity', 'ContainerActivity', 'ShellActivity', 'LauncherActivity',
  /// Settings 主页的容器 Activity 名就是「Settings」，同样没有信息量
  'Settings', 'HomeActivity', 'Home', 'Main',
  /// 各家桌面的入口类名不同，但都只是「桌面」本身，补在应用名后面只会读成英文
  'Launcher', 'Desktop', 'DesktopActivity',
  /// Settings 的子页面都是这种长容器名，对用户没有信息量：带上只会读成一串英文
  'Settings\$ConnectedDeviceDashboardActivity', 'Settings\$BluetoothDashboardActivity',
  'Settings\$NetworkDashboardActivity', 'Settings\$AppNotificationDashboardActivity',
  'Settings\$DisplaySettingsActivity', 'Settings\$SoundSettingsActivity',
]);

/// 少数有信息量的系统页仍值得跟在应用名后面，但只显示中文。
/// 其余 Activity 类名一律不展示：不同厂商的命名千差万别，把英文内部名
/// 倒给用户既不统一，也没有帮助。
const ACTIVITY_CN = {
  AppInfoActivity: '应用信息',
  AppDetailsActivity: '应用详情',
  InstalledAppDetails: '应用详情',
  BluetoothSettingsActivity: '蓝牙',
  WifiSettingsActivity: '无线网络',
  NetworkSettingsActivity: '网络',
  DisplaySettingsActivity: '显示',
  SoundSettingsActivity: '声音',
  StorageSettingsActivity: '存储',
  LanguageSettingsActivity: '语言',
  PowerUsageSummary: '用电情况',
  DataUsageSummary: '流量使用',
};

/// 只拿到包名时（屏幕时间、设备画面这类只有包名的位置）也要说人话：
/// 系统组件在应用清单里没有图标条目，以前就直接漏出 com.android.settings 这种原始包名
const AOSP_NAMES = {
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
  'com.android.shell': 'Shell',
  'com.android.providers.downloads': '下载',
  'com.android.inputmethod.latin': '系统输入法',
  'com.google.android.videos': 'Google 影视',
  'com.google.android.apps.youtube.tv': 'YouTube TV',
  'com.android.vending': 'Google Play',
};

/// 包名 → 人话：装好的图标清单优先，其次已知包名表，再退到常见系统组件，最后才是原始包名
function appLabel(pkg) {
  if (!pkg) return '';
  return iconMeta(pkg)?.label || knownName(pkg) || AOSP_NAMES[pkg] || pkg;
}

/// 屏幕使用时间 / 设备画面这类位置通常只有包名。服务端补好的名字优先，
/// 其次是设备清单里的真名，最后才退回图标表 / 已知包名。
function appNameFor(pkg, hint) {
  if (!pkg) return '';
  if (hint) return String(hint).trim();
  const installed = state?.profile?.apps?.find?.((a) => a.package === pkg);
  return installed ? displayName(installed) : appLabel(pkg);
}

let state = null;
let preview = false;
/// 设备预览走 MJPEG：一张图是服务端连续推帧的容器，加载完就不再触发 load。
/// 非流式单帧轮询只保留在服务端没有编码器时的回退路径
let previewStream = false;
let frameFailed = false;
/// 预览开始时记一个时间戳：首帧迟迟不到时，等待层从「正在读取」切成
/// 「读取较慢」，但不误报失败（失败有独立文案和重试逻辑）
let firstFrameAt = 0;
let firstFrameHint = 0;

/// 设备画面框跟随真实分辨率：竖屏手机显示成竖屏，横屏大屏显示成 16:9。
/// 这里只把比例同步给 CSS；预览尺寸上限和全屏覆盖由样式表控制。
function syncDeviceRatio(w, h) {
  const el = $('.tv-screen');
  if (!el) return;
  const W = Number(w) || 0;
  const H = Number(h) || 0;
  const ratio = W > 0 && H > 0 ? W / H : 16 / 9;
  el.style.setProperty('--device-ratio', String(ratio));
  el.dataset.orientation = W > 0 && H > 0 && W < H ? 'portrait' : 'landscape';
}
/// 设备画面怎么放进屏幕：contain 完整显示（比例不同就有黑边）/ cover 铺满裁切。
/// 没有哪种更对，只有用户想要哪种，所以做成画面上的开关
let fitMode = readFit();

/// 画面直通开关：开着时鼠标点画面 = 设备上 input tap，按住拖 = input swipe。
/// 触屏上不抢手势（拖动要留给页面滚动），所以这条通路只对鼠标和笔生效
let tapMode = (() => {
  try {
    return localStorage.getItem('tvdeck.tap') !== '0';
  } catch {
    return true;
  }
})();
/// 系统页三块数据：放在这里声明，是因为 showTab 会在脚本末尾被立刻调用一次
let homeData = null;
let startupData = null;
let bootData = null;
let capsData = null;

/// 自动化脚本。脚本清单、运行记录都是「服务端那一份」的投影，跟着 /api/automation 刷新；
/// 编辑草稿单独放一个变量（而不是直接改服务端返回的对象），是为了让「改了一半还没保存」的内容
/// 不被后台 20 秒一轮的状态轮询悄悄冲掉 —— 这两种数据必须分开活。
let autoData = null;
let autoDraft = null;
/// scriptId → 最近一次运行的逐步结果。放在外面是为了「列表重画」「切走再回来」之后
/// 结果还在原来那条脚本下面，而不是一刷新就没了
const autoRuns = new Map();
/// jobId → scriptId：正在轮询的作业。用轮询而不是 onmessage，是因为要能跨页面刷新接上
const autoWatching = new Map();
let autoTimer = null;
/// 媒体库清单。「播放图片 / 视频」那一步的候选就是它，素材换设备不用变，
/// 所以它跟 /api/automation 分开活着，单独一条 /api/media
let mediaItems = null;

/// scripts/extract-icons.mjs 的产物，覆盖非 launcher 应用（如系统设置），用于给前台应用配真名和 logo
let iconIdx = {};
const iconMeta = (pkg) => iconIdx[pkg] || null;

function loadIcons() {
  return fetch('/icons/index.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => {
      iconIdx = j;
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- 顶部导航
/// 上排只留 3 个天天要用的面板（总览 / 控制 / 应用）+ 第 4 格「更多」，一共 4 格。
/// 其余面板按通用 ADB 工作流分组，不预设手机、车机、开发板或大屏中的某一种形态。
/// 组名、组内顺序都从这儿取，不存在「上排叫这个、抽屉里叫那个」。
const NAV_GROUPS = [
  ['设备与操作', ['home', 'pad', 'apps']],
  ['设备与数据', ['device', 'usage', 'picture']],
  ['连接与系统', ['link', 'system']],
  ['自动化', ['auto']],
];
/// 收进抽屉的次级面板：除掉上排那 3 格，剩下的全在抽屉里（见 buildMore）
const MORE_IDS = NAV_GROUPS.slice(1).flatMap(([, ids]) => ids);
const moreTab = $('#tab-more');
/// 「更多」默认那颗省略号：某一页收在抽屉里、又正好是当前页时要临时换掉，换回来得留着原件
const moreIcon = moreTab.querySelector('svg').outerHTML;
let curTab = 'home';
let moreOpen = false;
let opsOpen = false;
/// 首屏那一次 showTab 不播进场：刚打开页面就整页往上飘一下，看着像加载没完成
let paneAnimReady = false;

/// 抽屉里按组摊成磁贴，图标、短名、一句话说明都从上排那几个按钮现取：
/// 只有一份来源，以后改面板名也不会出现「上排叫这个、抽屉里叫那个」
/// 宽屏左侧导航直接铺开全部面板，但没有分节标题时 10 个按钮排成一串，
/// 「画面为什么跟设备挨着」这类归属感要靠猜。这里按 NAV_GROUPS 插小标题；
/// 窄屏上排只有 3 格、分组收在抽屉里，所以标题只在 >=1180 显示（样式里控制）
function buildNavRail() {
  const nav = $('#tabs');
  if (!nav) return;
  $$('.tab-grp', nav).forEach((n) => n.remove());
  for (const [title, ids] of NAV_GROUPS) {
    const first = $(`.tab[data-tab="${ids[0]}"]`, nav);
    if (!first) continue;
    const g = document.createElement('p');
    g.className = 'tab-grp';
    g.setAttribute('aria-hidden', 'true');
    g.textContent = title;
    first.before(g);
  }
}
buildNavRail();

function buildMore() {
  const list = $('#morelist');
  list.textContent = '';
  /// 抽屉里摊成一张平铺网格：以前四组各带一个小标题，七格被切成四截，
  /// 手机上看着零碎。分组信息交给每格自己那句说明，标题不再单独占行
  /// 第一组那 3 格上排一直露着，抽屉里不重复放一遍
  const grid = document.createElement('div');
  grid.className = 'more-grid';
  for (const id of MORE_IDS) {
    const tab = $(`.tab.sec[data-tab="${id}"]`);
    if (!tab || tab.hidden) continue;
    const name = tab.dataset.n || id;
    const desc = tab.dataset.d || '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mtile';
    b.dataset.jump = id;
    b.title = tab.title || name;
    const tx = document.createElement('span');
    tx.className = 'mtile-tx';
    const bName = document.createElement('b');
    bName.textContent = name;
    tx.append(bName);
    if (desc) {
      const iDesc = document.createElement('i');
      iDesc.textContent = desc;
      tx.append(iDesc);
    }
    const ic = document.createElement('span');
    ic.className = 'mtile-ic';
    ic.innerHTML = tab.querySelector('svg').outerHTML;
    b.append(ic, tx);
    b.onclick = () => {
      showTab(id);
      setMore(false);
    };
    grid.append(b);
  }
  list.append(grid);
}

function setMore(open) {
  slideSheet($('#moresheet'), open, open ? null : () => moreTab.focus({ preventScroll: true }));
  moreOpen = open;
  document.body.classList.toggle('more-lock', open);
  moreTab.setAttribute('aria-expanded', open ? 'true' : 'false');
    /// 打开时把焦点放进去：键盘/方向键用户下一个 Tab 就落在第一行，
  /// 不然要从页首一路数过来（当前那一页有行的话，直接落在它上面）
  if (open) ($('#morelist .mtile.on') || $('#morelist .mtile'))?.focus();
  if (!open) $$('.tab.on').forEach((t) => t.dataset.tab !== 'more' && t.classList.remove('on'));
  syncMore();
}

/// 抽屉开合统一走这里：开是「先显示再播进场动画」，关是「先播退场动画再落 hidden」。
/// 收场那 140ms 里 hidden 还是 false，所以用 dataset 挡一道，连点「更多」不会把状态点乱
function slideSheet(el, open, onDone) {
  if (!el) return;
  if (open) {
    if (!el.hidden && el.dataset.closing !== '1') return;
    delete el.dataset.closing;
    el.classList.remove('out');
    el.hidden = false;
    return;
  }
  if (el.hidden || el.dataset.closing === '1') return;
  el.dataset.closing = '1';
  const done = () => {
    if (el.dataset.closing !== '1') return;
    delete el.dataset.closing;
    el.classList.remove('out');
    el.hidden = true;
    onDone?.();
  };
  let reduce = false;
  try {
    reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    /* 老浏览器没有 matchMedia：按有动画处理，反正也只是多 140ms */
  }
  if (reduce) return done();
  el.classList.add('out');
  el.addEventListener('animationend', done, { once: true });
  /// 兜底：动画被打断（切后台、被别的样式覆盖）时也要把 hidden 落下去
  setTimeout(done, 400);
}

/// 「更多」始终是入口，不因停在抽屉里的哪一页而换文案。
/// 当前页改由抽屉里的磁贴选中态表达；上排第 4 格只负责「打开/收起更多」。
function syncMore() {
  moreTab.innerHTML = `${moreIcon}<span class="tab-lb">更多</span>`;
  moreTab.title = '更多面板';
  moreTab.setAttribute('aria-label', '更多面板');
  moreTab.classList.toggle('on', moreOpen);
  /// 抽屉开着时当前页不再保持选中：不然「设备」和「更多」同时亮着，
  /// 看起来像有两个当前页。关掉抽屉时按 curTab 把选中放回去。
  if (moreOpen) {
    $$('.tab.on').forEach((t) => t.dataset.tab !== 'more' && t.classList.remove('on'));
  } else {
    $(`.tab[data-tab="${curTab}"]`)?.classList.add('on');
  }
  $$('#morelist .mtile').forEach((r) => {
    const on = r.dataset.jump === curTab;
    r.classList.toggle('on', on);
    r.setAttribute('aria-current', on ? 'page' : 'false');
  });
}

/// 桌面端次级面板直接露在竖导航里，选中态只认一个当前页；
/// 窄屏收进「更多」抽屉时则由 syncMore 决定亮谁，避免出现两个选中
function syncNavSelection() {
  if (moreTab.offsetParent !== null) return;
  $$('.tab.on').forEach((t) => t.dataset.tab !== curTab && t.classList.remove('on'));
  $(`.tab[data-tab="${curTab}"]`)?.classList.add('on');
}

function showTab(id, opts = {}) {
  /// 换页必须从新页顶部开始看：窄屏整页滚动（window），桌面端滚动在 main。
  /// 之前只切 .pane 不改滚动位置，从长列表底部点另一个菜单会停在新页的空白处，
  /// 看着像「点错了」或「页面坏了」。切页用瞬时归零，不做平滑，
  /// 否则用户会看见页面自己往上跑一趟。
  const switching = id !== curTab;
  if (switching) {
    const main = $('main');
    if (main && main.scrollTop) main.scrollTop = 0;
    if (window.scrollY) window.scrollTo({ top: 0, behavior: 'auto' });
  }
  const tabs = $$('.tab');
  tabs.forEach((t) => {
    const on = t.dataset.tab === id;
    t.classList.toggle('on', on);
    /// 上排的「更多」不是一页而是入口，它的选中态由 syncMore 决定，不跟着这里走
    if (t.dataset.tab === 'more') t.classList.remove('on');
    if (on) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  $$('.pane').forEach((p) => {
    const on = p.dataset.pane === id;
    p.classList.toggle('on', on);
    p.classList.remove('enter');
    if (!on || !paneAnimReady || document.fullscreenElement) return;
    /// 先派一次重排再挂 class，来回点同一格也能重播；
    /// 收场用定时器而不是 animationend：面板里还有会冒泡的动画（按键涟漪、画面提示），
    /// 监听事件会被它们提前打断
    void p.offsetWidth;
    p.classList.add('enter');
    clearTimeout(p.enterTimer);
    p.enterTimer = setTimeout(() => p.classList.remove('enter'), 280);
  });
  localStorage.setItem('tvdeck.tab', id);
  curTab = id;
  /// 总览页的健康快照跟着页签切换启停：进总览立刻补一拍，切走就停轮询，
  /// 不让它和设备页那套健康轮询同时在后台打 /api/health
  updateHomeSnapPoll();
  /// 画面只在总览页露着：切走就停取帧（把 adb 让给这一页要读的数据），
  /// 切回来立刻补一帧，别让人对着离开时那一屏旧画面
  if (preview) {
    if (id === 'home') tick();
    else clearTimeout(frameTimer);
  }
  /// 上排那批按钮在窄屏是平铺的，不用滑；极窄屏才会溢出，这时把当前格带进视野
  /// 桌面端「更多」那格是 display:none，对它 scrollIntoView 会把滚动容器
  /// 拉到 0,0、整页跳顶：只有实际显示出来的 tab 才带进视野
  const curTabBtn = tabs.find((t) => t.dataset.tab === id);
  if (curTabBtn && curTabBtn.offsetParent !== null) {
    curTabBtn.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
  /// 抽屉开着时点别的菜单：切页本身不带收抽屉，页面切走了但抽屉还挂在上面。
  /// 顺手把它收起来，让「点哪个菜单就只看哪一页」的预期成立
  if (moreOpen || !$('#moresheet').hidden) setMore(false);
  syncMore();
  syncNavSelection();
  /// 应用页铺几条是按窗口量出来的，切回来的这一刻面板才露出来、才量得准，
  /// 所以进来重画一次（在别处是隐藏状态，量出来永远是 0）
  if (id === 'apps') {
    renderApps();
    /// 「启动」段的清单随 /api/state 一起回来了，不用另开请求；
    /// 只有「安装与管理」段要额外读一次已装应用清单，切到那段才读。
    if (curAppsSeg() === 'manage' && !inv) loadInv();
  }
  if (id === 'device') {
    /// 只加载当前选中分段，其余子页切到时再按需拉取。
    /// 以前一进设备页就把信息/进程/文件/健康/录屏/日志六条全打出去，
    /// 六条同时敲 adb 互相抢串口，首屏反而更慢——其实用户一眼只看得到一段。
    ensureDevSeg(curDevSeg());
    updateDevInfoPoll();
    updateHealthPoll();
    updateProcPoll();
    updateStampTick();
    /// 录制进度条只有录屏分段可见时才接上，避免为不可见的一段白打一次
    if (curDevSeg() === 'record') void resumeRec();
  }
  if (id === 'usage' && !usageLoaded) loadUsage();
  if (id === 'link') {
    renderCurConn();
    /// 首页的「手动输入」进连接页时不该顺手自动扫描，否则折叠框刚弹开就被
    /// loadScan 里的 link-manual.open = false 收回去
    if ((opts.scan ?? true) && !scanData) void loadScan(false);
  }
  /// 系统页：能力横幅和当前分段都需要，其余分段切到时再拉。
  /// 以前进页面就同时读默认桌面/启动项/开机自启三份，每条都要敲 adb 上百个包，
  /// 三份一起跑只会互相拖慢；用户一眼只看得见一段。
  if (id === 'system') {
    if (!capsData) loadCaps();
    syncSysOffline();
    ensureSysSeg(curSysSeg());
  }
  /// 脚本页：进来看一次。之后由「重新读取」按钮和运行结束时的回落控制，
  /// 不做自动轮询 —— 脚本清单是用户自己改的，没有别的东西会让它在背后变
  if (id === 'auto' && !autoData) loadAuto();
}

/// 用事件委托：上排第 5 格「更多」的图标会被 syncMore 换掉，直接绑在每个按钮上会跟着丢
$('#tabs').onclick = (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  /// 「更多」是入口不是页面：点它是开合抽屉，不切页
  if (t.dataset.tab === 'more') setMore(!moreOpen);
  else showTab(t.dataset.tab);
};

/// 设备页当前选中的分段（信息/进程/文件/健康/录屏/日志）
function curDevSeg() {
  return $('#dev-seg button.on')?.dataset.seg || 'info';
}

/// 系统页当前选中的分段（默认桌面/启动项/开机自启）
function curSysSeg() {
  return $('#sys-seg button.on')?.dataset.seg || 'home';
}

/// 应用页当前选中的分段（启动/安装与管理）
function curAppsSeg() {
  return $('#apps-seg button.on')?.dataset.seg || 'launch';
}

/// 系统页三段各配一条懒加载，避免进页面就同时读三份包清单
function ensureSysSeg(name) {
  switch (name) {
    case 'home': if (!homeData) loadHome(); break;
    case 'startup': if (!startupData) loadStartup(); break;
    case 'boot': if (!bootData) loadBoot().then(() => fillBootTargets()); break;
  }
}

/// 设备页六个分段各配一条懒加载：进设备页只拉当前分段，切段时才拉对应数据。
/// 守卫用各自的数据变量判空，避免重复触发。
function ensureDevSeg(name) {
  switch (name) {
    case 'info': if (!devInfo) loadDevice(); break;
    case 'proc': if (!procs) loadProcs(); break;
    case 'file': if (!fsRows) loadFs(fsDir); break;
    case 'health': if (!healthData) loadHealth(); break;
    case 'record': if (!recRows) loadRecs(); break;
    case 'log': if (!logRows) loadLog(); break;
  }
}

function syncDeviceCapabilities() {
  const online = !!state?.online;
  const shown = new Set(state?.keys || []);
  /// 设备按键按本次 ADB 探测结果逐个显示。鼠标、触控板、文字输入不属于按键能力，
  /// 因此即使设备只报告返回/主页，也仍保留一套可用的通用控制界面。
  $$('.capability-key').forEach((el) => {
    const key = (el.dataset.key || '').trim();
    el.hidden = !(online && key && shown.has(key));
  });
  $$('.capability-keys').forEach((el) => {
    const keys = (el.dataset.keys || '').trim().split(/\s+/).filter(Boolean);
    const any = keys.some((k) => shown.has(k));
    const all = keys.length > 0 && keys.every((k) => shown.has(k));
    el.hidden = !(online && (el.dataset.match === 'any' ? any : all));
  });
  const keyCount = $('#keycount');
  if (keyCount) keyCount.textContent = online ? `${shown.size} 个可用按键` : '';
}

$$('[data-jump]').forEach((b) => (b.onclick = () => {
  showTab(b.dataset.jump);
  /// 「查看详情」这类入口应直达对应分段：设备页默认停在「信息」，
  /// 从健康快照点进来却要再找一次「健康」，等于白点的这一下
  if (b.dataset.seg) $(`#dev-seg [data-seg="${b.dataset.seg}"]`)?.click();
}));

/// 面板内分段（应用：启动/管理；设备：信息/进程/文件），选择记下来下次进来还在这一屏
function wireSeg(sel) {
  const seg = $(sel);
  if (!seg) return;
  const pane = seg.closest('.pane');
  seg.onclick = (e) => {
    const b = e.target.closest('button[data-seg]');
    if (!b) return;
    $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
    $$('.subpane', pane).forEach((s) => s.classList.toggle('on', s.dataset.sub === b.dataset.seg));
    localStorage.setItem(`tvdeck.seg.${sel}`, b.dataset.seg);
    /// 分段内容各自不同长度：从一个长列表底部切到短内容，页面还停在旧位置
    /// 会切出一片空/错位感。切段时把主滚动容器轻轻带回顶部。
    /// 桌面端滚动在 main（overflow-y:auto），窄屏是整页/panel，逐级回退。
    if (e.isTrusted) {
      const sc = pane.closest('main') || document.scrollingElement || document.documentElement;
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      try { sc.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); } catch { sc.scrollTop = 0; }
    }
    if (sel === '#dev-seg') {
      /// 切到哪个分段就懒加载哪个分段的数据，其余不碰 adb。
      ensureDevSeg(b.dataset.seg);
      if (b.dataset.seg === 'record') void resumeRec();
      updateDevInfoPoll();
      updateHealthPoll();
      updateProcPoll();
      updateStampTick();
    }
    if (sel === '#sys-seg') ensureSysSeg(b.dataset.seg);
    if (sel === '#apps-seg' && b.dataset.seg === 'manage' && !inv) loadInv();
  };
  const saved = localStorage.getItem(`tvdeck.seg.${sel}`);
  /// 恢复上次分段要在本脚本初始化完成后执行：部分分段守卫引用了后面才声明的
  /// inv / healthData，立即 click 会踩到暂时性死区并报 ReferenceError。
  if (saved) queueMicrotask(() => seg.querySelector(`[data-seg="${saved}"]`)?.click());
}

wireSeg('#apps-seg');
  wireSeg('#dev-seg');
  wireSeg('#sys-seg');
wireSeg('#auto-seg');

$('#btn-details').onclick = () => {
  const d = $('#details');
  d.hidden = !d.hidden;
};

/// 详情卡和抽屉不同，没有遮罩可接点击：点面板里任何非卡片区域都要收回去，
/// 不然它会一直盖在列表上，用户只能再去找那个小圆点按钮
document.addEventListener('pointerdown', (e) => {
  const d = $('#details');
  if (d.hidden || d.contains(e.target) || $('#btn-details').contains(e.target)) return;
  d.hidden = true;
});

function setOps(open) {
  slideSheet($('#opsheet'), open);
  opsOpen = open;
  $('#btn-ops').classList.toggle('on', open);
  if (open) renderOps();
}

$('#btn-ops').onclick = () => setOps(!opsOpen);
$('#btn-op-close').onclick = () => setOps(false);
$('#opsheet').onclick = (e) => {
  if (e.target === $('#opsheet')) setOps(false);
};
$('#btn-op-clear').onclick = () => {
  ops = [];
  saveOps();
  renderOps();
  log('操作日志已清空');
};

$('#btn-more-close').onclick = () => setMore(false);
$('#moresheet').onclick = (e) => {
  if (e.target === $('#moresheet')) setMore(false);
};
/// 点抽屉外面一律收起：上排 tab、顶栏菜单、主题切换这些入口点击时不会都经过 showTab，
/// 只靠切页关抽屉会漏；先按下再响应也让同一个点击只做一件事
document.addEventListener('pointerdown', (e) => {
  const sheet = $('#moresheet');
  if (sheet.hidden || sheet.contains(e.target) || $('#tab-more').contains(e.target)) return;
  setMore(false);
});
/// 有的环境只有鼠标/键盘事件，或 pointerdown 被浏览器/远程层吞掉：
/// mousedown 再补一刀，保证「点别的菜单/按钮」时抽屉一定会先收起来
document.addEventListener('mousedown', (e) => {
  const sheet = $('#moresheet');
  if (sheet.hidden || sheet.contains(e.target) || $('#tab-more').contains(e.target)) return;
  setMore(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  /// 两个抽屉都按「先关掉这一层」处理。后面还挂着设备按键映射（Escape=返回）：
  /// 这里已经消费掉这次按键，不拦住的话关抽屉的同一次按键会顺手给设备发一条「返回」
  if (opsOpen) setOps(false);
  else if (moreOpen) setMore(false);
  else return;
  e.stopImmediatePropagation();
});

function focusLabel(comp, apps, resolved) {
  if (!comp) return '无前台应用';
  const [pkg, act] = comp.split('/');
  const a = apps.find((x) => x.package === pkg);
  const short = (act || '').split('.').filter(Boolean).pop() || '';
  // resolved 是服务端按全量名字缓存算出的人话名，优先级最高：
  // 页面那份 apps 清单只收启动项，系统桌面/设置这类根本不在里面
  const name = resolved || (a ? displayName(a) : appLabel(pkg));
  const detail = ACTIVITY_CN[short] || (/[^\x00-\x7F]/.test(short) ? short : '');
  return detail && !GENERIC_ACT.has(short) ? `${name} · ${detail}` : name;
}

/// 输入设备名来自 Android 的 dumpsys，直接显示会露出 "built-in keyboard" 这类英文。
/// 只保留用户能据此判断设备类型的信息，认不出来时也不把内部名字倒给用户。
function inputDeviceLabel(raw) {
  const s = String(raw || '').toLowerCase();
  if (/remote|consumer control|\brc\b/.test(s)) return '设备按键输入';
  if (/gamepad|joystick/.test(s)) return '游戏手柄';
  if (/keyboard|qwerty|key/.test(s)) return '设备自带按键';
  return '设备按键';
}

/// 设备离线时把「拖了也没用」的控件真正禁掉，而不是留一个能动却发不出去的滑杆
function setControlsEnabled(on) {
  for (const sel of ['#vol', '#bright', '#btn-shot']) {
    const el = $(sel);
    if (el) el.disabled = !on;
  }
  $$('.rounds .round').forEach((b) => (b.disabled = !on));
  /// 电源按钮同样只在设备在线时可点：离线时点下去只会换回 503「设备没连上」，
  /// 与其让用户点了没反应，不如直接禁用，并把原因写在按钮说明里
  $$('#powerrow .chip').forEach((b) => (b.disabled = !on));
  /// 录屏也一样：屏幕在设备上，连不上就没得录
  const rec = $('#btn-rec');
  if (rec) rec.disabled = !on || recBusy;
  if (!on) {
    $('#volinfo').textContent = '设备离线，连上后才能调';
    $('#volnum').textContent = '—';
  }
}

/// 昵称按设备序列号分开存：换设备时不继承上一台的旧名字
function deviceNick(serial) {
  if (serial) return localStorage.getItem(`tvdeck.nick.${serial}`) || '';
  return localStorage.getItem('tvdeck.nick') || '';
}

/// 模拟器的完整展示名常带「Android 模拟器」前缀和内部构建名。标题只承担认出设备的
/// 职责，优先保留有辨识度的后半段；完整名称仍留在悬停提示里。
function compactDeviceName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '设备';
  const api = raw.match(/^Android\s*模拟器\s*·?\s*（API\s*(\d+)）$/);
  if (api) return `模拟器 · API ${api[1]}`;
  const emulatorTail = raw.replace(/^Android\s*模拟器\s*/i, '').trim();
  return emulatorTail || '模拟器';
}

function transportLabel(serial) {
  const v = String(serial || '');
  if (/^emulator-\d+$/i.test(v)) return '模拟器 ADB';
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) return '无线 ADB';
  return 'USB / 本地 ADB';
}

/// 首屏设备状态条：设备名已经在顶部，这里只补充能否调试和连接事实。
/// 所有值都从实时状态回填，不写死任何机型或连接方式。
function paintDeviceBrief(s, p, modelClean) {
  const on = !!s.online;
  const modelText = on
    ? [prettyBrand(p.brand), p.screen?.w && p.screen?.h ? `${p.screen.w}×${p.screen.h}` : null]
        .filter(Boolean)
        .join(' · ') || '当前 ADB 设备'
    : '当前没有在线 ADB 设备';
  const focus = on ? (s.focusName || focusLabel(s.focus, p.apps, s.focusName)) : '—';
  const setText = (id, text, title = '') => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.title = title || text;
  };
  setText('#db-state', on ? '已连接 · 可调试' : '等待 ADB 设备');
  setText('#db-model', modelText, on ? modelClean : '');
  setText('#db-android', on && p.androidVersion ? `Android ${p.androidVersion}` : '—');
  setText('#db-serial', p.serial || '—', p.serial ? '当前 adb 调试标识' : '');
  setText('#db-transport', on ? transportLabel(p.serial) : '—');
  setText('#db-focus', focus, on && s.focus ? `前台 ${s.focus}` : '');
  $('#db-dot')?.classList.toggle('on', on);
  const source = $('#tvSource');
  if (source) {
    source.textContent = on ? `来源 ${p.serial || modelClean}` : '等待 ADB 设备';
    source.title = on ? modelClean : '';
  }
}

function renderState(s) {
  $('#psub')?.classList.remove('loading');
  /// 换设备（或这次连上了另一台）时，设备页那几块按需加载的缓存必须先失效，
  /// 否则新设备的页面会顶着上一台的 CPU 占用、进程数，看着像读错了
  if (state?.profile?.serial && state.profile.serial !== s.profile?.serial) resetDeviceCaches();
  const wasOnline = !!state?.online;
  state = s;
  syncDeviceRatio(s.screen?.w, s.screen?.h);
  if (wasOnline && !s.online) {
    /// 刚掉线：设备页/系统页如果正停在信息、桌面等依赖设备读数的分段，
    /// 立刻把旧数据换成离线空态，别让上一台的数据继续挂在页面上
    resetDeviceCaches();
    if (curTab === 'device' && curDevSeg() === 'info') void loadDevice();
    if (curTab === 'system' && curSysSeg() === 'home' && !homeData) {
      const box = $('#homelist');
      if (box) box.replaceChildren(emptyOff({ title: '连接后读取桌面候选', note: '可切换默认桌面，并还原到切换前的系统桌面。', action: false }));
      const note = $('#homenote');
      if (note) note.textContent = '';
    }
    if (curTab === 'system') syncSysOffline();
  }
  if (s.online && !wasOnline) {
    /// 刚连上：让设备页/系统页把之前可能显示过的离线空态换成真实数据入口
    if (curTab === 'device' && curDevSeg() === 'info') void loadDevice();
    if (curTab === 'system' && curSysSeg() === 'home' && !homeData) void loadHome();
    if (curTab === 'system') syncSysOffline();
  }
  /// 首屏的 /api/state 是异步回来的（真机上这一趟常要一两秒）。日志面板要是比它先画了，
  /// 那一刻还不知道手里是哪台设备，收藏集合只能按空集算 —— 刷新页面后星标就会"消失"，
  /// 得等用户手动再读一次日志才回得来。序列号第一次到位、而手上确实有一批日志时补画一遍。
  /// 只在序列号**变了**的时候补画：renderState 每轮轮询都会走一趟，无条件重画会把
  /// 用户已经滚到的位置和展开的堆栈一起冲掉
  if ((s.profile?.serial || '') && s.profile.serial !== logMarksSerial && logRows) renderLog();
  const p = s.profile;
  /// 优先用设备自己报的市场名 / 模拟器标注（modelFriendly），没有才退回原始型号。
  /// 模拟器那类构建目标代号（sdk_google_atv64_arm64）直接给用户看没有意义
  const modelRaw = p.modelFriendly || p.model || '';
  const modelClean = (p.modelFriendly ? modelRaw : modelRaw.replace(new RegExp(`^${p.brand}\\s*`, 'i'), '')).trim() || '设备';
  const titleEl = $('#device');
  if (document.activeElement !== titleEl) {
    titleEl.textContent = s.online ? (deviceNick(p.serial) || compactDeviceName(modelClean)) : '未连接';
    titleEl.title = s.online ? modelClean : '当前没有在线 ADB 设备';
  }
  // 厂牌本身就是 Android 时，后面再跟「Android 14」会读成两遍 Android，只留版本那半截
  const verText = p.androidVersion ? `Android ${p.androidVersion}` : '';
  const brandText = p.brand && !/^android$/i.test(p.brand.trim()) ? prettyBrand(p.brand) : '';
  $('#model').textContent = s.online
    ? ([brandText, verText].filter(Boolean).join(' · ') || prettyBrand(p.brand) || '已连接')
    : (p.serial ? `上次：${p.serial}` : '等待设备连接');
  $('#model').title = s.online ? [modelClean, verText].filter(Boolean).join(' · ') : $('#model').textContent;
  paintDeviceBrief(s, p, modelClean);
  $(".pane[data-pane='home']").classList.toggle('home-offline', !s.online);
  const homeC = $('#home-connect');
  if (homeC) homeC.hidden = !!s.online;
  $('#focus').textContent = s.online ? focusLabel(s.focus, p.apps, s.focusName) : '';
  const shot = $('#btn-shot');
  if (shot) shot.hidden = !s.online;
  $('#serial').textContent = p.serial || '';
  /// 左上角字标是产品名，不随当前设备品牌变；设备画面里的厂牌才跟着设备走
  $('#brand').textContent = 'ADB';
  /// 设备屏前的标记：离线时固定显示产品名 ADB；在线时优先用前台应用图标，
  /// 没有图标才退回设备品牌首字母
  const mark = $('#tvBrand');
  const fg = (s.focus || '').split('/')[0];
  const fgFile = s.online && fg ? iconMeta(fg)?.file : '';
  mark.replaceChildren();
  mark.classList.toggle('has-logo', !!fgFile);
  if (fgFile) {
    const img = document.createElement('img');
    img.src = `/icons/${fgFile}`;
    img.alt = '';
    img.onerror = () => {
      img.remove();
      mark.classList.remove('has-logo');
      mark.textContent = s.online ? initial(p.brand || 'D') : 'ADB';
    };
    mark.append(img);
  } else {
    mark.textContent = s.online ? initial(p.brand || 'D') : 'ADB';
  }

  const dot = $('#dot');
  dot.classList.toggle('on', !!s.online);
  dot.textContent = s.online ? '已连接' : '离线';
  /// 窄屏顶部只剩一条标题栏，底部那条状态条收掉了，连接状态改由设备名下面这个
  /// 小圆点报：颜色与文字口径跟底部那条完全一致，不会一处说连着一处说掉线
  const hdot = $('#hdot');
  if (hdot) {
    hdot.classList.toggle('on', !!s.online);
    hdot.setAttribute('aria-label', s.online ? '已连接' : '离线');
  }
  updateHealthPoll();
  /// 设备连上 / 掉线都要让总览页快照跟着启停：掉线后不该继续空转轮询，
  /// 重新连上时总览页要立刻把读数接回来
  updateHomeSnapPoll();

  const rc = $('#btn-reconnect');
  const rcTarget = p.serial || (p.ip ? `${p.ip}:5555` : '');
  rc.hidden = !!s.online || !rcTarget;
  rc.disabled = false;
  rc.dataset.ip = p.ip || '';
  rc.dataset.port = String(serialPort(rcTarget));
  rc.title = rcTarget ? `重新连接 ${rcTarget}` : '档案里没有历史地址，无法重连';
  const hrc = $('#btn-home-reconnect');
  if (hrc) {
    hrc.hidden = !!s.online || !rcTarget;
    hrc.disabled = false;
    hrc.dataset.ip = p.ip || '';
    hrc.dataset.port = String(serialPort(rcTarget));
    hrc.title = rcTarget ? `重新连接 ${rcTarget}` : '档案里没有历史地址，无法重连';
  }

  // 顶上这个 ⏻ 按当前状态给动作：在线=发送电源键，离线=唤醒，不再是一按就 toggle
  const pw = $('#btn-power');
  pw.classList.toggle('off', !s.online);
  /// 在线/离线切换时，上一次没确认完的电源态不能留着：红框在离线时会
  /// 看起来像「唤醒需要二次确认」，实际点下去是直接唤醒
  if (!s.online && pw.classList.contains('armed')) {
    sleepArmAt = 0;
    paintPowerArm(pw, false);
  }
  const pt = s.online ? '向设备发送电源键（部分设备会休眠并断开无线调试）' : '唤醒设备（等网络回来，最长 25 秒）';
  pw.title = pt;
  pw.setAttribute('aria-label', pt);
  pw.setAttribute('aria-pressed', 'false');

  /// 按键通路：直写输入设备 = 免掉设备端 keyevent 冷启动，回退时说明原因
  const ip = $('#inputpath');
  if (ip) {
    const fast = s.inputPath?.via === 'evdev';
    ip.classList.toggle('fast', fast);
    const deviceLabel = fast && s.inputPath.deviceLabel ? inputDeviceLabel(s.inputPath.deviceLabel) : '';
    /// 「17 键」是实现细节：用户只关心按键现在走哪条通路、快不快。
    /// 键数既不影响操作也不解释问题，露出来只会多一圈要读的字
    ip.querySelector('span').textContent = !s.online
      ? '未探测'
      : fast
        ? `${deviceLabel ? `「${deviceLabel}」` : '直写设备输入'} · 低延迟`
        : s.inputPath?.note || '系统通道 · 略慢';
    ip.title = fast
      ? '直写设备输入节点，跳过系统按键服务的冷启动，按下即响应'
      : s.inputPath?.note || '通过系统按键通道发送，功能一致，响应略慢';
    ip.querySelector('span').title = ip.title;
  }
  /// 触控板的能力说明、禁用态和辅助按键都由设备实测结果决定，这里统一回填
  paintTouchpad(s);

  $('#d-model').textContent = withBrand(p.brand, modelClean);
  $('#d-android').textContent = p.androidVersion || '—';
  $('#d-addr').textContent = p.ip || '—';
  $('#d-serial').textContent = p.serial || '—';
  const ev = $('#d-evidence');
  ev.textContent = p.evidenceDir || '未取证 · 点击补全';
  ev.classList.toggle('ev-missing', !p.evidenceDir);
  renderCurConn();

  paintTvIdle();
  syncDeviceCapabilities();

  /// 离线时滑杆和加减键都不能用：能拖动却发不出去，比直接禁用更让人困惑
  const music = s.volume.find((v) => v.stream === 'STREAM_MUSIC');
  if (music && s.online) {
    const vol = $('#vol');
    vol.max = music.max;
    $('#volnum').textContent = music.level;
    if (document.activeElement !== vol) vol.value = music.level;
    $('#volinfo').textContent = `上限 ${music.max}`;
    $('#volinfo').title = `设备音频输出，上限 ${music.max}`;
  } else if (!s.online) {
    $('#volnum').textContent = '—';
    $('#volinfo').textContent = '';
  }
  setControlsEnabled(!!s.online);

  /// 亮度以设备实时回读为准，profile 里的值只做兜底
  const sb = p.picture.find((x) => x.key === 'screen_brightness');
  const brightLive = s.brightness ?? (sb ? Number(sb.live ?? sb.value) : null);
  if (brightLive !== null && !Number.isNaN(brightLive)) {
    if (document.activeElement !== $('#bright')) $('#bright').value = brightLive;
    $('#brightv').textContent = `${brightLive}/255`;
  }
  /// 没有护眼通路时收起整组控件：四个禁用按钮再配一句「不可用」，
  /// 既占空间，又容易让人反复确认是不是自己没点到
  if (s.night) {
    const supported = s.night.supported !== false;
    const nightOk = supported && !!s.online;
    for (const sel of ['#btn-night-on', '#btn-night-off', '#btn-night-apply', '#nightlvl']) {
      const el = $(sel);
      if (el) el.disabled = !nightOk;
    }
    $('#btn-night-on')?.closest('.row')?.classList.toggle('is-hidden', !supported);
    const el = $('#nightstate');
    /// 支持时只留当前状态，不再重复控件组已经写明的「护眼」；
    /// 不支持时控件已经收起，这一行就是结论本身
    /// 服务端不支持时给的是完整病因（「设备没有系统护眼服务，开不了」），
    /// 前半句「护眼不可用」已经由控件消失表达，再拼一遍只会重复
    el.textContent = supported
      ? (s.night.activated ? '已开启' : '已关闭')
      : (s.night.detail || '当前设备不支持护眼');
    el.title = s.night.detail || '';
    el.classList.toggle('warn', !supported);
  }
  if (s.pq) {
    /// 读不到面板参数的设备不占一行说明：这页没有对应的调节控件，纯噪声
    $('#pqinfo').textContent = s.pq.ok
      ? `${Object.entries(s.pq.attrs)
          .map(([k, v]) => `${PQ_NAMES[k] ?? k} ${v}`)
          .join(' · ')} · ${s.pq.panel}`
      : '';
    $('#pqinfo')?.setAttribute('title', s.pq.ok ? '面板调节范围以设备回读为准，256 通常为中立值' : '');
  }

  const pb = $('#btn-preview');
  if (pb) {
    paintTvBtns();
    actsPinned = !preview;
    if (actsPinned) {
      clearTimeout(actsTimer);
      paintActs(true);
    } else {
      scheduleActsHide();
    }
  }
  $('.tv').classList.toggle('live', preview);
  /// 连上设备就自动把画面亮起来：用户的预期是「设备连上了就该看到它的屏幕」，
  /// 而不是对着一张等待图自己去找预览按钮。用户主动停过就不再自动开
  /// 自动拉起时不再弹「预览已开启」：用户刚打开页面就会看到一行提示，
  /// 而画面本来就是自动出现的，这条提示没有可执行信息
  if (s.online && !preview && !previewAutoOff) void setMirror(true, { quiet: true });

  /// 清单没读到就别把 0 当数字挂出去：读数是 0 和「还没读到」是两回事
  /// 离线时 profile 里残留的是上一台设备/上一次会话的清单，不能继续当成本次读数
  const gotApps = !!s.online && p.apps.length > 0;
  $('#appcount').textContent = gotApps ? String(p.apps.length) : '';
  $('#appcount2').textContent = gotApps ? `(${p.apps.length})` : '';
  const favAll = document.querySelector('.card .link[data-jump="apps"]');
  if (favAll) favAll.hidden = !s.online;
  const healthLink = document.querySelector('.card .link[data-jump="device"][data-seg="health"]');
  if (healthLink) healthLink.hidden = !s.online;
/// 键盘输入与手势都取决于设备实测能力：通路有没有、屏幕多大。
  /// 探测结果跟着每次状态刷新一起回填，不在这里额外开一次请求
  paintTextPaths(s.text);
  paintGestureCap(s.screen);

  paintFav(p.apps);

  renderApps();

  const pic = $('#picture');
  if (!pic.children.length && p.picture.length) {
    pic.replaceChildren(
      ...p.picture.map((x) => {
        const row = document.createElement('div');
        row.className = 'pictrow';
        const name = document.createElement('span');
        name.className = 'kname';
        const label = document.createElement('b');
        label.textContent = pictureName(x.key);
        const sub = document.createElement('span');
        /// 原来每行都挂一条「系统设置 / 安全设置」副行，等于把同样的来源
        /// 重复五遍，手机上白占一百多像素。来源本来就在悬停说明里，
        /// 只有「回读值和写入值对不上」时这条副行才真的在传达信息，
        /// 其余情况直接不渲染，读数行回到紧凑的一行。
        const mismatch = x.live !== undefined && x.live !== x.value;
        if (mismatch) sub.textContent = `${TABLE_CN[x.table]} · 当前 ${x.live}`;
        name.append(label, sub);
        name.title = `${x.table}/${x.key}（当前 ${x.live ?? x.value}）`;
        const input = document.createElement('input');
        input.value = x.live ?? x.value;
        input.onchange = () =>
          api('/api/picture', { key: x.key, table: x.table, value: input.value }, `${pictureName(x.key)} → ${input.value}`)
            .then((r) => log(`${pictureName(x.key)} · ${r.detail}`, r.verified ? 'ok' : 'warn'))
            .catch((e) => log(e.message, 'err'));
        row.append(name, input);
        return row;
      }),
    );
  }
}

function iconBox(cls, a, name) {
  const box = document.createElement('span');
  box.className = cls;
  if (a.icon) {
    const img = document.createElement('img');
    img.src = a.icon;
    img.alt = '';
    img.onerror = () => {
      img.remove();
      box.textContent = monogram(name);
    };
    box.append(img);
  } else {
    box.textContent = monogram(name);
  }
  return box;
}

/// 总览页两处宽屏（1180 起）布局，窄屏一律不动：
/// 常用应用铺成两行（8 个）。只放一行时右栏只有 508px 高，
///    左栏画面卡是 687（1912 实测），右栏底下要空出小两百像素。
/// 两处只在跨断点的那一下重排，窗口在断点之内拖动不碰 DOM
const HOME_WIDE = matchMedia('(min-width: 1180px)');
const FAV_WIDE = 8;
const FAV_NARROW = 4;

function paintFav(apps) {
  const fav = $('#favlist');
  if (!fav) return;
  if (!state?.online) {
    fav.replaceChildren(emptyOff({
      title: '暂无应用',
      note: '连接后自动读取。',
      action: false,
    }));
    return;
  }
  if (!apps?.length) {
    const note = captionEl('应用清单还没读取到，点一下重试。');
    const retry = Object.assign(document.createElement('button'), {
      type: 'button',
      className: 'link',
      textContent: '重试',
      title: '重新读取这台设备的应用清单',
    });
    retry.onclick = () => {
      note.textContent = '正在重新读取…';
      retry.disabled = true;
      api('/api/state', { fresh: 1 }, '重新读取设备状态')
        .then((r) => {
          if (r.ok) {
            state = r;
            renderApps();
            paintFav(state?.profile?.apps);
          } else {
            note.textContent = r.detail || '还是没有读到，请稍后再试。';
            retry.disabled = false;
          }
        })
        .catch((e) => {
          note.textContent = e.message || '重新读取失败，请稍后再试。';
          retry.disabled = false;
        });
    };
    const row = Object.assign(document.createElement('div'), { className: 'fav-empty row' });
    row.append(note, retry);
    fav.replaceChildren(row);
    return;
  }
  const n = HOME_WIDE.matches ? FAV_WIDE : FAV_NARROW;
  fav.replaceChildren(...apps.slice(0, n).map(appTile));
}

function layoutHome() {
  const pane = $(".pane[data-pane='home']");
  const colA = pane?.querySelector('.hcol-a');
  paintFav(state?.profile?.apps);
}

HOME_WIDE.addEventListener('change', layoutHome);
layoutHome();

function appTile(a) {
  const name = displayName(a);
  const b = document.createElement('button');
  b.className = 'tile';
  b.title = a.package;
  const ico = iconBox('ico', a, name);
  const lb = document.createElement('span');
  lb.className = 'lb';
  lb.textContent = name;
  b.append(ico, lb);
  b.onclick = () => launch(a, name);
  return b;
}

function appRow(a) {
  const name = displayName(a);
  const b = document.createElement('button');
  b.className = 'appbtn';
  /// 手机端列表以应用名为主，包名/完整组件收进 title，
  /// 需要排查包名时悬停或读屏仍能拿到，桌面端不受影响
  b.title = a.component || a.package;
  const m = iconBox('mono', a, name);
  const txt = document.createElement('span');
  txt.className = 'txt';
  const t = document.createElement('b');
  t.textContent = name;
  const sub = document.createElement('span');
  sub.textContent = a.package;
  txt.append(t, sub);
  b.append(m, txt);
  b.onclick = () => launch(a, name);
  return b;
}

/// 启动列表默认铺几个：不是写死的 8 个，而是按当前窗口量出来这一屏铺得下几行。
/// 沿用抽屉那次判断：有地方就铺满，别让人为省地方多点一次；地方真不够才收起来。
/// 320×568 这种一列的小屏量出来不足 8 条，兜底还是 8 条，不会比以前更差
let appsAll = false;
let appsShown = 8;

/// 面板没露着、或者这一帧还没布局的时候，所有元素量出来都是 0，
/// 这时候别改数，沿用上一次的量；返回 0 表示「这次量不到」
function appFitCount(apps) {
  const list = $('#applist');
  const pane = list?.closest('.pane');
  const main = pane?.closest('main');
  const more = $('#btn-apps-more');
  if (!list || !pane || !main || !more) return 0;
  if (!pane.offsetParent || !list.offsetHeight) return 0;
  const lcs = getComputedStyle(list);
  const gap = parseFloat(lcs.rowGap) || 0;
  const rowH = list.firstElementChild?.offsetHeight || 0;
  const cols = Math.max(1, (lcs.gridTemplateColumns || '').split(' ').filter(Boolean).length);
  if (!rowH) return 0;
  /// 列表顶端不用它自己的 rect 定位：切页时面板会从下方 6px 处入场，
  /// 动画期间直接量会少算 6px。主区不吃这个动画，用它左上角加面板内偏移来算
  const mcs = getComputedStyle(main);
  const mrect = main.getBoundingClientRect();
  const inner = list.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  const listY = mrect.top + (parseFloat(mcs.paddingTop) || 0) + inner;
  const limit = mrect.bottom - (parseFloat(mcs.paddingBottom) || 0);
  const rows = (space) => Math.max(0, Math.floor((space + gap) / (rowH + gap)));
  /// 折叠时那条「展开全部」自己也要占一行。按钮上一轮可能被藏起来了，
  /// 先把元素露出来量一下高度再放回去，不然会把这一行算漏
  const wrap = more.closest('.row') || more;
  const wasHidden = more.hidden;
  if (wasHidden) more.hidden = false;
  const reserve =
    wrap.offsetHeight +
    (parseFloat(getComputedStyle(wrap).marginTop) || 0) +
    (parseFloat(getComputedStyle(pane).gap) || 0);
  if (wasHidden) more.hidden = true;
  let fit = rows(limit - listY - reserve) * cols;
  /// 本来就铺得下全部的话，连那行按钮也不用留了，再放开算一次
  if (fit >= apps.length) fit = rows(limit - listY) * cols;
  return Math.max(8, Math.min(fit, apps.length));
}

function renderApps() {
  if (!state?.online) {
    $('#applist').replaceChildren(emptyOff({
      title: '连接设备后读取应用清单',
      note: '连上后会自动列出可启动的应用。',
      action: false,
    }));
    $('#btn-apps-more').hidden = true;
    return;
  }
  const apps = state?.profile.apps ?? [];
  if (!apps.length) {
    const note = captionEl(state ? '正在读取应用清单…' : '未连接设备，先在「连接」页连上再试。');
    if (state) {
      const retry = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'link',
        textContent: '重试',
        title: '重新读取这台设备的应用清单',
      });
      retry.onclick = () => {
        note.textContent = '正在重新读取…';
        retry.disabled = true;
        api('/api/state', { fresh: 1 }, '重新读取设备状态')
          .then((r) => {
            if (r.ok) {
              state = r;
              renderApps();
            } else {
              note.textContent = r.detail || '还是没有读到，请稍后再试。';
              retry.disabled = false;
            }
          })
          .catch((e) => {
            note.textContent = e.message || '重新读取失败，请稍后再试。';
            retry.disabled = false;
          });
      };
      const row = Object.assign(document.createElement('div'), { className: 'fav-empty row' });
      row.append(note, retry);
      $('#applist').replaceChildren(row);
    } else {
      $('#applist').replaceChildren(note);
    }
    $('#btn-apps-more').hidden = true;
    return;
  }
  const fit = appFitCount(apps);
  const n = appsAll ? apps.length : fit || appsShown;
  if (!appsAll && fit) appsShown = Math.min(fit, apps.length);
  $('#applist').replaceChildren(...apps.slice(0, n).map(appRow));
  const b = $('#btn-apps-more');
  b.hidden = apps.length <= n;
  b.textContent = appsAll ? '收起' : `展开全部 ${apps.length} 个`;
}

$('#btn-apps-more').onclick = () => {
  appsAll = !appsAll;
  renderApps();
};

function launch(a, name) {
  api('/api/launch', { name: a.component }, `${name} · 启动`)
    .then((r) => log(`${name} · ${r.ok ? '已发送' : r.detail}`, r.ok ? 'ok' : 'err'))
    .catch((e) => log(e.message, 'err'));
}

/// fresh=true 用于「刚做完一次改变设备状态的动作」：服务端动作后只把缓存标成过期，
/// 下一轮默认还会先回旧值，探测这种写完档案就要立刻看到结果的场景必须绕开缓存
/// 同一时刻只留一条状态读取。首屏、图标加载完、visibilitychange 和 20 秒轮询
/// 很容易撞在一起；无线设备上一次全量 state 要一两秒，并发只会让后回来的旧结果
/// 盖掉新结果，按钮也看起来「点了没反应」。
let stateFlight = null;
let stateAgain = false;

async function refresh(fresh = false) {
  if (stateFlight) {
    /// 正在读的时候又要求强制刷新：记下来，当前这趟结束后再补一趟
    if (fresh) stateAgain = true;
    return stateFlight;
  }
  stateFlight = (async () => {
    /// 接口超过 300ms 还没回来时，状态行提示「刷新中」；很快的请求
    /// 不闪这一句，避免每次轮询都抖一下。
    let slowTimer = 0;
    let slowTick = 0;
    let slowStart = 0;
    const upd = $('#pupdated');
    const paintSlow = () => {
      if (!upd) return;
      const wait = Math.max(0, Math.round((Date.now() - slowStart) / 1000));
      upd.textContent = wait ? `· 刷新中 ${wait}s` : '· 刷新中…';
      upd.title = `正在读取设备状态${wait ? `，已等待 ${wait} 秒` : ''}…`;
    };
    slowTimer = setTimeout(() => {
      if (!upd) return;
      upd.classList.remove('warn');
      upd.hidden = false;
      slowStart = Date.now();
      paintSlow();
      slowTick = setInterval(paintSlow, 1000);
    }, 300);
    try {
      const s = await api(fresh ? '/api/state?fresh=1' : '/api/state');
      clearTimeout(slowTimer);
      clearInterval(slowTick);
      stateReadAt = Date.now();
      renderStateFreshness();
      startStateFreshTick();
      renderState(s);
    } catch (e) {
      clearTimeout(slowTimer);
      clearInterval(slowTick);
      $('#psub')?.classList.remove('loading');
      if (upd) {
        upd.hidden = false;
        upd.classList.add('warn');
        upd.textContent = '· 读取失败';
        upd.title = e.message || '设备状态读取失败';
      }
      log(e.message, 'err');
    } finally {
      stateFlight = null;
      if (stateAgain) {
        stateAgain = false;
        void refresh(true);
      }
    }
  })();
  return stateFlight;
}

/// 按键之后设备状态会变，但立刻全量刷新会和服务端抢 adb；合并成一次延迟刷新
let keySettle = 0;
function settleRefresh(delay = 1200) {
  clearTimeout(keySettle);
  keySettle = setTimeout(refresh, delay);
}

/// 长按连发：按住方向/音量键连续发键，点一下才发一次。
/// 前端自己做「按住 420ms 后每 170ms 补一发」，和后端 pressKey 的 700ms 单次长按
/// 不是一回事 —— 后者只产生一个长按事件，做不出「按住音量连续加减」。
const REPEAT_AFTER = 420;
const REPEAT_EVERY = 170;
const REPEAT_KEYS = new Set(['up', 'down', 'left', 'right', 'volUp', 'volDown']);

/// 触觉反馈只在真有触屏的设备上给，桌面鼠标点击不该震
const buzz = (ms = 8) => {
  if (navigator.maxTouchPoints > 0 && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
};

$$('[data-key]').forEach((b) => {
  const key = b.dataset.key;
  const what = KEY_CN[key] || key;
  const long = b.dataset.long === '1';
  let hold = 0;
  let repeat = 0;
  let busy = false;
  let fired = 0;       // 本轮按住补发过几发，只用来决定错误提示要不要弹
  let repeating = false; // 已经进入连发态（按住超过 REPEAT_AFTER）
  let repeated = false;  // 上一次交互是连发，松手时补发的 click 要吃掉
  let skipClick = false; // 连发失败后，松手补发的 click 也一并吃掉，别重复报错

  /// 连发只走 /api/key 直写通路：不读回、不记操作日志。带读回的 /api/volume
  /// 步进一次要几百毫秒，跟不上手指，还会把日志刷满
  const repeatFire = async () => {
    if (busy) return;
    busy = true;
    try {
      await api('/api/key', { key }, `${what} · 连发`, true);
      if (key === 'volUp' || key === 'volDown') {
        const el = $('#volnum');
        const n = Number(el.textContent);
        const max = Number($('#vol').max) || 100;
        if (Number.isFinite(n)) el.textContent = Math.max(0, Math.min(max, n + (key === 'volUp' ? 1 : -1)));
      }
      fired += 1;
      buzz(6);
    } catch (e) {
      /// 设备掉线时按住不放会一秒刷出好几条 503，没必要：发不出去就立刻停，
      /// 只提示一次，并把松手那下 click 也吃掉
      clearTimeout(hold);
      clearInterval(repeat);
      hold = repeat = 0;
      b.classList.remove('firing');
      repeating = false;
      skipClick = true;
      log(e.message, 'err');
    } finally {
      busy = false;
    }
  };

  const stopRepeat = () => {
    clearTimeout(hold);
    clearInterval(repeat);
    hold = repeat = 0;
    b.classList.remove('firing');
    if (!repeating) return;
    repeating = false;
    fired = 0;
    repeated = true;
    buzz(14);
    /// 连发期间只发键不读回，松手后补一次状态刷新（音量数字、前台应用）
    settleRefresh(1500);
  };

  b.addEventListener('pointerdown', (e) => {
    if (b.disabled || !REPEAT_KEYS.has(key)) return;
    /// 上一次是 pointercancel/移出结束的（浏览器不会再补 click），标记要清掉，
    /// 否则这一次点按会被当成"连发的尾巴"吃掉
    repeated = false;
    skipClick = false;
    /// 捕获指针：手指按住后轻微滑动不会中途丢掉 pointerup，连发能一直走到松手
    try {
      b.setPointerCapture(e.pointerId);
    } catch {
      /* 老浏览器没有指针捕获，靠 pointerleave 兜底 */
    }
    b.classList.add('firing');
    buzz(8);
    hold = setTimeout(() => {
      repeating = true;
      repeatFire();
      repeat = setInterval(repeatFire, REPEAT_EVERY);
    }, REPEAT_AFTER);
  });
  /// 手指滑出按钮就算松手：这是触屏上「拖走取消」的通用手势。留 12px 余量，
  /// 手指按住的自然抖动不该把连发掐断
  b.addEventListener('pointermove', (e) => {
    if (!repeating) return;
    const r = b.getBoundingClientRect();
    const pad = 12;
    if (e.clientX < r.left - pad || e.clientX > r.right + pad || e.clientY < r.top - pad || e.clientY > r.bottom + pad) {
      stopRepeat();
      repeated = false; // 手指已经移出按钮，浏览器不会再补 click
    }
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave']) b.addEventListener(ev, stopRepeat);

  b.onclick = async () => {
    /// 长按已经连发过，松手时浏览器还会补一个 click，这里吃掉它，不然会多走一格
    if (repeated || skipClick) {
      repeated = false;
      skipClick = false;
      return;
    }
    b.classList.add('firing');
    buzz(10);
    const t0 = performance.now();
    try {
      const label = `${what}${long ? ' 长按' : ''}`;
      const r = ['volUp', 'volDown', 'mute'].includes(key)
        ? await api('/api/volume', { dir: key === 'volUp' ? 'up' : key === 'volDown' ? 'down' : 'mute' }, label)
        : await api('/api/key', { key, long }, label);
      const ms = Math.round(performance.now() - t0);
      const music = r.levels?.find((v) => v.stream === 'STREAM_MUSIC');
      if (music) {
        $('#vol').max = music.max;
        $('#volnum').textContent = music.level;
        if (document.activeElement !== $('#vol')) $('#vol').value = music.level;
      }
      log(`${label} · ${r.detail || '已发送'} · ${ms}ms`, r.ok ? 'ok' : 'err');
      if (r.levels) settleRefresh(3000);
      else settleRefresh();
    } catch (e) {
      log(e.message, 'err');
    } finally {
      setTimeout(() => b.classList.remove('firing'), 120);
    }
  };
});

/// 拖动即生效（原来只在松手 change 时发一次，滑杆看起来"没反应"）；
/// 设备上一次写入要几百毫秒，拖动途中只发软请求，并合并成"当前最新值"，避免请求堆积。
let volDrag = 0;
let volBusy = false;
let volPending = null;

function pushVolume(level, final) {
  if (volBusy) {
    volPending = { level, final: final || volPending?.final || false };
    return;
  }
  volBusy = true;
  api('/api/volume', final ? { level } : { level, soft: true }, `音量 → ${level}`, !final)
    .then((r) => {
      const music = r.levels?.find((v) => v.stream === 'STREAM_MUSIC');
      if (music) {
        $('#vol').max = music.max;
        if (!final && document.activeElement === $('#vol')) $('#volnum').textContent = level;
        else $('#volnum').textContent = music.level;
        if (document.activeElement !== $('#vol')) $('#vol').value = music.level;
        $('#volinfo').textContent =
          `设备扬声器 · 上限 ${music.max}` + (final && r.verified === false ? ' · 设备未确认到该值' : '');
      }
      if (final) log(r.detail || `音量 ${level}`, r.verified ? 'ok' : 'err');
    })
    .catch((x) => log(x.message, 'err'))
    .finally(() => {
      volBusy = false;
      if (volPending) {
        const p = volPending;
        volPending = null;
        pushVolume(p.level, p.final);
      }
    });
}

$('#vol').addEventListener('input', (e) => {
  const level = Number(e.target.value);
  $('#volnum').textContent = level;
  clearTimeout(volDrag);
  volDrag = setTimeout(() => pushVolume(level, false), 200);
});
$('#vol').onchange = (e) => {
  clearTimeout(volDrag);
  pushVolume(Number(e.target.value), true);
};


/// 电源与唤醒分开做：发一次电源键之后 adb 可能掉线，唤醒则要等设备网络回来，是长请求
let powerBusy = false;

function powerBusyOn(b, txt) {
  powerBusy = true;
  b.disabled = true;
  b.dataset.prev = b.textContent;
  if (b.id !== 'btn-power') b.textContent = txt;
  else b.classList.add('armed');
}

function powerBusyOff(b) {
  b.disabled = false;
  if (b.id !== 'btn-power' && b.dataset.prev) b.textContent = b.dataset.prev;
  b.classList.remove('armed');
  powerBusy = false;
}

/// 电源键可能造成"面板连不上设备"（部分设备休眠会断 Wi-Fi），所以第一次点击只警告
let sleepArmAt = 0;
/// 顶部那颗电源键只有图标：确认窗口里必须自己说明「再点一次」，
/// 不能只靠变色。离线时它是唤醒入口，不能挂「会断连接」的提示。
const POWER_ARM_MS = 5000;

function paintPowerArm(b, armed) {
  if (!b) return;
  b.classList.toggle('armed', armed);
  if (b.id === 'btn-power' && state?.online) {
    b.title = armed ? '再点一次确认发送电源键；部分机型休眠后会断开无线调试' : '电源 / 唤醒';
    b.setAttribute('aria-label', armed ? '再点一次确认发送电源键' : '电源 / 唤醒');
    b.setAttribute('aria-pressed', String(armed));
    const hint = $('#powerArmHint');
    if (hint) hint.hidden = !armed;
  }
}

async function doSleep(id) {
  if (powerBusy) return;
  const b = $(id);
  if (Date.now() - sleepArmAt > POWER_ARM_MS) {
    sleepArmAt = Date.now();
    paintPowerArm(b, true);
    if (b.id !== 'btn-power') {
      b.dataset.prev = b.textContent;
      b.textContent = '会断连接，再点确认';
    }
    log('再点一次「电源」才执行：部分机型休眠后需在设备上手动唤醒', 'warn');
    const armedAt = sleepArmAt;
    setTimeout(() => {
      /// 期间已经真正执行过（sleepArmAt 被清零），就别把新的忙碌态擦掉
      if (sleepArmAt !== armedAt) return;
      sleepArmAt = 0;
      paintPowerArm(b, false);
      if (b.dataset.prev) b.textContent = b.dataset.prev;
    }, POWER_ARM_MS);
    return;
  }
  sleepArmAt = 0;
  paintPowerArm(b, false);
  if (b.dataset.prev) b.textContent = b.dataset.prev;
  powerBusyOn(b, '发送中…');
  try {
    const r = await api('/api/sleep', {}, '发送电源键');
    log(r.detail, r.verified ? 'warn' : 'err');
  } catch (e) {
    log(e.message, 'err');
  } finally {
    powerBusyOff(b);
    paintPowerArm(b, false);
    setTimeout(refresh, 2500);
  }
}

async function doWake(id) {
  if (powerBusy) return;
  const b = $(id);
  powerBusyOn(b, '等待设备上线…');
  const t0 = performance.now();
  try {
    const r = await api('/api/wake', { budget: 25000 }, '唤醒设备');
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log(`${r.detail} · 本次请求 ${secs}s`, r.verified ? 'ok' : r.ok ? 'warn' : 'err');
    if (r.steps?.length) console.info('唤醒过程：', r.steps.join(' / '));
  } catch (e) {
    log(e.message, 'err');
  } finally {
    powerBusyOff(b);
    refresh();
    setTimeout(refresh, 3000);
  }
}

$('#btn-sleep').onclick = () => doSleep('#btn-sleep');
$('#btn-wake').onclick = () => doWake('#btn-wake');
$('#btn-power').onclick = () => (state?.online ? doSleep('#btn-power') : doWake('#btn-power'));

/// 手动「重新读取设备状态」必须绕开只读缓存真读一次。
/// 这里不能写成 onclick = refresh：事件对象会被当成参数，等于所有调用都变成强制刷新
$('#btn-refresh').onclick = () => refresh(true);

/// 快照层读的是轻量缓存，改型/换设备后可能还压着旧字段；这里强制重跑一次通用探测，
/// 让型号、应用、画面设置全部回到当前连接设备。按钮反馈走操作日志
async function runReprobe() {
  try {
    /// 走 api() 的统一记录：操作日志里能看到耗时和结果，失败也不用自己再写一遍
    const p = await api('/api/probe', {}, '重新探测当前设备');
    log(`已重新探测 ${p.model || '?'}（应用 ${p.apps} 个）`, 'ok');
    resetDeviceCaches();
    await refresh(true);
  } catch (e) {
    log(e.message, 'err');
  }
}

$('#btn-reprobe').onclick = async (b) => {
  const btn = b.currentTarget;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在重新探测…';
  await runReprobe();
  btn.disabled = false;
  btn.textContent = old;
};

/// 换设备后 evidenceDir 会被清空，这里给个一键补全入口，不用去找探测按钮
$('#d-evidence').onclick = () => {
  if (state?.profile?.evidenceDir) return;
  const btn = $('#btn-reprobe');
  btn.disabled = true;
  btn.textContent = '正在补全取证…';
  runReprobe().finally(() => {
    btn.disabled = false;
    btn.textContent = '重新探测当前设备';
  });
};

$('#btn-reconnect').onclick = async () => {
  const b = $('#btn-reconnect');
  b.disabled = true;
  b.textContent = '连接中…';
  try {
    const r = await api('/api/connect', {}, '重连设备');
    log(r.ok ? '设备连接已恢复' : `重连失败 · ${r.detail || '无响应'}`, r.ok ? 'ok' : 'err');
  } catch (e) {
    log(e.message, 'err');
  } finally {
    b.disabled = false;
    b.textContent = '重连上次设备';
    refresh();
  }
};

/* ── 连接页：搜索局域网里的设备、看已连接列表、按 IP 建立无线调试 ── */
let scanData = null;

/// 设备连接状态的中文说法，未知状态原样显示，避免把新状态吞掉
const ADB_STATE_CN = {
  device: '在线',
  offline: '离线',
  unauthorized: '等待设备上授权',
  no_permissions: '调试服务权限不足',
  recovery: '恢复模式',
  sideload: '侧载模式',
  bootloader: '引导模式',
  host: '本地调试服务',
};

/// adb serial 就是 ip:port，端口被改过时提示和重连都必须跟着走
function serialPort(serial) {
  const m = /:(\d+)$/.exec(String(serial || '').trim());
  return m ? Number(m[1]) : 5555;
}

/// 说明性长文一律挪进悬停提示：页面上只留扫一眼能读完的那半句
const krow = (k, v, tip = '') => {
  const r = document.createElement('div');
  r.className = 'drow';
  const a = document.createElement('span');
  a.textContent = k;
  const b = document.createElement('b');
  b.textContent = v;
  if (tip) {
    b.title = tip;
    b.classList.add('cut');
  }
  r.append(a, b);
  return r;
};

function srow(main, sub, action, tip = '', subTip = '') {
  const row = document.createElement('div');
  row.className = 'srow';
  const box = document.createElement('div');
  box.className = 's-main';
  const b = document.createElement('b');
  b.textContent = main;
  box.append(b);
  if (sub) {
    const s = document.createElement('span');
    s.className = 's-sub';
    s.textContent = sub;
    if (subTip) {
      s.title = subTip;
      s.classList.add('cut');
    }
    box.append(s);
  }
  row.append(box);
  if (action) row.append(action);
  return row;
}

function actChip(text, onClick) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.type = 'button';
  b.textContent = text;
  b.onclick = () => onClick(b);
  return b;
}

/// getprop 出来的厂牌常是全小写（"google"、"oneplus"），直接上页面像日志。
/// 只在整串都是小写 ASCII 时首字母大写，「Sony」这类本身有大小写的不动
function prettyBrand(b) {
  const v = String(b || '').trim();
  if (!v) return '';
  return /^[a-z][a-z0-9 _-]*$/.test(v) ? v.charAt(0).toUpperCase() + v.slice(1) : v;
}

/// 厂牌 + 机型名拼一行，但两边都在说同一件事时不要念两遍：
/// 「Android」模拟器、「Google」Android 模拟器这类，机型名自己已经带厂牌
function withBrand(brand, model) {
  const b = prettyBrand(brand);
  const m = String(model || '').trim();
  if (!m) return b || '—';
  const lm = m.toLowerCase();
  if (!b) return m;
  if (lm.startsWith(`${b.toLowerCase()} `) || lm.startsWith('android ')) return m;
  return `${b} ${m}`;
}

let linkIpAuto = '';

function renderCurConn() {
  const box = $('#curconn');
  if (!box) return;
  const p = state?.profile || {};
  const model = (p.modelFriendly || (p.model || '').replace(new RegExp(`^${p.brand}\\s*`, 'i'), '')).trim() || p.model || '—';
  /// 手动输入框只在「空着」或「还是上一次自动填的地址」时跟着换设备：
  /// 用户自己敲的地址不能覆盖，但切完设备还顶着上一台的 serial 会让人连错机器
  const inp = $('#linkip');
  if (inp && document.activeElement !== inp) {
    const cur = (inp.value || '').trim();
    /// 模拟器和 USB 设备的 ip 字段其实就是 serial（emulator-5556），
    /// 填进「调试地址」再点连接只会被 IPv4 校验打回，不如留空让用户填真 IP
    const asIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(p.ip || '') ? p.ip : '';
    if (!cur || cur === linkIpAuto) inp.value = asIp;
    linkIpAuto = inp.value || '';
  }
  const head = document.createElement('div');
  head.className = 'curdev-head';
  const mark = document.createElement('span');
  mark.className = 'curdev-mark';
  mark.textContent = state?.online ? initial(p.brand || model) : 'ADB';
  const body = document.createElement('div');
  body.className = 'curdev-body';
  const name = document.createElement('b');
  name.className = 'curdev-name';
  name.textContent = state?.online ? (withBrand(p.brand, model) || '设备') : '当前没有在线 ADB 设备';
  const sub = document.createElement('span');
  sub.className = 'curdev-sub';
  sub.textContent = state?.online
    ? (p.androidVersion ? `Android ${p.androidVersion}` : '系统信息未读取')
    : (p.serial ? `上次：${p.serial}` : '还没有连接过设备');
  body.append(name, sub);
  const online = document.createElement('span');
  online.className = `curdev-state${state?.online ? ' on' : ''}`;
  online.textContent = state?.online ? '已连接' : '未连接';
  online.setAttribute('aria-label', online.textContent);
  head.append(mark, body, online);

  const address = p.serial || (p.ip ? `${p.ip}:${p.port || 5555}` : '未记录');
  /// 只有真正的网络地址才在详情卡里单列一行；模拟器和 USB 设备的 serial
  /// （emulator-5554）不是地址，标成「地址」会让人以为它是 IP，
  /// 改名成「调试序列号」又跟下方同一台设备重复一次。直接不显示，
  /// 需要看序列号时下方设备列表里本来就有
  const isNetAddr = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(address);
  const rows = isNetAddr ? [krow('地址', address)] : [];
  /// 逐台型号在下方「自动扫描」列表里已经各占一行，这里再拼一长串就是把同一批
  /// 名字念两遍，还会把这一行顶成三行高；只留台数，全名进悬停提示
  const adb = scanData?.adb;
  const adbNames = (adb || []).map((d) => `${d.modelFriendly || d.model || '未知型号'} ${d.serial}（${ADB_STATE_CN[d.state] || d.state || '状态未知'}）`);
  /// 只有一台时下面列表里就是它本人，「已连接的设备 1 台」纯属重复；
  /// 多台或一台都没有时才需要这行汇总
  /// 还没扫描过时（adb 为 undefined）这一行只会写「扫描后显示」，
  /// 是句占位话，不是设备状态；空着更干净，真扫过之后才有内容可说
  if (adb && adb.length !== 1) {
    rows.push(
      krow(
        '已连接的设备',
        adb.length ? `${adb.length} 台` : '无',
        adbNames.join('\n'),
      ),
    );
  }
  box.replaceChildren(head, ...rows);
}

function renderScan() {
  const box = $('#scanlist');
  const d = scanData;
  if (!d) return;
  const cur = state?.profile?.serial || '';
  const nodes = [];
  const adbList = d.adb || [];
  const candList = d.candidates || [];
  for (const dev of d.adb || []) {
    const ip = dev.serial.split(':')[0];
    const port = serialPort(dev.serial);
    const live = dev.state === 'device';
    const here = dev.serial === cur;
    /// adb 报的 model 是构建代号（sdk_google_atv64_arm64），后端补了 getprop 才有可读机型名
    const name = dev.modelFriendly || dev.model || '未知型号';
  /// 同时挂着多台 adb 设备（真机、模拟器、盒子等）时，页面必须能点名切到哪一台。
    /// 以前只能控制 adb 列表里的第一台，用户除了回终端没有别的办法
    const act = here
      ? null
      : live
        ? actChip('切到这台', (b) => selectDevice(dev.serial, b))
        : actChip('重连', (b) => attachLink(ip, b, port));
    const row = srow(
      `${name} · ${dev.serial}`,
      here ? '当前设备' : live ? '在线 · 可切换' : `状态：${ADB_STATE_CN[dev.state] || dev.state || '未知'}`,
      act,
      '',
      live || here ? '' : '点重连会先摘掉这条旧记录再握手',
    );
    if (here) row.classList.add('is-current');
    nodes.push(row);
  }
  /// 两组数据来源不同：上面是 adb 已经认得的设备，下面是网段里扫到的 IP。
  /// 不隔开时，候选行紧贴在设备行下面，看起来像是它的子项，容易点错
  if (adbList.length && candList.length) {
    const sep = document.createElement('p');
    sep.className = 'caption scan-group';
    /// 台数和扫描范围已经在下面的元信息行里说过，这里只做分组，不再复述
    sep.textContent = '局域网内发现的 ADB 设备';
    nodes.push(sep);
  }
  for (const c of d.candidates || []) {
    const ports = c.ports || [];
    /// Android 11+ 的无线调试端口是随机的，候选自带哪个端口就连哪个；
    /// 5555 只是最常见值，不能再把非 5555 端口当成「连不了 ADB」。
    const adbPort = ports.includes(5555) ? 5555 : ports[0] || null;
    /// 自动发现只返回网络 ADB 候选。主行只回答「端口是什么、能不能连」，
    /// 端口清单和发现来源折进悬停提示，主行只保留连接判断。
    const sub = adbPort ? '网络 ADB · 可连接' : '网络 ADB · 自定义端口';
    const tip = [
      `开放端口 ${ports.join(' / ') || '未明'}`,
      adbPort ? '' : 'Android 11+ 无线调试端口，连接后需在设备上确认授权',
      c.reason ? `发现来源：${c.reason}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const there = state?.online && c.ip === cur;
    /// 候选来自 ADB mDNS 或端口探测，只要带回端口就能直接发起连接。
    const cls = '';
    nodes.push(
      srow(
        adbPort ? `${c.ip}:${adbPort}` : c.ip,
        sub,
        adbPort ? actChip(there ? '重连' : '连接', (b) => attachLink(c.ip, b, adbPort)) : null,
        '',
        tip,
      ),
    );
    if (cls) nodes.at(-1).classList.add(cls.trim());
  }
  if (nodes.length) {
    box.replaceChildren(...nodes);
  } else {
    const empty = document.createElement('div');
    empty.className = 'empty-state empty-off';
    const head = document.createElement('b');
    head.textContent = '没有发现网络 ADB 设备';
    const sub = document.createElement('p');
    sub.textContent = '设备需先开启“无线调试 / 网络 ADB”，并与服务端处于同一局域网。';
    const row = document.createElement('div');
    row.className = 'row';
    const manual = document.createElement('button');
    manual.textContent = '手动输入地址';
    manual.onclick = () => {
      const d = $('#link-manual');
      const bm = $('#btn-manual');
      if (bm) bm.setAttribute('aria-expanded', 'true');
      if (d) d.open = true;
      const inp = $('#linkip');
      if (inp) inp.focus();
    };
    row.append(manual);
    empty.append(head, sub, row);
    box.replaceChildren(empty);
  }
  /// 元信息行要说清「这一屏数据是哪来的」。以前缓存命中也照抄「耗时 2.5 秒」，
  /// 那是服务器真搜一次的时间，不是这次请求花的时间，同句里再跟一句「0 秒前的缓存」
  /// 就自相矛盾，还催用户去点一次根本不会变的搜索。
  const n = (d.candidates || []).length;
  const metaEl = $('#scanmeta');
  const spent = `真搜一次花 ${(d.ms / 1000).toFixed(1)} 秒`;
  /// 候选来自 ADB mDNS 或已开放的调试端口，统一写成「ADB 发现」，
  /// 局域网设备统一按通用 ADB 设备表述，不绑定任何硬件形态。
  const scopeText = /已有设备/.test(d.scope || '') ? '局域网 ADB 发现' : d.scope;
  let meta;
  if (d.cached) {
    const age = d.ageSec <= 1 ? '刚刚' : `${d.ageSec} 秒前`;
    /// 90 秒内重复打开连接页直接回缓存：数据还新鲜时不用再喊「点搜索拿最新」
    meta = d.ageSec < 15
      ? `${age}搜过 · ${n} 台`
      : `${age} · ${n} 台`;
    metaEl.title = `${scopeText} · ${spent}，这次读的是缓存`;
  } else {
    meta = `${(d.ms / 1000).toFixed(1)} 秒 · ${n} 台`;
    metaEl.title = scopeText;
  }
  metaEl.textContent = meta;
}

/// force：用户亲手点了搜索按钮，必须真搜；页面自己顺带加载才允许吃缓存。
/// 扫描期间保留上一轮结果：连接页刚打开时自动扫一次，清空列表会像页面坏了
let scanRequestSeq = 0;

function setScanState(text, kind = 'busy') {
  const el = $('#scanstate');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle('busy', !!text && kind === 'busy');
  el.classList.toggle('err', !!text && kind === 'err');
}

async function loadScan(full, force = false) {
  const box = $('#scanlist');
  const b = full ? $('#btn-scan-full') : $('#btn-scan');
  if (b.disabled || $('#btn-scan').disabled) return;
  /// 点扫描后手工输入区让位：地址框和结果列表同时占据注意力时容易混淆，
  /// 这里把折叠收起来，只留一个明确正在做的事
  $('#link-manual').open = false;
  $('#btn-manual')?.setAttribute('aria-expanded', 'false');
  const request = ++scanRequestSeq;
  b.disabled = true;
  $('#btn-scan').disabled = true;
  b.textContent = '扫描中…';
  /// 按钮自己已经写着「扫描中…」，再在下面补一行「正在扫描 ADB 设备…」
  /// 等于同一句话念两遍；状态行只在真的需要额外说明时出现
  setScanState('');
  /// 没有旧结果时才放占位；有结果就让用户继续看、继续点，扫描完成后原位替换
  /// 按钮已经写着「扫描中…」，列表里再放一句同样的话就是第三次重复。
  /// 这里只铺两条安静的骨架行，表示「结果马上到」
  if (!scanData) {
    const skel = document.createElement('div');
    skel.className = 'scan-skel';
    skel.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 2; i++) {
      const row = document.createElement('div');
      row.className = 'scan-skel-row';
      const av = document.createElement('i');
      av.className = 'scan-skel-av';
      const lines = document.createElement('div');
      lines.className = 'scan-skel-lines';
      const l1 = document.createElement('i');
      l1.className = 'scan-skel-line scan-skel-line-1';
      const l2 = document.createElement('i');
      l2.className = 'scan-skel-line scan-skel-line-2';
      lines.append(l1, l2);
      row.append(av, lines);
      skel.append(row);
    }
    /// 只有骨架行还是像「两块坏掉的灰板」：补一句正在扫描，说明这是什么
    const hint = captionEl('正在扫描局域网中的 ADB 设备…');
    hint.classList.add('scan-skel-hint');
    box.replaceChildren(hint, skel);
  }
  try {
    const data = await api(`/api/scan?full=${full ? 1 : 0}&ms=${full ? 6000 : 2500}${force ? '&force=1' : ''}`);
    /// 只让最后一次请求落盘，避免自动扫描和手动重扫互相覆盖
    if (request !== scanRequestSeq) return;
    scanData = data;
    setScanState('');
    renderScan();
    renderCurConn();
  } catch (e) {
    if (request !== scanRequestSeq) return;
    /// 旧结果也是有效信息：失败只报在状态行，不把用户正在看的设备列表抹掉
    if (!scanData) box.replaceChildren(captionEl('扫描没有完成，请稍后重试。'));
    setScanState(`扫描失败：${e.message}`, 'err');
  } finally {
    if (request === scanRequestSeq) {
      b.textContent = full ? '整网段查找 ADB' : scanData ? '重新扫描' : '扫描 ADB 设备';
      b.disabled = false;
      $('#btn-scan').disabled = false;
    }
  }
}

async function selectDevice(serial, b) {
  if (b.disabled) return;
  const prev = b.textContent;
  b.disabled = true;
  b.textContent = '切换中…';
  try {
    const r = await api('/api/select', { serial }, `切换到设备 ${serial}`);
    log(r.detail || `已切到 ${serial}`, r.ok ? 'ok' : 'warn');
    /// refresh() 里发现换设备会走 resetDeviceCaches，顺手把 scanData 清成 null，
    /// 列表就停在切换前那一帧：顶栏已经是新设备，列表却还给旧设备标「当前」，
    /// 看起来像切错了。已连接列表不会因为切了一次就变了，留一份原样重画即可
    const keepScan = scanData;
    await refresh();
    if (keepScan) {
      scanData = keepScan;
      renderScan();
    }
    renderCurConn();
    if (!r.ok) loadScan(false);
  } catch (e) {
    log(e.message, 'err');
  } finally {
    b.disabled = false;
    b.textContent = prev;
  }
}

async function attachLink(ip, b, port = 5555) {
  if (b.disabled) return;
  const prev = b.textContent;
  b.disabled = true;
  b.textContent = '连接中…';
  try {
    const r = await api('/api/connect', { ip, port }, `连接 ${ip}:${port}`);
    log(r.detail, r.ok && r.verified ? 'ok' : r.ok ? 'warn' : 'err');
    await refresh();
    renderCurConn();
    /// 从首页直接发起的手动连接 / 重连成功后回总览，让用户立刻看到设备画面；
    /// 失败时留在连接页，状态行已经由 renderCurConn / scanstate 表达
    const hsc = r.ok && r.verified && state?.online;
    if (hsc && curTab === 'link') showTab('home');
  } catch (e) {
    log(e.message, 'err');
  } finally {
    b.disabled = false;
    b.textContent = prev;
  }
}

$('#btn-scan').onclick = () => loadScan(false, true);
$('#btn-scan-full').onclick = () => loadScan(true, true);
$('#btn-home-scan').onclick = () => {
  showTab('link', { scan: false });
  void loadScan(false, true);
};
$('#btn-home-manual').onclick = () => {
  showTab('link', { scan: false });
  const d = $('#link-manual');
  d.open = true;
  $('#btn-manual')?.setAttribute('aria-expanded', 'true');
  $('#linkip').focus();
};
$('#btn-home-reconnect').onclick = async () => {
  const b = $('#btn-home-reconnect');
  const ip = b.dataset.ip || '';
  const port = Number(b.dataset.port || 5555) || 5555;
  b.disabled = true;
  b.textContent = '连接中…';
  try {
    const r = await api('/api/connect', ip ? { ip, port } : {}, '重连设备');
    log(r.detail, r.ok && r.verified ? 'ok' : r.ok ? 'warn' : 'err');
    await refresh();
    if (r.ok && r.verified && state?.online) {
      if (curTab === 'home') renderCurConn();
      else showTab('home');
    }
  } catch (e) {
    log(e.message, 'err');
  } finally {
    b.disabled = false;
    b.textContent = '重连上次设备';
  }
};

$('#btn-manual').onclick = () => {
  const d = $('#link-manual');
  d.open = !d.open;
  $('#btn-manual').setAttribute('aria-expanded', String(d.open));
  if (d.open) $('#linkip').focus();
};
$('#link-manual').addEventListener('toggle', () => {
  $('#btn-manual')?.setAttribute('aria-expanded', String($('#link-manual').open));
});

async function linkManual() {
  const inp = $('#linkip');
  const portEl = $('#linkport');
  /// 允许把「192.168.1.6:5555」整段粘进来，粘完自动拆成 IP + 端口
  let raw = (inp.value || '').trim();
  if (!raw) raw = state?.profile?.ip || '';
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(raw);
  if (!m) {
    log('先填一个正确的设备 IP，例如 192.168.1.6 或 192.168.1.6:5555', 'err');
    inp.focus();
    return;
  }
  const ip = m[1];
  const port = m[2] ? Number(m[2]) : Number((portEl.value || '').trim() || 5555);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log('端口要填 1 - 65535 之间的数字，无线调试默认端口 5555', 'err');
    portEl.focus();
    return;
  }
  inp.value = ip;
  portEl.value = String(port);
  await attachLink(ip, $('#btn-link'), port);
}

$('#btn-link').onclick = linkManual;
for (const el of [$('#linkip'), $('#linkport')]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      linkManual();
    }
  });
}

/// 服务器地址：留空 = 同源（现在这种「浏览器直接开本服务」的用法）。
/// 打包成客户端后前端和后台不再同源，就在这里指一次，刷新后生效。
/// 校验只拦「忘了写协议头」这种最常见的错，别的一律放行，多一层假设反而误伤。
(function initServerBox() {
  const input = $('#srvurl');
  const now = $('#srvnow');
  if (!input || !now) return;
  input.value = SRV;
  now.textContent = SRV ? SRV : '同源（当前服务端）';

  const apply = (v) => {
    try {
      if (v) localStorage.setItem(SRV_KEY, v);
      else localStorage.removeItem(SRV_KEY);
    } catch {
      /* 隐私模式写不进 localStorage：这一次仍然能生效，只是记不住 */
    }
  };

  const save = () => {
    const v = (input.value || '').trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) {
      log('地址要以 http:// 或 https:// 开头，例如 http://192.168.1.6:8787', 'err');
      input.focus();
      return;
    }
    apply(v);
    log(v ? `服务器已切到 ${v}，正在重新加载…` : '已恢复同源，正在重新加载…', 'ok');
    /// 重新加载而不是就地改 SRV：SRV 是 const，就地改会让"有些请求走新、有些走旧"，
    /// 这种半新半旧的状态最难查
    setTimeout(() => location.reload(), 420);
  };

  $('#btn-srv-save').onclick = save;
  $('#btn-srv-reset').onclick = () => {
    apply('');
    /// 还要把 URL 上的 ?server= 摘掉，否则刷新时它又会被解析回 localStorage
    const u = new URL(location.href);
    u.searchParams.delete('server');
    location.replace(u.toString());
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
})();

/// 「新标签打开纯画面」：客户端形态下 screen.html 也是本地那份，
/// 得把服务器地址一起带过去，它才知道去问谁要设备画面
(() => {
  const go = $('.fs-hint-go');
  if (go && SRV) go.href = `/screen?server=${encodeURIComponent(SRV)}`;
})();

$('#device').addEventListener('blur', (e) => {
  const v = e.target.textContent.trim();
  const serial = state?.profile?.serial || '';
  const key = `tvdeck.nick${serial ? `.${serial}` : ''}`;
  if (v) localStorage.setItem(key, v);
  else localStorage.removeItem(key);
  refresh();
});
$('#device').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
});

/// 画面上的控制层：没采集时一直露着（好找开关），采集中轻点画面才显形、2.5 秒自动收回，
/// 免得那个停止按钮一直压在画面上
let actsTimer = 0;
let actsPinned = true;

const paintActs = (on) => {
  $('#tvacts').classList.toggle('show', on);
  paintFsHint();
};

function scheduleActsHide() {
  clearTimeout(actsTimer);
  actsTimer = setTimeout(() => {
    /// 全屏里把按钮条收掉，鼠标用户就找不到「退出全屏」了：这一层只在非全屏自动收
    if (!actsPinned && !theater) paintActs(false);
  }, 2500);
}

function revealActs() {
  paintActs(true);
  scheduleActsHide();
}

$('.tv-screen').addEventListener('click', revealActs);
$('.tv-screen').addEventListener('touchstart', revealActs, { passive: true });
$('#btn-preview').addEventListener('click', revealActs);
$('#btn-fs').addEventListener('click', revealActs);

let frameTimer = 0;
/// 后台自动刷新的轻量帧门槛：预览帧比它小才算「轻」，超过就只在前台
/// 刷，不再发桌面通知；PNG 大帧拖着接口跑，后台提醒不能跟着变重
const FRAME_LIGHT_LIMIT = 48 * 1024;
let lastLightFrame = 0;

/// 画面挂在总览页里（全屏也是这一页铺满视口）。人切到别的页时那片画面根本没露出来，
/// 取帧却是实打实的整屏截图，一秒一张会把 adb 占住，别的数据请求全排在它后面
const tvOnScreen = () => theater || ($('.pane[data-pane="home"]')?.classList.contains('on') ?? true);

/// 单帧轮询：这一帧真的落地（load 或 error）之后才排下一张。
/// 以前是到点就换 src，设备一慢就攒出一串互相打断的截图请求，
/// 表现就是画面一闪一黑、或者干脆停在纯黑上
function scheduleFrame(ms) {
  clearTimeout(frameTimer);
  /// 页面切到后台就不再取帧：看不见的画面没必要一直让设备截屏。
  /// 同样地，人已经离开总览页也不再取帧。回到前台由 visibilitychange 补一帧，
  /// 切回总览页由 showTab 补一帧
  if (!preview || document.hidden || !tvOnScreen()) return;
  frameTimer = setTimeout(tick, ms);
}

/// 自动预览首帧失败时的快速窗口（毫秒）。iOS 上只有用户手势里发起的请求
/// 能用「已连接但拿不到」的设备地址；页面刚打开自动补的那一帧失败并不代表
/// 设备离线，短一点可以让界面更快回落到稳定状态。
const AUTO_PREVIEW_FIRST_RETRY_MS = 1800;

/// 两层画面交替：正在显示的那层不动，新帧加载到另一层
const shots = [$('#shot'), $('#shotB')];
let frontShot = 0;
const shownShot = () => shots[frontShot];

function showShot(i) {
  if (i === frontShot) return;
  shots[frontShot].classList.remove('on');
  shots[i].classList.add('on');
  frontShot = i;
}

function tick() {
  if (!preview || document.hidden || !tvOnScreen()) return;
  if (previewStream) return;
  shots[1 - frontShot].src = srv(`/device.jpg?t=${Date.now()}`);
  /// 兜底：8 秒还没落地就重新排队，别让轮询停在这一帧上
  scheduleFrame(8000);
}

/// 设备预览是纯本地循环（/device.jpg 单帧轮询），不启动服务端画面采集
async function setMirror(on, { quiet = false } = {}) {
  if (on === preview) return;
  preview = on;
  previewStream = !!(on && state?.devicePreview?.running && state?.devicePreview?.available);
  const pb = $('#btn-preview');
  $('.tv').classList.toggle('live', preview);
  paintTvBtns();
  if (on) {
    frameFailed = false;
    firstFrameAt = Date.now();
    /// 首帧没到时页面不会自己重绘：2.2 秒后补一次，让等待文案从
    /// 「正在读取」自然过渡到「读取较慢」，而不是一直停在第一句
    clearTimeout(firstFrameHint);
    firstFrameHint = setTimeout(() => {
      if (preview && !$('.tv').classList.contains('has-frame')) paintTvIdle();
    }, 2300);
    pb.classList.add('busy');
    if (previewStream) shots[1 - frontShot].src = srv(state.devicePreview.url || '/device.mjpg');
    else tick();
    if (!quiet) log('设备屏幕预览已开启', 'ok');
  } else {
    clearTimeout(firstFrameHint);
    firstFrameAt = 0;
    clearTimeout(frameTimer);
    for (const s of shots) {
      s.classList.remove('on');
      s.removeAttribute('src');
    }
    frontShot = 0;
    $('.tv').classList.remove('has-frame');
    log('已停止设备预览', 'ok');
  }
  paintTvIdle();
  // 判断 MJPEG 是否真的可用要等 img 的 load/error：一次失败后降级成单帧轮询
  // 后，不再永远吊在一条服务端不支持的流上
  setTimeout(() => {
    if (on && previewStream && !frameFailed) scheduleFrame(1200);
  }, 1600);
}

const toggleMirror = () => setMirror(!preview);

/// 用户自己按过「停止」就记住：之后设备一直连着，也别再自动把画面打开
let previewAutoOff = false;

/// 等待层的文案：在线但还没画出第一帧时必须说清楚，别让用户对着一块纯黑猜
function paintTvIdle() {
  const idle = $('#tvState');
  if (idle) idle.textContent = state?.online ? '设备在线' : '未连接';
  const sub = $('#tvSub');
  if (!sub) return;
  const hasFrame = $('.tv').classList.contains('has-frame');
  /// 三种等待要分开说：在取第一帧、取帧一直失败、设备根本没连上。
  /// 都是黑屏，但用户该做的事完全不同
  let text = '';
  if (!state?.online) text = '手动输入 IP 与端口，或扫描局域网中的 ADB 设备';
  else if (frameFailed) text = '取帧失败，正在重试…';
  else if (preview && !hasFrame) {
    text = Date.now() - firstFrameAt > 2200 ? '画面读取较慢，正在继续…' : '正在读取设备画面…';
  }
  if (sub.textContent !== text) sub.textContent = text;
  sub.hidden = !text;
  sub.classList.toggle('waiting', preview && !hasFrame && !frameFailed && !!state?.online);
  /// 没设备时屏幕上最该点的是「去哪填 IP / 去哪扫描」，别让人自己找 tab
  const cta = $('#btn-goto-link');
  if (cta) cta.hidden = !!state?.online;
}

$('#btn-goto-link').onclick = () => showTab('link');

/// 只有真的画出过一帧，才把等待层收起来。
/// 以前是一按预览就收起等待层，于是点全屏的那一秒正好是一整块纯黑，看着就像全屏坏了；
/// 设备离线时那块黑还会一直黑下去
function frameState(ok, i) {
  if (!preview) return;
  $('#btn-preview').classList.remove('busy');
  if (ok) {
    /// 迟到的帧（这期间已经翻过页）直接扔，免得把旧画面又翻回来
    if (i !== 1 - frontShot) return;
    frameErrLogged = false;
    frameFailed = false;
    firstFrameAt = 0;
    clearTimeout(firstFrameHint);
    showShot(i);
    $('.tv').classList.add('has-frame');
    paintTvIdle();
    paintFsMeta();
    lastLightFrame = Date.now();
    scheduleFrame(700);
    return;
  }
  /// 已经有画面时失败就不动它：留着上一帧比整块黑掉强
  if ($('.tv').classList.contains('has-frame')) {
    scheduleFrame(1400);
    return;
  }
  /// 首帧偶发超时很常见（设备刚亮屏、无线 ADB 抖一下）。先给短重试窗口，
  /// 别让一次失败就闪出“没取到”，等连续失败再把问题告诉用户
  if (firstFrameAt && Date.now() - firstFrameAt < (previewAutoOff ? 3500 : AUTO_PREVIEW_FIRST_RETRY_MS)) {
    paintTvIdle();
    scheduleFrame(900);
    return;
  }
  frameFailed = true;
  paintTvIdle();
  // 失败不关预览：留着循环重试，用户回来时画面自己会好
  if (!frameErrLogged) {
    frameErrLogged = true;
    log(state?.online ? '这一帧没取到，还在重试' : '设备离线，取帧失败，仍在重试', 'warn');
  }
  scheduleFrame(1400);
}

let frameErrLogged = false;

shots.forEach((img, i) => {
  img.addEventListener('load', () => {
    /// 新帧带着设备真实尺寸回来时再同步一次比例，作为 /api/state 缺失/陈旧时的兜底。
    /// 整张 <img> 的尺寸是缩放后的框，真正可信的是 naturalWidth / naturalHeight
    if (img.naturalWidth && img.naturalHeight) syncDeviceRatio(img.naturalWidth, img.naturalHeight);
    /// load 只说明数据到了，浏览器可能还没解码完。等 decode 成功再翻面，
    /// 消掉「旧帧被拿走、新帧还没画出来」那一瞬的黑屏；解码异常就按原流程翻面兜底
    img.decode().then(() => frameState(true, i)).catch(() => frameState(true, i));
  });
  img.addEventListener('error', () => frameState(false, i));
});

$('#btn-preview').onclick = () => {
  /// 正在播时按下 = 用户主动停，记下来，别再自动开
  previewAutoOff = preview;
  toggleMirror();
};

/// 切回前台立刻补一帧，别让画面停在离开时的旧帧上
document.addEventListener('visibilitychange', () => {
  if (!preview) return;
  if (document.hidden) {
    clearTimeout(frameTimer);
    return;
  }
  tick();
});

/// 全屏：点击那一帧必须同步做完状态切换，原生 API 只是顺带请求（iOS Safari 没有元素级全屏，
/// 靠 .fs 铺满视口兜住；之前 await 网络请求把用户手势耗光了，于是按下像没反应）
let theater = false;

/// 「全屏了但画面没变大」是这页最容易挨骂的一件事，而且各浏览器差别极大：
/// 有的内置浏览器 requestFullscreen 存在、调用之后却什么都不做，所以只认 document.fullscreenElement
const FS_NO_API = '这个浏览器不让网页全屏。满屏请按 F11，或点「在新标签打开纯画面」';
const FS_REFUSED = '浏览器收回了全屏请求。满屏请按 F11';
/// 内置浏览器会给原生全屏、但几秒后又自己收回去。以前这种情况被写成「请求被忽略」，
/// 用户对着一个「点过全屏、也确实满过屏、现在又变小了」的页面只会更糊涂
const FS_DROPPED = '浏览器收回了全屏。想一直满屏：点「在新标签打开纯画面」或按 F11';

let fsTimer = 0;

/// 文件页和总览页的全屏提示是两块不相干的文案，不能用同一个 id：
/// 之前 $() 永远命中总览页那个，文件页的读取信息根本写不进去
function setFsDirNote(text) {
  const note = $('#fsdirnote');
  if (!note) return;
  note.textContent = text;
}

function setFsStamp() {
  if (!fsStampAt || !fsRows) return;
  const ago = Math.max(0, Math.round((Date.now() - fsStampAt) / 1000));
  setFsDirNote(`${fsRows.rows.length} 项 · ${ago} 秒前读取`);
}

function setFsNote(text) {
  const note = $('#fsnote');
  if (!note || note.textContent === text) return;
  note.textContent = text;
  note.hidden = !text;
}

const nativeFs = () => document.fullscreenElement || document.webkitFullscreenElement;

/// 有 API 不等于能全屏：这个只用来挑提示文案，判断生效一律用 nativeFs()
const canNativeFullscreen = () => {
  const el = $('.tv-screen');
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
};

/// 请求原生全屏之后看几拍 fullscreenElement：没进去就把原因写在提示条上，
/// 别让用户对着「看起来全屏了、其实只是铺满窗口」的页面猜
function watchNativeFs() {
  clearInterval(fsTimer);
  let tries = 0;
  fsTimer = setInterval(() => {
    if (!theater) {
      clearInterval(fsTimer);
      return;
    }
    if (nativeFs()) {
      clearInterval(fsTimer);
      setFsNote('');
      return;
    }
    tries += 1;
    if (tries >= 3) {
      clearInterval(fsTimer);
      setFsNote(canNativeFullscreen() ? FS_REFUSED : FS_NO_API);
    }
  }, 300);
}

function setTheater(on) {
  theater = on;
  $('.tv-screen').classList.toggle('fs', on);
  const acts = $('#tvacts');
  const tools = $('#tvtools');
  if (acts && tools) {
    if (on) $('.tv-screen').append(acts);
    else tools.append(acts);
    tools.hidden = on;
  }
  document.body.classList.toggle('fs-lock', on);
  clearInterval(fsTimer);
  /// 进全屏先按「有没有 API」给个初值，真正的结论由 watchNativeFs 落地
  if (!on) setFsNote('');
  else setFsNote(nativeFs() || canNativeFullscreen() ? '' : FS_NO_API);
  /// 这一轮进全屏有没有真的拿到原生全屏，从干净状态重新开始记
  sawNativeFs = !!nativeFs();
  /// 进全屏等于「我要点画面」：只读模式下点了没反应，顺手打开点按
  if (on && !tapMode) setTapMode(true);
  /// 没开预览就进全屏，看到的是一块等待黑屏，点上去还什么都没有
  if (on && !preview) void setMirror(true);
  /// 全屏里三个按钮都带文字：只剩图标时，鼠标用户找不到哪个是干什么的
  paintTvBtns();
  paintFsMeta();
  /// 全屏里按钮条常驻：否则全黑一片里找不到出口。
  /// 提示条只亮 6 秒就淡出，免得长时间盖在画面上、被当成画面的一部分
  paintActs(on ? true : $('#tvacts').classList.contains('show'));
  hintSticky = false;
  if (on) showHint(6000);
  /// 切全屏这一帧视口未必结算完（内置浏览器是异步 resize），下一帧再量一次，
  /// 免得可点区域框停在旧尺寸上、比真实画面小一圈
  if (on) {
    settleStage();
    repaintStage();
  }
}

/// 画面比例是用户偏好，跨会话记住
function readFit() {
  try {
    return localStorage.getItem('tvdeck.fit') === 'cover' ? 'cover' : 'contain';
  } catch {
    return 'contain';
  }
}

/// 画面操作条的文案与状态统一从这里出。普通视图也保留短标签，
/// 避免触屏用户只看到 ▢ / ◉ / ⤢ 却不知道各自作用。
function paintTvBtns() {
  $('.tv-screen').classList.toggle('cover', fitMode === 'cover');
  for (const id of ['#btn-fit', '#btn-preview', '#btn-touch', '#btn-fs']) $(id)?.classList.toggle('wide', theater);
  const on = !!(state?.online);
  const paint = (el, icon, label) => {
    el.innerHTML =
      `<span class="tvbtn-ic" aria-hidden="true">${icon}</span>` +
      `<span class="tvbtn-lb">${label}</span>`;
  };
  const f = $('#btn-fit');
  if (f) {
    const cover = fitMode === 'cover';
    paint(f, cover ? '⛶' : '▢', cover ? '铺满' : '完整');
    f.classList.toggle('on', cover);
    f.title = cover ? '画面铺满（可能裁掉四周），点击改为完整显示' : '画面按比例完整显示（可能有黑边），点击改为铺满';
    f.setAttribute('aria-label', f.title);
    f.setAttribute('aria-pressed', String(cover));
  }
  const p = $('#btn-preview');
  if (p) {
    p.disabled = !on;
    paint(p, preview ? '⏹' : '◉', preview ? '停止' : '预览');
    p.classList.toggle('on', preview);
    p.title = on
      ? (preview ? '停止设备预览' : '预览设备屏幕')
      : '设备离线，连接后才能预览屏幕';
    p.setAttribute('aria-label', p.title);
    p.setAttribute('aria-pressed', String(preview));
  }
  const b = $('#btn-fs');
  if (b) {
    paint(b, theater ? '✕' : '⤢', theater ? '退出' : '全屏');
    b.classList.toggle('on', theater);
    b.title = theater ? '退出全屏' : '全屏画面';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(theater));
  }
  const t = $('#btn-touch');
  if (t) {
    t.disabled = !on;
    /// 用矢量图标代替 emoji：字形图标跟这一排的 ▢ / ◉ / ⤢ 是同一套描线语言，
    /// emoji 在部分系统上会被渲染成彩色贴纸，堆在一排线框按钮里很跳
    const icon = tapMode
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.6v13.2l3.3-3 2 4.6 2.7-1.2-2-4.5H18z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="7.4"/><path d="m7.2 16.8 9.6-9.6"/></svg>';
    paint(t, icon, tapMode ? '点按' : '只读');
    t.classList.toggle('on', tapMode);
    t.title = on
      ? (tapMode
        ? '鼠标点画面就直接点按设备，按住拖就是滑动。点击改为只读'
        : '只读：鼠标点画面不会传到设备。点击开启点按直通')
      : '设备离线，连接后才能用点按操作画面';
    t.setAttribute('aria-label', t.title);
    t.setAttribute('aria-pressed', String(tapMode));
  }
  /// 十字光标是最省事的「这里能点」提示
  $('.tv-screen')?.classList.toggle('tappable', tapMode);
  /// 只读/可点按切换时鼠标可能没动，光标得按旧位置重算，别停在错的那一种
  paintHitCursor();
  paintPicFrame();
  paintFsHint();
}

/// 全屏时把「画面多大、为什么有黑边」写在提示条上，省得用户以为是裁切坏了
function paintFsMeta() {
  const m = $('#fsmeta');
  if (!m) return;
  if (!theater) {
    m.hidden = true;
    return;
  }
  const img = shownShot();
  const size = img.naturalWidth && img.naturalHeight ? `设备画面 ${img.naturalWidth}×${img.naturalHeight}` : '正在取设备画面';
  m.textContent = `${size} · ${fitMode === 'cover' ? '已铺满裁切' : '按比例完整显示，比例不同会有黑边'}`;
  m.hidden = false;
}

/// 全屏提示条：常驻 + 文案跟状态走。
/// 以前这句话写死在 HTML 里，只读模式下也写着「点画面=点按设备」，
/// 用户照着点什么都不发生，结论就是「鼠标坏了」
function paintFsHint() {
  const hint = $('#fshint');
  if (!hint) return;
  hint.hidden = !theater;
  paintRoBadge();
  if (!theater) return;
  const sub = $('#fshow');
  if (sub) {
    sub.textContent = tapMode
      ? '点画面＝点按设备，按住拖＝滑动'
      : '只读中：点画面不会传到设备，点角标开启';
  }
}

/// 只读是个「点了没反应」的状态，光靠提示条一行小字不够。
/// 全屏时在左下角挂一枚常驻红角标，鼠标一进全屏就知道现在点不动画面
function paintRoBadge() {
  const el = $('.tv-screen');
  if (!el) return;
  const on = theater && !tapMode;
  let b = el.querySelector('.ro-badge');
  if (!on) {
    b?.remove();
    return;
  }
  if (!b) {
    b = document.createElement('span');
    b.className = 'ro-badge';
    b.textContent = '🚫 只读 · 画面点击不会传到设备';
    el.append(b);
  }
}

/// 全屏提示条自己也挡在画面上。以前它常驻不散，窄窗口里能占掉画面上沿一大块。
/// 现在进全屏亮 6 秒就淡出；鼠标靠到窗口顶部、或哪一下被拦下时再显形
let hintTimer = 0;
/// 常驻提示：全屏被浏览器收回后，画面在窄窗口里只剩中间一条，
/// 出口必须一直挂在那儿，不能被后来的一次「短提示」顶掉
let hintSticky = false;
function showHint(ms) {
  const h = $('#fshint');
  if (!h || !theater) return;
  h.classList.remove('dim');
  if (hintSticky && ms) return;
  hintSticky = !ms;
  clearTimeout(hintTimer);
  if (ms) {
    hintTimer = setTimeout(() => {
      if (theater) h.classList.add('dim');
    }, ms);
  }
}

/// 显示框里的落点 → 设备像素。object-fit 决定画面在框里是留边还是被裁：
/// 留边时先把黑边减掉再按缩放比还原，否则越靠边点得越偏
/// 画面自己的框，不是 .tv-screen 的外框：外框含 8px 机身边框，
/// 拿它当画面算缩放，越靠边偏得越多（1080p 上能错开几十个像素）
const displayBox = () => (shownShot() || $('.tv-screen')).getBoundingClientRect();

/// edge=true 时，落在画面外的黑边上不再丢弃，而是按「最近的画面边缘」收住再发。
/// 窄窗口（内置浏览器侧栏）里 16:9 画面只是中间一条，上下黑边占掉大半个窗口；
/// 那些地方点下去没有任何反应，用户唯一能得出的结论就是「鼠标坏了」
function toDevicePoint(clientX, clientY, edge = false) {
  const img = shownShot();
  const nx = img?.naturalWidth || 0;
  const ny = img?.naturalHeight || 0;
  if (!nx || !ny) return null;
  const box = displayBox();
  const scale =
    fitMode === 'cover'
      ? Math.max(box.width / nx, box.height / ny)
      : Math.min(box.width / nx, box.height / ny);
  const left = box.left + (box.width - nx * scale) / 2;
  const top = box.top + (box.height - ny * scale) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
  const outside = x < 0 || y < 0 || x > nx || y > ny;
  if (outside && !edge) return null;
  /// 设备像素是 0..nx-1，夹到 nx 就落到屏幕外了
  return {
    x: Math.round(Math.min(nx - 1, Math.max(0, x))),
    y: Math.round(Math.min(ny - 1, Math.max(0, y))),
    edge: outside,
  };
}

/// 点按要看得见：设备侧没有回执，页面再没反馈就像没点到
function tapRipple(clientX, clientY, kind) {
  /// 涟漪是 .tv-screen 的子元素，它的定位原点正是画面框，用同一个 box 才对得上
  const box = displayBox();
  const d = document.createElement('span');
  d.className = kind ? `tv-ripple ${kind}` : 'tv-ripple';
  d.style.left = `${clientX - box.left}px`;
  d.style.top = `${clientY - box.top}px`;
  $('.tv-screen').append(d);
  setTimeout(() => d.remove(), 560);
}

/// 落点旁边的即时回执。提示条只在全屏里显示，非全屏点了只闪一圈涟漪，
/// 鼠标用户很容易判成「点了没反应」，所以回执必须出现在鼠标/手指的位置
function tapNote(clientX, clientY, text, kind) {
  if (!text) return;
  const box = displayBox();
  const el = document.createElement('span');
  el.className = `tv-note${kind ? ` ${kind}` : ''}`;
  el.textContent = text;
  /// 贴着落点上方显示，靠近边缘时往回拉，别被画面框裁掉
  const half = 84;
  el.style.left = `${Math.min(Math.max(clientX - box.left, half), Math.max(half, box.width - half))}px`;
  el.style.top = `${Math.min(Math.max(clientY - box.top - 18, 14), Math.max(14, box.height - 14))}px`;
  $('.tv-screen').append(el);
  setTimeout(() => el.remove(), 1900);
}

/// adb 一进一出要一两百毫秒，连点会排成一串；同一时间最多排 2 个，多的直接丢
const TAP_QUEUE_MAX = 2;
let tapQueue = 0;
let swipeBusy = false;
let tapStart = null;
/// 触屏按下后一小段时间里让指针类鼠标兼容事件让位，避免一次触屏点按
/// 同时被 pointerdown 路线和浏览器合成的 mousedown 路线各发一次
let lastTouchPointerAt = 0;
/// 只要见过一次 pointerdown/mousedown，click 兜底就永久让位，
/// 免得正常浏览器里同一次点击被发两遍
let sawPress = false;
let tapOfflineLogged = false;
let speakTimer = 0;

/// 点按开关只有一个入口：控制台里那颗按钮和全屏提示条里那颗都走这里，
/// 免得两处各写各的（全屏时按钮条未必在视野里）
function setTapMode(on) {
  tapMode = on;
  try {
    localStorage.setItem('tvdeck.tap', tapMode ? '1' : '0');
  } catch {
    /* 隐私模式下写不了，这次会话内记住就行 */
  }
  paintTvBtns();
  revealActs();
  log(tapMode ? '鼠标点画面 = 直接点按设备' : '画面已改为只读，鼠标点击不再传到设备', tapMode ? 'ok' : 'warn');
}

/// 点按开关只有这一颗。以前全屏提示条里还放了一颗「改为只读」，
/// 它就飘在画面中间，用户点画面时手一偏就点到它，画面当场变只读，
/// 之后怎么点都没反应 —— 用户只能得出「全屏后鼠标坏了」这个结论
$('#btn-touch').onclick = () => setTapMode(!tapMode);

/// 点在画面外的黑边上时，把真正能点的区域闪一圈。
/// 窄面板里的 16:9 画面就是中间一条，光说「点在画面外」用户听不懂
function flashPicture() {
  const img = shownShot();
  const nx = img?.naturalWidth || 0;
  const ny = img?.naturalHeight || 0;
  if (!nx || !ny) return;
  /// 必须和 paintPicFrame 用同一个框（画面自己的框，不含 8px 机身边框），
  /// 否则外框一变，闪出来的范围和虚线框就对不上
  const box = displayBox();
  const scale =
    fitMode === 'cover'
      ? Math.max(box.width / nx, box.height / ny)
      : Math.min(box.width / nx, box.height / ny);
  const d = document.createElement('span');
  d.className = 'tv-picflash';
  d.style.width = `${nx * scale}px`;
  d.style.height = `${ny * scale}px`;
  d.style.left = `${(box.width - nx * scale) / 2}px`;
  d.style.top = `${(box.height - ny * scale) / 2}px`;
  $('.tv-screen').append(d);
  setTimeout(() => d.remove(), 900);
}

/// 点按要看得见：设备侧没有回执，页面再没反馈，用户只能得出「鼠标坏了」。
/// 正常发出去的画白涟漪，被拦下的画灰/红涟漪 + 在提示条里写清原因
function tapFlash(clientX, clientY, kind, text, short) {
  tapRipple(clientX, clientY, kind);
  /// 被拦下时提示条必须显形，否则用户盯着老提示条看不出状态变了
  if (kind === 'blocked') {
    flashPicture();
    showHint(7000);
  }
  /// 长句留给提示条，落点旁边只放一句短的
  tapNote(clientX, clientY, short || text, kind);
  const tip = $('#fspeak');
  if (!tip) return;
  clearTimeout(speakTimer);
  tip.textContent = text || '';
  tip.className = `fspeak${text ? ' on' : ''}${kind ? ` ${kind}` : ''}`;
  if (text) {
    speakTimer = setTimeout(() => {
      tip.textContent = '';
      tip.className = 'fspeak';
    }, 3000);
  }
}

/// 全屏里 16:9 画面在窄窗口（内置浏览器侧栏、手机竖屏）里只剩中间一条，
/// 用户对着一整块黑屏根本不知道哪一块能点，点黑边又「什么都不发生」。
/// 这里把真正能点的画面用一圈虚线框出来，黑边够宽时再挂一个角标，省掉一轮猜测
function paintPicFrame() {
  const el = $('.tv-screen');
  if (!el) return;
  const img = shownShot();
  const nx = img?.naturalWidth || 0;
  const ny = img?.naturalHeight || 0;
  const f = el.querySelector('.tv-picframe');
  const box = nx && ny ? displayBox() : null;
  const scale = box
    ? fitMode === 'cover'
      ? Math.max(box.width / nx, box.height / ny)
      : Math.min(box.width / nx, box.height / ny)
    : 0;
  const w = scale ? nx * scale : 0;
  const h = scale ? ny * scale : 0;
  const gapX = box ? box.width - w : 0;
  const gapY = box ? box.height - h : 0;
  /// 非全屏、还没取到帧、或者画面几乎贴着边框时，这圈虚线只有噪音
  if (!theater || !scale || (gapX < 8 && gapY < 8)) {
    f?.remove();
    return;
  }
  const node = f || document.createElement('span');
  if (!f) {
    node.className = 'tv-picframe';
    node.innerHTML = '<i class="tv-picframe-tag"></i>';
    el.append(node);
  }
  node.style.width = `${w}px`;
  node.style.height = `${h}px`;
  node.style.left = `${gapX / 2}px`;
  node.style.top = `${gapY / 2}px`;
  /// 黑边够宽才挂角标，否则角标比画面还显眼
  node.classList.toggle('tagy', gapY > 26 || gapX > 26);
  const tag = node.querySelector('.tv-picframe-tag');
  if (tag) {
    tag.textContent = tapMode ? '设备画面 · 鼠标 / 触屏点这里' : '只读中 · 点这里不会传到设备';
  }
}

/// 光标只剩一种状态：能点按就是十字（CSS 的 .tappable 管），别的什么都不设。
/// 以前黑边单独给 not-allowed，用户一看到禁止符号就认定「全屏之后鼠标坏了」，
/// 而「哪一条才是画面」这件事已经交给 .tv-picframe 那圈虚线框去说了
function paintHitCursor() {
  const el = $('.tv-screen');
  /// 旧版本可能已经写过内联 cursor，清掉免得压过 .tappable
  if (el && el.style.cursor) el.style.cursor = '';
}

/// 一次按下→抬起的完整判定：点按、滑动、以及「为什么没发出去」都在这里落地。
/// 以前每条被拦的分支都是静默 return，用户分不出「我没点中」和「系统没发出去」
async function gestureEnd(x0, y0, t0, x, y) {
  if (!state?.online) {
    tapFlash(x, y, 'blocked', '设备没连上，这一下没发出：先回「连接」把设备接上', '设备没连上');
    if (!tapOfflineLogged) {
      tapOfflineLogged = true;
      log('设备离线，点按发不出去。先在「连接」里把设备接上', 'warn');
    }
    return;
  }
  if (!tapMode) {
    tapFlash(x, y, 'blocked', '当前是只读：点画面不会传到设备，点提示条里的「开启点按」', '只读，没发出');
    log('只读模式：画面点按没发给设备', 'warn');
    return;
  }
  const dist = Math.hypot(x - x0, y - y0);
  const dt = performance.now() - t0;
  /// 两个落点都按「最近的画面边缘」收：全屏里黑边占掉大半个窗口，
  /// 那里点一下必须也有反应，否则「鼠标坏了」的结论迟早还会回来
  const a = toDevicePoint(x0, y0, true);
  const b = toDevicePoint(x, y, true);

  /// 原地按住不放不算操作：以前会掉进下面的滑动分支，
  /// 变成一次 x1==y1==x2==y2 的滑动，等于在设备上误触发长按
  if (dist < 10) {
    if (!a) {
      tapFlash(x, y, 'blocked', '还没取到设备画面，这一下没发出去：等画面出来再点', '画面还没出来');
      return;
    }
    /// 黑边上点的那一下不能装作没发生：说清落点已经被收到画面边缘
    const aTip = a.edge ? `这里在画面外的黑边上，已按最近的画面边缘发送 ${a.x},${a.y}` : '';
    /// 按住不动 = 设备上的长按：用同点位的 swipe 复现。
    /// 以前这一支直接丢弃，按住一会儿再松手什么都没发生，用户只能得出「鼠标坏了」
    if (dt >= 700) {
      /// 上一手滑动还在路上时只能丢：两笔滑动同时打到设备会互相打断。
      /// 但丢了必须出声，静默 return 是「鼠标坏了」最主要的一条误判来源
      if (swipeBusy) {
        tapFlash(x, y, 'blocked', '上一笔滑动还在发，这一下没发出：等回执后再按住', '上一笔还没发完');
        return;
      }
      swipeBusy = true;
      tapFlash(x, y, 'ok', aTip, `已发送长按 ${a.x},${a.y}`);
      buzz(8);
      try {
        await api('/api/swipe', { x1: a.x, y1: a.y, x2: a.x, y2: a.y, ms: Math.min(2000, Math.round(dt)) }, `长按 ${a.x},${a.y}`, true);
        tapOfflineLogged = false;
      } catch (err) {
        tapFlash(x, y, 'err', `没发出去：${err.message}`, '没发出去');
        log(err.message, 'err');
      } finally {
        swipeBusy = false;
      }
      return;
    }
    if (tapQueue >= TAP_QUEUE_MAX) {
      tapFlash(x, y, 'blocked', '前面几下还在发，慢一点再点', '发送太快，等一下');
      return;
    }
    tapQueue += 1;
    tapFlash(x, y, 'ok', aTip, `已发送点按 ${a.x},${a.y}`);
    buzz(8);
    try {
      await api('/api/tap', { x: a.x, y: a.y }, `点按 ${a.x},${a.y}`, true);
      tapOfflineLogged = false;
    } catch (err) {
      tapFlash(x, y, 'err', `没发出去：${err.message}`, '没发出去');
      log(err.message, 'err');
    } finally {
      tapQueue -= 1;
    }
    return;
  }

  /// 拖出来的就是滑动：某一头落在黑边上时按最近的画面边缘收住，不整笔丢掉
  if (!a || !b) {
    tapFlash(x, y, 'blocked', '还没取到设备画面，这一下没发出去：等画面出来再拖', '画面还没出来');
    return;
  }
  if (swipeBusy) {
    tapFlash(x, y, 'blocked', '上一笔滑动还在发，这一下没发出去：等回执出来再拖', '上一笔还没发完');
    return;
  }
  const bTip = a.edge || b.edge ? `起点或终点落在黑边上，已按最近的画面边缘收住：${a.x},${a.y} → ${b.x},${b.y}` : '';
  swipeBusy = true;
  tapFlash(x, y, 'ok', bTip, `已发送滑动 ${a.x},${a.y} → ${b.x},${b.y}`);
  try {
    await api('/api/swipe', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ms: Math.min(2000, Math.max(60, Math.round(dt))) }, '滑动', true);
    tapOfflineLogged = false;
  } catch (err) {
    tapFlash(x, y, 'err', `没发出去：${err.message}`, '没发出去');
    log(err.message, 'err');
  } finally {
    swipeBusy = false;
  }
}

const screenEl = $('.tv-screen');

/// 压在画面上的按钮/提示条自己要吃点击，不能当成点按设备
const CHROME_SEL = '.tv-acts, .tv-idle, .fs-hint';
const chromeTarget = (t) => (t instanceof Element ? t.closest(CHROME_SEL) : null);
const inChrome = (t) => !!chromeTarget(t);
/// 真正的控件（按钮、链接、输入）自己会处理点击，不需要我们多嘴
const isControl = (t) => t instanceof Element && !!t.closest('button, a, input, select, textarea, label, [role="button"]');

/// 以前点在控件/提示区上是直接 return：画面一动不动、也没有任何回执，
/// 用户只能得出「鼠标坏了」。落在非控件的地方就补一句「这里不是画面」。
/// pointerdown / mousedown / click 三条路都挂着，同一次点击只留一条回执
let chromeNoteAt = 0;
function noteChrome(clientX, clientY, t) {
  if (!chromeTarget(t) || isControl(t)) return false;
  const now = performance.now();
  if (now - chromeNoteAt < 400) return true;
  chromeNoteAt = now;
  tapFlash(clientX, clientY, 'blocked', '这里是页面底衬，不是设备画面：点虚线框里才能操作', '这里不是画面');
  log('点在控件/提示区的空白处，没发给设备', 'warn');
  return true;
}

/// 兜底：个别 webview 不认 user-drag 样式，原生拖图会让抬手事件永远不来
screenEl.addEventListener('dragstart', (e) => e.preventDefault());

/// 鼠标 / 触控笔 / 手指都要能点画面，而且不能只认一种事件源：
/// 有的内置浏览器、远程桌面客户端、触屏驱动的鼠标模拟只送 pointer，或者只送 mouse，
/// 个别极端情况只送一个 click。表现出来都是「按钮点得动、画面点不动」，
/// 最容易被判成鼠标坏，所以三条路都挂上，谁先走通谁算数，一次操作只发一次。
/// 手指滑动仍然留给页面滚动：浏览器一接管滚动就发 pointercancel，起点随之作废。
function beginTap(x, y, kind, src) {
  tapStart = { x, y, t: performance.now(), kind, src };
}

/// 抬手统一入口：pointerup / mouseup / click 都可能走到这里。
/// 第一条走通的把起点收掉，后面到的拿到空起点就不再发第二次
function finishTap(x, y) {
  const s0 = tapStart;
  tapStart = null;
  if (!s0) return false;
  /// 手指只认「快速轻点」：按住或带位移的当滚动，不发给设备
  if (s0.kind === 'touch' && performance.now() - s0.t > 350) return false;
  void gestureEnd(s0.x, s0.y, s0.t, x, y);
  return true;
}

/// 左键判定故意不看 button 本身：个别输入设备把左键报成 button 1 甚至 -1。
/// 只看「主键按下」这一个位，另外明确排除右键，免得弹菜单时顺手点一下设备
const primaryPress = (e) => e.button !== 2 && (!e.buttons || (e.buttons & 1) === 1);

const dropTap = () => {
  tapStart = null;
};

if (window.PointerEvent) {
  screenEl.addEventListener('pointerdown', (e) => {
    revealActs();
    if (e.pointerType === 'touch') lastTouchPointerAt = performance.now();
    if (!primaryPress(e) || inChrome(e.target)) {
      if (e.button === 2) tapFlash(e.clientX, e.clientY, 'blocked', '右键不发给设备：左键点一下 = 点按，按住拖 = 滑动', '右键不发送');
      else noteChrome(e.clientX, e.clientY, e.target);
      tapStart = null;
      return;
    }
    sawPress = true;
    beginTap(e.clientX, e.clientY, e.pointerType || 'mouse', 'pointer');
    /// 抓住这个指针：不抓的话，鼠标在画面外松手、或 webview 转手事件时 pointerup 收不到，
    /// 这一下就静默消失——「点了没反应」里最难查的一类
    try {
      screenEl.setPointerCapture(e.pointerId);
    } catch {
      /* 老 webview 没有就算了，window 上的抬手兜底一样收得到 */
    }
  });
  /// 抬手一律挂在 window 上：手滑出画面再松手，也算这一次操作
  window.addEventListener('pointerup', (e) => {
    finishTap(e.clientX, e.clientY);
  });
  /// 指针被系统抢走（浏览器接管滚动、切窗、右键菜单）时清掉起点，
  /// 免得下一次抬手被当成一次滑动
  window.addEventListener('pointercancel', dropTap);
  screenEl.addEventListener('lostpointercapture', dropTap);
}

/// 传统 mouse 事件这条路一直留着，两级作用：
/// 1) 有的 webview 有 PointerEvent 构造器却从不派发 pointer 事件，只能靠它；
/// 2) pointerdown 收到了而 pointerup 被吞掉时，能靠 mouseup 把这次操作收尾。
/// 已经有按下记录时不覆盖起点，免得把起点换成更晚的一次按下
screenEl.addEventListener('mousedown', (e) => {
  if (performance.now() - lastTouchPointerAt < 700) return;
  if (tapStart) return;
  revealActs();
  if (!primaryPress(e) || inChrome(e.target)) {
    noteChrome(e.clientX, e.clientY, e.target);
    tapStart = null;
    return;
  }
  sawPress = true;
  beginTap(e.clientX, e.clientY, 'mouse', 'mouse');
});
window.addEventListener('mouseup', (e) => {
  finishTap(e.clientX, e.clientY);
});

/// 最后一道保险：只送 click 的环境（部分内置浏览器、远程桌面、无障碍点击）。
/// 已经收过 pointerdown/mousedown、且这次抬手已被处理时直接让位；
/// 只有「按下了但抬手一直没来」才用 click 的落点收尾
screenEl.addEventListener('click', (e) => {
  if (inChrome(e.target)) {
    noteChrome(e.clientX, e.clientY, e.target);
    return;
  }
  if (e.defaultPrevented) return;
  if (sawPress && !tapStart) return;
  revealActs();
  if (!tapStart) beginTap(e.clientX, e.clientY, 'click', 'click');
  finishTap(e.clientX, e.clientY);
});

screenEl.addEventListener(
  'touchstart',
  () => {
    lastTouchPointerAt = performance.now();
    revealActs();
  },
  { passive: true },
);

/// 鼠标靠到窗口顶部就说明用户在找说明/出口，这时把提示条叫回来。
/// 只在全屏里跑，非全屏提示条本来就是 hidden
screenEl.addEventListener(
  'mousemove',
  (e) => {
    if (!theater) return;
    if (e.clientY < 140) showHint(4000);
    paintHitCursor();
  },
  { passive: true },
);
$('#btn-fit').onclick = () => {
  fitMode = fitMode === 'cover' ? 'contain' : 'cover';
  try {
    localStorage.setItem('tvdeck.fit', fitMode);
  } catch {
    /* 隐私模式下写不了，这次会话内记住就行 */
  }
  paintTvBtns();
  paintFsMeta();
  revealActs();
};

function requestNative(on) {
  const el = $('.tv-screen');
  const req = on ? el.requestFullscreen || el.webkitRequestFullscreen : document.exitFullscreen || document.webkitExitFullscreen;
  if (!req) return;
  try {
    const r = on ? req.call(el) : req.call(document);
    r?.catch?.(() => {});
  } catch {
    /* 被拒时 .fs 已经铺满视口，不在这里另报一次，等 watchNativeFs 给结论 */
  }
}

/// 浏览器自带的全屏（F11 / ⌃⌘F 之类）全屏的是整个文档，
/// 页面还按正常排版走，画面不会自己变大，也就点不到大画面。
/// 以前这里只认元素级全屏，所以按了 F11 之后「看着全屏了，鼠标还是原来的小画面」
const pageFullscreen = () => {
  const el = nativeFs();
  return !!el && el !== $('.tv-screen');
};

/// 浏览器自带全屏带进来的全屏态：它退出时要跟着收
let theaterFromPageFs = false;

/// 真的进过元素级全屏没有。全屏被浏览器收回时要靠它区分「从来没进去」和「进去又被收回」
let sawNativeFs = false;

/// 视口变了就重新量一遍。原生全屏进出、内置浏览器自己收全屏，
/// 都会让画面实际尺寸换一档；不重量的话那圈虚线框会停在旧尺寸上，
/// 框比画面大一圈，用户点框里的空白照样没反应
let stagePaintTimers = [];
const repaintStage = () => {
  /// 视口不是一帧就结算完的：内置浏览器进出全屏要过几拍才落定，
  /// 只量一次会量到旧尺寸，所以按几拍重量，后一拍覆盖前一拍
  stagePaintTimers.forEach(clearTimeout);
  stagePaintTimers = [0, 110, 320, 900].map((ms) =>
    setTimeout(() => {
      if (!theater) return;
      paintPicFrame();
      paintFsMeta();
      paintHitCursor();
    }, ms),
  );
};

/// 进/出全屏这一帧视口未必结算完（内置浏览器是异步 resize），收尾再量一次
const settleStage = () => {
  requestAnimationFrame(() => {
    if (!theater) return;
    paintPicFrame();
    paintFsMeta();
    paintHitCursor();
  });
};

/// 用户用浏览器自带的全屏 / 退出（F11、⌃⌘F，或原生全屏里按 Esc）时，提示条要跟着变
const onFsChange = () => {
  if (pageFullscreen()) {
    if (!theater) {
      theaterFromPageFs = true;
      setTheater(true);
    }
    setFsNote('');
    repaintStage();
    return;
  }
  if (theaterFromPageFs) {
    theaterFromPageFs = false;
    setTheater(false);
    return;
  }
  if (!theater) return;
  if (nativeFs()) {
    sawNativeFs = true;
    setFsNote('');
    /// 真的满屏了，提示条按原设计 6 秒淡出，别一直压在画面上
    showHint(6000);
    repaintStage();
    return;
  }
  /// 进去过又丢了：内置浏览器会自己在几秒后退出原生全屏。
  /// 这不是「请求被忽略」，得说实话，并把「怎么才能一直满屏」一起给出
  if (sawNativeFs) {
    sawNativeFs = false;
    setFsNote(FS_DROPPED);
    /// 这种状态下画面只占窗口中间一条，上下全是可点的黑边，
    /// 出口常驻：淡出之后用户会重新掉回「点了没反应」的猜测里
    showHint(0);
    log('浏览器收回了全屏，可点「在新标签打开纯画面」持续满屏', 'warn');
    repaintStage();
    return;
  }
  setFsNote(canNativeFullscreen() ? FS_REFUSED : FS_NO_API);
};
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

$('#btn-fs').onclick = () => {
  if (theater || nativeFs()) {
    theaterFromPageFs = false;
    setTheater(false);
    requestNative(false);
    return;
  }
  setTheater(true);
  requestNative(true);
  watchNativeFs();
  void setMirror(true);
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && theater) {
    setTheater(false);
    requestNative(false);
    /// 同上：全屏这一层先消费 Escape，别再顺手给设备发「返回」
    e.stopImmediatePropagation();
  }
});


/// 亮度滑杆：拖动途中软写，松手那次以回读值为准
let brightDrag = 0;
let brightBusy = false;
let brightPending = null;

function pushBright(value, final) {
  if (brightBusy) {
    brightPending = { value, final: final || brightPending?.final || false };
    return;
  }
  brightBusy = true;
  api('/api/picture', { key: 'screen_brightness', table: 'system', value }, `屏幕亮度 → ${value}`, !final)
    .then((r) => {
      const back = Number((r.detail || '').match(/\d+/)?.[0] ?? value);
      if (document.activeElement !== $('#bright')) $('#bright').value = back;
      $('#brightv').textContent = `${back}/255`;
      if (final) log(`屏幕亮度 → ${r.detail}`, r.verified ? 'ok' : 'warn');
    })
    .catch((x) => log(x.message, 'err'))
    .finally(() => {
      brightBusy = false;
      if (brightPending) {
        const p = brightPending;
        brightPending = null;
        pushBright(p.value, p.final);
      }
    });
}

$('#bright').addEventListener('input', (e) => {
  $('#brightv').textContent = `${e.target.value}/255`;
  clearTimeout(brightDrag);
  brightDrag = setTimeout(() => pushBright(e.target.value, false), 220);
});
$('#bright').onchange = (e) => {
  clearTimeout(brightDrag);
  pushBright(e.target.value, true);
};

function nightResult(r, label) {
  const el = $('#nightstate');
  el.textContent = `${label}：${r.detail}`;
  el.classList.toggle('warn', r.ok === false || r.verified === false);
  log(`${label} · ${r.verified ? '已回读确认' : '未确认'} · ${r.detail}`, r.verified ? 'ok' : 'warn');
}

$('#btn-night-on').onclick = () => api('/api/night', { action: 'on' }, '护眼模式 开').then((r) => nightResult(r, '护眼开')).catch((e) => log(e.message, 'err'));
$('#btn-night-off').onclick = () => api('/api/night', { action: 'off' }, '护眼模式 关').then((r) => nightResult(r, '护眼关')).catch((e) => log(e.message, 'err'));
$('#btn-night-apply').onclick = () =>
  api('/api/night', { action: 'level', level: $('#nightlvl').value }, `遮罩强度 → ${$('#nightlvl').value}`)
    .then((r) => nightResult(r, `遮罩强度 ${$('#nightlvl').value}`))
    .catch((e) => log(e.message, 'err'));

let usageLoaded = false;

/// 应用清单暂时为空时轻补一次状态：多半是设备刚上线、清单还没探测完，
/// 每 20 秒的全量轮询已经够慢了，不用给用户一句「稍后重试」然后干等
async function loadUsage() {
  const btn = $('#btn-usage');
  btn.disabled = true;
  btn.textContent = '统计中…';
  const usageBox = $('#usage');
  if (usageBox) usageBox.replaceChildren(Object.assign(document.createElement('p'), { className: 'caption', textContent: '正在统计…' }));
  try {
    const u = await api(`/api/usage?hours=${$('#hours').value}`);
    $('#usagesrc').textContent = String(u.source || '').includes('dumpsys')
      ? '来自系统使用统计'
      : String(u.source || '').replace(/ · .*$/, '');
    const total = u.rows.reduce((n, r) => n + r.minutes, 0);
    const top = u.rows.slice().sort((x, y) => y.minutes - x.minutes)[0];
    const fmt = (m) => (m >= 60 ? `${(m / 60).toFixed(1)} 小时` : `${m} 分钟`);
    $('#usage-total').textContent = u.rows.length ? fmt(total) : '无';
    $('#usage-top').textContent = top ? appNameFor(top.package, top.label) : '—';
    $('#usage-count').textContent = String(u.rows.length);
    $('#usagestat').hidden = false;
    /// 条形按窗口内最长的那条归一化：不同时长窗口之间比例才有可比性
    const peak = Math.max(1, ...u.rows.map((r) => r.minutes));
    $('#usage').replaceChildren(
      ...(u.rows.length
        ? u.rows.map((r) => {
            const tile = document.createElement('div');
            tile.className = 'utile';
            const name = appNameFor(r.package, r.label);
            const dur = r.minutes >= 60 ? `${(r.minutes / 60).toFixed(1)} 小时` : `${r.minutes} 分钟`;
            const nm = document.createElement('b');
            nm.textContent = name;
            const sub = document.createElement('em');
            /// 应用名已经是人话了，包名只留在悬停说明里，别让每一行都再顶一串英文
            sub.textContent = dur;
            const track = document.createElement('i');
            track.className = 'ubar';
            const fill = document.createElement('b');
            fill.style.width = `${Math.round((r.minutes / peak) * 100)}%`;
            track.append(fill);
            tile.append(nm, sub, track);
            tile.title = `${name} · ${r.package} · ${dur}`;
            tile.setAttribute('aria-label', `${name}，累计 ${dur}`);
            return tile;
          })
        : [Object.assign(document.createElement('p'), { className: 'caption', textContent: '无 30 秒以上应用' })]),
    );
    const hb = $('#usage-hbars');
    const hwrap = $('#usage-hourly');
    if (hb) hb.textContent = '';
    if (hwrap && u.hourly && u.hourly.length) {
      const hmax = Math.max(1, ...u.hourly.map((r) => r.minutes));
      for (const r of u.hourly) {
        const cell = document.createElement('div');
        cell.className = 'uhcell';
        const bar = document.createElement('i');
        bar.style.height = `${Math.max(4, Math.round((r.minutes / hmax) * 56))}px`;
        const dur = r.minutes >= 60 ? `${(r.minutes / 60).toFixed(1)} 小时` : `${r.minutes} 分钟`;
        const t = document.createElement('span');
        t.dataset.hour = `${String(r.hour).padStart(2, '0')}:00`;
        t.textContent = dur;
        cell.title = `${String(r.hour).padStart(2, '0')}:00 · ${dur}`;
        cell.setAttribute('aria-label', cell.title);
        cell.append(bar, t);
        hb.append(cell);
      }
      hwrap.hidden = false;
    } else if (hwrap) hwrap.hidden = true;
    usageLoaded = true;
  } catch (e) {
    log(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '重新统计';
  }
}

$('#btn-usage').onclick = () => loadUsage();

/// 应用管理：第三方清单 + 逐行动作 + 本机 APK 安装
let inv = null;
const mb = (kb) => (kb >= 1048576 ? `${(kb / 1048576).toFixed(2)}GB` : `${(kb / 1024).toFixed(0)}MB`);

/// 字节数：不到 1MB 的文件不能显示成 0.0MB
const humanSize = (bytes) => {
  const n = Number(bytes) || 0;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
};

function chip(label, run, danger) {
  const b = document.createElement('button');
  b.className = `chip${danger ? ' danger' : ''}`;
  b.textContent = label;
  let armed = false;
  const reset = () => {
    armed = false;
    b.textContent = label;
    b.classList.remove('armed');
  };
  b.onclick = async () => {
    if (danger && !armed) {
      armed = true;
      b.textContent = '再点一次确认';
      b.classList.add('armed');
      setTimeout(reset, 5000);
      return;
    }
    b.disabled = true;
    try {
      const r = await run();
      log(`${label} · ${r.detail}`, r.verified ? 'ok' : r.ok ? 'warn' : 'err');
    } catch (e) {
      log(e.message, 'err');
    } finally {
      reset();
      b.disabled = false;
    }
  };
  return b;
}

function invRow(r) {
  const wrap = document.createElement('div');
  wrap.className = 'invrow';
  const head = document.createElement('button');
  head.className = 'invhead';
  const box = iconBox('mono', { icon: r.icon }, r.label);
  const txt = document.createElement('span');
  txt.className = 'txt';
  const name = document.createElement('b');
  name.textContent = r.label;
  const sub = document.createElement('span');
  sub.textContent = [
    r.system ? '预装' : '自己装的',
    r.version && `v${r.version}`,
    r.running ? `运行中 ${mb(r.rssKb)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  txt.append(name, sub);
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '›';
  head.append(box, txt, chev);
  const body = document.createElement('div');
  body.className = 'invbody';
  const pkgline = document.createElement('p');
  pkgline.className = 'pkgline';
  pkgline.textContent = r.pkg + (r.abi ? ` · ${r.abi}` : '') + (r.targetSdk ? ` · 目标 SDK ${r.targetSdk}` : '');
  const acts = document.createElement('div');
  acts.className = 'row acts';
  acts.append(...[
    r.launchable ? chip('打开', () => api('/api/app', { action: 'launch', pkg: r.pkg }, `${r.label} · 打开`)) : null,
    chip('强停', () => api('/api/app', { action: 'stop', pkg: r.pkg }, `${r.label} · 强停`)),
    r.named === '包名（未解析）' &&
      chip('解析名称', async () => {
        const x = await api('/api/name', { pkg: r.pkg }, `${r.label} · 解析名称`);
        if (x.label) {
          r.label = x.label;
          r.named = 'APK 解析';
          // 服务端把同义叫法一起算好了，跟着名字同步，搜新名字立刻能命中
          if (x.search) r.search = x.search;
          renderInv();
        }
        return x;
      }),
    // 预装包不给卸载/清数据入口（服务端 thirdPartyOnly 也会拒绝）：
    // 与其让人点了才报错，不如直接放一个点不动的说明按钮
    r.system
      ? Object.assign(chip('预装包不可卸载', async () => ({ ok: false, verified: false, detail: '' }), true), {
          disabled: true,
          title: '厂商预装/系统包不参与卸载与清数据，只能打开或强停',
        })
      : chip('清数据', () => api('/api/app', { action: 'clear', pkg: r.pkg }, `${r.label} · 清数据`), true),
    r.system
      ? null
      : chip('卸载', async () => {
          const x = await api('/api/app', { action: 'uninstall', pkg: r.pkg }, `${r.label} · 卸载`);
          if (x.ok) {
            inv = null;
            loadInv();
          }
          return x;
        }, true),
  ].filter(Boolean));
  body.append(pkgline, acts);
  head.onclick = () => {
    wrap.classList.toggle('open');
    chev.textContent = wrap.classList.contains('open') ? '⌄' : '›';
  };
  wrap.append(head, body);
  return wrap;
}

/// 应用清单筛选：默认「常用」= 有启动入口 / 自己装的 / 正在运行。
/// 全量包（框架服务上百个）收在「全部」里；数据一次拿全，切筛选不再等 adb。
const INV_FILTERS = {
  main: { text: '常用', keep: (r) => r.launchable || !r.system },
  third: { text: '自己装的', keep: (r) => !r.system },
  sys: { text: '预装', keep: (r) => r.system },
  run: { text: '运行中', keep: (r) => r.running },
  all: { text: '全部', keep: () => true },
};
let invFilter = 'main';

function renderInv() {
  const q = $('#invq').value.trim().toLowerCase();
  const f = INV_FILTERS[invFilter] ?? INV_FILTERS.main;
  // 关键词先过一遍，筛选条上的数字才是「搜这个词时每一类有多少」，
  // 不然切到「全部」数字还是上一类筛完的结果，看着像没生效
  // 服务端下发的 r.search 已经带上中英文同义叫法（搜「设置」能翻出 Settings），
  // 老数据没有这个字段时退回「显示名 + 包名」
  const key = (r) => (r.search ?? `${r.label} ${r.pkg}`).toLowerCase();
  const hit = inv ? inv.rows.filter((r) => !q || key(r).includes(q)) : [];
  const rows = hit.filter(f.keep);
  $$('#invfilter button').forEach((b) => {
    const one = INV_FILTERS[b.dataset.inv];
    b.textContent = `${one.text}${inv ? ` (${hit.filter(one.keep).length})` : ''}`;
    b.classList.toggle('on', b.dataset.inv === invFilter);
  });
  const c = $('#invcount');
  if (c && inv) c.textContent = `显示 ${rows.length} / 共 ${inv.total} 个`;
  $('#invlist').replaceChildren(
    ...(rows.length
      ? rows.map(invRow)
      : [
          Object.assign(document.createElement('p'), {
            className: 'caption',
            textContent: inv
              ? q
                ? `没有匹配「${q}」的应用。`
                : '这一类没有应用，换个筛选看看。'
              : '还没有读取清单。',
          }),
        ]),
  );
}

async function loadInv() {
  const b = $('#btn-inv');
  b.disabled = true;
  b.textContent = '读取中…';
  try {
    inv = await api('/api/apps');
    $('#invnote').textContent = `${inv.total} 个包 · ${inv.ms}ms`;
    renderInv();
  } catch (e) {
    log(e.message, 'err');
  } finally {
    b.disabled = false;
    b.textContent = '重新读取';
  }
}

$('#btn-inv').onclick = loadInv;
$('#invq').addEventListener('input', renderInv);
$('#invq').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    $('#invq').value = '';
    renderInv();
  }
});
$('#invfilter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-inv]');
  if (!b) return;
  invFilter = b.dataset.inv;
  renderInv();
});

/// 安装：上传 → 解析预览 → 确认安装（覆盖厂商预装包需要二次确认）
let pending = null;
let pendingConfirm = false;

function renderApk() {
  const box = $('#apkbox');
  $('#btn-apk-cancel').hidden = !pending;
  if (!pending) {
    box.replaceChildren();
    /// 空态不再常驻一句「选 APK 后解析确认安装」：按钮和下方确认卡已经说明了流程，
    /// 这句只在真的开始解析、出错时才占一行，避免整段变成说明书
    $('#apkstate').textContent = '';
    return;
  }
  const d = pending;
  const card = document.createElement('div');
  card.className = 'card apkcard';
  const top = document.createElement('div');
  top.className = 'card-top';
  const name = document.createElement('span');
  name.className = 'card-t';
  name.textContent = d.label || d.name;
  const size = document.createElement('b');
  size.className = 'bignum';
  size.textContent = humanSize(d.bytes);
  top.append(name, size);
  const meta = document.createElement('p');
  meta.className = 'pkgline';
  meta.textContent = [d.pkg || '包名解析失败', d.present ? `设备端已装 v${d.version || '?'}` : '设备端没有', d.system && '厂商预装包'].filter(Boolean).join(' · ');
  const acts = document.createElement('div');
  acts.className = 'row acts';
  const go = async (confirm) => {
    const r = await api('/api/install', { host: d.host, confirm }, `安装 ${d.label || d.name}`);
    if (r.needsConfirm) {
      pendingConfirm = true;
      renderApk();
    } else {
      pending = null;
      pendingConfirm = false;
      renderApk();
      if (r.ok) loadInv();
    }
    return r;
  };
  acts.append(
    chip(pendingConfirm ? '确认覆盖系统包' : '安装到设备', () => go(pendingConfirm)),
    chip('放弃', async () => {
      const r = await api('/api/upload/del', { host: pending.host }, '清理上传临时文件');
      pending = null;
      pendingConfirm = false;
      renderApk();
      return r;
    }),
  );
  card.append(top, meta, acts);
  box.replaceChildren(card);
  $('#apkstate').textContent = d.detail;
}

$('#apkfile').onchange = async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  pending = null;
  pendingConfirm = false;
  $('#apkstate').textContent = `正在上传 ${f.name}（${humanSize(f.size)}）…`;
  const t0 = performance.now();
  try {
    const res = await fetch(srv(`/api/upload?name=${encodeURIComponent(f.name)}`), { method: 'POST', body: f });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
    pending = d;
    recordOp({ t: Date.now(), text: `上传 ${d.name}`, detail: d.detail, cmd: '/api/upload', kind: 'ok', ms: Math.round(performance.now() - t0) });
    renderApk();
  } catch (err) {
    recordOp({ t: Date.now(), text: `上传 ${f.name}`, detail: err.message, cmd: '/api/upload', kind: 'err', ms: Math.round(performance.now() - t0) });
    $('#apkstate').textContent = `上传失败：${err.message}`;
  } finally {
    e.target.value = '';
  }
};

$('#btn-apk-cancel').onclick = () => {
  if (pending) api('/api/upload/del', { host: pending.host }, '清理上传临时文件').catch(() => {});
  pending = null;
  pendingConfirm = false;
  renderApk();
};

/// 设备信息 / 进程 / 文件管理
let devInfo = null;
let devInfoAt = null;
let procs = null;
let procsStampAt = null;
/// 进程页先画一页，剩下的用户点「显示更多」再放；换设备/重新读取/换筛选都回到第一页
const PROC_PAGE = 60;
let procShown = PROC_PAGE;
let fsStampAt = null;
let fsRows = null;
let fsDir = '/storage/emulated/0';

const captionEl = (text) => Object.assign(document.createElement('p'), { className: 'caption', textContent: text });

/// 功能必须连上设备才能用的离线空态：一句话收口 + 去连接按钮。
/// 跟设备按键的禁用不同，这里页面内容本来就是从设备读的，
/// 给一个行动入口比留一颗「重新读取」死按钮更符合直觉
function emptyOff({ title = '设备未连接', note = '连上设备后，这里会自动读取数据', action = true } = {}) {
  const box = document.createElement('div');
  box.className = 'empty-state empty-off';
  const head = document.createElement('b');
  head.textContent = title;
  const sub = document.createElement('p');
  sub.textContent = note;
  box.append(head, sub);
  if (action) {
    const row = document.createElement('div');
    row.className = 'row';
    const go = document.createElement('button');
    go.textContent = '连接设备';
    go.onclick = () => showTab('link');
    row.append(go);
    box.append(row);
  }
  return box;
}

/// 占用类指标的统一阈值：总览快照和设备健康子页必须同一套判级，
/// 否则同一个数字在两个页面一个绿一个橙，用户会怀疑哪个才是真的
const METRIC_WARN_PCT = 75;
const METRIC_HOT_PCT = 90;
const metricLevel = (pct) =>
  typeof pct !== 'number' || !Number.isFinite(pct) ? null
    : pct >= METRIC_HOT_PCT ? 'critical'
    : pct >= METRIC_WARN_PCT ? 'warn'
    : 'ok';
const METRIC_LEVEL_TIP = {
  ok: '占用不高',
  warn: '开始吃紧',
  critical: '接近上限',
};
const METRIC_LEVEL_WORD = { ok: '正常', warn: '偏高', critical: '过高' };
/// 横条上刻两道告警线：光有一根杠看不出「离告警还有多远」
function appendMetricTicks(track) {
  [METRIC_WARN_PCT, METRIC_HOT_PCT].forEach((mark) => {
    const tick = document.createElement('u');
    tick.style.left = `${mark}%`;
    track.append(tick);
  });
}
async function loadDevice(silent = false) {
  const box = $('#devlist');
  const tech = $('#devtech');
  const techBox = $('#devtechlist');
  const power = $('#powerrow');
  if (!state?.online) {
    box.replaceChildren(emptyOff({ title: '设备信息需要先连接设备', note: '连上之后自动读取型号、系统、网络等基础信息，也可以做重启等电源操作。' }));
    if (tech) tech.hidden = true;
    if (power) power.hidden = true;
    renderDevStamp();
    return;
  }
  if (power) power.hidden = false;
  if (!silent || !devInfo) box.replaceChildren(captionEl('逐项读取中…'));
  try {
    devInfo = await api('/api/device');
    devInfoAt = Date.now();
    const fieldRow = (f) => {
      const row = document.createElement('div');
      row.className = 'drow wide';
      const k = document.createElement('span');
      k.textContent = f.k;
      const v = document.createElement('b');
      v.textContent = f.v;
      row.append(k, v);
      if (f.note) {
        /// 说明行只留带读数的短句；纯机制解释（「按系统报告的可用内存统计」）
        /// 和长清单（只读分区、传感器名单）折进悬停提示，不再把行高顶成两三行
        const hasData = /[0-9A-Za-z]/.test(f.note);
        if (f.note.length > 26 || !hasData) {
          v.title = f.note;
          v.classList.add('hasnote');
        } else {
          const n = document.createElement('i');
          n.className = 'inote';
          n.textContent = f.note;
          row.append(n);
        }
      }
      return row;
    };
    /// 首层只放常看读数。固件串、构建号、传感器、温度、CPU 变动少，
    /// 排查时才需要，折进「技术详情」避免手机上一项占三四行。
    const PRIMARY = new Set(['型号', '系统', '运行时长', '内存', '存储', '网络']);
    const primary = devInfo.filter((f) => {
      /// 模拟器 / USB 设备本来就没有局域网地址，把「网络」这一行整行隐掉，
      /// 而不是显示「设备没给出局域网地址」让人误以为断网。
      if (f.k === '网络' && f.v === '设备没给出局域网地址') return false;
      return PRIMARY.has(f.k);
    });
    const technical = devInfo.filter((f) => !PRIMARY.has(f.k));
    box.replaceChildren(...primary.map(fieldRow));
    if (tech && techBox) {
      techBox.replaceChildren(...technical.map(fieldRow));
      tech.hidden = !technical.length;
    }
  } catch (e) {
    /// 静默刷新失败时旧数据还能看：别把它清掉，只在时间注脚里说明这轮没拿到
    if (!silent || !devInfo) {
      box.replaceChildren(captionEl(e.message));
      if (tech) tech.hidden = true;
    }
  }
  renderDevStamp();
}

function renderDevStamp() {
  const el = $('#devstamp');
  if (!el) return;
  if (!devInfo) {
    el.textContent = '';
    return;
  }
  const ago = devInfoAt ? Math.max(0, Math.round((Date.now() - devInfoAt) / 1000)) : null;
  el.textContent = ago !== null ? `${ago} 秒前读取` : '正在读取…';
}

function procCountText(appOnly) {
  const all = procs || [];
  const ago = procsStampAt ? Math.max(0, Math.round((Date.now() - procsStampAt) / 1000)) : null;
  const n = appOnly ? all.filter((x) => !x.kernel).length : all.length;
  const label = appOnly ? '应用' : '';
  const kernelNote = !appOnly ? ` · 含 ${all.filter((x) => x.kernel).length} 系统` : '';
  return `${ago !== null ? `${ago} 秒前读取 · ` : ''}共 ${n} 个${label}${kernelNote}`;
}

function updateProcStamp() {
  const el = $('#proccount');
  if (el && procs) {
    const q = $('#procq')?.value.trim().toLowerCase();
    const appOnly = $('#proc-app-only')?.checked !== false;
    const base = appOnly ? procs.filter((x) => !x.kernel) : procs;
    /// 计数只说「这一屏画了多少 / 一共多少」，剩下的靠列表底部那颗
    /// 「显示更多」放出来；以前写死 Math.min(60) 会让用户以为设备只有 60 个进程
    const total = q ? base.filter((x) => x.name.toLowerCase().includes(q)).length : base.length;
    const shown = Math.min(procShown, total);
    el.textContent = `${procCountText(appOnly)} · 显示 ${shown}${total > shown ? `/${total}` : ''}`;
  }
}

async function loadProcs() {
  const box = $('#proclist');
  if (!state?.online) {
    box.replaceChildren(emptyOff({ title: '进程列表需要先连接设备', note: '连上后这里会列出设备正在运行的应用与系统进程。' }));
    const count = $('#proccount');
    if (count) count.textContent = '';
    return;
  }
  box.replaceChildren(captionEl('ps -A 读取中…'));
  try {
    const d = await api('/api/processes');
    // 服务端统一返回 { rows }，这里再兜一层：万一是裸数组也不要把列表读空
    procs = Array.isArray(d) ? d : d.rows;
    procsStampAt = Date.now();
    procShown = PROC_PAGE;
    renderProcs();
  } catch (e) {
    box.replaceChildren(captionEl(e.message));
  }
}

function renderProcs() {
  const q = $('#procq').value.trim().toLowerCase();
  const all = procs || [];
  const appOnly = $('#proc-app-only').checked;
  const app = all.filter((p) => !p.kernel);
  const base = appOnly ? app : all;
  const matched = q ? base.filter((p) => p.name.toLowerCase().includes(q)) : base;
  const list = matched.slice(0, procShown);
  $('#proccount').textContent = `${procCountText(appOnly)} · 显示 ${list.length}${matched.length > list.length ? `/${matched.length}` : ''}`;
  const nodes = list.map((p) => {
      const row = document.createElement('div');
      row.className = 'procrow';
      const pid = document.createElement('em');
      pid.textContent = p.pid;
      const nm = document.createElement('b');
      nm.textContent = p.name;
      const rss = document.createElement('span');
      rss.textContent = mb(p.rssKb);
      row.append(pid, nm, rss);
      return row;
    });
  /// 进程数常上百，一次全画会让手机滚动很沉；先给一页，剩下的点一下再放，
  /// 但必须把「还有多少」写出来，否则看起来就是被截断了
  const rest = matched.length - list.length;
  if (rest > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'logmore';
    more.textContent = `显示更多（还有 ${rest} 个）`;
    more.onclick = () => {
      /// 滚到这次新放出来的第一行，而不是滚到列表末尾那颗按钮：
      /// 直接跳到底会把中间这 60 个进程一闪而过
      const firstNew = procShown;
      procShown += PROC_PAGE;
      renderProcs();
      const rows = $('#proclist').children;
      rows[Math.min(firstNew, rows.length - 1)]?.scrollIntoView({ block: 'start' });
    };
    nodes.push(more);
  }
  $('#proclist').replaceChildren(...nodes);
}

async function loadFs(dir) {
  fsDir = dir;
  $('#fspathead').querySelector('span').textContent = dir;
  const box = $('#fslist');
  if (!state?.online) {
    box.replaceChildren(emptyOff({ title: '设备文件需要先连接设备', note: '连上后可以从这里浏览设备目录、推送或拉取文件。' }));
    return;
  }
  box.replaceChildren(captionEl(`读取 ${dir} …`));
  try {
    const d = await api(`/api/fs?path=${encodeURIComponent(dir)}`);
    fsRows = d;
    fsStampAt = Date.now();
    setFsStamp();
    box.replaceChildren(
      ...(d.rows.length
        ? d.rows.map((r) => {
            const row = document.createElement('div');
            row.className = 'fsrow';
            const kind = document.createElement('em');
            kind.textContent = r.kind === 'dir' ? '▸' : r.kind === 'link' ? '↗' : '·';
            const nm = document.createElement('b');
            nm.textContent = r.name;
            const meta = document.createElement('span');
            meta.textContent = `${r.kind === 'dir' ? '目录' : humanSize(r.size)} · ${r.mtime}`;
            row.append(kind, nm, meta);
            const full = `${dir.replace(/\/+$/, '')}/${r.name}`;
            if (r.kind === 'dir') {
              row.classList.add('nav');
              row.onclick = () => loadFs(full);
            } else {
              const a = document.createElement('a');
              a.className = 'chip';
              a.textContent = '下载';
              a.href = `/api/download?path=${encodeURIComponent(full)}`;
              row.append(a);
            }
            return row;
          })
        : [captionEl(d.note || '空目录')]),
    );
  } catch (e) {
    box.replaceChildren(captionEl(e.message));
  }
}

$('#btn-proc-refresh').onclick = loadProcs;
$('#procq').addEventListener('input', () => {
  procShown = PROC_PAGE;
  renderProcs();
});
$('#procq').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    $('#procq').value = '';
    procShown = PROC_PAGE;
    renderProcs();
  }
});
$('#proc-app-only').addEventListener('change', () => {
  procShown = PROC_PAGE;
  renderProcs();
});
$('#btn-fs-refresh').onclick = () => loadFs(fsDir);
$('#btn-fs-up').onclick = () => {
  const up = fsDir.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  loadFs(up || '/');
};
$('#fsroot').onchange = (e) => loadFs(e.target.value);
$('#pushfile').onchange = async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  setFsDirNote(`推送 ${f.name}（${humanSize(f.size)}）到 ${fsDir} …`);
  const t0 = performance.now();
  try {
    const up = await fetch(srv(`/api/upload?name=${encodeURIComponent(f.name)}`), { method: 'POST', body: f });
    const d = await up.json().catch(() => ({}));
    if (!up.ok || d.error) throw new Error(d.error || `HTTP ${up.status}`);
    recordOp({ t: Date.now(), text: `上传 ${d.name}`, detail: d.detail, cmd: '/api/upload', kind: 'ok', ms: Math.round(performance.now() - t0) });
    const r = await api('/api/push', { host: d.host, dest: fsDir }, `推送 ${f.name} → ${fsDir}`);
    log(`${f.name} · ${r.detail}`, r.verified ? 'ok' : 'err');
    loadFs(fsDir);
  } catch (err) {
    log(err.message, 'err');
  } finally {
    e.target.value = '';
  }
};

// ---------------------------------------------------------------- 设备健康与录屏
// 两块都挂在设备页：读数和产物都跟着「当前设备」走，换设备后必须重读，
// 所以缓存变量在 refresh() 里跟着连接状态一起清（见 resetDeviceCaches）。

let healthData = null;
/// 静默轮询和手动「重新读取」共用同一份状态：前一次还没回来时不再叠一条请求，
/// 否则设备响应慢时会出现多条 /api/health 并发，后回来的旧结果还会覆盖新结果。
let healthBusy = false;
let healthQueued = false;
/// 最近一次真正成功的采样时刻；失败回退时不能用它冒充「刚刚刷新」
let healthOkAt = null;
let recRows = null;
let recBusy = false;
/// 刚录完那一条的文件名：只用来在列表里打一次「新」高亮，不参与任何判断
let recFresh = '';
/// 正在录制的那条后台任务（id + 阶段 + 百分比）。录制不再是「挂着的一条请求」，
/// 所以进度得靠它来画；刷新页面后也会用它把进度条接回来
let recJob = null;
let recPoll = null;
/// 勾选的录像文件名。批量删除要有个明确的集合，不能靠 DOM 里翻
let recSel = new Set();

/// 容量：KB 起步，过了 1GB 才换单位。固定用 MB 显示一块 60GB 的磁盘会变成 56789MB，量级看不出来
const capKb = (kb) => (kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}GB` : `${Math.round(kb / 1024)}MB`);

/// 设备上的秒数换算成人话；只有读不到值时才回「读不到」，不编数
const uptimeText = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
};
/// 秒表用的格式：分钟粒度在几秒内完全不动，看不出「动态刷新」已经生效
const uptimeLiveText = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d) return `${d} 天 ${h} 小时 ${m} 分 ${sec} 秒`;
  if (h) return `${h} 小时 ${m} 分 ${sec} 秒`;
  return `${m} 分 ${sec} 秒`;
};

/// 「已运行」在两次采样之间也会一秒一秒地涨，静态文字会让人怀疑数据没在动。
/// 记下读数到达本机的时刻，每秒按本机钟往前推；下一次真实采样回来再校准。
let uptimeBase = null;
let uptimeTimer = 0;
function stopUptimeTick() {
  clearInterval(uptimeTimer);
  uptimeTimer = 0;
}
function startUptimeTick() {
  stopUptimeTick();
  if (!uptimeBase) return;
  uptimeTimer = setInterval(() => {
    if (document.hidden) return;
    renderUptime();
  }, 1000);
}
function renderUptime() {
  if (!uptimeBase) return;
  const sec = uptimeBase.sec + Math.round((Date.now() - uptimeBase.at) / 1000);
  const cell = [...document.querySelectorAll('#healthfoot .stat')].find(
    (c) => c.querySelector('.stat-k')?.textContent === '已运行',
  );
  if (cell) cell.querySelector('.stat-v').textContent = uptimeLiveText(sec);
  else stopUptimeTick();
}

/// 健康趋势：只留最近 30 次采样，按 serial 分开存。
/// 换设备后曲线不能继承上一台的读数，所以键就是序列号；存在 localStorage 里，刷新页面还在
const HEALTH_KEY = 'tvdeck.health';
const HEALTH_POINTS = 30;
let healthHist = (() => {
  try {
    const o = JSON.parse(localStorage.getItem(HEALTH_KEY) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
})();

function sampleHealth(serial, H) {
  if (!serial || !H) return;
  const cpu = typeof H.cpu === 'number' && H.cpu >= 0 ? H.cpu : null;
  const mem = H.memTotalKb > 0 && H.memUsedKb >= 0 ? Math.round((H.memUsedKb / H.memTotalKb) * 100) : null;
  const load = Array.isArray(H.load) && H.cores ? Math.min(100, Math.round((H.load[0] / H.cores) * 100)) : null;
  const temp = typeof H.tempC === 'number' ? Math.min(100, Math.max(0, H.tempC)) : null;
  const disk = H.disk && H.disk.totalKb > 0 ? Math.round((H.disk.usedKb / H.disk.totalKb) * 100) : null;
  const procs = Number.isFinite(H.procs) && H.procs >= 0 ? H.procs : null;
  const bat = H.battery || {};
  const batpct = bat.supported && typeof bat.level === 'number' && bat.level >= 0 ? Math.min(100, bat.level) : null;
  if (cpu === null && mem === null && load === null && temp === null && procs === null && batpct === null) return;
  const cur = healthHist[serial] || { pts: [] };
  cur.pts = [...(cur.pts || []), { t: Date.now(), cpu, mem, load, disk, procs, temp, bat: batpct }].slice(-HEALTH_POINTS);
  healthHist[serial] = cur;
  try {
    localStorage.setItem(HEALTH_KEY, JSON.stringify(healthHist));
  } catch {
    /* 隐私模式存不住，本次会话里的曲线仍然画得出来 */
  }
}

/// 折线固定按 0-100% 归一化，横轴固定 30 格：
/// 这样 CPU 和内存两条曲线可以直接横向比高低，采样点少时线从左往右长出来，
/// 不会把两个点硬撑满整幅宽度、画成一段唬人的「趋势」
function drawSpark(svg, values, now, maxV = 100) {
  svg.replaceChildren();
  const W = 120;
  const H = 34;
  const pad = 4;
  const cap = maxV > 0 ? maxV : 100;
  const py = (v) => H - pad - (Math.max(0, Math.min(cap, v)) / cap) * (H - pad * 2);
  const ns = 'http://www.w3.org/2000/svg';
  const dot = (x, y, cls = 'spark-dot') => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', x.toFixed(1));
    c.setAttribute('cy', y.toFixed(1));
    c.setAttribute('r', '2.4');
    c.setAttribute('class', cls);
    return c;
  };
  if (!values || values.length < 2) {
    if (values && values.length === 1) {
      svg.append(dot(60, py(values[0].v)));
      return true;
    }
    return false;
  }
  /// 横轴按两次采样的真实间隔展开，右端一直延伸到「现在」：
  /// 即使两次采样之间读数没变，折线也会随着时间往左漂移，
  /// 用户能明确看出时间在走、采样在继续，而不是对着一张静止图
  const t0 = values[0].t;
  const t1 = Math.max(values[values.length - 1].t, now || values[values.length - 1].t);
  const span = Math.max(1, t1 - t0);
  const px = (t) => ((t - t0) / span) * (W - pad * 2) + pad;
  const pts = values.map((p) => `${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`);
  const lastV = values[values.length - 1].v;
  const area = document.createElementNS(ns, 'polygon');
  area.setAttribute('class', 'spark-area');
  area.setAttribute('points', `${px(t0).toFixed(1)},${H} ${pts.join(' ')} ${px(t1).toFixed(1)},${H}`);
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('class', 'spark-path');
  line.setAttribute('points', pts.join(' '));
  /// 每次采样都落一个可见的点：两三个点时趋势该是几段折线就画几段，
  /// 用户数点就知道已经采了几拍，而不是对着一条近乎静止的线猜
  const spark = values.map((p, i) => dot(px(p.t), py(p.v), i === values.length - 1 ? 'spark-dot' : 'spark-dot spark-dot-plain'));
  svg.append(area, line, ...spark);
  return true;
}

/// 时间轴每秒漂移时只改已有元素的坐标，不重建 DOM：
/// 末点呼吸动画才能一直连续，用户也不会看到整卡闪一下
function redrawSpark(svg, values, now, maxV) {
  const W = 120;
  const H = 34;
  const pad = 4;
  const cap = maxV > 0 ? maxV : 100;
  const py = (v) => H - pad - (Math.max(0, Math.min(cap, v)) / cap) * (H - pad * 2);
  const t0 = values[0].t;
  const t1 = Math.max(values[values.length - 1].t, now || values[values.length - 1].t);
  const span = Math.max(1, t1 - t0);
  const px = (t) => ((t - t0) / span) * (W - pad * 2) + pad;
  const points = values.map((p) => `${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`);
  const line = svg.querySelector('.spark-path');
  const area = svg.querySelector('.spark-area');
  const dots = [...svg.querySelectorAll('.spark-dot')];
  if (!line || !area || dots.length !== values.length) return drawSpark(svg, values, now, maxV);
  line.setAttribute('points', points.join(' '));
  area.setAttribute('points', `${px(t0).toFixed(1)},${H} ${points.join(' ')} ${px(t1).toFixed(1)},${H}`);
  dots.forEach((c, i) => {
    c.setAttribute('cx', px(values[i].t).toFixed(1));
    c.setAttribute('cy', py(values[i].v).toFixed(1));
    c.setAttribute('class', i === values.length - 1 ? 'spark-dot' : 'spark-dot spark-dot-plain');
  });
  return true;
}

function sparkSeriesFor(key) {
  const serial = state?.profile?.serial;
  const hist = (serial && healthHist[serial]) || { pts: [] };
  return (hist.pts || []).filter((p) => p[key] !== null && p[key] !== undefined).map((p) => ({ t: p.t, v: p[key] }));
}

function sparkMaxFor(key, values) {
  if (key !== 'procs') return 100;
  const nums = values.map((p) => p.v).filter((v) => typeof v === 'number');
  return nums.length ? Math.max(...nums) : 100;
}

function renderSparkMeta() {
  const serial = state?.profile?.serial;
  const hist = (serial && healthHist[serial]) || { pts: [] };
  const grid = $('#sparkgrid');
  const meta = $('#sparkmeta');
  if (!grid || !meta) return;
  const series = [
    { key: 'cpu', title: 'CPU 占用趋势', fmt: (v) => `${v}%` },
    { key: 'mem', title: '内存占用趋势', fmt: (v) => `${v}%` },
    { key: 'load', title: '负载（占核数）趋势', fmt: (v) => `${v}%` },
    { key: 'disk', title: '磁盘占用趋势', fmt: (v) => `${v}%` },
    { key: 'procs', title: '进程数趋势', fmt: (v) => `${v} 个` },
    { key: 'temp', title: '温度趋势', fmt: (v) => `${v}°C` },
    { key: 'bat', title: '电量趋势', fmt: (v) => `${v}%` },
  ];
  const pts = hist.pts || [];
  const shown = pts.filter((p) => series.some((c) => p[c.key] !== null && p[c.key] !== undefined));
  if (shown.length >= 2) {
    const fmt = (t) => {
      const d = new Date(t);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    };
    meta.hidden = false;
    const liveEnd = Math.max(shown[shown.length - 1].t, Date.now());
    meta.textContent = `${fmt(shown[0].t)} → ${fmt(liveEnd)} · 保留最近 ${HEALTH_POINTS} 个采样点`;
  } else if (shown.length === 1) {
    // 只有一拍时上面那行「N 秒前采样」已经在说时间；这里再写「已采 1 拍」
    // 等于同一件事的第二种说法，干脆留空，攒够两拍再出趋势时间轴
    meta.hidden = true;
    meta.textContent = '';
  } else {
    meta.hidden = true;
  }
}

function renderSparks() {
  const serial = state?.profile?.serial;
  const hist = (serial && healthHist[serial]) || { pts: [] };
  const grid = $('#sparkgrid');
  if (!grid) return;
  const series = [
    { key: 'cpu', title: 'CPU 占用趋势', fmt: (v) => `${v}%` },
    { key: 'mem', title: '内存占用趋势', fmt: (v) => `${v}%` },
    { key: 'load', title: '负载（占核数）趋势', fmt: (v) => `${v}%` },
    { key: 'disk', title: '磁盘占用趋势', fmt: (v) => `${v}%` },
    { key: 'procs', title: '进程数趋势', fmt: (v) => `${v} 个` },
    { key: 'temp', title: '温度趋势', fmt: (v) => `${v}°C` },
    { key: 'bat', title: '电量趋势', fmt: (v) => `${v}%` },
  ].filter((c) => (hist.pts || []).some((p) => p[c.key] !== null && p[c.key] !== undefined));

  let any = false;
  grid.replaceChildren(
    ...series.map((c) => {
      const card = document.createElement('div');
      card.className = 'sparkcard';
      card.dataset.key = c.key;
      const b = document.createElement('b');
      b.textContent = c.title;
      const em = document.createElement('em');
      const pts = hist.pts.filter((p) => p[c.key] !== null && p[c.key] !== undefined).map((p) => ({ t: p.t, v: p[c.key] }));
  const pulse = pts.length >= 2 && pts[pts.length - 1].v !== pts[pts.length - 2].v;
      const last = pts.length ? pts[pts.length - 1].v : null;
      const nums = pts.map((p) => p.v).filter((v) => typeof v === 'number');
      const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      const lo = nums.length ? Math.min(...nums) : null;
      const hi = nums.length ? Math.max(...nums) : null;
      em.textContent = last === null ? '' : c.fmt(last);
      if (avg !== null && lo !== null && hi !== null && last !== null) {
        const near = Math.abs(last - avg) <= Math.max(1, (hi - lo) * 0.35);
        const one = `均值 ${c.fmt(Math.round(avg * 10) / 10)}`;
        const two = lo === hi ? `区间 ${c.fmt(lo)}` : `区间 ${c.fmt(lo)} 至 ${c.fmt(hi)}`;
        em.title = `${one} · ${two}`;
        em.classList.toggle('spark-flat', near && lo !== hi && hi - lo < 8);
      } else {
        em.title = '';
        em.classList.remove('spark-flat');
      }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 120 34');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('class', 'sparkline');
      svg.setAttribute('aria-hidden', 'true');
      svg.classList.toggle('pulse', pulse);
      const maxV = sparkMaxFor(c.key, pts);
      card.dataset.max = String(maxV);
      const drawn = drawSpark(svg, pts, Date.now(), maxV);
      any = any || drawn;
      // 单点只能画一个孤立圆点，用户看不出趋势还会以为图坏了：
      // 这种卡先收着折线区，改成一句话说明，攒够两拍自动换成真曲线
      card.classList.toggle('is-early', pts.length < 2);
      const chip = document.createElement('i');
      chip.className = 'spark-chip';
      chip.hidden = true;
      if (pts.length >= 2) {
        const prev = pts[pts.length - 2].v;
        const lastV = pts[pts.length - 1].v;
        if (prev !== null && prev !== undefined && lastV !== null && lastV !== undefined && lastV !== prev) {
          chip.hidden = false;
          chip.textContent = lastV > prev ? '↑' : '↓';
          chip.title = `上一拍 ${c.fmt(prev)}，最新一拍 ${c.fmt(lastV)}`;
        }
      }
      const count = document.createElement('i');
      count.className = 'spark-count';
      /// 五张卡各写一遍「1 拍」只是噪声，页脚那行已经统一说明采样进度
      count.hidden = pts.length < 2;
      count.textContent = pts.length ? `${pts.length} 拍` : '';
      count.title = '浏览器里记录的连续采样拍数，每 5 秒增加一拍';
      const head = document.createElement('div');
      head.className = 'spark-head';
      head.append(b, chip, count);
      card.append(head, em, svg);
      if (pulse) card.classList.add('pulse');
      return card;
    }),
  );
  grid.hidden = !any;

  /// 图下沿一行「几秒前到几秒前」的时间注脚：动态不只是值在变，
  /// 时间轴本身也要能对得上「我盯了它多久」；每秒在 tick 里重算
  renderSparkMeta();
  renderHealthMeta();
}

function renderHealthMeta() {
  const meta = $('#healthmeta');
  if (!meta) return;
  const serial = state?.profile?.serial;
  /// 图下那行「17:29:27 → 17:29:38」已经说明了最新采样到哪一刻，
  /// 上面再挂一句「2 秒前采样」是同一个事实的第二种写法。只有还没攒够
  /// 两拍、没有趋势时间轴可看时，这行才需要自己报采样时间
  const hist = (serial && healthHist[serial]) || { pts: [] };
  const hasTrend = (hist.pts || []).length >= 2;
  const now = Date.now();
  const ago = healthStampAt ? Math.max(0, Math.round((now - healthStampAt) / 1000)) : null;
  meta.hidden = !serial || hasTrend;
  meta.textContent = serial
    ? healthStampAt
      ? `${ago} 秒前采样`
      : '等待首次采样'
    : '';
}

/// 底排这些格子和上面的大卡一样会变：进程数、负载、温度尤其敏感。
/// 没有变化提示时，用户盯着它看不出「自动刷新到底做了什么」
let healthPrevCells = {};
const cellFlash = new Set();

function flashChangedCells(cells) {
  cells.forEach(([k, v]) => {
    if (healthPrevCells[k] !== undefined && healthPrevCells[k] !== v) cellFlash.add(k);
    healthPrevCells[k] = v;
  });
}

function healthCard(label, pct, value, sub) {
  const card = document.createElement('div');
  card.className = `hrow${healthPrevVals[label] !== undefined && healthPrevVals[label] !== value ? ' flash' : ''}`;
  healthPrevVals[label] = value;
  const head = document.createElement('div');
  head.className = 'hmain';
  const k = document.createElement('b');
  k.textContent = label;
  const v = document.createElement('em');
  v.textContent = value;
  const lv = metricLevel(pct);
  // 排布和总览快照对齐：名字在左，状态徽标紧跟名字，读数靠右。
  // 之前徽标排在名字左边，扫一眼会误以为它是整列的表头
  head.append(k);
  /// 「正常」是默认态，三张卡各挂一枚只是在复述同一句话：
  /// 只有偏高 / 过高才值得占用视线，异常时用颜色和文字同时强调。
  if (lv && lv !== 'ok') {
    const badge = document.createElement('span');
    badge.className = `hbadge ${lv}`;
    badge.textContent = METRIC_LEVEL_WORD[lv];
    // 徽标不带 margin-right 时会把读数挤到同一行右侧：这里靠 CSS 的 auto 边距推右
    head.append(badge);
  }
  head.append(v);
  const track = document.createElement('i');
  track.className = 'htrack';
  const fill = document.createElement('b');
  fill.className = lv || '';
  fill.style.width = pct === null ? '0' : `${pct}%`;
  track.append(fill);
  // 和总览快照同一套刻度线：健康子页也要能看出「离告警还有多远」
  appendMetricTicks(track);
  track.title = `${label} ${pct === null ? '暂无读数' : `${pct}%，满条 100%，条上竖线是 ${METRIC_WARN_PCT}% 与 ${METRIC_HOT_PCT}%`}`;
  card.append(head, track);
  if (sub) {
    const note = document.createElement('span');
    note.className = 'hsub';
    note.textContent = sub;
    card.append(note);
  }
  card.dataset.key = label;
  card.dataset.pct = pct === null ? '0' : String(pct);
  return card;
}

/// 读数格要能看出「这一拍变了」：拿上一次渲染的值做对比，
/// 变了才给整张卡一个短促高亮，没变就不打扰
let healthPrevVals = {};
const healthMicro = new Map();
let healthStampAt = null;
let healthMetaTimer = 0;

/// CPU 和磁盘没有本机钟可以连续推，采样后给进度条一个短促微光：
/// 不编中间值、不假装实时，只把「这一拍确实刷新了」这件事讲清楚
function markHealthMicro(key) {
  healthMicro.set(key, Date.now());
}

function tickHealthMicro(now) {
  for (const [key, at] of healthMicro) {
    const el = document.querySelector(`#healthgrid .hrow[data-key="${key}"]`);
    const fill = el?.querySelector('.htrack > b');
    if (!el || !fill) continue;
    fill.classList.toggle('micro', Number(el.dataset.pct || '0') > 0 && now - at < 1000);
    if (now - at >= 1000) healthMicro.delete(key);
  }
}

function stopHealthMetaTick() {
  clearInterval(healthMetaTimer);
  healthMetaTimer = 0;
}

/// 「最近采样几秒前」这句话本身也要往前走，否则右上角时间一停，
/// 用户还是会怀疑自动刷新没在工作；只在健康子页可见时计数
function startHealthMetaTick() {
  stopHealthMetaTick();
  healthMetaTimer = setInterval(() => {
    if (!healthPaneVisible() || document.hidden) return;
    /// 展示层每秒只推进时间注脚和重画，不重建 DOM：
    /// 元素不换，末点呼吸动画才能连续；值变化的卡片由采样回调单独标 pulse
    const serial = state?.profile?.serial;
    const hist = (serial && healthHist[serial]) || { pts: [] };
    const fmts = {
      cpu: (v) => `${v}%`,
      mem: (v) => `${v}%`,
      load: (v) => `${v}%`,
      disk: (v) => `${v}%`,
      procs: (v) => `${v} 个`,
      temp: (v) => `${v}°C`,
      bat: (v) => `${v}%`,
    };
    for (const card of document.querySelectorAll('#sparkgrid .sparkcard')) {
      const key = card.dataset.key;
      const svg = card.querySelector('.sparkline');
      if (!key || !svg) continue;
      const values = sparkSeriesFor(key);
      card.classList.toggle('is-early', values.length < 2);
      if (values.length >= 2) redrawSpark(svg, values, Date.now(), Number(card.dataset.max) || sparkMaxFor(key, values));
      const fmt = fmts[key];
      if (fmt && values.length) {
        const em = card.querySelector('em');
        const chip = card.querySelector('.spark-chip');
        const count = card.querySelector('.spark-count');
        const nums = values.map((p) => p.v).filter((v) => typeof v === 'number');
        const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        const lo = nums.length ? Math.min(...nums) : null;
        const hi = nums.length ? Math.max(...nums) : null;
        if (em) {
          const last = values[values.length - 1].v;
          em.textContent = fmt(last);
          if (avg !== null && lo !== null && hi !== null) {
            const near = Math.abs(last - avg) <= Math.max(1, (hi - lo) * 0.35);
            const one = `均值 ${fmt(Math.round(avg * 10) / 10)}`;
            const two = lo === hi ? `区间 ${fmt(lo)}` : `区间 ${fmt(lo)} 至 ${fmt(hi)}`;
            em.title = `${one} · ${two}`;
            em.classList.toggle('spark-flat', near && lo !== hi && hi - lo < 8);
          } else {
            em.title = '';
            em.classList.remove('spark-flat');
          }
        }
        if (chip) {
          if (values.length >= 2) {
            const prev = values[values.length - 2].v;
            const last = values[values.length - 1].v;
            if (prev !== last) {
              chip.hidden = false;
              chip.textContent = last > prev ? '↑' : '↓';
              chip.title = `上一拍 ${fmt(prev)}，最新一拍 ${fmt(last)}`;
            } else {
              chip.hidden = true;
            }
          } else {
            chip.hidden = true;
          }
        }
        if (count) {
          const n = hist.pts?.length || 0;
          count.hidden = n < 2;
          count.textContent = n >= 2 ? `${n} 拍` : '';
        }
      }
    }
    renderSparkMeta();
    renderHealthMeta();
    tickHealthMicro(Date.now());
  }, 1000);
}

/// 底排读数每秒走秒：已运行跟着本机钟往前走、电池温度这类连续量短标时不重排
/// 整排（重排会打断用户正在读的行），数字在原地更新
function tickHealthFoot() {
  const sec = uptimeBase ? uptimeBase.sec + Math.round((Date.now() - uptimeBase.at) / 1000) : null;
  for (const c of document.querySelectorAll('#healthfoot .stat')) {
    const k = c.querySelector('.stat-k')?.textContent;
    const v = c.querySelector('.stat-v');
    if (!v) continue;
    if (k === '已运行' && sec !== null) v.textContent = uptimeLiveText(sec);
    else if (k === '温度' && healthData?.tempC !== null && healthData?.tempC !== undefined)
      v.textContent = `${healthData.tempC}°C`;
    else if (k === '电池' && healthData?.battery?.supported) {
      const bat = healthData.battery;
      const parts = [];
      if (bat.level !== null && bat.level !== undefined) parts.push(`${bat.level}%`);
      if (bat.status) parts.push(bat.status);
      if (bat.tempC !== null && bat.tempC !== undefined) parts.push(`${bat.tempC}°C`);
      if (bat.voltageMv) parts.push(`${(bat.voltageMv / 1000).toFixed(2)}V`);
      v.textContent = parts.join(' · ') || '读不到';
    }
  }
}

/// 内存大卡同样一秒一秒往前走：采样值是近似，本机钟连续推进比「等 5 秒」更像实时。
/// 标题行只放百分比，绝对量挪到下方说明行，窄卡里两边都不会被截成省略号
function tickHealthCard(el, usedKb, totalKb) {
  if (!el || usedKb === null || totalKb === null) return;
  const pct = Math.round((usedKb / totalKb) * 100);
  const v = el.querySelector('em');
  if (v) v.textContent = `${pct}%`;
  const sub = el.querySelector('.hsub');
  if (sub) sub.textContent = `${capKb(usedKb)} / ${capKb(totalKb)}`;
}

async function loadHealth(quiet = false) {
  if (healthBusy) {
    /// 手动刷新在轮询途中点下来时，不丢掉这次意图：等当前请求结束后补跑一次。
    if (!quiet) healthQueued = true;
    return;
  }
  healthBusy = true;
  const btn = $('#btn-health');
  if (!state?.online) {
    healthBusy = false;
    $('#healthgrid').replaceChildren(emptyOff({ title: '健康状态需要先连接设备', note: '连上后自动采样 CPU、内存、存储、温度和电量。' }));
    $('#healthsum').textContent = '';
    if (btn) {
      btn.disabled = false;
      btn.textContent = '读取健康';
    }
    $('#healthfoot').hidden = true;
    return;
  }
  btn.disabled = true;
  if (!quiet) btn.textContent = '读取中…';
  /// CPU 占用要两次 /proc/stat 采样（中间隔 0.4 秒），所以第一次进来会有半秒空白，
  /// 这里先说明在等什么，别让用户以为卡住了
  /// 静默刷新不重画骨架：每 5 秒把整块读数换成一句「正在采样」会闪一下，
  /// 用户看到的是页面在跳，而不是数据在更新。只有首次进入和手动刷新才显示等待态。
  if (!quiet || !healthData) $('#healthgrid').replaceChildren(captionEl('正在采样，约 1 秒…'));
  if (!quiet || !healthData) $('#healthfoot').hidden = true;
  try {
    const next = await api('/api/health');
    /// 后端在采样失败时会回上一次成功读数并标 stale=true；保留它，但把时间标成
    /// 「上次成功读数」，不要让用户以为这是这一秒刚采到的值。
    healthData = next;
    if (!next?.stale) healthOkAt = Date.now();
    healthStampAt = healthOkAt || Date.now();
    renderHealth();
    renderHealthFreshness();
  } catch (e) {
    /// 一次抖动不该把已经读到的 CPU / 内存全清空。保留上一拍，并在标题旁说明
    /// 这次没采到、当前显示的是几秒前的成功读数。
    if (healthData?.ok !== false) {
      renderHealth();
      renderHealthFreshness(e.message);
    } else {
      $('#healthgrid').replaceChildren(captionEl(e.message));
      $('#healthsum').textContent = '';
    }
  } finally {
    healthBusy = false;
    btn.disabled = false;
    if (!quiet) btn.textContent = '重新读取';
    tickHealthFoot();
    renderHealthMeta();
    if (healthQueued) {
      healthQueued = false;
      void loadHealth(false);
    }
  }
}

/// 健康区右上角的状态：成功采样只显示时间；失败回退时明确写「上次成功读数」。
/// 文案放这里而不是散在 renderHealth 里，避免 stale 状态被普通详情串覆盖。
function renderHealthFreshness(failure) {
  const sum = $('#healthsum');
  if (!sum) return;
  const base = String(healthData?.detail || '').trim();
  const bits = base ? base.split(' · ') : [];
  const head = bits.length > 2 ? `${bits.slice(0, 2).join(' · ')} +${bits.length - 2}` : base;
  const ago = healthOkAt ? Math.max(0, Math.round((Date.now() - healthOkAt) / 1000)) : null;
  if (failure || healthData?.stale) {
    const when = ago === null ? '上一次成功读数' : `${ago} 秒前的成功读数`;
    sum.textContent = `${head ? `${head} · ` : ''}${when} · 本次未更新`;
    sum.title = failure
      ? `本次采样失败：${failure}\n当前显示的是${when}`
      : `设备本次没有返回新读数，当前显示的是${when}`;
    sum.classList.add('stale');
    return;
  }
  sum.textContent = head;
  sum.title = base;
  sum.classList.remove('stale');
}

function renderHealth() {
  const H = healthData;
  const grid = $('#healthgrid');
  /// 标题后面那串和下面的卡片、底排格子是同一批读数，重复一遍只会让页面更吵：
  /// 正文只留头两项，完整串进悬停提示
  {
    renderHealthFreshness();
  }

  if (H.ok === false) {
    grid.replaceChildren(captionEl(H.detail || '当前设备没有给出可读的运行读数。'));
    $('#healthfoot').hidden = true;
    $('#sparkgrid').hidden = true;
    return;
  }

  const cpu = typeof H.cpu === 'number' && H.cpu >= 0 ? H.cpu : null;
  grid.replaceChildren(
    healthCard(
      'CPU 占用',
      cpu,
      cpu === null ? '读不到' : `${cpu}%`,
      H.cores ? `${H.cores} 核负载占满载比例` : '整机负载占满载比例',
    ),
  );
  if (cpu !== null) markHealthMicro('CPU 占用');

  let memPct = null;
  if (H.memTotalKb > 0 && H.memUsedKb >= 0) {
    const pct = Math.round((H.memUsedKb / H.memTotalKb) * 100);
    memPct = pct;
    grid.append(
      healthCard('内存', pct, `${pct}%`, `${capKb(H.memUsedKb)} / ${capKb(H.memTotalKb)}`),
    );
  } else {
    grid.append(healthCard('内存', null, '读不到'));
  }

  if (H.disk && H.disk.totalKb > 0) {
    const pct = Math.round((H.disk.usedKb / H.disk.totalKb) * 100);
    grid.append(
      healthCard(
        '存储空间',
        pct,
        `${pct}%`,
        `${capKb(H.disk.usedKb)} / ${capKb(H.disk.totalKb)} · 剩 ${capKb(H.disk.availKb)}`,
      ),
    );
    markHealthMicro('存储空间');
  } else {
    grid.append(healthCard('磁盘', null, '读不到'));
  }

  /// 底下一排是「不好画成进度条」的读数。负载要和核数比才有意义：
  /// 4 核跑 3.9 是快满了，16 核跑 3.9 才刚起步
  const cells = [];
  if (H.cores) cells.push(['CPU 核数', String(H.cores), '']);
  if (Array.isArray(H.load) && H.load.length) {
    const per = H.cores ? H.load[0] / H.cores : null;
    cells.push(['负载 1/5/15 分', H.load.map((n) => n.toFixed(2)).join(' / '), per === null ? '' : per < 1 ? 'ok' : per < 1.8 ? 'warn' : 'hot']);
  }
  if (H.procs) cells.push(['进程数', String(H.procs), '']);
  if (H.tempC !== null && H.tempC !== undefined) cells.push(['温度', `${H.tempC}°C`, H.tempC >= 75 ? 'warn' : '']);
  if (H.uptimeSec) cells.push(['已运行', uptimeText(H.uptimeSec), 'ok']);
  /// 电池只在设备真的报了电池服务时才出现：部分设备的电池服务多半是桩，
  /// 但既然它自己给出了读数就照实显示，页面不替设备判断「你该不该有电池」
  const bat = H.battery || {};
  if (bat.supported) {
    const parts = [];
    if (bat.level !== null && bat.level !== undefined) parts.push(`${bat.level}%`);
    if (bat.status) parts.push(bat.status);
    if (bat.tempC !== null && bat.tempC !== undefined) parts.push(`${bat.tempC}°C`);
    if (bat.voltageMv) parts.push(`${(bat.voltageMv / 1000).toFixed(2)}V`);
    /// 低电量且没在充电才是真该提醒的事；插着电的 20% 不用染红
    const low = bat.level !== null && bat.level !== undefined && bat.level <= 15 && !bat.charging;
    cells.push(['电池', parts.join(' · ') || '读不到', low ? 'warn' : '']);
  }

  if (H.uptimeSec) {
    const last = cells.find((c) => c[0] === '已运行');
    if (last) last[1] = uptimeLiveText(H.uptimeSec);
  }

  flashChangedCells(cells);

  const foot = $('#healthfoot');
  foot.hidden = !cells.length;
  foot.replaceChildren(
    ...cells.map(([k, v, kind]) => {
      const c = document.createElement('div');
      c.className = `stat${cellFlash.has(k) ? ' flash' : ''}`;
      const kk = document.createElement('span');
      kk.className = 'stat-k';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = `stat-v${kind ? ` k-${kind}` : ''}`;
      vv.textContent = v;
      if (H.tempZone && k === '温度') kk.title = H.tempZone;
      c.append(kk, vv);
      return c;
    }),
  );
  cellFlash.clear();

  if (H.uptimeSec) {
    uptimeBase = { sec: H.uptimeSec, at: Date.now() };
    startUptimeTick();
  }
  startHealthMetaTick();

  /// 采样放在最后：只有真拿到了读数才进曲线。后端在 adb 抖动时会回上一次成功的
  /// 值并标 stale=true，这种旧值不该再进曲线，否则看起来像是又采了一拍
  const prevLast = state?.profile?.serial
    ? (healthHist[state.profile.serial]?.pts || []).slice(-2)
    : null;
  if (!H.stale) sampleHealth(state?.profile?.serial, H);
  renderSparks();
  if (prevLast && prevLast.length === 2) {
    for (const card of document.querySelectorAll('#sparkgrid .sparkcard')) {
      const svg = card.querySelector('.sparkline');
      const key = ['cpu','mem','load','disk','procs','temp','bat'][
        Array.from(card.parentElement?.children || []).indexOf(card)
      ];
      if (!svg || key === undefined || key === null) continue;
      const p = healthHist[state?.profile?.serial]?.pts || [];
      if (p.length < 2) continue;
      const a = p[p.length - 2][key], z = p[p.length - 1][key];
      svg.classList.toggle('pulse', a !== z);
      if (a !== z) card.classList.add('pulse');
      else card.classList.remove('pulse');
    }
  }
}

$('#btn-health').onclick = () => loadHealth();

/// 健康读数要跟着设备走：CPU、内存、温度、运行时长这类值每一拍都可能变，
/// 只靠手动「重新读取」就会让人对着半分钟前的旧数。这里在健康子页可见且设备在线时
/// 每 5 秒静默刷新一次；切走子页、切走页签或设备离线就停，避免后台白打 /api/health。
const HEALTH_POLL_MS = 5000;
let healthPoll = 0;
let healthSamplePoll = 0;
function healthPaneVisible() {
  return (
    curTab === 'device' &&
    !document.hidden &&
    document.querySelector('.subpane[data-sub="health"]')?.classList.contains('on')
  );
}
function updateHealthPoll() {
  const want = healthPaneVisible() && state?.online;
  /// 切回前台后，秒表要立刻接上；等到下一次采样才恢复会先静止十几秒
  if (want && uptimeBase && !uptimeTimer) {
    renderUptime();
    startUptimeTick();
  }
  if (want && !healthPoll) {
    healthPoll = setInterval(() => {
      if (!healthPaneVisible() || !state?.online) {
        updateHealthPoll();
        return;
      }
      tickHealthFoot();
      const memCard = document.querySelector('#healthgrid .hrow[data-key="内存"]');
      const H = healthData;
      if (memCard && H?.memTotalKb > 0 && H?.memUsedKb >= 0) tickHealthCard(memCard, H.memUsedKb, H.memTotalKb);
      renderHealthMeta();
    }, 1000);
    /// 采样照旧每 5 秒走一次，秒 tick 只做展示层推进
    healthSamplePoll = setInterval(() => {
      if (healthPaneVisible() && state?.online) void loadHealth(true);
      else updateHealthPoll();
    }, HEALTH_POLL_MS);
  } else if (!want && healthPoll) {
    clearInterval(healthPoll);
    healthPoll = 0;
    clearInterval(healthSamplePoll);
    healthSamplePoll = 0;
    stopHealthMetaTick();
  }
}
for (const ev of ['visibilitychange', 'pagehide']) {
  document.addEventListener(ev, () => {
    if (document.hidden || ev === 'pagehide') {
      stopUptimeTick();
      stopHealthMetaTick();
    }
    updateHealthPoll();
    updateProcPoll();
    updateDevInfoPoll();
    updateStampTick();
  });
}

/// 总览页的健康快照：健康子页自己有完整轮询，但总览页之前一行读数都没有，
/// 用户盯着总览看不出设备活着没有。这里独立打 /api/health，只取 CPU / 内存 /
/// 已运行三条做快照；curTab 是 home 且设备在线才轮，跟设备页那套互不干扰。
let homeSnapData = null;
let homeSnapPrev = {};
let homeSnapPoll = 0;
let homeSnapTick = 0;
let homeSnapAt = 0;
/// 服务端对 /api/health 有 5 秒只读缓存：快照也按 5 秒轮会每次都命中缓存，
/// 表面在轮、值永远不动。改成 6 秒，正好落在缓存过期之后
const HOME_SNAP_POLL_MS = 6000;
/// 快照横条只能看到「现在多少」，看不出是在变重还是回落。
/// 本地保留最近 40 个采样点（约 4 分钟），渲染时补一条迷你趋势
const HOME_SNAP_HIST_MAX = 40;
const homeSnapHistory = { cpu: [], mem: [], disk: [] };

/// 采样是 6 秒一拍，但「已运行」这种秒表读数不该 6 秒才跳一格：
/// 用最近一次采样的秒数加本地经过时间，每秒往前推
function tickHomeSnapUptime() {
  const el = $('#snapUptime');
  if (!el || !uptimeBase) return;
  el.textContent = uptimeLiveText(uptimeBase.sec + (Date.now() - uptimeBase.at) / 1000);
  const at = $('#snaptime');
  if (at && homeSnapAt) {
    const ago = Math.max(0, Math.round((Date.now() - homeSnapAt) / 1000));
    at.textContent = `· ${ago === 0 ? '刚刚采样' : `${ago} 秒前采样`}`;
  }
}

function homeSnapVisible() {
  return curTab === 'home' && !document.hidden && !!state?.online;
}

function renderHomeSnap(quiet = false) {
  const box = $('#homesnap');
  if (!box) return;
  const H = homeSnapData;
  if (!H || H.ok === false) {
    box.replaceChildren(captionEl(H?.detail || '当前设备没有给出可读的运行读数。'));
    return;
  }
  /// 首次数据没到时 box 里是「正在读取」单行提示，布局跳动很明显；
  /// 数据快到时给四张卡搭好骨架，读数再填进去，首屏就不闪了
  if (!quiet && !box.querySelector('.snapgrid')) {
    const ghost = document.createElement('div');
    ghost.className = 'snapgrid snap-ghost';
    for (let i = 0; i < 4; i++) {
      const g = document.createElement('div');
      g.className = 'snapstat snap-ghost-card';
      g.setAttribute('aria-hidden', 'true');
      ghost.append(g);
    }
    box.replaceChildren(ghost);
  }
  // 复用全局 metricLevel / METRIC_LEVEL_TIP
  const cpu = typeof H.cpu === 'number' && H.cpu >= 0 ? H.cpu : null;
  const memPct = H.memTotalKb > 0 && H.memUsedKb >= 0
    ? Math.round((H.memUsedKb / H.memTotalKb) * 100)
    : null;
  const trendParts = (series) => {
    const pts = series.filter((p) => typeof p.v === 'number').slice(-HOME_SNAP_HIST_MAX);
    /// 不满 3 个点时先占位：不画线（两点连线会看成陡变），但把这一行的高度留住，
    /// 否则首屏 12 秒里快照区会突然长高 40 多像素，下面的卡片整体往下跳
    if (pts.length < 3) return { pending: true, coords: '' };
    const min = Math.min(...pts.map((p) => p.v));
    const max = Math.max(...pts.map((p) => p.v));
    const span = Math.max(max - min, 1);
    const coords = pts.map((p, i) => {
      const x = pts.length === 1 ? 0 : (i / (pts.length - 1)) * 100;
      const y = 20 - ((p.v - min) / span) * 18;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    /// 基准点要落在历史窗口之内：40 个采样点 × 6 秒 ≈ 234 秒，
    /// 之前按 240 秒（4 分钟）找基准点，永远差 6 秒找不到，涨跌说明从没显示过。
    /// 改成 3 分钟（180 秒）稳落在窗口内，约 30 个点之前。
    const old = pts.findLast((p) => Date.now() - p.t >= 180000);
    const cur = pts.at(-1);
    let delta = '';
    if (old && old !== cur) {
      const diff = Math.round(cur.v - old.v);
      if (diff !== 0) {
        const mins = Math.max(1, Math.round((Date.now() - old.t) / 60000));
        delta = `较 ${mins} 分钟前 ${diff > 0 ? '升' : '降'} ${Math.abs(diff)}%`;
      }
    }
    return { coords, delta };
  };
  /// 一个指标一张卡：指标名 + 状态 + 读数在同一行，横条独占一行拉满宽度，
  /// 条上再画 75% / 90% 两条告警刻度线；读不到也照样出条（空条 + 灰化 + 原因），
  /// 不再出现「四张卡里莫名少一条、剩下的条看不出是什么」的情况
  const stat = ({ label, value, sub, pct = null, gauge, series, reason, text = false }) => {
    const cell = document.createElement('div');
    cell.className = 'snapstat';
    if (text) cell.classList.add('is-text');
    const lv = metricLevel(pct);
    const nodata = !text && pct === null;
    if (nodata) cell.classList.add('is-nodata');
    const head = document.createElement('div');
    head.className = 'snap-head';
    const tag = document.createElement('span');
    tag.className = 'snap-title';
    tag.textContent = label;
    head.append(tag);
    /// 只有偏高/过高才给徽标；「正常」交给顶部摘要一句话，不再每张卡重复一次
    if (lv && lv !== 'ok') {
      const badge = document.createElement('span');
      badge.className = `snap-badge fill-${metricLevel(pct)}`;
      badge.textContent = lv === 'ok' ? '正常' : lv === 'warn' ? '偏高' : '过高';
      head.append(badge);
    }
    const v = document.createElement('b');
    v.className = 'snap-v';
    if (nodata) v.classList.add('nodata');
    v.textContent = value;
    if (label === '已运行') v.id = 'snapUptime';
    head.append(v);
    cell.append(head);
    if (text) {
      if (sub) {
        const s = document.createElement('span');
        s.className = 'snap-sub';
        s.textContent = sub;
        cell.append(s);
      }
      return cell;
    }
    const track = document.createElement('i');
    track.className = 'htrack snap-track';
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    if (nodata) {
      track.setAttribute('aria-valuetext', `${label}：暂无读数`);
      track.title = `${label}：${reason || '设备未上报该读数'}`;
    } else {
      track.setAttribute('aria-valuenow', String(pct));
      track.setAttribute('aria-valuetext', `${label} ${pct}%，${gauge || METRIC_LEVEL_TIP[lv]}`);
    }
    const fill = document.createElement('b');
    fill.className = nodata ? 'nodata' : lv;
    // 低于 4% 时按 4% 画：真实数值仍写在读数和 aria 里，只是不让条短到看不见
    fill.style.width = nodata ? '0%' : `${Math.max(pct, 4)}%`;
    track.append(fill);
    appendMetricTicks(track);
    cell.append(track);
    /// 刻度尺和图例都撤了：满条＝100%、竖线＝告警线，这些只写在悬停提示里，
    /// 每张卡再重复一行「0 75 90 满」等于把同一句话念四遍
    track.title = nodata
      ? track.title
      : `${label} ${pct}%，${METRIC_LEVEL_TIP[lv]}：满条是 100%，条上竖线是 ${METRIC_WARN_PCT}% 与 ${METRIC_HOT_PCT}%`;
    const meta = nodata ? reason || '设备未上报该读数' : gauge;
    if (meta) {
      const s = document.createElement('span');
      s.className = 'snap-sub';
      s.textContent = meta;
      cell.append(s);
    }
    if (nodata) return cell;
    const trend = series ? trendParts(series) : null;
    if (trend) {
      const row = document.createElement('div');
      row.className = 'snap-trend';
      /// 采样不满 3 点时干脆不画图：一条孤零零的虚线和短横比空着更像渲染错误。
      /// 行高由 CSS 撑住，曲线到位时不会把下面的卡片顶下去
      if (trend.pending) {
        row.classList.add('pending');
        row.setAttribute('aria-hidden', 'true');
        row.title = `${label} 正在采样走势，约 12 秒后给出近 3 分钟曲线`;
        cell.append(row);
        return cell;
      }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 24');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      // 先铺一条水平虚线做基线：曲线有了参照，也不会被看成第二根进度条
      const base = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      base.setAttribute('class', 'trend-base');
      base.setAttribute('x1', '0');
      base.setAttribute('y1', '12');
      base.setAttribute('x2', '100');
      base.setAttribute('y2', '12');
      svg.append(base);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', trend.coords);
      svg.append(line);
      row.append(svg);
      if (trend.delta) {
        const d = document.createElement('span');
        d.textContent = trend.delta;
        row.append(d);
      }
      row.title = `${label} 近 3 分钟走势（比 3 分钟前的点更低说明回落，反之在变重）${trend.delta ? ' · ' + trend.delta : ''}`;
      cell.append(row);
    }
    return cell;
  };
  const grid = document.createElement('div');
  grid.className = 'snapgrid';
  const diskPct = H.disk?.totalKb > 0 && H.disk?.usedKb >= 0
    ? Math.round((H.disk.usedKb / H.disk.totalKb) * 100)
    : null;
  grid.replaceChildren(
    stat({
      label: 'CPU 占用',
      value: cpu === null ? '未上报' : `${cpu}%`,
      pct: cpu,
      gauge: undefined,
      reason: '设备未上报 CPU 读数',
      series: homeSnapHistory.cpu,
    }),
    stat({
      label: '内存使用',
      value: memPct === null ? '未上报' : `${memPct}%`,
      pct: memPct,
      gauge: H.memTotalKb > 0 ? `${capKb(H.memUsedKb)} / ${capKb(H.memTotalKb)}` : undefined,
      reason: '设备未上报内存总量',
      series: homeSnapHistory.mem,
    }),
    stat({
      label: '存储空间',
      value: diskPct === null ? '未上报' : `${diskPct}%`,
      pct: diskPct,
      gauge: H.disk?.totalKb > 0 ? `${capKb(H.disk.usedKb)} / ${capKb(H.disk.totalKb)}` : undefined,
      reason: '设备未上报存储分区',
      series: homeSnapHistory.disk,
    }),
    stat({
      label: '已运行',
      value: H.uptimeSec ? uptimeLiveText(H.uptimeSec) : '未上报',
      text: true,
    }),
  );
  // 快照标题下方先给一句结论，扫一眼就知道设备整体状态；
  // 每张卡里再展开具体哪项吃紧，避免用户逐条读进度条
  const summaryItems = [
    { label: 'CPU', pct: cpu },
    { label: '内存', pct: memPct },
    { label: '存储', pct: diskPct },
  ];
  const missing = summaryItems.filter((it) => it.pct === null).map((it) => it.label);
  const summary = document.createElement('div');
  summary.className = 'snap-sum';
  const worst = summaryItems.reduce((worst, cur) => {
    const lv = metricLevel(cur.pct);
    if (!lv) return worst;
    if (!worst) return { ...cur, lv };
    const rank = { ok: 0, warn: 1, critical: 2 };
    return rank[lv] > rank[worst.lv] ? { ...cur, lv } : worst;
  }, null);
  if (worst) {
    summary.classList.add(worst.lv);
    // 建议按指标给：CPU 高是关后台，存储高是清空间，别一句通用话套所有情况
    const ADVICE = {
      CPU: { warn: '看看哪个应用在占处理器', critical: '关掉占用的应用或重启' },
      内存: { warn: '看看后台应用数量', critical: '关掉不用的应用释放内存' },
      存储: { warn: '留意剩余空间变化', critical: '清缓存或卸载不用的应用' },
    };
    summary.textContent = worst.lv === 'ok'
      ? '设备运行正常'
      : `${worst.label} ${worst.lv === 'warn' ? '偏高' : '过高'}，${ADVICE[worst.label][worst.lv]}`;
    if (missing.length) summary.textContent += ` · ${missing.join('、')}没读到`;
  } else {
    summary.textContent = '暂时读不到占用';
  }
  const chips = [];
  if (typeof H.tempC === 'number') chips.push(`温度 ${H.tempC}°C`);
  if (H.battery?.supported && typeof H.battery.level === 'number') chips.push(`电量 ${H.battery.level}%`);
  /// 进程数不再挂在快照底部：它和四张卡没有直接关系，
  /// 每次单独占一行显得像漏项；健康详情里本来就有「进程数」一栏
  const nodes = [summary, grid];
  if (chips.length) {
    const status = document.createElement('div');
    status.className = 'snapstatus';
    const text = document.createElement('span');
    text.textContent = chips.join(' · ');
    status.append(text);
    if (homeSnapAt) {
      const at = document.createElement('span');
      at.className = 'snap-time';
      at.id = 'snaptime';
      const ago = Math.max(0, Math.round((Date.now() - homeSnapAt) / 1000));
      at.textContent = ago === 0 ? '刚刚采样' : `${ago} 秒前采样`;
      status.append(at);
    }
    nodes.push(status);
  }
  box.replaceChildren(...nodes);
}

async function loadHomeSnap(quiet = false) {
  const box = $('#homesnap');
  if (!box) return;
  if (!quiet || !homeSnapData) {
    if (!quiet && !box.querySelector('.snap-ghost')) {
      /// 骨架先占住四张卡的位置，读数到了再无缝替换
      const ghost = document.createElement('div');
      ghost.className = 'snapgrid snap-ghost';
      for (let i = 0; i < 4; i++) {
        const g = document.createElement('div');
        g.className = 'snapstat snap-ghost-card';
        g.setAttribute('aria-hidden', 'true');
        ghost.append(g);
      }
      box.replaceChildren(ghost);
    } else if (!box.querySelector('.snap-ghost')) {
      box.replaceChildren(captionEl('正在读取设备运行读数…'));
    }
  }
  try {
    homeSnapData = await api('/api/health');
    homeSnapAt = Date.now();
    if (homeSnapData && homeSnapData.ok !== false) {
      const cpu = typeof homeSnapData.cpu === 'number' && homeSnapData.cpu >= 0 ? homeSnapData.cpu : null;
      const memPct = homeSnapData.memTotalKb > 0 && homeSnapData.memUsedKb >= 0
        ? Math.round((homeSnapData.memUsedKb / homeSnapData.memTotalKb) * 100)
        : null;
      const diskPct = homeSnapData.disk?.totalKb > 0 && homeSnapData.disk?.usedKb >= 0
        ? Math.round((homeSnapData.disk.usedKb / homeSnapData.disk.totalKb) * 100)
        : null;
      const now = Date.now();
      homeSnapHistory.cpu.push({ t: now, v: cpu });
      homeSnapHistory.mem.push({ t: now, v: memPct });
      homeSnapHistory.disk.push({ t: now, v: diskPct });
      for (const key of ['cpu', 'mem', 'disk']) {
        if (homeSnapHistory[key].length > HOME_SNAP_HIST_MAX) {
          homeSnapHistory[key].splice(0, homeSnapHistory[key].length - HOME_SNAP_HIST_MAX);
        }
      }
    }
    if (homeSnapData?.uptimeSec) {
      /// 秒表基准全站共用：健康子页和总览快照拿到的是同一个采样点，
      /// 切页后两处读数不会再各走各的、差出几秒
      uptimeBase = { sec: homeSnapData.uptimeSec, at: Date.now() };
    }
    renderHomeSnap(quiet);
  } catch (e) {
    homeSnapData = null;
    homeSnapAt = 0;
    box.replaceChildren(captionEl(e.message));
  }
}

function updateHomeSnapPoll() {
  const want = homeSnapVisible();
  /// 掉线后轮询已经停了，但最后一帧读数还会挂在总览页上，看着像设备还活着。
  /// 这里把残留帧清掉，给出明确的离线提示；重连后 loadHomeSnap 会自然补上
  if (curTab === 'home' && !state?.online) {
    if (homeSnapPoll) {
      clearInterval(homeSnapPoll);
      homeSnapPoll = 0;
      clearInterval(homeSnapTick);
      homeSnapTick = 0;
    }
    const snapBox = $('#homesnap');
    homeSnapData = null;
    homeSnapPrev = {};
    homeSnapAt = 0;
    if (snapBox && !snapBox.querySelector('.empty-off')) {
      renderHomeSnapOffline(snapBox);
    }
    return;
  }
  if (want && !homeSnapPoll) {
    if (!homeSnapData) void loadHomeSnap();
    homeSnapTick = setInterval(() => {
      if (homeSnapVisible()) tickHomeSnapUptime();
    }, 1000);
    homeSnapPoll = setInterval(() => {
      if (homeSnapVisible()) void loadHomeSnap(true);
      else updateHomeSnapPoll();
    }, HOME_SNAP_POLL_MS);
  } else if (!want && homeSnapPoll) {
    clearInterval(homeSnapPoll);
    homeSnapPoll = 0;
    clearInterval(homeSnapTick);
    homeSnapTick = 0;
  }
}

/// 离线健康快照：保留四张卡的骨架，数值置为占位符，
/// 让用户明确知道“连上设备后这里会显示什么”，而不是一张没有含义的空卡。
function renderHomeSnapOffline(box = $('#homesnap')) {
  if (!box) return;
  const wrap = document.createElement('div');
  wrap.className = 'hrow';
  const summary = document.createElement('div');
  summary.className = 'snap-sum';
  summary.textContent = '连接设备后自动采样';
  wrap.append(summary);
  const grid = document.createElement('div');
  grid.className = 'snapgrid';
  const specs = [
    ['CPU 占用', '—'],
    ['内存使用', '—'],
    ['存储空间', '—'],
    ['已运行', '—'],
  ];
  for (const [label, value] of specs) {
    const cell = document.createElement('div');
    cell.className = 'snapstat is-nodata';
    const head = document.createElement('div');
    head.className = 'snap-head';
    const tag = document.createElement('span');
    tag.className = 'snap-title';
    tag.textContent = label;
    const v = document.createElement('b');
    v.className = 'snap-v nodata';
    v.textContent = value;
    head.append(tag, v);
    cell.append(head);
    const track = document.createElement('i');
    track.className = 'htrack snap-track';
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuetext', `${label}：暂无读数`);
    const fill = document.createElement('b');
    fill.className = 'nodata';
    fill.style.width = '0%';
    track.append(fill);
    appendMetricTicks(track);
    cell.append(track);
    grid.append(cell);
  }
  box.replaceChildren(summary, grid);
}

/// 进程表和目录列表也给「这条数据是几秒前拿到的」提示：进程列表在子页可见时
/// 每 30 秒静默刷新（进程变化比 CPU 慢，轮太快只是白打 adb）；文件目录不自动刷，
/// 自动刷目录会打断正在浏览/推送的路径，只把读取时间往前走
const PROC_POLL_MS = 30000;
const DEV_INFO_POLL_MS = 20000;
let devInfoPoll = 0;
let procPoll = 0;
let stampTick = 0;
function subPaneOn(name) {
  return (
    curTab === 'device' &&
    !document.hidden &&
    document.querySelector(`.subpane[data-sub="${name}"]`)?.classList.contains('on')
  );
}
function procPaneVisible() {
  return subPaneOn('proc');
}
function filePaneVisible() {
  return subPaneOn('file');
}
function updateProcPoll() {
  const want = procPaneVisible() && state?.online;
  if (want && !procPoll) {
    procPoll = setInterval(() => {
      if (procPaneVisible() && state?.online) void loadProcs();
      else updateProcPoll();
    }, PROC_POLL_MS);
  } else if (!want && procPoll) {
    clearInterval(procPoll);
    procPoll = 0;
  }
}
function devInfoPaneVisible() {
  return subPaneOn('info');
}
function updateDevInfoPoll() {
  const want = devInfoPaneVisible() && state?.online;
  if (want && !devInfoPoll) {
    devInfoPoll = setInterval(() => {
      if (devInfoPaneVisible() && state?.online) void loadDevice(true);
      else updateDevInfoPoll();
    }, DEV_INFO_POLL_MS);
  } else if (!want && devInfoPoll) {
    clearInterval(devInfoPoll);
    devInfoPoll = 0;
  }
}
function updateStampTick() {
  const want = !document.hidden && (devInfoPaneVisible() || procPaneVisible() || filePaneVisible() || subPaneOn('log'));
  if (want && !stampTick) {
    stampTick = setInterval(() => {
      if (document.hidden) return;
      if (devInfoPaneVisible()) renderDevStamp();
      if (procPaneVisible()) updateProcStamp();
      if (filePaneVisible()) setFsStamp();
      if (subPaneOn('log')) renderLogSum();
    }, 1000);
  } else if (!want && stampTick) {
    clearInterval(stampTick);
    stampTick = 0;
  }
}
/// 电源动作：四种都是不可逆的（重启会掉连接、关机要人按电源键），
/// 所以每个都先弹确认，并把「设备会断连」写进文案，免得用户以为界面卡死了
const POWER_TEXT = {
  reboot: ['重启', '设备会断开几秒到一分钟，回来后自动重新认到。'],
  recovery: ['重启到恢复模式', '设备会进恢复模式，需在恢复菜单里手动重启。'],
  bootloader: ['重启到引导模式', '设备会停在引导程序，需要手动再启动才能回到系统。'],
  shutdown: ['关机', '设备会断电，之后需在设备上手动开机才能回来。'],
};

$('#powerrow').onclick = async (e) => {
  const b = e.target.closest('button[data-power]');
  if (!b || b.disabled) return;
  /// 按钮正常情况下已被 setControlsEnabled 禁用，这里再挡一层：
  /// 刚掉线但状态还没刷新的一瞬间点进去，别真的把命令下到一个已经不响应的连接上
  if (state && !state.online) {
    log('设备离线，先连上再执行电源操作', 'warn');
    return;
  }
  const act = b.dataset.power;
  const [label, warn] = POWER_TEXT[act] || [b.textContent, ''];
  if (!(await askDialog({ message: `确定要「${label}」吗？\n\n${warn}`, danger: true }))) return;
  b.disabled = true;
  try {
    const r = await api('/api/power', { action: act }, `电源 · ${label}`);
    log(r.detail || `${label}命令已送达`, r.verified ? 'ok' : 'warn');
    /// 命令一发出去设备就切走了，这时候状态卡还写着「在线」是假的：
    /// 隔一下拉一次，让它自己翻成离线或重连
    setTimeout(refresh, 1500);
  } catch (err) {
    log(err.message, 'err');
    b.disabled = false;
  }
};

/// 录屏：每个 mp4 一张卡。播放走内联 <video> 而不是新开标签 ——
/// 内置浏览器里新标签会把当前这次会话带走，回来还得重新找一遍设备
const recStamp = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

async function loadRecs() {
  const box = $('#reclist');
  if (!box) return;
  if (!state?.online) {
    box.replaceChildren(emptyOff({ title: '录屏记录需要先连接设备', note: '连上后可以在这里查看已保存的屏幕录像。' }));
    return;
  }
  try {
    const d = await api('/api/recordings');
    recRows = d.rows || [];
    box.dataset.dir = d.dir || '';
    renderRecs();
  } catch (e) {
    box.replaceChildren(captionEl(e.message));
  }
}

function recCard(r) {
  const row = document.createElement('div');
  /// 刚录完那一段打一次高亮：列表按时间倒序，新录像本来就在最上面，
  /// 但它长什么样和旧的一模一样，不标一下用户分不清刚录的是哪条
  row.className = `recrow${r.name === recFresh ? ' fresh' : ''}`;
  const head = document.createElement('div');
  head.className = 'rechead';
  /// 勾选框：整块是 44px 的点击区（.recpick 撑起来），手指点得中，
  /// 勾选状态记在 recSel 里而不是读 DOM，批量删的时候按集合取
  const pick = document.createElement('label');
  pick.className = 'recpick';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = recSel.has(r.name);
  box.setAttribute('aria-label', `选择 ${r.name}`);
  box.onchange = () => {
    if (box.checked) recSel.add(r.name);
    else recSel.delete(r.name);
    renderRecTools();
  };
  pick.append(box);
  const nm = document.createElement('b');
  nm.textContent = r.name;
  nm.title = r.name;
  const meta = document.createElement('em');
  meta.textContent = `${humanSize(r.bytes)} · ${recStamp(r.at)}`;
  head.append(pick, nm, meta);

  const acts = document.createElement('div');
  acts.className = 'recacts';
  const src = srv(`/recording?name=${encodeURIComponent(r.name)}`);

  let video = null;
  const play = document.createElement('button');
  play.type = 'button';
  play.textContent = '播放';
  play.onclick = () => {
    if (video) {
      video.remove();
      video = null;
      play.textContent = '播放';
      return;
    }
    video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = src;
    row.insertBefore(video, acts);
    play.textContent = '收起';
    video.play().catch(() => {});
  };

  const dl = document.createElement('a');
  dl.textContent = '下载这份录像';
  dl.href = src;
  dl.download = r.name;

  const rev = document.createElement('button');
  rev.type = 'button';
  rev.textContent = '在文件夹中显示';
  rev.onclick = () =>
    api('/api/recordings/reveal', { name: r.name }, `在文件夹里定位 ${r.name}`)
      .then((d) => log(d.detail, 'ok'))
      .catch((e) => log(e.message, 'err'));

  /// 重命名：录屏文件名本身带设备序列号和长串时间戳，录多了全长得一样，
  /// 给它一个说得出用途的名字（「办公室设备-演示」）比翻时间戳更好找
  const ren = document.createElement('button');
  ren.type = 'button';
  ren.textContent = '重命名';
  ren.onclick = async () => {
    const base = r.name.replace(/\.mp4$/i, '');
    const input = await askDialog({
      message: `给这段录像起个新名字（自动补 .mp4）：\n\n${r.name}`,
      defaultValue: base,
      input: true,
      okText: '重命名',
    });
    if (input === null) return;
    const to = input.trim();
    if (!to || to === base) return;
    ren.disabled = true;
    try {
      const d = await api('/api/recordings/rename', { name: r.name, to }, `重命名 ${r.name}`);
      const old = r.name;
      const renamed = (recRows || []).map((x) => (x.name === old ? { ...x, name: d.name || to } : x));
      recRows = renamed;
      if (recFresh === old) recFresh = d.name || to;
      /// 勾选集合是按文件名记的，改名后要跟着搬，否则「删除所选」会找不到这一条
      if (recSel.has(old)) {
        recSel.delete(old);
        recSel.add(d.name || to);
      }
      renderRecs();
      log(d.detail, 'ok');
    } catch (e) {
      log(e.message, 'err');
      ren.disabled = false;
    }
  };

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = '删除';
  del.onclick = async () => {
    /// 这条不可撤销：删掉的是本机那份 mp4，设备上不受影响，所以确认文案要说清删的是哪一份
    if (!(await askDialog({ message: `删掉服务端这份录像？\n\n${r.name}\n\n设备上不受影响。`, okText: '删除', danger: true }))) return;
    del.disabled = true;
    try {
      const d = await api('/api/recordings/del', { name: r.name }, `删除录像 ${r.name}`);
      recRows = (recRows || []).filter((x) => x.name !== r.name);
      recSel.delete(r.name);
      renderRecs();
      log(d.detail, 'ok');
    } catch (e) {
      log(e.message, 'err');
      del.disabled = false;
    }
  };

  acts.append(play, dl, rev, ren, del);
  row.append(head, acts);
  return row;
}

/// 勾选类控件的状态都在这儿统一翻：全选框的勾选/半选、删除所选的数量与显隐。
/// 卡片里的 onchange 和列表重画都会调它，避免同一套判断在两地各写一遍
function renderRecTools() {
  const rows = recRows || [];
  const all = $('#recall');
  const box = $('#recallbox');
  const delBtn = $('#btn-rec-del-sel');
  if (!all || !box || !delBtn) return;
  const picked = rows.filter((r) => recSel.has(r.name));
  all.hidden = rows.length === 0;
  box.checked = rows.length > 0 && picked.length === rows.length;
  /// 半选态：选了一部分但没有全选，全选框画成中间态，避免「没勾满却也不是空」
  box.indeterminate = picked.length > 0 && picked.length < rows.length;
  delBtn.hidden = picked.length === 0;
  delBtn.textContent = `删除所选（${picked.length}）`;
}

function renderRecs() {
  const rows = recRows || [];
  const box = $('#reclist');
  const total = rows.reduce((s, r) => s + (r.bytes || 0), 0);
  /// 列表重画时顺手把已经不存在的文件名从勾选集合里剔掉，
  /// 否则删完一批后「删除所选」的数字会算进已经没了的条目
  recSel = new Set([...recSel].filter((n) => rows.some((r) => r.name === n)));
  $('#recstate').textContent = rows.length ? `共 ${rows.length} 段` : '';
  /// 录像都堆在本机磁盘上，条数之外还要让「一共占了多少」一眼可见，
  /// 否则录到磁盘满才发现
  $('#recmem').textContent = rows.length ? `服务端共占 ${humanSize(total)}` : '';
  $('#btn-rec-clear').hidden = !rows.length;
  /// 空列表时 .list 只剩边框与左右内距，单行 caption 会被压成一条细线，
  /// 看起来像分隔线。挂个类给空态撑出正常高度
  box.classList.toggle('is-empty', rows.length === 0);
  box.replaceChildren(
    ...(rows.length
      ? rows.map(recCard)
      : [captionEl('还没有录像。')]),
  );
  renderRecTools();
}

$('#recallbox').onchange = () => {
  recSel = new Set($('#recallbox').checked ? (recRows || []).map((r) => r.name) : []);
  renderRecs();
};

/// 批量删除：一次请求带 names 数组，后端逐个删并回 failed 列表。
/// 这样「选了 5 条、有 1 条删不掉」时能精确地把删掉的那几条从列表里摘掉，而不是整批回滚
$('#btn-rec-del-sel').onclick = async () => {
  const rows = recRows || [];
  const picked = rows.filter((r) => recSel.has(r.name));
  if (!picked.length) return;
  const total = picked.reduce((s, r) => s + (r.bytes || 0), 0);
  if (
    !(await askDialog({
      message: `删除所选的 ${picked.length} 段录像（共 ${humanSize(total)}）？\n\n只删服务端保存的 mp4。`,
      okText: '删除',
      danger: true,
    }))
  )
    return;
  const btn = $('#btn-rec-del-sel');
  btn.disabled = true;
  try {
    const d = await api('/api/recordings/del', { names: picked.map((r) => r.name) }, `删除 ${picked.length} 段录像`);
    const failed = new Set(d.failed || []);
    const gone = new Set(picked.map((r) => r.name).filter((n) => !failed.has(n)));
    recRows = rows.filter((r) => !gone.has(r.name));
    gone.forEach((n) => recSel.delete(n));
    if (gone.has(recFresh)) recFresh = '';
    renderRecs();
    log(d.detail, d.ok ? 'ok' : 'warn');
  } catch (e) {
    log(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

$('#btn-rec-clear').onclick = async () => {
  const rows = recRows || [];
  if (!rows.length) return;
  const total = rows.reduce((s, r) => s + (r.bytes || 0), 0);
  /// 这条一次删掉一整批，确认文案里必须写清删的是「本机那几份」而不是设备上的内容
  if (
    !(await askDialog({
      message: `清空服务端全部 ${rows.length} 段录像（共 ${humanSize(total)}）？\n\n只删服务端保存的 mp4。`,
      okText: '清空',
      danger: true,
    }))
  )
    return;
  const btn = $('#btn-rec-clear');
  btn.disabled = true;
  try {
    const d = await api('/api/recordings/clear', {}, '清空服务端录像');
    recFresh = '';
    recSel = new Set();
    recRows = [];
    renderRecs();
    log(d.detail, d.ok ? 'ok' : 'warn');
  } catch (e) {
    log(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

/// ---- 录制进度 ----
/// 录制在服务端是后台任务：POST /api/record 立刻拿回 jobId，之后按 jobId 轮询阶段。
/// 页面不再挂一条几十秒的长请求，刷新页面或切走再回来都能把进度条接回来
let recTimer = null;

function stopRecTimer() {
  if (recTimer) {
    clearInterval(recTimer);
    recTimer = null;
  }
}

/// 把一条 job 画到进度条和「开始录制」按钮上。done/error 之后按钮要恢复可点，
/// 所以这里同时负责按钮的禁用与文案，别处只管调它
function paintRecJob(j) {
  recJob = j;
  const btn = $('#btn-rec');
  const wrap = $('#recprog');
  const running = !!j && (j.phase === 'record' || j.phase === 'pull');
  recBusy = running;
  if (!wrap || !btn) return;
  if (!j) {
    wrap.hidden = true;
    wrap.classList.remove('err');
    /// 离线时按钮保持禁用：进度收起来不代表设备能录
    btn.disabled = state?.online === false;
    btn.classList.remove('rec-on');
    btn.textContent = '开始录制';
    return;
  }
  wrap.hidden = false;
  wrap.classList.toggle('err', j.phase === 'error');
  $('#recbar').setAttribute('aria-valuenow', String(j.pct ?? 0));
  $('#recbarfill').style.width = `${j.pct ?? 0}%`;
  const labels = {
    record: `设备录制中 · 已 ${j.elapsed}s / 共 ${j.seconds}s`,
    pull: '录制完成 · 正在拉回服务端…',
    done: `已完成${j.name ? ` · ${j.name}` : ''}`,
    error: j.detail || '录制失败',
  };
  $('#recproglabel').textContent = labels[j.phase] || '';
  btn.disabled = running || state?.online === false;
  btn.classList.toggle('rec-on', running);
  if (running) btn.textContent = j.phase === 'record' ? `录制中 ${Math.max(0, j.seconds - j.elapsed)}s` : '正在拉回…';
  else btn.textContent = '开始录制';
}

/// 盯住一条任务直到收尾：每 700ms 问一次阶段与百分比
function watchRec(job) {
  if (!job || !job.id) return;
  stopRecTimer();
  paintRecJob({ pct: 0, elapsed: 0, ...job });
  const tick = async () => {
    try {
      const d = await api(`/api/record/status?job=${encodeURIComponent(job.id)}`);
      if (d.gone) throw new Error('录制任务已经结束了');
      paintRecJob(d.job);
      if (d.job.phase === 'done' || d.job.phase === 'error') {
        stopRecTimer();
        if (d.job.phase === 'done') {
          recFresh = d.job.name || '';
          log(d.job.detail || '录像已存到服务端', 'ok');
        } else {
          log(d.job.detail || '录制失败', 'err');
        }
        await loadRecs();
      }
    } catch (e) {
      /// 轮询本身失败（断网、服务重启）不能把界面永远卡在「录制中」
      stopRecTimer();
      paintRecJob(null);
      log(e.message, 'err');
      await loadRecs().catch(() => {});
    }
  };
  recTimer = setInterval(tick, 700);
  void tick();
}

/// 进设备页时接一下进度：当前设备上还有任务在跑就继续显示，没有就把残留的进度收起来
async function resumeRec() {
  if (recBusy) return;
  try {
    const d = await api('/api/record/status');
    if (d.active) watchRec(d.active);
    else paintRecJob(null);
  } catch {
    /* 离线时问不到就保持现状，等下一次进页面再说 */
  }
}

async function startRecord() {
  if (recBusy) return;
  const seconds = Number($('#reclen').value) || 10;
  const height = Number($('#recqual').value) || 0;
  const btn = $('#btn-rec');
  recBusy = true;
  btn.disabled = true;
  btn.classList.add('rec-on');
  btn.textContent = '正在下发…';
  try {
    const r = await api('/api/record', { seconds, height }, `录屏 ${seconds} 秒`);
    if (r.ok === false) {
      /// 设备上已经有一条任务在跑：把那条的进度接过来显示，别再开第二条
      recBusy = false;
      if (r.job) watchRec(r.job);
      else paintRecJob(null);
      log(r.detail, 'warn');
      return;
    }
    log(r.detail, 'ok');
    watchRec(r.job);
  } catch (e) {
    log(e.message, 'err');
    recBusy = false;
    paintRecJob(null);
  }
}

$('#btn-rec').onclick = () => startRecord();

/// 存设备画面：直接拿 /device.jpg 这一帧存成本机文件。
/// 走 blob 而不是让服务器落盘，是因为截图多半是立刻要用的（贴到聊天里），
/// 不需要再回头去目录里找
$('#btn-snap').onclick = async () => {
  const btn = $('#btn-snap');
  btn.disabled = true;
  try {
    const res = await fetch(srv('/device.jpg'), { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const blob = await res.blob();
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tvdeck-shot-${stamp}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    recordOp({ t: Date.now(), text: '存设备画面', detail: `抓了一帧屏幕（${humanSize(blob.size)}）`, cmd: '/device.jpg', kind: 'ok' });
    log(`已存下设备画面（${humanSize(blob.size)}）`, 'ok');
  } catch (e) {
    log(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

// ---------------------------------------------------------------- 设备日志（logcat）
// 读的是设备上的 logcat 环形缓冲，和服务端主机的系统日志无关：设备给 shell 留了读日志权限就能读，
// 被厂商收走的就写「读不到」。这批缓存跟着当前设备走，换设备后由 resetDeviceCaches 清掉重读。

let logRows = null;
let logStampAt = null;
/// 过滤框命中的关键字：只影响这一屏怎么画，不重新去设备上读。
/// 设备上的日志一屏也就几百行，客户端筛比再下一趟 adb 快得多，也不会把缓冲区刷掉
let logQuery = '';
/// 第几次读取。行数/等级/只看应用三个开关都会各自触发一次读取，
/// 手快连着切两下时两次请求会重叠，先发的后到就会把新结果盖回旧的 —— 只认最后一次
let logSeq = 0;
/// 「只看崩溃」和关键字一样，是本机侧的过滤：已经读回来的那批行里挑了再画，
/// 不再回设备。所以它跟关键字能叠加（先按崩溃挑、再在挑出来的里面搜关键字）
let logCrashOnly = false;
/// 「只看某一级」的精确等级过滤（等级条上点出来的）。空串＝没开。
/// 它和上面那个「等级」下拉不是一回事：下拉是让**设备**只吐某一档以上的日志（要重读一次），
/// 这里是在**已经读回来的这批**里精确挑一级，点一下立刻见效，不回头敲设备。
/// 也因此它能在「E 及以上」里再切出「只看 E」，把 F 摘掉 —— 这是下拉一个人做不到的
let logOnlyLevel = '';
/// 收藏（星标）：把「现在没空细看、等下还要回头找」的行钉住。
/// 一屏几百行，翻出一条关键 W 之后重新读一批就再也找不回来了 —— 星标记的是「哪一行」，
/// 不是「第几行」（见 logKey），所以同一批日志重新读一次，星还长在原来那行上。
/// 存在 localStorage 里，按设备序列号分开存：换设备不会串标，刷新页面也还在
const LOG_MARKS_KEY = 'tvdeck.logmarks';
let logMarksAll = (() => {
  try {
    const o = JSON.parse(localStorage.getItem(LOG_MARKS_KEY) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    /* 存坏了就当没有收藏，别让一条坏数据把整个日志面板卡死 */
    return {};
  }
})();
/// 当前设备的收藏集合（从 logMarksAll 里派生）。序列号一变就重新派生，见 logMarksFor ——
/// 不在 resetDeviceCaches 里重新派生，是因为那里被调用时 state 还是上一台设备的
let logMarks = new Set();
let logMarksSerial = null;
/// 「只看收藏」和「只看崩溃」同一层：都是在已经读回来的这批行里挑，不回设备
let logMarkOnly = false;
/// 「只看新增」：勾上的一刻拿当前这批当基准，之后每次重读只显示基准里没有的行。
/// 排查设备问题时最想知道的往往不是"现在有什么"，而是"我刚复现了一下，多出来哪几行"，
/// 不 diff 就只能把前后两批几百行来回扫，人眼找不同既慢又漏。
/// 基准是**冻结**的，不跟着每次重读往后移：否则一开自动刷新，每 3 秒基准就换成刚读回来的这批，
/// 「新增」永远是 0，这个开关等于没用。冻结之后它就是个盯梢开关 ——
/// 勾上 → 去设备上复现 → 新冒出来的行自己出现在列表里
let logNewOnly = false;
let logBaseKeys = null;
/// 渐进式渲染：几百行一次性铺进 DOM，手机上整页会被拉到几万像素高，
/// 滚动条细得几乎抓不住，滚到底要滑很久。先画 LOG_PAGE 行，底部一个
/// 「再显示 200 行」按钮，按需追加。过滤条件一改就回到第一页。
const LOG_PAGE = 200;
let logShown = LOG_PAGE;
/// 自动刷新的定时器句柄。null = 没在跑。它和下面的 logBusy 一起保证同一时刻只有一次 adb 往返：
/// 设备读一次要 1~3 秒，定时器要是照着 3 秒硬发，慢设备上会叠成一堆互相盖写的请求
let logFollowTimer = null;
let logBusy = false;

/// 等级 → 视觉档：E/F 走错误色、W 走警告色，其余保持中性。
/// 不整行染色，只染左边那条竖条和等级字母，正文的对比度才不被压掉
const LOG_HEAT = { E: 'err', F: 'err', W: 'warn' };

/// 等级条上的排列顺序：按 logcat 自己的严重度从轻到重（V 最轻，S 是 silent）。
/// 不按字母排 —— 按严重度排，眼睛从左往右扫过去正好是「越来越严重」，
/// 最右边那一段就是最该看的那一段。表里没有的等级追加在最后，不丢行（见 renderLogDist）
const LOG_ORDER = ['V', 'D', 'I', 'W', 'E', 'F', 'S'];

/// 崩溃行的判定。只认「表头」，不认 Java 包名 —— 堆栈里的 `java.lang.` `at com.xxx`
/// 在正常日志里也常出现（比如某个库偷偷 catch 之后打了条 warning），拿包名当条件会满屏误报。
/// 再加一条 level === 'F'：F 是 logcat 自己的致命级，见到就是致命，不用猜文字
const LOG_CRASH_RE =
  /FATAL EXCEPTION|ANR in |beginning of crash|Fatal signal|native crash|Native crash|tombstone|SIGSEGV|SIGABRT|SIGBUS|SIGILL|am_crash|am_anr|backtrace:/i;
const isCrashRow = (x) => x.level === 'F' || LOG_CRASH_RE.test(x.msg || '');

/// 一条日志的稳定身份。logcat 的 threadtime 前缀（时间 + pid/tid + 等级 + 标签）在同一台设备上
/// 不会变，所以同一行重新读回来算出来的键还是同一个，星标自然就还长在同一行上。
/// 正文只取前 160 字：键要短到能在 localStorage 里存几百条，而 160 字已经远超
/// 「两行不同日志的前 160 字一模一样」的概率
function logKey(x) {
  return [x.time, x.pid, x.tid, x.level, x.tag, String(x.msg || '').slice(0, 160)].join('|');
}

/// 当前设备的收藏集合。读的是 state 里现在的序列号，而不是传进来的参数 ——
/// 换设备时 renderState 是先调 resetDeviceCaches() 再赋值 state 的，
/// 所以任何"在缓存失效时顺手取序列号"的写法都会取到上一台设备
function logMarksFor() {
  const serial = state?.profile?.serial || '';
  if (serial !== logMarksSerial) {
    logMarksSerial = serial;
    logMarks = new Set(serial ? logMarksAll[serial] || [] : []);
  }
  return logMarks;
}

/// 落盘。没有序列号就不写：不知道该把这次收藏记在哪台设备头上，
/// 硬写进空串那个键里，下次连上真设备反而一条都取不出来
function saveLogMarks() {
  const serial = logMarksSerial || '';
  if (!serial) return;
  if (logMarks.size) logMarksAll[serial] = [...logMarks];
  else delete logMarksAll[serial];
  try {
    localStorage.setItem(LOG_MARKS_KEY, JSON.stringify(logMarksAll));
  } catch {
    /* 隐私模式存不住：本次会话里的星还是亮的，刷新才没，不为此打断操作 */
  }
}

/// threadtime 的日期段（06-14）在这一屏里没有信息量，只留 HH:MM:SS.mmm。
/// 设备时区多半和本机不同，所以时间只做截断、不做换算，免得凭空多出 8 小时差
const logTime = (t) => (t || '').split(' ').pop() || t;

/// 读一批日志。silent 是给自动刷新用的：不动按钮文字、不铺「读取中」占位，出错也不弹提示。
/// 每 3 秒把列表清空重画一次看起来就是在闪，而且那时候屏幕上已经有内容了，
/// 结论（读到几行、降级到哪种写法、读不到的原因）本来就写在计数栏和列表里，不需要再弹一次
async function loadLog({ silent = false } = {}) {
  const btn = $('#btn-log');
  const box = $('#loglist');
  if (!box) return;
  if (!state?.online) {
    box.replaceChildren(emptyOff({ title: '日志需要先连接设备', note: '连上后可读取设备内存中的系统与应用日志。' }));
    const btnLog = $('#btn-log');
    if (btnLog) {
      btnLog.disabled = false;
      btnLog.textContent = '读取日志';
    }
    return;
  }
  /// 只有自动刷新会被"上一次还没回来"挡住；手动点「读取日志」永远立即生效，
  /// 靠下面的 logSeq 把过期的那次结果丢掉就够了，不该让按钮点了没反应
  if (silent && logBusy) return;
  logBusy = true;
  const seq = ++logSeq;
  if (btn && !silent) {
    btn.disabled = true;
    btn.textContent = '读取中…';
  }
  if (!silent)
    box.replaceChildren(captionEl('正在读设备上的日志缓冲…'));
  const lines = Number($('#loglines')?.value) || 400;
  const level = $('#loglevel')?.value || '';
  const onlyApp = !!$('#logapp')?.checked;
  try {
    const q = new URLSearchParams({ lines: String(lines), level });
    /// scope=app 不带 pkg：让服务端去问设备当前前台是谁，再按那个进程筛。
    /// 这样用户不用自己填包名，也不会拿上一次的前台应用去筛
    if (onlyApp) q.set('scope', 'app');
    const data = await api(`/api/log?${q}`);
    if (seq !== logSeq) return;
    logRows = data;
    logStampAt = Date.now();
    /// 新的一批从第一页开始看
    if (!silent) logShown = LOG_PAGE;
    renderLog();
    /// 自动刷新撞上"读不到"的设备（权限被收走、缓冲区空）时立刻停表：
    /// 继续按 3 秒去敲一台读不出东西的设备，既没有产出，也让设备一直在被连接
    if (silent && data && data.ok === false) stopLogFollow('当前设备现在读不到日志，自动刷新已停下');
  } catch (e) {
    if (seq !== logSeq) return;
    logRows = null;
    box.replaceChildren(captionEl(e.message));
    $('#logsum').textContent = '';
    /// 这一批没读回来，上一批的崩溃数/收藏数就不能继续挂在角标上：
    /// 数字还亮着，但列表里是"读不到"的说明，看起来就像这两个数字是刚读出来的
    syncLogCounts();
    for (const id of ['#btn-log-copy', '#btn-log-export', '#btn-log-report']) {
      const b = $(id);
      if (b) b.disabled = true;
    }
    /// 这条路径没走 renderLog，所以要自己把等级条收掉：
    /// 留着上一批的构成，看起来就像"这次也读到了这些"，比空着更误导人
    renderLogDist([]);
    if (silent) stopLogFollow(`自动刷新出错：${e.message}`);
  } finally {
    logBusy = false;
    /// 只有最后一次读取才配恢复按钮：先发的那次回来得晚，不该把「读取中…」抹掉
    if (btn && !silent && seq === logSeq) {
      btn.disabled = false;
      btn.textContent = '读取日志';
    }
  }
}

/// 有没有粗指针：有（或压根没有 hover）就按触屏处理。
/// 行内的标签 / pid 只有 14px 高，撑不到 44px 的触控目标 —— 硬撑高会把点击区压到
/// 下一行的正文上，点正文就变成筛选，比不能点更糟。所以触屏上这两个退化成纯文字，
/// 真正的动作收进「选中这一行之后出现的操作条」（见 selectLogRow），那里的按钮都是 44px。
/// 鼠标端一个字都没有改：标签 / pid 仍是能点的按钮
const COARSE_PTR = matchMedia('(any-pointer: coarse)').matches || matchMedia('(hover: none)').matches;

/// 行里的标签 / pid。触屏上是 <span>（没有 onclick，也就不该拦冒泡），
/// 鼠标上是真按钮：键盘与读屏也能用上「点一下只看这个标签」这个动作
function logChip(cls, text, aria, title) {
  const b = document.createElement(COARSE_PTR ? 'span' : 'button');
  b.className = cls;
  if (!COARSE_PTR) {
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', aria);
  }
  highlightInto(b, text, logTokens());
  return b;
}

/// 一条日志：第一行是「等级 时间 标签 #pid」，第二行起才是正文。
/// 正文在 CSS 里默认只露 3 行，点了才展开 —— 异常堆栈动辄几十行，整段铺开会把列表刷没。
/// 能不能展开不在这里判断：消息是不是真的被截掉，只有进了 DOM 量出来才知道
/// （同样长度的消息在窄屏上会多折一两行），那步在 renderLog 里统一做
function logRow(x) {
  const row = document.createElement('div');
  row.className = `logrow${LOG_HEAT[x.level] ? ` is-${LOG_HEAT[x.level]}` : ''}`;
  /// 这一行是哪条日志记在行上：重画之后要按它把选中态还原回来（见 restoreLogSel）
  row.__log = x;

  const head = document.createElement('div');
  head.className = 'loghead';
  const lv = document.createElement('b');
  lv.className = 'loglv';
  lv.textContent = x.level || '?';
  const tm = document.createElement('em');
  tm.className = 'logtime';
  tm.textContent = logTime(x.time);
  /// 标签是个真按钮：点一下就把筛选框换成这个标签。排查时最常见的一条路是
  /// 「先看到某个进程在刷屏，然后只想看它」—— 手动把长包名敲进筛选框既慢又容易敲错。
  /// 用 button 而不是给 span 挂 onclick，是为了键盘和读屏也能用上这个动作
  const tag = logChip('logtag', x.tag || '—', `只看标签 ${x.tag || '无'} 的日志`, '点一下，只用这个标签筛');
  /// pid 和标签同一套机制：点一下就把筛选框换成 #4102。
  /// 崩溃堆栈里「PID: 3301」和每行行尾的 #3301 是同一个进程，能点就能一键把整段现场圈出来，
  /// 比让人肉眼扫几百行找同一个数字靠谱。行里显示的就是 #4102，所以筛的也是 #4102 ——
  /// 看见什么就敲什么，不用回头记「这里要少打一个井号」
  const pid = logChip('logpid', `#${x.pid}`, `只看 pid ${x.pid} 的日志`, '点一下，只用这个 pid 筛');
  /// 收藏星标：和标签/pid 一样是行内的真按钮（键盘和读屏都能用），但它是绝对定位在
  /// 右侧留白里的（见 CSS），不占 head 的排版空间，标签该多宽还是多宽
  const key = logKey(x);
  const marked = logMarksFor().has(key);
  if (marked) row.classList.add('is-mark');
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = 'logmark';
  mark.tabIndex = -1;
  mark.setAttribute('aria-pressed', marked ? 'true' : 'false');
  mark.title = marked ? '取消收藏这一行' : '收藏这一行，等下还要回来看';
  mark.setAttribute('aria-label', mark.title);
  head.append(lv, tm, tag, pid, mark);
  /// 触屏上这两个是 <span>（见 logChip），没有 onclick，也就不该拦冒泡：
  /// 点它们等于点了这一行，该开合堆栈就开合堆栈
  if (tag.tagName === 'BUTTON') tag.onclick = (e) => {
    /// 标签所在的这一行自己有「点开堆栈」的动作，不拦住冒泡就会点一下筛一次、顺手把行也开合一次
    e.stopPropagation();
    applyLogQuery(x.tag || '');
  };
  /// 触屏上 pid 是 <span>（见 logChip），没有 onclick 可挂
  if (pid.tagName === 'BUTTON') pid.onclick = (e) => {
    /// 同上：行内控件的点击不该冒到行上去，否则筛一次顺带把这条堆栈也开合一次
    e.stopPropagation();
    applyLogQuery(`#${x.pid}`);
  };
  mark.onclick = (e) => {
    /// 同上：这里只该收藏，不该顺带把这行的堆栈也展开
    e.stopPropagation();
    toggleLogMark(key, row, mark);
  };

  const msg = document.createElement('div');
  msg.className = 'logmsg';
  highlightInto(msg, (x.msg || '').replace(/\s+$/, ''), logTokens());
  row.append(head, msg);
  return row;
}

/// 筛选框里这一刻要同时命中的词。空格分隔就是「都要有」（AND）：
/// 单关键字是它的特例，所以老用法一个字都不变；写两个词能把
/// 「某个进程 + 某种报错」精确挑出来，省掉搜一遍再肉眼翻一遍的功夫
function logTokens() {
  return logQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/// 把命中的词在行内标出来。拼的是 DOM 节点，不走 innerHTML ——
/// 日志正文里什么字符都可能有（`<`、`&`、引号），把设备给的内容拼成 HTML 再塞进去
/// 等于让设备上的日志决定这个页面怎么渲染。
/// 先收全部命中区间再切分，是为了让互相重叠的词（`an` 和 `anr`）不重复标、也不漏标
function highlightInto(el, text, tokens) {
  const src = String(text ?? '');
  if (!tokens.length || !src) {
    el.textContent = src;
    return;
  }
  const lower = src.toLowerCase();
  const spans = [];
  for (const t of tokens) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(t, from);
      if (at < 0) break;
      spans.push([at, at + t.length]);
      from = at + t.length;
    }
  }
  if (!spans.length) {
    el.textContent = src;
    return;
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  const parts = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) parts.push(document.createTextNode(src.slice(at, s)));
    const hit = document.createElement('mark');
    hit.className = 'loghit';
    hit.textContent = src.slice(s, e);
    parts.push(hit);
    at = e;
  }
  if (at < src.length) parts.push(document.createTextNode(src.slice(at)));
  el.replaceChildren(...parts);
}

/// 改筛选条件的唯一入口：点标签、敲键盘、换设备清空都走这里。
/// 内存里的 logQuery 和输入框必须同一次改完，否则重画和输入框里显示的条件会对不上
function applyLogQuery(text) {
  logQuery = text;
  const box = $('#logq');
  if (box) box.value = text;
  logShown = LOG_PAGE;
  if (logRows) renderLog();
}

/// 收藏 / 取消收藏一行。只改这一行的样子和本地存储：不回设备、不重读日志
function toggleLogMark(key, row, btn) {
  const marks = logMarksFor();
  const on = !marks.has(key);
  if (on) marks.add(key);
  else marks.delete(key);
  saveLogMarks();
  row.classList.toggle('is-mark', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? '取消收藏这一行' : '收藏这一行，等下还要回来看';
  btn.setAttribute('aria-label', btn.title);
  buzz(8);
  /// 开着「只看收藏」时取消收藏，这一行就该当场从列表里消失；而重画会把整行的按钮
  /// 都换成新的，所以那种情况必须整段重画，只改这一个按钮的样子是不够的
  if (logMarkOnly) renderLog();
  /// 其余情况不重画整张列表（重画会把用户的滚动位置和展开态冲掉），但计数栏要跟着走：
  /// 只更新右边那两个角标、不动这一行的话，用户刚点完星会看到「收藏」这两个字没冒出来，
  /// 以为没点上，回头又点一次
  else renderLogSum();
}

/// 选中的那一行用日志自身的键记着（row.__log 经 logKey 算出来的那个）：
/// 列表一重画，行都是全新的节点，记下标的话筛选一变就指到别的行上去了
let logSelKey = '';

/// 一行日志的文本，格式跟整批复制一致：同样的位宽右对齐，
/// 单独复制一行粘到 issue 里，跟整段导出里的那一行长得一模一样
function logLineText(x) {
  return (
    `${x.time || ''}  ${String(x.pid ?? '').padStart(5)} ${String(x.tid ?? '').padStart(5)} ` +
    `${x.level || '?'} ${x.tag || ''}: ${x.msg || ''}`
  );
}

/// 复制一行。退路同 copyLog：这个页面常挂在 http://192.168.x.x:8787 上，
/// 那不是安全上下文，navigator.clipboard 直接是 undefined
async function copyLogLine(x) {
  const text = logLineText(x);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no-clipboard');
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    if (!ok) {
      log('这个环境不允许直接写剪贴板，可以改用「导出 .txt」把文件存下来', 'warn');
      return;
    }
  }
  log('这一行已复制');
}

/// 选中行的操作条。只有这一个地方生成它：点行、键盘选行都会走到这里。
/// 按环境出按钮 —— 标签 / pid 的筛选在鼠标端行内就能点，这里就不再重复一遍
function buildLogActs(row) {
  const x = row.__log;
  if (!x) return;
  let acts = row.querySelector('.logacts');
  if (!acts) {
    acts = document.createElement('div');
    acts.className = 'logacts';
    /// 条子自己吃掉点击：行本身有「点一下开合堆栈」的动作，
    /// 点在条子的空白处不该顺手把这行合上
    acts.onclick = (e) => e.stopPropagation();
    row.querySelector('.loghead')?.after(acts);
  }
  const key = logKey(x);
  const marked = logMarksFor().has(key);
  const chips = [];
  const chip = (label, aria, act) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.onclick = (e) => {
      e.stopPropagation();
      return act(b);
    };
    chips.push(b);
  };
  chip('复制这行', '把这一行日志复制到剪贴板', () => void copyLogLine(x));
  chip(marked ? '取消收藏' : '收藏', marked ? '取消收藏这一行' : '收藏这一行', (b) => toggleLogMark(key, row, b));
  if (COARSE_PTR) {
    if (x.tag) chip(`只看 ${x.tag}`, `只看标签 ${x.tag} 的日志`, () => applyLogQuery(x.tag));
    chip(`只看 #${x.pid}`, `只看 pid ${x.pid} 的日志`, () => applyLogQuery(`#${x.pid}`));
  }
  acts.replaceChildren(...chips);
}

/// 选中一行：选中样式、操作条、焦点三件事同时落到这一行上 ——
/// 「现在选的是哪一行」和「焦点在哪」是同一件事，键盘用户不用去别处找自己选到哪了
function selectLogRow(row, opts = {}) {
  const box = $('#loglist');
  if (!box) return;
  logSelKey = row?.__log ? logKey(row.__log) : '';
  for (const r of box.querySelectorAll('.logrow.sel')) {
    if (r === row) continue;
    r.classList.remove('sel');
    r.querySelector('.logacts')?.remove();
  }
  if (!row) return;
  row.classList.add('sel');
  buildLogActs(row);
  /// 键盘换行时只挪到"刚好看得见"：整屏跳一下会把用户正在看的那一段顶走
  if (opts.reveal) row.scrollIntoView({ block: 'nearest' });
  /// 点行之后焦点要落到列表上，否则键盘的上下键还得再点一次才生效
  if (opts.focus) box.focus({ preventScroll: true });
}

/// 重画之后把选中还原回来。那一行被筛掉了就什么都不做 ——
/// 让一条已经不在屏幕上的行继续占着选中态，下次打开日志会莫名其妙多出一条操作条
function restoreLogSel() {
  const box = $('#loglist');
  if (!box || !logSelKey) return;
  const row = [...box.querySelectorAll('.logrow')].find((r) => r.__log && logKey(r.__log) === logSelKey);
  if (!row) return;
  row.classList.add('sel');
  buildLogActs(row);
}

/// 列表级的点击与键盘。一屏几百行日志，行内控件（标签 / pid / 星标 / 三角）加起来
/// 有上千个 Tab 站，按一次 Tab 就走不出这个列表，所以整张列表只占一个 Tab 站：
/// 上下键在行间走、回车开合整条、c 复制、m 收藏、Esc 取消选中。
/// 这里用 on* 属性而不是 addEventListener：renderLog 每次都会调它，重复挂监听会越积越多
function bindLogList() {
  const box = $('#loglist');
  if (!box) return;
  box.tabIndex = 0;
  box.setAttribute('aria-label', '设备日志列表：上下键选行，回车展开整条');
  const rows = () => [...box.querySelectorAll('.logrow')];
  box.onclick = (e) => {
    /// 操作条上的按钮自己处理完了，不该再被当成「又选了一行」
    if (e.target.closest('.logacts')) return;
    const row = e.target.closest('.logrow');
    /// 点行＝选中。开合堆栈那件事仍由 makeExpandable 挂在行上，这里不插手
    if (row) selectLogRow(row, { focus: true });
  };
  box.onkeydown = (e) => {
    const list = rows();
    if (!list.length) return;
    const i = list.findIndex((r) => r.classList.contains('sel'));
    const cur = i < 0 ? null : list[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const from = i < 0 ? (step > 0 ? -1 : 0) : i;
      const next = list[Math.min(list.length - 1, Math.max(0, from + step))];
      selectLogRow(next, { reveal: true });
      return;
    }
    if (!cur) return;
    /// 回车 / 空格开合整条。走那个真按钮：展开态与箭头方向由它自己维护
    if (e.key === 'Enter' || e.key === ' ') {
      const t = cur.querySelector('.logtoggle');
      if (!t) return;
      e.preventDefault();
      t.click();
      return;
    }
    if (e.key === 'c') void copyLogLine(cur.__log);
    else if (e.key === 'm') cur.querySelector('.logmark')?.click();
    else if (e.key === 'Escape') selectLogRow(null);
  };
}

/// 两个角标（崩溃数、收藏数）在任何一条重画路径上都要对上。
/// 单独抽出来是因为勾选框（只看崩溃 / 只看收藏）变了不一定重画整张列表，
/// 那时候角标得自己跟上，不然勾了「只看收藏」角标还停在上一批的数字上
function syncLogCounts() {
  const all = Array.isArray(logRows?.rows) ? logRows.rows : [];
  const crashN = all.filter(isCrashRow).length;
  /// 收藏角标给的是**当前设备一共收藏了几行**，不是"这一批里恰好出现几行"：
  /// 星标是跨批次存在的，只报当前窗口里的数量，用户会以为自己收藏全丢了
  /// 读不到的时候（logRows 是空的、或者服务端明确回了 ok:false）不能继续挂上一批的数字：
  /// 数字还亮着、列表里却是"读不到"的说明，看起来就像这个数字是刚数出来的
  const markN = logRows && logRows.ok !== false ? logMarksFor().size : 0;
  /// 「新增」角标：这一批里比基准新出来的行数。基准是勾「只看新增」那一刻冻结的，
  /// 所以只有勾着它的时候才有数字可报 —— 不勾就压根没有可比的一批
  const base = logNewOnly ? logBaseKeys : null;
  const newN = base && Array.isArray(logRows?.rows)
    ? logRows.rows.filter((x) => !base.has(logKey(x))).length
    : 0;
  const cb = $('#logcrashn');
  if (cb) {
    cb.textContent = String(crashN);
    cb.hidden = !crashN;
  }
  const mb = $('#logmarkn');
  if (mb) {
    mb.textContent = String(markN);
    mb.hidden = !markN;
    mb.title = `当前设备上收藏了 ${markN} 行`;
  }
  const nb = $('#lognewn');
  if (nb) {
    nb.textContent = String(newN);
    nb.hidden = !newN;
    nb.title = `比勾选那一刻多出 ${newN} 行`;
  }
  /// 一批日志都还没读回来时，「只看新增」点不动 —— 没有基准，勾了也只能得出一张空列表，
  /// 那看起来就像工具坏了。先读一次，它自己就可用了
  const nt = $('#lognew');
  if (nt) nt.disabled = !logRows;
  return { crashN, markN, newN };
}

/// 给一条日志挂上「可展开」：鼠标点行上任何地方都能开合，键盘走行尾那个真按钮。
/// 只在真的被截掉时才挂 —— 短消息点开没有任何变化，挂了反而让人以为漏看了什么。
/// 这里不再给整行挂 role=button：行里已经有「标签」这个可交互元素了，
/// role=button 里嵌一个按钮，读屏会把它当成按钮里的按钮，反而说混乱
function makeExpandable(row) {
  row.classList.add('expandable');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'logtoggle';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', '展开这条日志的完整内容');
  row.querySelector('.loghead')?.append(btn);
  const toggle = () => {
    const open = row.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? '收起这条日志' : '展开这条日志的完整内容');
  };
  btn.onclick = (e) => {
    /// 这个按钮自己的点击已经处理过了，不能再冒到行上去让它再开合一次
    e.stopPropagation();
    toggle();
  };
  row.onclick = (e) => {
    /// 行内的按钮（标签、展开三角）各有各的动作，点它们不该顺手把这行也开合一次
    if (e.target.closest('button')) return;
    toggle();
  };
}

/// 这一屏实际画出来的行 =「只看崩溃」先过一遍，再按关键字搜。
/// 两个过滤都是本机侧做的，放在同一处算，是为了让复制/导出拿到的和屏幕上看到的是同一批 ——
/// 否则用户筛完复制出去，粘贴出来却是全量，很容易把看日志的人带偏
function visibleLogRows() {
  const all = Array.isArray(logRows?.rows) ? logRows.rows : [];
  const tokens = logTokens();
  return all.filter((x) => {
    if (logCrashOnly && !isCrashRow(x)) return false;
    /// 精确等级过滤（等级条点出来的）。放在关键字前面算，是因为它最便宜，
    /// 而且它和「只看崩溃」一样是本机侧的条件，和关键字是干净的三重叠加
    if (logOnlyLevel && (x.level || '?') !== logOnlyLevel) return false;
    /// 收藏过滤。和上面两个一样是本机侧的，所以这三条能任意叠加
    if (logMarkOnly && !logMarksFor().has(logKey(x))) return false;
    /// 「只看新增」：基准里已经有的行都算"老的"。没有基准就没法比，这时候不过滤
    /// （勾选框在没有基准时是禁用的，见 syncLogCounts）
    if (logNewOnly && logBaseKeys && logBaseKeys.has(logKey(x))) return false;
    if (!tokens.length) return true;
    /// 过滤键带上 tag/pid：出问题时用户记的多半是「哪个进程/哪个标签在刷」。
    /// pid 两种写法都要认：行里显示的是 #4102，所以 #4102 得命中；
    /// 手打个 4102 也能命中，靠的是「#4102」本身就含「4102」这段子串
    const pid = x.pid ?? '';
    const hay = `${x.tag} ${pid === '' ? '' : `#${pid}`} ${x.msg}`.toLowerCase();
    /// 多个词是「都要命中」而不是「命中任意一个」：日志动辄几百行，
    /// 按任意命中筛出来还是几百行，等于没筛；要的就是把范围压到能一眼看完
    if (!tokens.every((t) => hay.includes(t))) return false;
    return true;
  });
}

/// 列表为什么是空的，三种原因分开写：「本机筛没了」要放宽条件、「设备读不到」要修权限、
/// 「读到了但是空的」只需要再读一次。笼统一句"暂无数据"会让人以为工具坏了，
/// 而这三件事该做的动作完全不同
function emptyLogText(d, total) {
  /// 「设备压根没读到」必须排在最前面判定：这时候根本不存在"这一批日志"，
  /// 再说"没有崩溃记录""没有匹配的行"就是把读失败说成了筛没了，会让人往错的方向查
  if (d.ok === false) return d.detail || '设备没有给出日志：当前设备可能收走了 shell 的读日志权限。';
  const q = logTokens().join(' + ');
  /// 现在同时生效的条件最多三个（只看某一级 × 只看崩溃 × 关键字），而且是叠加关系。
  /// 只有一个条件时按那个条件单独说（话说得准）；两个以上就必须把**所有**生效的条件
  /// 一次摆出来 —— 只提其中一个，用户把那个去掉发现还是空的，就以为工具坏了
  const cond = [];
  if (logOnlyLevel) cond.push(`只看 ${logOnlyLevel} 级`);
  if (logCrashOnly) cond.push('只看崩溃');
  if (logMarkOnly) cond.push('只看收藏');
  if (logNewOnly) cond.push('只看新增');
  if (q) cond.push(`关键字「${q}」`);
  if (cond.length > 1) {
    const how = [];
    if (logOnlyLevel) how.push('点等级条上被选中的那一段可以取消等级限制');
    if (logCrashOnly) how.push('取消「只看崩溃」');
    if (logMarkOnly) how.push('取消「只看收藏」');
    if (logNewOnly) how.push('取消「只看新增」');
    if (q) how.push('删掉一两个关键字');
    return `这批日志里没有同时满足「${cond.join(' + ')}」的行。${how.join('，或')}，放宽哪一个都会重新出结果。`;
  }
  if (logOnlyLevel)
    return `这批日志里没有 ${logOnlyLevel} 级的行。点等级条上被选中的那一段就取消这个限制；` +
      '也可能是「等级」先滤掉了一层，换低一档再读。';
  if (logCrashOnly)
    return '这批日志里没有崩溃记录。想让崩溃跑出来就去设备上复现一次。';
  if (logMarkOnly) {
    /// 收藏是跟着设备存的，所以「一行都没收藏过」和「收藏的那几行不在这批里」必须分开说：
    /// 前者是还没标过，后者是标了、但设备那边已经把这几行滚出缓冲区了，该做的动作完全不同
    const n = logMarksFor().size;
    if (!n)
      return '还没有收藏。点行右侧 ☆ 收藏，刷新后也还在。';
    if (Array.isArray(d.rows) && d.rows.length)
      return `收藏的 ${n} 行已被滚动缓冲挤掉：把「行数」调大再读一次。`;
    return '这批是空的，点「读取日志」重新读一批。';
  }
  if (logNewOnly) {
    /// 这里的"空"是好事：说明设备什么都没新打出来。要点明基准是什么时候定的，
    /// 否则用户会以为开关没生效 —— 他勾上之后再点「读取日志」，读回来的还是同一批
    return '这批还没有新行。去设备上复现一次再点「读取日志」，新行会自己出现。';
  }
  if (q) {
    /// 多个词是「都要命中」，所以空结果要写清楚是"这几个词没能同时出现在同一行"，
    /// 否则用户会以为只要有一个词对上就该出结果，回头怀疑工具把行丢了
    return `没有同时包含「${q}」的行。删掉一两个词再读一批。`;
  }
  return '这批是空的。刚开机或刚清空缓冲时会这样，再读一次。';
}

/// 计数栏那一行的文案。单独抽出来，是因为「收藏 / 取消收藏」也要能就地刷新它（见 toggleLogMark）：
/// 那一步不重画整张列表，但这一行必须跟着走，不然刚点完星看不到「收藏」两个字冒出来
/// 日志也补一个「这批是几秒前抓的」：和进程、文件页一个口径，
/// 只走秒计数栏，不自动重读 —— 自动刷日志会打断正在看的上下文
function logCountText() {
  const ago = logStampAt ? Math.max(0, Math.round((Date.now() - logStampAt) / 1000)) : null;
  return ago !== null ? `${ago} 秒前抓取` : null;
}

function logSumText() {
  const d = logRows || {};
  const all = Array.isArray(d.rows) ? d.rows : [];
  const { crashN, markN } = syncLogCounts();
  const markedN = all.filter((x) => logMarksFor().has(logKey(x))).length;
  /// 计数栏直接用服务端写好的 detail：里面已经含「读到 N 行 · 等级 · pid · 降级说明」，
  /// 页面再自己拼一遍数字就会和降级说明里的口径打架
  const parts = [];
  const agoText = logCountText();
  if (agoText) parts.push(agoText);
  parts.push(d.detail || `${all.length} 行`);
  if (crashN) parts.push(`崩溃 ${crashN} 行`);
  /// 收藏报的是"这一批里出现了几行收藏"，和上面那个角标（当前设备一共收藏了几行）
  /// 口径不同，所以两个数字都要写清楚各自在数什么
  if (markedN) parts.push(`收藏 ${markedN} 行${markN > markedN ? `（设备上共 ${markN}）` : ''}`);
  /// 读失败时一行都没有，也就无所谓"筛出多少"：写上去会让人以为筛条件把内容滤没了
  if (d.ok !== false && (logCrashOnly || logOnlyLevel || logMarkOnly || logNewOnly || logQuery.trim()))
    parts.push(`筛出 ${visibleLogRows().length} 行`);
  return parts.filter(Boolean).join(' · ');
}

/// 只刷计数栏。日志还没读回来时留空 —— 写一个字都是错的
function renderLogSum() {
  const el = $('#logsum');
  if (el) el.textContent = logRows ? logSumText() : '';
}

function renderLog() {
  const box = $('#loglist');
  if (!box) return;
  const d = logRows || {};
  const all = Array.isArray(d.rows) ? d.rows : [];
  const rows = visibleLogRows();
  renderLogSum();

  renderLogDist(all);

  /// 空列表没有可复制/导出的内容，直接把按钮禁掉，比点了再弹一句"没有内容"干净
  for (const id of ['#btn-log-copy', '#btn-log-export']) {
    const b = $(id);
    if (b) b.disabled = rows.length === 0;
  }
  /// 崩溃报告可能只装收藏的行，所以它的禁用条件和上面两个不一样：
  /// 只要报告里会有内容（有崩溃行或有收藏行）就该能点
  const rbtn = $('#btn-log-report');
  if (rbtn) rbtn.disabled = crashReportRows(rows).length === 0;

  if (!rows.length) {
    box.replaceChildren(captionEl(emptyLogText(d, all.length)));
    bindLogList();
    return;
  }
  /// 只画前 logShown 行；剩下的靠底部那个按钮一页页放出来
  const cut = Math.min(logShown, rows.length);
  const nodes = rows.slice(0, cut).map(logRow);
  if (cut < rows.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'logmore';
    more.textContent = `再显示 ${Math.min(LOG_PAGE, rows.length - cut)} 行（还有 ${rows.length - cut} 行）`;
    more.onclick = (e) => {
      e.stopPropagation();
      logShown += LOG_PAGE;
      renderLog();
      const box2 = $('#loglist');
      /// 追加后把新露出的一行滚到视野里，用户不用自己再找“刚才停在哪”
      const firstNew = box2?.querySelectorAll('.logrow')[cut];
      firstNew?.scrollIntoView({ block: 'center' });
    };
    nodes.push(more);
  }
  box.replaceChildren(...nodes);
  markLogOverflow();
  /// 行是刚建的，列表级的点击 / 键盘要重新挂一次；选中态按日志自身的键还原回来
  bindLogList();
  restoreLogSel();
}

/// 等级条：把刚读回来的整批按等级切成几段，段宽＝这个等级的条数占比，每一段本身就是按钮。
/// 按等级数行数并排好序。等级条和崩溃报告里的那张构成表用的是同一份数据 ——
/// 同一批日志在两个地方显示不同的数字，用户会先怀疑其中一个算错了。
/// 认得的等级按 LOG_ORDER 的严重度排；不认得的（厂商自己加的字）排在最后：
/// 宁可排得难看，也不能因为不认识就把这个等级的行抹掉
function logLevelCounts(all) {
  const counts = new Map();
  for (const x of all) {
    const lv = x.level || '?';
    counts.set(lv, (counts.get(lv) || 0) + 1);
  }
  const rank = (lv) => {
    const i = LOG_ORDER.indexOf(lv);
    return i < 0 ? LOG_ORDER.length : i;
  };
  return [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

/// 等级条本体。
/// 用整批而不是"当前筛完的视图"，两个原因：
///   ① 它要回答的第一个问题是「这批里到底有没有 Error/Fatal」，跟着筛条件走会把这个问题答丢；
///   ② 段宽是相对的，跟着筛条件变会让同一批日志的构成每次长得都不一样，反倒看不出东西。
/// 点一段＝只看这一级，再点一下取消：和「只看崩溃」一样是本机侧过滤（见 visibleLogRows），不回设备
function renderLogDist(all) {
  const box = $('#logdist');
  const bar = $('#logdistbar');
  if (!box || !bar) return;
  /// 读不到、或这批真的是空的：整条不出现。
  /// 空条占着位置什么都不说，用户会以为"各等级都是 0"，而真相是"根本没有这批日志"
  if (!all.length) {
    box.hidden = true;
    bar.replaceChildren();
    return;
  }
  const segs = logLevelCounts(all).map(([lv, n]) => {
    const on = logOnlyLevel === lv;
    const seg = document.createElement('button');
    seg.type = 'button';
    /// 颜色沿用那套语义：只有 E/F 走红、W 走黄，其余保持中性
    /// （和行左边那条等级竖条同一个规则，扫一眼就知道该往哪看）
    seg.className = `logseg is-${LOG_HEAT[lv] || 'plain'}${on ? ' on' : ''}`;
    /// 占比靠 flex-grow（basis 是 0，见 CSS），宽度严格按条数分。
    /// 但 min-width 还在：触控目标不能小于 44px，所以条数极少的等级会显得比实际占比宽一点。
    /// 这是有意让的 —— 一条 1/400 的 Fatal 若只分到 0.25% 宽，等于看不见也点不到
    seg.style.flexGrow = String(n);
    seg.dataset.level = lv;
    seg.setAttribute('aria-pressed', on ? 'true' : 'false');
    seg.title = `${lv} 级 ${n} 行 · 点一下只看这一级`;
    seg.setAttribute('aria-label', `${lv} 级 ${n} 行，${on ? '已选中，再点一下取消' : '点一下只看这一级'}`);
    const lb = document.createElement('b');
    lb.textContent = lv;
    const num = document.createElement('span');
    num.textContent = String(n);
    seg.append(lb, num);
    seg.onclick = () => {
      /// 再点同一段＝取消。等级条自己 toggle，不像标签/pid 那样去改筛选框：
      /// 筛选框里放的是关键字，把等级塞进去会和关键字搅在一起，用户分不清哪个是哪个
      logOnlyLevel = on ? '' : lv;
      logShown = LOG_PAGE;
      renderLog();
    };
    return seg;
  });
  bar.replaceChildren(...segs);
  box.hidden = false;
}

/// 给「真的被截掉」的行挂上可展开。折没折行只有进了 DOM 并且**可见**时才量得准：
/// 日志段没被选中时是 display:none，所有尺寸都是 0，那一遍量出来的结论是"没折"。
/// 所以渲染完量一次，段被切换出来时再补一次（切分段只翻 class，不会重渲染）
function markLogOverflow() {
  for (const node of $$('#loglist .logrow')) {
    if (node.classList.contains('expandable')) continue;
    const msg = node.querySelector('.logmsg');
    if (msg && msg.scrollHeight - msg.clientHeight > 2) makeExpandable(node);
  }
}

/// 记录日志的滚动位置：原地重读一批（比如点「读取日志」）时列表会整段重画，
/// 用户本来滚到下面看某条错误，重读一下跳回顶部就很烦。读之前先存、画完再还原
function rememberLogScroll() {
  const box = $('#loglist');
  return box ? box.scrollTop : 0;
}

/// 把当前视图还原成接近 `logcat -v threadtime` 的文本：pid/tid 按同样位宽右对齐，
/// 粘到别处（issue、聊天、编辑器）能和设备上的原文对得上，别人报的行号、时间点也能对上位置
function logText() {
  const d = logRows || {};
  const rows = visibleLogRows();
  const p = state?.profile || {};
  const markN = rows.filter((x) => logMarksFor().has(logKey(x))).length;
  const head = [
    '# ADB 设备日志导出',
    `# 设备 ${p.serial || '未知'}${p.model ? ` · ${p.model}` : ''}`,
    `# ${d.detail || ''}`,
    `# 读法 ${d.read || d.command || ''}`,
    `# 导出时间 ${new Date().toLocaleString()}`,
    /// 收藏只在报告里逐行标出来，txt 这边保持原样的 logcat 行（要能直接粘进别的日志工具），
    /// 所以这里只报个数说清楚"你标过行、但这份粘贴里看不出来"
    ...(markN ? [`# 其中 ${markN} 行是你收藏过的（导出报告 .md 会逐条标出来）`] : []),
    '',
  ];
  const body = rows.map(
    (x) =>
      `${x.time || ''}  ${String(x.pid ?? '').padStart(5)} ${String(x.tid ?? '').padStart(5)} ` +
      `${x.level || '?'} ${x.tag || ''}: ${x.msg || ''}`,
  );
  return [...head, ...body].join('\n');
}

/// 复制走 Clipboard API，失败再退到隐藏 textarea + execCommand。
/// 退路必须留着：这个页面经常是拿 http://192.168.x.x:8787 打开的，不是 localhost，
/// 而 navigator.clipboard 只在安全上下文（https / localhost）里才有，局域网地址下是 undefined
async function copyLog() {
  const rows = visibleLogRows();
  if (!rows.length) return;
  const text = logText();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no-clipboard');
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    if (!ok) {
      log('这个环境不允许直接写剪贴板，改用「导出 .txt」把文件存下来', 'warn');
      return;
    }
  }
  buzz(10);
  log(`已复制 ${rows.length} 行到剪贴板`, 'ok');
}

/// 本机下载一段文本。导 .txt 和导报告 .md 走同一套：Blob + 隐藏的 <a download>。
/// 两处各写一遍，最容易只在其中一处漏掉 revokeObjectURL —— 漏了那份 blob 就一直在内存里挂着
function downloadText(name, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return blob;
}

/// 文件名里的时间戳与设备名。本地时间戳里那堆冒号冒号冒号在文件名里不能用（有的系统直接拒绝保存），
/// 所以统一换成连字符；序列号里可能带冒号（IP:端口），也要换掉
const fileStamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const fileSerial = () => String(state?.profile?.serial || 'device').replace(/[^\w.-]/g, '_');

/// 导出成本机 .txt 文件。设备上什么都没动，纯本机产物
function exportLog() {
  const rows = visibleLogRows();
  if (!rows.length) return;
  const name = `logcat-${fileSerial()}-${fileStamp()}.txt`;
  const blob = downloadText(name, logText());
  log(`已导出 ${rows.length} 行 → ${name}（${Math.max(1, Math.round(blob.size / 1024))} KB）`, 'ok');
}

/// 报告里会出现哪些行：屏幕上可见的崩溃行，加上可见的收藏行。
/// 两样都没有时报告是个空壳，按钮就该禁着（见 renderLog）；这里同时给导出计数用
function crashReportRows(rows) {
  const marks = logMarksFor();
  return rows.filter((x) => isCrashRow(x) || marks.has(logKey(x)));
}

/// Markdown 围栏要自己算长度：日志正文里出现反引号是常事（打印代码片段、拼接 SQL），
/// 围栏跟正文里最长的那串一样长就会提前闭合，报告后半段的排版全塌
function mdFence(text) {
  const runs = String(text).match(/`+/g) || [];
  return '`'.repeat(Math.max(3, ...runs.map((s) => s.length + 1)));
}

/// 报告里的一条日志：整条正文原样进围栏，不截断 —— 截断的堆栈正是最没用的一种报告。
/// 标题上带序号（崩溃现场按 1、2、3 数下去，方便口头说"第 2 条"）和收藏星
function mdLogBlock(x, { n = 0, star = false } = {}) {
  const fence = mdFence(x.msg || '');
  return [
    `### ${n ? `${n}. ` : ''}${x.level || '?'} · ${logTime(x.time)} · ${x.tag || '无标签'}${star ? ' ★' : ''}`,
    '',
    `- 进程：pid ${x.pid ?? '?'} · tid ${x.tid ?? '?'}`,
    '',
    fence,
    String(x.msg || '').replace(/\s+$/, ''),
    fence,
  ].join('\n');
}

/// 崩溃报告（Markdown）。取的是"屏幕上这一批"（和复制/导出同一批），所以「先按 pid 筛、
/// 再导报告」得到的是一份只讲那个进程的报告。用了哪些筛选条件会原样写进报告头 ——
/// 报告转发出去之后，看报告的人得知道这不是全部日志
function crashReportMd(rows) {
  const d = logRows || {};
  const p = state?.profile || {};
  const marks = logMarksFor();
  const all = Array.isArray(d.rows) ? d.rows : [];
  const crashes = rows.filter(isCrashRow);
  const crashAll = all.filter(isCrashRow).length;
  /// 收藏里的崩溃行已经在「崩溃现场」里了，这里只挑剩下的，避免同一条贴两遍
  const marked = rows.filter((x) => marks.has(logKey(x)) && !isCrashRow(x));
  const filters = [];
  if (logOnlyLevel) filters.push(`只看 ${logOnlyLevel} 级`);
  if (logCrashOnly) filters.push('只看崩溃');
  if (logMarkOnly) filters.push('只看收藏');
  if (logNewOnly) filters.push('只看新增');
  if (logQuery.trim()) filters.push(`关键字「${logQuery.trim().replace(/\s+/g, ' ')}」`);

  const L = [
    '# ADB 设备崩溃报告',
    '',
    `- 设备：\`${p.serial || '未知'}\`${p.model ? `（${p.model}）` : ''}`,
    `- 读取方式：\`${d.read || d.command || '未知'}\``,
    `- 读取时间：${new Date().toLocaleString()}`,
    `- 这一批：${d.detail || `${all.length} 行`}`,
    `- 屏幕上的筛选：${filters.length ? filters.join(' + ') : '无'}`,
    `- 崩溃行：${crashes.length} 行` +
      (crashAll > crashes.length ? `（这批里一共 ${crashAll} 行崩溃，其余不在上面的筛选范围内）` : ''),
    `- 前端版本：\`${BUILD}\``,
    '',
    '## 等级构成',
    '',
    '| 等级 | 行数 |',
    '| --- | ---: |',
    ...logLevelCounts(all).map(([lv, n]) => `| ${lv} | ${n} |`),
    '',
    '## 崩溃现场',
    '',
  ];
  if (crashes.length) {
    crashes.forEach((x, i) =>
      L.push(mdLogBlock(x, { n: i + 1, star: marks.has(logKey(x)) }) + '\n'),
    );
  } else {
    L.push('这批里没有崩溃行（下面只有你收藏的行）。\n');
  }
  if (marked.length) {
    L.push('## 收藏的行');
    L.push('');
    marked.forEach((x) => L.push(mdLogBlock(x) + '\n'));
  }
  return L.join('\n');
}

/// 导出崩溃报告。带 ★ 的行就是收藏过的行，报告转发出去之后不用再口头交代"哪几条重要"
function reportLog() {
  const rows = visibleLogRows();
  const items = crashReportRows(rows);
  if (!items.length) return;
  const name = `crash-${fileSerial()}-${fileStamp()}.md`;
  const blob = downloadText(name, crashReportMd(rows), 'text/markdown;charset=utf-8');
  log(`已导出崩溃报告 → ${name}（${Math.max(1, Math.round(blob.size / 1024))} KB，${items.length} 条现场）`, 'ok');
}

/// 自动刷新：每 3 秒重读一次。设备读一趟要 1~3 秒，所以定时间隔比单次往返略长，
/// 再叠上 loadLog 里的 logBusy 挡板，慢设备上也不会把请求堆起来
const LOG_FOLLOW_MS = 3000;

/// 日志段现在是不是不可见。用 offsetParent 判断，比读 CSS class 稳：
/// 它同时覆盖「分段没选中」和「整个设备页没选中」两种情况
function logFollowPaused() {
  const box = $('#loglist');
  return !box || box.offsetParent === null;
}

/// 停表。reason 非空时顺带告诉用户为什么停 —— 自动停必须是"说清楚了"的，
/// 勾还在、但是不刷了，不给交代就会让人以为坏了
function stopLogFollow(reason = '') {
  if (logFollowTimer) clearInterval(logFollowTimer);
  logFollowTimer = null;
  const cb = $('#logfollow');
  if (cb && cb.checked) cb.checked = false;
  if (reason) log(reason, 'warn');
}

function startLogFollow() {
  if (logFollowTimer) return;
  logFollowTimer = setInterval(() => {
    /// 切到别的分段/页签之后还在后台敲设备没有意义，但勾选状态留着：切回来接着刷
    if (logFollowPaused()) return;
    const box = $('#loglist');
    /// 本来贴着底看尾巴的，刷新后继续贴底；正翻某段历史的，位置原地不动
    const stick = box ? box.scrollHeight - box.scrollTop - box.clientHeight < 24 : false;
    const keep = box ? box.scrollTop : 0;
    void loadLog({ silent: true }).then(() => {
      const b = $('#loglist');
      if (b) b.scrollTop = stick ? b.scrollHeight : keep;
    });
  }, LOG_FOLLOW_MS);
}

$('#btn-log').onclick = () => {
  const keep = rememberLogScroll();
  void loadLog().then(() => {
    const box = $('#loglist');
    if (box) box.scrollTop = keep;
  });
};

/// 三个筛选条件（行数/等级/只看当前应用）任何一个变了就重新去设备读：
/// 等级和只看应用都是 logcat 侧的过滤，客户端筛不出来
for (const sel of ['#loglines', '#loglevel', '#logapp']) {
  const el = $(sel);
  if (el) el.onchange = () => void loadLog();
}

/// 关键字过滤只重画，不重新读：设备日志一次也就几百行，本地筛是即时的
$('#logq').oninput = () => applyLogQuery($('#logq').value);
$('#logq').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    $('#logq').value = '';
    applyLogQuery('');
  }
});

/// 「只看崩溃」和关键字同性质 —— 都是已经读回来的那批行里挑，所以同样只重画不重读。
/// 勾选状态存进 logCrashOnly，renderLog / 复制 / 导出都从这一处取结论
$('#logcrash').onchange = () => {
  logCrashOnly = !!$('#logcrash')?.checked;
  logShown = LOG_PAGE;
  if (logRows) renderLog();
};

/// 「只看收藏」和上面那几个同性质：只重画，不重读设备。
/// 一个收藏都没有的时候也让它勾上：列表会写清楚"还没收藏任何行、点 ☆ 就收藏"，
/// 比把开关禁掉、让人猜它为什么点不动好
$('#logmark').onchange = () => {
  logMarkOnly = !!$('#logmark')?.checked;
  logShown = LOG_PAGE;
  if (logRows) renderLog();
};

/// 「只看新增」和上面两个同性质（只重画不重读），但多一步：勾上的那一刻要把基准钉下来。
/// 基准＝此刻屏幕上这批的键集合，已经在看的行当然不算"新增"，之后才从设备上冒出来的才算。
/// 点掉时把基准一起丢掉 —— 留着它，下次勾上会拿一份过期的基准去比，用户等的"新行"就永远不出现
$('#lognew').onchange = () => {
  logNewOnly = !!$('#lognew')?.checked;
  logBaseKeys = logNewOnly && logRows ? new Set((logRows.rows || []).map(logKey)) : null;
  logShown = LOG_PAGE;
  if (logRows) renderLog();
  else syncLogCounts();
};

/// 复制、导出、导报告拿的都是"屏幕上这一批"（含只看崩溃/只看收藏/关键字过滤），不是全量
$('#btn-log-copy').onclick = () => void copyLog();
$('#btn-log-export').onclick = () => exportLog();
$('#btn-log-report').onclick = () => reportLog();

/// 自动刷新开关。开的时候说清楚节奏和它什么时候会自己停，
/// 不然用户看到勾还在却不刷新，只会觉得功能坏了
$('#logfollow').onchange = () => {
  if ($('#logfollow')?.checked) {
    buzz(8);
    log(`自动刷新已开启：每 ${LOG_FOLLOW_MS / 1000} 秒重读一次，切到别的分段时自动暂停`, 'ok');
    startLogFollow();
  } else {
    stopLogFollow();
  }
};

/// 切到日志段的那一刻补量一次：进设备页时日志段多半是隐藏的，那一遍渲染量出来全是 0。
/// 放在 timeout 里是为了等分段切换的类名先落地 —— 同一个点击事件里，
/// wireseg 那个处理器是不是先跑，不该由这里的注册顺序决定
$('#dev-seg').addEventListener('click', (e) => {
  if (e.target.closest('button[data-seg="log"]')) setTimeout(markLogOverflow, 0);
});

/// 转屏 / 改窗口宽度会让同一条消息多折或少数行，截断结论跟着变，重新量一遍
let logResizeTimer = null;
window.addEventListener('resize', () => {
  if (logRows) {
    clearTimeout(logResizeTimer);
    logResizeTimer = setTimeout(markLogOverflow, 200);
  }
});

$('#btn-log-clear').onclick = async () => {
  if (
    !(await askDialog({
      message:
        '清空当前设备的日志缓冲区？\n\n只清内存里的日志缓冲，不删设备文件，清掉后只能读到新行。',
      danger: true,
    }))
  )
    return;
  const btn = $('#btn-log-clear');
  btn.disabled = true;
  try {
    const r = await api('/api/log/clear', {}, '清空设备日志缓冲');
    log(r.detail, r.ok ? 'ok' : 'warn');
    /// 清成功了才有必要重读：没清掉的话缓冲区还是原来那批，重读也是白跑一趟
    if (r.ok) {
      logRows = null;
      await loadLog();
    }
  } catch (e) {
    log(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

/// 换设备（或掉线重连）后，这几块读数都是上一台的，必须清掉重新读，
/// 否则新设备的页面会顶着旧设备的 CPU / 进程数
function resetDeviceCaches() {
  devInfo = null;
  procs = null;
  procShown = PROC_PAGE;
  fsRows = null;
  healthData = null;
  devInfoAt = null;
  procsStampAt = null;
  fsStampAt = null;
  stopUptimeTick();
  uptimeBase = null;
  stopHealthMetaTick();
  healthStampAt = null;
  healthPrevVals = {};
  const meta = $('#sparkmeta');
  if (meta) meta.hidden = true;
  /// 总览页的健康快照也是「这台设备」的读数，切换设备后必须放掉，
  /// 不然新设备的总览会先顶着上一台的 CPU / 内存显示 6 秒
  homeSnapData = null;
  homeSnapPrev = {};
  if (curTab === 'home') void loadHomeSnap();
  recRows = null;
  recFresh = '';
  recSel = new Set();
  capsData = null;
  homeData = null;
  startupData = null;
  bootData = null;
  inv = null;
  usageLoaded = false;
  scanData = null;
  mediaItems = null;
  /// 日志是「设备上」的，换设备后必须重读：新设备的日志顶着旧设备的内容会误导排查
  /// 自动刷新也要停：刷的是上一台设备的日志，换台之后继续跑只会把新设备的页面来回刷掉
  if (logFollowTimer) stopLogFollow();
  logRows = null;
  logStampAt = null;
  logQuery = '';
  logCrashOnly = false;
  logOnlyLevel = '';
  /// 「只看收藏」也跟着清：勾着它换一台设备，多半会看到一张空列表（新设备一行都没收藏过），
  /// 那看起来就像"当前设备的日志读不出来"。收藏本身不清 —— 它跟着设备存在 localStorage 里
  logMarkOnly = false;
  /// 「只看新增」的基准是那一批行算出来的，换了设备它就对不上了：不清掉，新设备上勾它
  /// 会拿上一台的键去比，结论是"全是新增"，看着像坏了
  logNewOnly = false;
  logBaseKeys = null;
  if ($('#logq')) $('#logq').value = '';
  if ($('#logcrash')) $('#logcrash').checked = false;
  if ($('#logcrashn')) $('#logcrashn').hidden = true;
  if ($('#logmark')) $('#logmark').checked = false;
  if ($('#logmarkn')) $('#logmarkn').hidden = true;
  if ($('#lognew')) $('#lognew').checked = false;
  if ($('#lognewn')) $('#lognewn').hidden = true;
/// 脚本本身跟设备无关（它存在服务端），但「可启动应用」是当前设备报出来的：
/// 换设备后把这份清单放掉重读，免得候选里还留着上一台的应用
  autoData = null;
  if ($('.pane.on')?.dataset.pane === 'auto') void loadAuto();
}
document.addEventListener('keydown', (e) => {
  if (e.target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  /// 焦点在按钮上时 Enter/空格本来就会激活它：再走一遍设备按键映射等于一次按键发两条命令。
  /// 方向键仍然照发，这样「Tab 选中 + 方向键」的设备按键习惯不受影响。
  const onBtn = e.target.tagName === 'BUTTON';
  /// Escape 优先处理界面层：两个抽屉和全屏开着时，它应该是「关掉这一层」而不是「给设备发返回」
  if (e.key === 'Escape' && (!$('#opsheet').hidden || !$('#moresheet').hidden || theater)) return;
  const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', Escape: 'back', Backspace: 'back', ' ': 'playPause' };
  const key = map[e.key];
  if (!key) return;
  if (onBtn && (key === 'ok' || key === 'playPause')) return;
  e.preventDefault();
  api('/api/key', { key }, `${KEY_CN[key] || key} · 键盘`).catch((x) => log(x.message, 'err'));
});

loadIcons().then(buildMore);
buildMore();
showTab(localStorage.getItem('tvdeck.tab') || 'home');
paneAnimReady = true;
/// 图标表和设备状态是两件事：图标是本地小文件（几十毫秒），状态要走一次 adb。
/// 两件并行发出去，图标回来就拿同一份状态再画一遍，图标自己补上。
/// 以前这里写的是 loadIcons().then(refresh) + refresh()：首屏会同时飞两个 /api/state，
/// 服务端就是两次 adb 全量读，而它们要的数据完全一样
loadIcons().then(() => {
  if (state) renderState(state);
});
refresh();
/// 状态轮询：页面切到后台就不敲服务端了（和取帧、日志跟随一个道理），
/// 回到前台立刻补一次，免得一直对着离开时那一屏旧数据
setInterval(() => {
  if (!document.hidden) void refresh();
}, 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

// ---------------------------------------------------------------- 系统页
// 启动项 / 默认桌面 / 开机自启。三项都是"先探测再执行"：
// 设备不支持就把原因显示出来，而不是给一个按了没反应的按钮。

/// 一行的通用外壳：左边两行字（主/副），右边放动作
function sysRow(main, sub, action, cls = '', subTip = '') {
  const row = document.createElement('div');
  row.className = `srow ${cls}`.trim();
  const box = document.createElement('div');
  box.className = 's-main';
  const b = document.createElement('b');
  b.textContent = main;
  box.append(b);
  if (sub) {
    const s = document.createElement('span');
    s.className = 's-sub';
    s.textContent = sub;
    if (subTip) {
      s.title = subTip;
      s.classList.add('cut');
    }
    box.append(s);
  }
  row.append(box);
  if (action) row.append(action);
  return row;
}

/// 开关按钮：状态一眼可辨，点击后立刻反映，不等整页刷新
function toggleBtn(on, onLabel, offLabel, run) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `chip ${on ? 'on' : 'off'}`;
  b.textContent = on ? onLabel : offLabel;
  b.setAttribute('aria-pressed', String(on));
  b.onclick = async () => {
    b.disabled = true;
    try {
      await run(b);
    } catch (e) {
      log(e.message, 'err');
    } finally {
      b.disabled = false;
    }
  };
  return b;
}

/// 能力横幅：当前设备到底能做到哪一步。
/// 三项能力都靠 adb 探测出来的客观事实分级，不按厂商名猜 ——
/// 同一套代码在 Android 8 的大屏设备和 Android 14 的手机上走不同分支，这里把分支摊开给用户看。
async function loadCaps() {
  const box = $('#syscaps');
  try {
    capsData = await api('/api/system/caps');
  } catch {
    /// 离线时不该弹错误，静默隐藏，页面其余部分照旧
    box.hidden = true;
    return;
  }
  renderCaps();
}

function renderCaps() {
  const box = $('#syscaps');
  const d = capsData;
  if (!d || !box) return;
  box.hidden = false;
  const f = d.facts || {};
  const bits = [
    f.release && `Android ${f.release}`,
    BUILD_TYPE_CN[f.buildType] ?? f.buildType,
    f.userId ? `用户 ${f.userId}` : '',
    f.isRoot ? '权限已最高' : f.canSu ? '可提权' : '权限普通',
    f.userCount > 1 ? `${f.userCount} 个用户` : '',
  ].filter(Boolean);
  $('#capsdev').textContent = bits.join(' · ');

  const lvText = { full: '支持', partial: '部分', none: '不支持' };
  const items = d.items || [];
  /// 三项都可用是把同一个结论复述三遍：直接不占一行，分成只是证明不是猜的。
  /// 有缺口时才把每一项摊开，缺哪项亮哪项。
  if (items.length && items.every((it) => it.level === 'full')) {
    $('#capslist').replaceChildren();
    return;
  }
  const rows = items.map((it) => {
    const el = document.createElement('div');
    el.className = 'cap';
    const lv = document.createElement('span');
    lv.className = `cap-lv ${it.level}`;
    lv.textContent = lvText[it.level] || it.level;
    const t = document.createElement('span');
    t.className = 'cap-t';
    t.textContent = it.label;
    const de = document.createElement('span');
    de.className = 'cap-d';
    de.textContent = it.detail;
    /// 证据行（SDK、权限、探测结果）是排查细节，不再单独占一行：
    /// 折进同一行的悬停提示，页面上每项只留「支持到什么程度 + 一句结论」
    de.title = it.evidence ? `${it.detail}\n${it.evidence}` : it.detail;
    if (it.evidence) de.classList.add('hasnote');
    el.append(lv, t, de);
    return el;
  });
  $('#capslist').replaceChildren(...rows);
}

/// 系统页离线时，设备动作按钮统一置灰：不打扰、也不让用户点出「读取中…」后又切回未连接。
/// 在线恢复后由入口加载函数重新放开。
function setSysDeviceButtons(online) {
  ['#btn-home-refresh', '#btn-home-restore', '#btn-startup', '#btn-boot-install', '#btn-boot-on', '#btn-boot-off', '#btn-boot-try']
    .forEach((sel) => {
      const el = $(sel);
      if (el) el.disabled = !online;
    });
  const sel = $('#boottarget');
  if (sel) sel.disabled = !online;
}

/// 系统页顶部只留一个离线行动入口。三个子段内部仍保留各自空态，
/// 但不再重复长说明和连接按钮，避免同一屏出现三四份相同提示。
function syncSysOffline() {
  const banner = $('#sysoff');
  if (banner) banner.hidden = !!state?.online;
  setSysDeviceButtons(!!state?.online);
}

$('#btn-sys-go-link').onclick = () => showTab('link');

async function loadHome() {
  const box = $('#homelist');
  const b = $('#btn-home-refresh');
  if (!state?.online) {
    box.replaceChildren(emptyOff({ title: '连接后读取桌面候选', note: '可切换默认桌面，并还原到切换前的系统桌面。', action: false }));
    const note = $('#homenote');
    if (note) note.textContent = '';
    setSysDeviceButtons(false);
    return;
  }
  setSysDeviceButtons(true);
  b.disabled = true;
  b.textContent = '读取中…';
  box.replaceChildren(captionEl('查询 HOME 候选…'));
  try {
    homeData = await api('/api/system/home');
    renderHome();
  } catch (e) {
    box.replaceChildren(captionEl(e.message));
  } finally {
    b.disabled = false;
    b.textContent = '读取桌面候选';
  }
}

function renderHome() {
  const box = $('#homelist');
  const d = homeData;
  if (!d) return;
  /// 候选本身就在下面列表里，再写一句「几个候选」或「走的哪条系统接口」
  /// 都是复述。只有真的没查到候选时才需要这句说明
  {
    const el = $('#homenote');
    el.textContent = d.candidates.length ? '' : String(d.note || '');
    el.title = `${d.note || ''} · ${d.method || ''} · ${d.ms}ms`;
  }
  const backup = d.backup?.original || '';
  const restore = $('#btn-home-restore');
  restore.disabled = !backup;
  if (backup) {
    const listed = d.candidates.some((c) => c.component === backup);
    /// 还原提示收进按钮悬停：按钮已经写着「还原原桌面」，下面再挂一行
    /// 同一个结论只会把版面撑高
    const at = d.backup?.at ? ` · 记录于 ${new Date(d.backup.at).toLocaleString('zh-CN')}` : '';
    restore.title = listed
      ? `还原到切换前的系统桌面${at}`
      : `还原到切换前的系统桌面（原桌面不在当前候选里）${at}`;
  } else {
    restore.title = '切过默认桌面后才能还原';
  }
  const rows = d.candidates.map((c) => {
    const tag = c.isFallback ? '兜底桌面' : c.isSystem ? '系统/预装' : '第三方';
    /// 副标题给中文名：直接摊 com.android.launcher3 这类包名，界面全是英文
    const pkgName = c.package ? appLabel(c.package) : '';
    /// 主标题已经是应用名时，副标题再写一遍就成了「系统桌面 · 系统桌面」
    const sub = pkgName && pkgName !== c.package && pkgName !== c.label ? `${pkgName} · ${tag}` : tag;
    const subTip = `${c.package || '无包名'} · ${tag}${c.isFallback ? ' · 系统兜底桌面，不显示图标' : ''}`;
    const action = c.isCurrent
      ? Object.assign(document.createElement('span'), { className: 'curtag', textContent: '当前桌面' })
      : actChip('设为桌面', async (b) => {
          const r = await api('/api/system/home', { component: c.component }, `默认桌面 → ${c.label}`);
          log(`${c.label} · ${r.detail}`, r.verified ? 'ok' : 'warn');
          await loadHome();
        });
    return sysRow(c.label, sub, action, c.isCurrent ? 'on' : '', subTip);
  });
  box.replaceChildren(...(rows.length ? rows : [captionEl('没有查询到桌面候选。')]));
}

async function restoreHome() {
  const r = await api('/api/system/home');
  homeData = r;
  const backup = r.backup?.original || '';
  if (!backup) {
    log('还没有可还原的记录：先切一次桌面，系统会记下原值', 'warn');
    return;
  }
  const target = r.candidates.find((c) => c.component === backup);
  const name = target?.label || backup;
  const res = await api('/api/system/home', { component: backup }, `还原桌面 → ${name}`);
  log(`${name} · ${res.detail}`, res.verified ? 'ok' : 'err');
  await loadHome();
}

async function loadStartup() {
  const box = $('#startuplist');
  const b = $('#btn-startup');
  if (!state?.online) {
    box.replaceChildren(emptyOff({ title: '连接后读取开机自启应用', note: '可查看并停用随设备启动的应用。', action: false }));
    const note = $('#startupnote');
    if (note) note.textContent = '';
    setSysDeviceButtons(false);
    return;
  }
  setSysDeviceButtons(true);
  b.disabled = true;
  b.textContent = '读取中…';
  box.replaceChildren(captionEl('查询开机自启应用…'));
  try {
    startupData = await api('/api/system/startup');
    renderStartup();
  } catch (e) {
    box.replaceChildren(captionEl(e.message));
  } finally {
    b.disabled = false;
    b.textContent = '读取启动项';
  }
}

function renderStartup() {
  const box = $('#startuplist');
  const d = startupData;
  if (!d) return;
  const q = $('#startupq').value.trim().toLowerCase();
  const rows = q ? d.rows.filter((r) => (r.search ?? `${r.label} ${r.pkg}`).toLowerCase().includes(q)) : d.rows;
  /// 标题右侧只放「当前筛出多少 / 一共多少」；「第三方几个、禁用了几个」
  /// 交给下面那行说明。以前两边都写总数，同一句数字念两遍
  $('#startupcount').textContent = q ? `${rows.length}/${d.rows.length} 个` : `${d.rows.length} 个`;
  /// 把清单来源写出来：有的设备能一条命令拿全（含已禁用），有的要退回解析 dumpsys
  {
    const el = $('#startupnote');
    /// 服务端那句「20 个声明了开机自启（第三方 2）」里的总数，标题右侧刚写过；
    /// 这里只留第三方、已禁用这类标题里没有的补充，避免同一屏念两遍同一个数字
    const thirdN = d.rows.filter((r) => r.thirdParty).length;
    const offN = d.rows.filter((r) => !r.enabled).length;
    const extra = [
      `第三方 ${thirdN}`,
      offN ? `已禁用 ${offN}` : '',
      d.canToggle === false ? '需要 adb root 才能修改' : '',
    ].filter(Boolean);
    el.textContent = extra.join(' · ');
    el.title = `${d.note} · ${d.ms}ms`;
  }
  const list = rows.slice(0, 80).map((r) => {
    const sub = r.pkg;
    const subTip = [r.pkg, r.thirdParty ? '第三方' : '系统/预装', r.receivers > 1 ? `${r.receivers} 个接收者` : ''].filter(Boolean).join(' · ');
    const action = toggleBtn(
      r.enabled,
      '已开启',
      '已关闭',
      async (b) => {
        const next = !r.enabled;
        b.textContent = '处理中…';
        try {
          const res = await api('/api/system/startup', { pkg: r.pkg, enabled: next, component: r.component }, `${r.label} · ${next ? '开启' : '关闭'}自启`);
          r.enabled = next;
          log(`${r.label} · ${res.detail}`, res.verified ? 'ok' : 'warn');
        } finally {
          renderStartup();
        }
      },
    );
    return sysRow(r.label, sub, action, r.enabled ? '' : 'off', subTip);
  });
  box.replaceChildren(...(list.length ? list : [captionEl(d.rows.length ? '没有匹配的应用。' : '当前设备没有查询到开机自启应用。')]));
  if (rows.length > 80) box.append(captionEl(`只显示前 80 条，用上面的筛选框缩小范围（共 ${rows.length} 条）。`));
}

async function loadBoot() {
  const box = $('#bootlist');
  try {
    if (!state?.online) {
      $('#bootnote').textContent = '';
      if (box) box.replaceChildren(emptyOff({ title: '连接后设置开机应用', note: '可选择开机自动打开的应用和启动延迟。', action: false }));
      setSysDeviceButtons(false);
      return;
    }
    setSysDeviceButtons(true);
    bootData = await api('/api/system/autostart');
    renderBoot();
  } catch (e) {
    $('#bootnote').textContent = e.message;
  }
}

/// 目标应用下拉：列「所有能被启动的应用」，不只第三方。
/// 大屏设备上最常设的开机目标恰恰是预装的直播/桌面/设置，只列第三方会把它们全漏掉。
/// 后端按 LAUNCHER + LEANBACK_LAUNCHER + HOME 三种入口查，这里按包名去重后分组显示。
let launchablesData = null;

async function fillBootTargets(keep = '') {
  const sel = $('#boottarget');
  const prev = keep || sel.value || bootData?.target || '';
  let rows = launchablesData?.rows || [];
  if (!rows.length) {
    try {
      launchablesData = await api('/api/system/launchables');
      rows = launchablesData.rows;
    } catch {
      rows = [];
    }
  }
  /// 预装/系统应用排在后面并单独成组：默认视线里是自己装的，需要时才往下找
  const third = rows.filter((r) => r.thirdParty);
  const sys = rows.filter((r) => !r.thirdParty);
  const opt = (r) => new Option(`${r.label}（${r.pkg}）`, r.pkg);
  const opts = [];
  if (third.length) {
    const g = document.createElement('optgroup');
    g.label = `自己安装的（${third.length}）`;
    g.append(...third.map(opt));
    opts.push(g);
  }
  if (sys.length) {
    const g = document.createElement('optgroup');
    g.label = `系统/预装（${sys.length}）`;
    g.append(...sys.map(opt));
    opts.push(g);
  }
  sel.replaceChildren(...opts);
  /// 当前配置的目标不一定还在候选里（应用被卸载、或 ROM 换了包名）。
  /// 直接 sel.value = prev 会静默落到空白项，用户以为"没配置"，
  /// 所以补一个显式项把真实值显示出来。
  if (prev) {
    sel.value = prev;
    if (sel.value !== prev) {
      sel.prepend(new Option(`${prev}（当前配置，不在可启动列表里）`, prev));
      sel.value = prev;
    }
  }
}

function renderBoot() {
  const d = bootData;
  if (!d) return;
  $('#bootnote').textContent = d.note;
  $('#btn-boot-install').hidden = d.installed || !d.apkAvailable;
  $('#boottarget').disabled = !d.installed;
  $('#bootdelay').value = String(Math.round((d.delayMs || 8000) / 1000));
  $('#bootdelayv').textContent = `${Math.round((d.delayMs || 8000) / 1000)}s`;
  $('#btn-boot-on').disabled = !d.installed;
  $('#btn-boot-off').disabled = !d.installed;
  /// 老版本 helper 没注册自测广播，非 root 设备上试跑跑不了；
  /// 但这类设备重装一次 helper 就好，所以按钮保持可点，点了会给明确提示
  $('#btn-boot-try').disabled = !d.installed || !d.enabled;
  $('#btn-boot-on').textContent = d.enabled ? '更新配置' : '开启开机自启';
  const parts = [];
  if (d.installed) {
    parts.push(d.enabled ? `当前：开机后打开 ${d.target || '（未选）'}` : '当前：已关闭');
    if (d.lastRun) {
      const t = new Date(d.lastRun);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      parts.push(`上次执行 ${hh}:${mm} · ${d.lastResult || '无结果'}`);
    }
    if (d.enabled && !d.accessibilityOn) parts.push('警告：无障碍豁免未开，Android 10+ 可能被系统拦下');
    /// helper 太旧的话，Android 11+ 会因包可见性解析不到目标应用，用户只看到"启动失败"却不知道原因
    if (!d.canSelftest) parts.push('自启组件版本较旧，建议点「安装组件」重装一次');
  }
  $('#bootresult').textContent = parts.join(' · ');
  /// 安装按钮在 helper 存在但太旧时也要露出来（正常情况是装过就藏）
  $('#btn-boot-install').hidden = !d.apkAvailable || (d.installed && d.canSelftest);
}

async function bootAction(body, label) {
  const r = await api('/api/system/autostart', body, label);
  log(r.detail, r.verified ? 'ok' : r.ok ? 'warn' : 'err');
  await loadBoot();
  return r;
}

$('#btn-home-refresh').onclick = loadHome;
$('#btn-home-restore').onclick = () => restoreHome().catch((e) => log(e.message, 'err'));
$('#btn-startup').onclick = loadStartup;
$('#startupq').addEventListener('input', renderStartup);
$('#startupq').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    $('#startupq').value = '';
    renderStartup();
  }
});
/// 换设备或 adb root/unroot 之后重新探测：能力分级会跟着变
$('#btn-caps-refresh').onclick = () =>
  api('/api/system/caps?fresh=1')
    .then((r) => {
      capsData = r;
      renderCaps();
      log(`重新探测完成：${(r.items || []).map((i) => `${i.label}=${i.level}`).join('、')}`, 'ok');
    })
    .catch((e) => log(e.message, 'err'));
$('#btn-boot-install').onclick = () => bootAction({ install: true }, '安装开机自启组件').catch((e) => log(e.message, 'err'));
$('#btn-boot-on').onclick = () =>
  bootAction({ enabled: true, target: $('#boottarget').value, delayMs: Number($('#bootdelay').value) * 1000 }, '开启开机自启').catch((e) =>
    log(e.message, 'err'),
  );
$('#btn-boot-off').onclick = () => bootAction({ enabled: false }, '关闭开机自启').catch((e) => log(e.message, 'err'));
$('#btn-boot-try').onclick = () => bootAction({ try: true }, '试跑开机自启').catch((e) => log(e.message, 'err'));
$('#bootdelay').addEventListener('input', (e) => {
  $('#bootdelayv').textContent = `${e.target.value}s`;
});

// ---------------------------------------------------------------- 键盘输入与手势
/// 这两块都建立在「设备实测」上，不猜：
///   文字通路 —— input text 只吃 ASCII，中文要靠设备端装 ADBKeyboard，结论由 /api/state 回填
///   手势坐标 —— 按 wm size 报的真实分辨率算，不同分辨率/比例的 ADB 设备共用同一套按钮

// ---------------------------------------------------------------- 自动化脚本
// 把页面上的动作串成一条可复用、可定时的序列。
// 步骤类型、按键清单全部来自 /api/automation，也就是服务端那一份：
// 页面不维护第二张表 —— 服务端加了动作、页面却认不出来，这种错配最难查。
//
// 保存前这里会先按同一套规则校验一遍，为的是把「第 3 步还没填内容」这种话
// 说到具体那一步上；服务端仍然会再校验一次，它才是权威。
//
// 「跑」一律以服务端盘上那一份为准：编辑页的「立即运行」会先存再跑，
// 免得出现「按钮上写着 3 步、跑的是上一次存的 5 步」这种事。

/// 触发方式的人话。和服务端 automation.ts 的 triggerText 说的是同一件事，
/// 列表、编辑器、运行记录三处共用，改一处就够了
const autoTriggerText = (t) =>
  t?.kind === 'daily'
    ? `每天 ${t.at || '08:00'}`
    : t?.kind === 'connect'
      ? `设备上线 ${Math.round((t.delayMs ?? 0) / 1000)} 秒后`
      : '手动';

/// 运行时间：今天、昨天只写时分，更早的补上日期。运行记录一屏几十条，越短越好扫
function autoWhen(ts) {
  if (!ts) return '';
  const p = (n) => String(n).padStart(2, '0');
  const day = (x) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  const d = new Date(ts);
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (day(d) === day(new Date())) return `今天 ${hm}`;
  if (day(d) === day(new Date(Date.now() - 86400000))) return `昨天 ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/// 只比较「用户能改的那几项」：updatedAt、last、firedKey 是服务端自己动的，
/// 拿它们比会永远显示「有改动没保存」
const autoPick = (s) => (s ? { name: s.name, enabled: s.enabled, trigger: s.trigger, steps: s.steps } : null);
const sameScript = (a, b) => JSON.stringify(autoPick(a)) === JSON.stringify(autoPick(b));

/// 破坏性动作的「再点一次确认」。和项目里别处同一套手感：
/// 系统 confirm 在触屏类设备上都不好按，按钮自己变个样更直接
function armConfirm(btn, label, run) {
  let armed = false;
  const reset = () => {
    armed = false;
    btn.textContent = label;
    btn.classList.remove('armed');
  };
  btn.onclick = async () => {
    if (!armed) {
      armed = true;
      btn.textContent = '再点一次确认';
      btn.classList.add('armed');
      setTimeout(reset, 5000);
      return;
    }
    reset();
    btn.disabled = true;
    try {
      await run();
    } catch (e) {
      log(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };
  return btn;
}

/// 列表卡片底部那排动作按钮
function autoBtn(label, run, danger = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `chip${danger ? ' danger' : ''}`;
  b.textContent = label;
  return armConfirm(b, label, run);
}

/// 卡片里的结果容器：运行结束时列表会重画一次，重画时按 scriptId 把结果放回原处
const autoHolders = new Map();

function autoSeg(name) {
  $('#auto-seg')?.querySelector(`[data-seg="${name}"]`)?.click();
}

/// 逐步结果。编号方块的颜色只是加快扫读，文字里照样写清楚状态 ——
/// 只靠颜色分状态，色觉障碍的用户和黑白截图里都会丢信息
function paintAutoRun(box, job) {
  if (!box || !job) return;
  box.hidden = false;
  const busy = (job.steps || []).some((v) => v.state === 'running' || v.state === 'pending');
  const head = captionEl(
    [autoWhen(job.at), job.by, busy ? '执行中…' : job.ok ? '成功' : '没成功', job.detail, job.ms ? `${job.ms}ms` : '']
      .filter(Boolean)
      .join(' · '),
  );
  const word = { pending: '待执行', running: '执行中', ok: '完成', warn: '已发出', failed: '失败', skipped: '没跑：前面有步骤没成功' };
  const rows = (job.steps || []).map((v) => {
    const el = document.createElement('div');
    el.className = `rstep ${v.state}`;
    const no = document.createElement('span');
    no.className = 'rno';
    no.textContent = v.state === 'ok' ? '✓' : v.state === 'failed' ? '✕' : v.state === 'warn' ? '!' : String(v.index + 1);
    const txt = document.createElement('span');
    txt.className = 'rtxt';
    const b = document.createElement('b');
    b.textContent = v.text;
    const sp = document.createElement('span');
    sp.textContent = [word[v.state] || '', v.detail, v.ms ? `${v.ms}ms` : ''].filter(Boolean).join(' · ');
    txt.append(b, sp);
    el.append(no, txt);
    return el;
  });
  box.replaceChildren(head, ...rows);
}

/// 把某一条脚本的结果画到它该在的地方：列表里的那张卡片，以及正在编辑它的编辑区
function paintAutoRunFor(scriptId, job) {
  const card = autoHolders.get(scriptId);
  if (card) paintAutoRun(card, job);
  if (autoDraft?.id === scriptId) paintEditorRun();
}

function paintEditorRun() {
  const box = $('#autorun');
  if (!box) return;
  const job = autoDraft?.id ? autoRuns.get(autoDraft.id) : null;
  if (job) paintAutoRun(box, job);
  else {
    box.hidden = true;
    box.replaceChildren();
  }
}

// ---- 读取与渲染 ----

async function loadAuto() {
  const b = $('#btn-auto-refresh');
  const box = $('#autolist');
  if (b) {
    b.disabled = true;
    b.textContent = '读取中…';
  }
  if (box && !autoData) box.replaceChildren(captionEl('读取脚本…'));
  try {
    autoData = await api('/api/automation');
    renderAutoEngine();
    fillAutoKinds();
    renderAutoList();
    renderAutoHist();
    void fillAutoLaunchList();
    /// 媒体库清单也要一起刷新：编辑区那一步的下拉是靠它填的。
    /// 已经有清单时不打断朗读（不把「重新读取」按钮改字），避免每次轮询都在闪
    void loadMedia({ quiet: !!mediaItems });
    /// 手上有一条没保存完的草稿时，重画的是它自己（而不是把它丢掉）：
    /// 「重新读取」的语义是刷新服务端那一份，不是放弃我正在写的这一条
    renderAutoEdit();
  } catch (e) {
    if (box) box.replaceChildren(captionEl(e.message));
    $('#autoeng').textContent = '读不到';
  } finally {
    if (b) {
      b.disabled = false;
      b.textContent = '重新读取';
    }
  }
}

function renderAutoEngine() {
  const d = autoData;
  if (!d) return;
  const on = d.engine?.enabled !== false;
  /// trigger 是对象 { kind }，不是字符串：以前按字符串比，定时脚本永远算成 0，
  /// 于是「暂停自动触发」整行被收起，用户找不到开关
  const daily = d.scripts.filter((s) => s.trigger?.kind === 'daily').length;
  const connect = d.scripts.filter((s) => s.trigger?.kind === 'connect').length;
  const auto = daily + connect;
  /// 没有可自动触发的脚本时开关没有操控对象，整行收起
  $('#auto-engine-row').hidden = !auto;
  $('#autoeng').textContent = on ? '已开启' : '已暂停';
  $('#autoeng').classList.toggle('warn', !on);
  $('#btn-auto-engine').textContent = on ? '暂停自动触发' : '开启自动触发';
  $('#btn-auto-engine').classList.toggle('on', on);
  $('#btn-auto-engine').setAttribute('aria-pressed', String(on));
  $('#autocount').textContent = d.scripts.length ? `${d.scripts.length} 条` : '';
  /// 这一行以前挂的是服务端内部路径（…/.tvdeck/automation.json），
  /// 对页面上「看脚本 / 跑脚本」没有任何用处，还容易被误读成要用户去改文件。
  /// 同样一行高度换成用户真正关心的事：定时与上线触发现在会不会自动跑
  const autoPathEl = $('#autopath');
  autoPathEl.classList.toggle('warn', !on);
  autoPathEl.textContent = !auto
    ? '还没有定时或上线触发'
    : on
      ? `${auto} 条会自动触发（定时 ${daily} · 上线 ${connect}）`
      : `${auto} 条已暂停自动触发`;
  autoPathEl.title = auto ? '手动运行的脚本不受这个开关影响' : '';
}

function fillAutoKinds() {
  const sel = $('#autoadd');
  if (!sel || sel.dataset.filled === '1') return;
  const kinds = autoData?.kinds || [];
  if (!kinds.length) return;
  sel.replaceChildren(...kinds.map((m) => new Option(m.label, m.kind)));
  sel.dataset.filled = '1';
}

/// 启动应用那一步的候选：value 放包名、显示名放人话名。
/// 包名里不会有空格和括号，存下去最稳；用户在下拉里看到的仍然是「当贝市场」。
/// 设备离线时拿不到清单，不挡着，手打包名一样能存
async function fillAutoLaunchList() {
  const dl = $('#autolaunchlist');
  if (!dl || dl.dataset.filled === '1') return;
  try {
    launchablesData = await api('/api/system/launchables');
    dl.replaceChildren(...(launchablesData.rows || []).map((r) => new Option(r.label, r.pkg)));
    dl.dataset.filled = '1';
  } catch {
    /* 离线：留着空清单，用户手打 */
  }
}

// ---- 媒体库 ----
// 素材（图片 / 视频 / 音乐）攒在服务端，脚本里的「播放图片 / 视频」挑一份名字存进脚本。
// 播放发生在设备上：设备自己去拉这份文件解码。所以库里存的是"文件名"，
// 脚本里存的也是"文件名"，而不是一份会被拷来拷去的二进制。

const mediaKindText = (k) => (k === 'video' ? '视频' : k === 'audio' ? '音频' : '图片');

async function loadMedia({ quiet } = {}) {
  const b = $('#btn-media-refresh');
  const box = $('#medialist');
  if (b && !quiet) {
    b.disabled = true;
    b.textContent = '读取中…';
  }
  if (box && !mediaItems) box.replaceChildren(captionEl('读取媒体库…'));
  try {
    const r = await api('/api/media');
    mediaItems = r.items || [];
    renderMedia();
  } catch (e) {
    if (box) box.replaceChildren(captionEl(e.message));
    $('#mediameta').textContent = '读不到';
    $('#mediameta').classList.add('warn');
  } finally {
    if (b) {
      b.disabled = false;
      b.textContent = '重新读取';
    }
  }
}

function mediaThumb(m) {
  if (m.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'mthumb';
    img.alt = '';
    img.loading = 'lazy';
    img.src = `/media/${encodeURIComponent(m.name)}`;
    return img;
  }
  const box = document.createElement('span');
  box.className = 'mthumb kind';
  box.textContent = mediaKindText(m.kind);
  return box;
}

function mediaRow(m) {
  const sub = `${mediaKindText(m.kind)} · ${humanSize(m.bytes)} · ${autoWhen(m.at)}传的`;
  const acts = document.createElement('div');
  acts.className = 'row acts';
  const view = document.createElement('a');
  view.className = 'chip';
  view.textContent = '看一眼';
  view.href = `/media/${encodeURIComponent(m.name)}`;
  view.target = '_blank';
  view.rel = 'noopener';
  acts.append(
    view,
    autoBtn(
      '删除',
      async () => {
        const r = await api('/api/media/del', { name: m.name }, `删除 ${m.name}`);
        log(r.detail, 'ok');
        mediaItems = (mediaItems || []).filter((x) => x.name !== m.name);
        renderMedia();
        /// 还有脚本正在用这个文件的话，编辑区那一步要立刻显示"库里没有了"，
        /// 而不是等到跑起来才发现
        renderAutoSteps();
      },
      true,
    ),
  );
  return sysRow(m.name, sub, acts);
}

function renderMedia() {
  const box = $('#medialist');
  const dl = $('#automediaurl');
  const label = $('#mediameta');
  if (!box) return;
  const items = mediaItems || [];
  if (label) {
    label.textContent = items.length ? `${items.length} 个文件` : '还没有文件';
    label.classList.toggle('warn', !items.length);
  }
  /// 文本输入那条岔路也要有候选：桌面上点一下就能选，大屏设备上最少还能照着手打
  if (dl) dl.replaceChildren(...items.map((m) => new Option(m.name, m.name)));
  if (!items.length) {
    /// 无脚本时整张媒体库卡片会被 renderAutoList 收起；
    /// 这里只清掉占位行，避免空卡片里再挂一句「还没有素材」。
    box.replaceChildren();
    return;
  }
  box.replaceChildren(...items.map(mediaRow));
}

/// 无脚本时只留一个主操作。素材库还没派上用场，不该和脚本空状态
/// 并列成两个「还没有…」，让人以为要分别处理两件事。
function renderAutoEmpty() {
  const box = $('#autolist');
  const card = $('#media-card');
  const engineCard = $('#auto-engine-card');
  const add = $('#btn-auto-add');
  const empty = autoData && !autoData.scripts.length;
  if (card) card.hidden = !!empty;
  /// 一条脚本都没有时「自动触发」没有操控对象，整张卡连同「重新读取」一起收起；
  /// 留一张只有开关说明的空卡片，只会让人以为哪里配置坏了
  if (engineCard) engineCard.hidden = !!empty;
  // 空状态里已经有一个主操作，顶部不再重复同一个按钮。
  if (add) add.hidden = !!empty;
  if (!box || !empty) return;
  const wrap = document.createElement('div');
  wrap.className = 'auto-empty';
  const title = document.createElement('b');
  title.textContent = '还没有脚本';
  const acts = document.createElement('div');
  acts.className = 'row';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'grow';
  go.textContent = '写一条脚本';
  go.onclick = () => newAuto();
  acts.append(go);
  wrap.append(title, acts);
  box.replaceChildren(wrap);
}

function renderAutoList() {
  const box = $('#autolist');
  const d = autoData;
  if (!d || !box) return;
  autoHolders.clear();
  if (!d.scripts.length) {
    renderAutoEmpty();
    return;
  }
  const card = $('#media-card');
  const engineCard = $('#auto-engine-card');
  const add = $('#btn-auto-add');
  if (card) card.hidden = false;
  if (engineCard) engineCard.hidden = false;
  if (add) add.hidden = false;
  box.replaceChildren(...d.scripts.map(autoCard));
}

function autoCard(s) {
  const el = document.createElement('div');
  el.className = `ablock${s.enabled ? '' : ' paused'}`;
  const sub = [
    `${s.steps.length} 步`,
    s.enabled ? '' : '已暂停，不会自动跑',
    s.last ? `上次 ${autoWhen(s.last.at)} · ${s.last.ok ? '成功' : '没成功'}` : '还没跑过',
  ]
    .filter(Boolean)
    .join(' · ');
  const head = sysRow(s.name, sub, null);
  const badge = document.createElement('span');
  /// 会自己动的脚本给个高亮标签：列表里一眼就分得出「哪几条不用我管」
  badge.className = `atrig${s.enabled && s.trigger.kind !== 'manual' ? ' live' : ''}`;
  badge.textContent = autoTriggerText(s.trigger);
  head.append(badge);
  el.append(head);

  const acts = document.createElement('div');
  acts.className = 'row acts';
  acts.append(
    autoBtn('立即运行', () => runAuto(s.id, autoHolders.get(s.id))),
    autoBtn('编辑', () => {
      autoDraft = JSON.parse(JSON.stringify(s));
      renderAutoEdit();
      autoSeg('edit');
    }),
    autoBtn(s.enabled ? '暂停' : '启用', async () => {
      const r = await api('/api/automation/save', { ...s, enabled: !s.enabled }, `${s.name} · ${s.enabled ? '暂停' : '启用'}`);
      log(r.detail, 'ok');
      await loadAuto();
    }),
    autoBtn(
      '删除',
      async () => {
        const r = await api('/api/automation/del', { id: s.id }, `删除 ${s.name}`);
        log(r.detail, 'ok');
        autoRuns.delete(s.id);
        if (autoDraft?.id === s.id) autoDraft = null;
        await loadAuto();
      },
      true,
    ),
  );
  el.append(acts);

  /// 这次运行的结果就挂在刚点的那张卡片下面：进度、失败在哪一步，
  /// 应该出现在手指按下去的地方，而不是跳到另一屏去找
  const runBox = document.createElement('div');
  runBox.className = 'runs';
  runBox.hidden = true;
  el.append(runBox);
  autoHolders.set(s.id, runBox);
  const job = autoRuns.get(s.id);
  if (job) paintAutoRun(runBox, job);
  return el;
}

function renderAutoHist() {
  const box = $('#autohist');
  const d = autoData;
  if (!d || !box) return;
  const rows = d.history || [];
  if (!rows.length) {
    box.replaceChildren(captionEl('还没有运行记录。'));
    return;
  }
  box.replaceChildren(
    ...rows.slice(0, 40).map((h) => {
      /// 一步都没跑的（设备不在线、被跳过）跟「跑了但失败」要分开：
      /// 前者是环境问题，后者是脚本问题，修的方向完全不同
      const skipped = !(h.steps || []).length;
      const el = document.createElement('div');
      el.className = `rstep ${h.ok ? 'ok' : skipped ? 'warn' : 'failed'}`;
      const no = document.createElement('span');
      no.className = 'rno';
      no.textContent = h.ok ? '✓' : skipped ? '–' : '✕';
      const txt = document.createElement('span');
      txt.className = 'rtxt';
      const b = document.createElement('b');
      b.textContent = h.name;
      const sp = document.createElement('span');
      sp.textContent = [autoWhen(h.at), h.by, h.detail].filter(Boolean).join(' · ');
      txt.append(b, sp);
      el.append(no, txt);
      return el;
    }),
  );
}

// ---- 编辑 ----

/// 新加一步时的默认参数：只是让控件有个落点，值本身都还能改。
/// 有候选清单的动作（按键）直接取第一项，免得一加进来就是空值、卡在保存那一步
function autoStepDefault(kind) {
  switch (kind) {
    case 'key':
      return { kind, value: autoData?.keys?.[0]?.id || 'ok' };
    case 'launch':
      return { kind, value: '' };
    case 'volume':
      return { kind, n: 20 };
    case 'night':
      return { kind, value: 'on' };
    case 'power':
      return { kind, value: 'sleep' };
    /// 默认就指向库里第一个文件：加了这一步的人十有八九是冲着某个素材来的，
    /// 先填上再让他换，比留个必填的空框少一次操作
    case 'media':
      return { kind, value: mediaItems?.[0]?.name || '' };
    case 'text':
      return { kind, value: '' };
    case 'url':
      return { kind, value: 'https://' };
    case 'wait':
      return { kind, n: 1000 };
    default:
      return { kind };
  }
}

/// 存之前先自己过一遍，把问题指到具体那一步。规则跟服务端 normStep 一致：
/// 服务端是权威，这里是为了把「至少要有一步有效动作」这种笼统提示换成「第 2 步还没填」，
/// 否则用户只会看到自己填过的那一步在保存后凭空消失
function autoDraftProblem() {
  const d = autoDraft;
  if (!d) return '先写一条脚本';
  if (!String(d.name || '').trim()) return '给脚本起个名字';
  if (!d.steps.length) return '至少加一步动作';
  if (d.trigger.kind === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.trigger.at || '')) return '每天的执行时间没填成 HH:MM';
  for (let i = 0; i < d.steps.length; i++) {
    const s = d.steps[i];
    const at = `第 ${i + 1} 步`;
    const kind = autoData?.kinds?.find((m) => m.kind === s.kind)?.label || s.kind;
    const v = String(s.value ?? '').trim();
    if (s.kind === 'key' && !(autoData?.keys || []).some((k) => k.id === s.value)) return `${at}「${kind}」还没选按键`;
    if (s.kind === 'launch') {
      if (!v) return `${at}「${kind}」还没填应用`;
      /// 服务端只放行 字母数字点线中文空格。这里先拦一道，
      /// 免得用户填了带括号的名字、点了保存才发现那一步被静默丢掉了
      if (!/^[\w.\-+\u4e00-\u9fa5 ]+$/.test(v)) return `${at}「${kind}」里有不支持的字符，从下拉里选一个，或者直接填包名`;
    }
    if (s.kind === 'media') {
      if (!v) return `${at}「${kind}」还没选要播的东西`;
      /// 只有清单已经读到手时才判"库里有没有这份"：设备离线 / 后端没起来时
      /// mediaItems 还是 null，那时候拦住保存只会让人以为功能坏了（服务端不拦名字）
      if (!/^https?:\/\//i.test(v) && Array.isArray(mediaItems) && !mediaItems.some((m) => m.name === v))
        return `${at}「${kind}」选的「${v}」不在媒体库里了，换一个或者重新上传`;
    }
    if (s.kind === 'text' && !v) return `${at}「${kind}」还没填要输入的文字`;
    if (s.kind === 'url' && !/^https?:\/\/\S+$/i.test(v)) return `${at}「${kind}」要填 http 或 https 开头的完整网址`;
    if ((s.kind === 'volume' || s.kind === 'wait') && !Number.isFinite(Number(s.n))) return `${at}「${kind}」的数字没填对`;
  }
  return '';
}

function markAutoDirty() {
  const d = autoDraft;
  if (!d) return;
  const stored = d.id ? autoData?.scripts.find((x) => x.id === d.id) : null;
  const dirty = !d.id || !sameScript(stored, d);
  const el = $('#autoedit-state');
  el.textContent = !d.id ? '还没保存' : dirty ? '有改动没保存' : '已保存';
  el.classList.toggle('warn', !!d.id && dirty);
}

function newAuto() {
  autoDraft = { id: '', name: '', enabled: true, trigger: { kind: 'manual' }, steps: [] };
  renderAutoEdit();
  autoSeg('edit');
  /// 点「写一条脚本」之后就该能直接打字，不用再去点一次输入框
  setTimeout(() => $('#autoname')?.focus(), 60);
}

function renderAutoEdit() {
  const d = autoDraft;
  const stored = d?.id ? autoData?.scripts.find((x) => x.id === d.id) : null;
  $('#autoedit-title').textContent = d?.id ? stored?.name || d.name || '脚本' : '新建脚本';
  markAutoDirty();
  $('#autoname').disabled = !d;
  $('#autoadd').disabled = !d;
  $('#btn-auto-step-add').disabled = !d;
  $('#btn-auto-save').disabled = !d;
  $('#btn-auto-run').disabled = !d;
  $('#btn-auto-del').hidden = !d?.id;
  $('#autoedit-note').textContent = d
    ? '存在服务端，不下发到设备'
    : '';

  if (!d) {
    $('#autoname').value = '';
    $('#autostepcount').textContent = '';
    $('#autosteps').replaceChildren(captionEl('从脚本列表点「写一条脚本」或「编辑」。'));
    $('#autodailyrow').hidden = true;
    $('#autoconnrow').hidden = true;
    $$('#autotrig button').forEach((b) => {
      b.classList.remove('on');
      b.setAttribute('aria-pressed', 'false');
    });
    paintEditorRun();
    return;
  }

  $('#autoname').value = d.name;
  $$('#autotrig button').forEach((b) => {
    const on = b.dataset.trig === d.trigger.kind;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#autodailyrow').hidden = d.trigger.kind !== 'daily';
  $('#autoconnrow').hidden = d.trigger.kind !== 'connect';
  $('#autoat').value = d.trigger.at || '08:00';
  const sec = Math.round((d.trigger.delayMs ?? 10000) / 1000);
  $('#autodelay').value = String(sec);
  $('#autodelayv').textContent = `${sec}s`;
  renderAutoSteps();
  paintEditorRun();
}

function renderAutoSteps() {
  const box = $('#autosteps');
  const d = autoDraft;
  if (!box) return;
  if (!d) {
    box.replaceChildren();
    return;
  }
  $('#autostepcount').textContent = d.steps.length ? `共 ${d.steps.length} 步` : '';
  if (!d.steps.length) {
    box.replaceChildren(captionEl('还没有动作。从下面的下拉框选一个，点「添加一步」。'));
    return;
  }
  box.replaceChildren(...d.steps.map(autoStepRow));
}

/// 一步的编辑行：第一行是「动作类型 + 上移/下移/删除」，第二行是按类型变的参数控件。
/// 参数为什么单独占一行：控件有下拉、滑杆、输入框、时间四种宽度，
/// 挤进同一行在 390px 的窄屏上必然互相压
function autoStepRow(s, i) {
  const row = document.createElement('div');
  row.className = 'steprow';
  const no = document.createElement('span');
  no.className = 'stepno';
  no.textContent = String(i + 1);
  const main = document.createElement('div');
  main.className = 'stepmain';

  const head = document.createElement('div');
  head.className = 'stephead';
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', `第 ${i + 1} 步的动作`);
  sel.append(...(autoData?.kinds || []).map((m) => new Option(m.label, m.kind)));
  sel.value = s.kind;
  sel.onchange = () => {
    /// 换动作类型时参数跟着换成新类型的默认值：把旧参数带过去，
    /// 只会留下一个字段名对不上的残值（从「等待」改成「启动应用」还留着 n）
    autoDraft.steps[i] = autoStepDefault(sel.value);
    renderAutoSteps();
    markAutoDirty();
  };
  const swap = (to) => {
    const steps = autoDraft.steps;
    const t = steps[to];
    steps[to] = steps[i];
    steps[i] = t;
    renderAutoSteps();
    markAutoDirty();
  };
  /// 上移下移做成两个键而不是拖拽：方向键移动时，拖拽在大屏浏览器上根本用不了
  const moveBtn = (d) =>
    Object.assign(document.createElement('button'), {
      type: 'button',
      textContent: d < 0 ? '↑' : '↓',
      title: d < 0 ? '上移一步' : '下移一步',
      'aria-label': `${d < 0 ? '上移' : '下移'}第 ${i + 1} 步`,
      disabled: d < 0 ? i === 0 : i === autoDraft.steps.length - 1,
    });
  const up = moveBtn(-1);
  up.onclick = () => swap(i - 1);
  const down = moveBtn(1);
  down.onclick = () => swap(i + 1);
  const del = Object.assign(document.createElement('button'), {
    type: 'button',
    className: 'del',
    textContent: '✕',
    title: '删除这一步',
    'aria-label': `删除第 ${i + 1} 步`,
  });
  del.onclick = () => {
    autoDraft.steps.splice(i, 1);
    renderAutoSteps();
    markAutoDirty();
  };
  head.append(sel, up, down, del);
  main.append(head);

  const note = document.createElement('span');
  note.className = 'stepnote';
  note.textContent = autoData?.kinds?.find((m) => m.kind === s.kind)?.hint || '';
  main.append(note);
  const param = autoStepParam(s, i);
  if (param) main.append(param);
  row.append(no, main);
  return row;
}

/// 按类型生成参数控件。控件改完只更新草稿 + 刷新「有没有改动」那一行，
/// 不重画整屏 —— 重画会把正在拖的滑杆和刚输入一半的框一起重置掉
function autoStepParam(s, i) {
  const setVal = (v) => {
    autoDraft.steps[i].value = v;
    markAutoDirty();
  };
  const setNum = (n) => {
    autoDraft.steps[i].n = n;
    markAutoDirty();
  };
  const selectOf = (opts, value, label, onPick) => {
    const sel = document.createElement('select');
    sel.className = 'grow';
    sel.setAttribute('aria-label', label);
    sel.append(...opts);
    sel.value = value;
    sel.onchange = () => onPick(sel.value);
    return sel;
  };
  const textOf = (value, label, placeholder, onType, list) => {
    const inp = document.createElement('input');
    inp.className = 'grow';
    inp.type = 'text';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.setAttribute('aria-label', label);
    inp.placeholder = placeholder;
    inp.value = value;
    if (list) inp.setAttribute('list', list);
    inp.addEventListener('input', () => onType(inp.value));
    return inp;
  };

  if (s.kind === 'key') {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(selectOf((autoData?.keys || []).map((k) => new Option(k.label, k.id)), s.value || 'ok', '按键', setVal));
    const lab = document.createElement('label');
    lab.className = 'checkline';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.long === true;
    cb.onchange = () => {
      autoDraft.steps[i].long = cb.checked;
      markAutoDirty();
    };
    lab.append(cb, document.createTextNode('长按'));
    row.append(lab);
    return row;
  }
  if (s.kind === 'launch') return textOf(s.value || '', '应用包名或名字', '例如 com.dangbeimarket', setVal, 'autolaunchlist');
  if (s.kind === 'volume') {
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('label');
    lab.className = 'slider';
    const r = document.createElement('input');
    r.type = 'range';
    r.min = '0';
    r.max = '100';
    r.step = '1';
    r.value = String(s.n ?? 20);
    r.setAttribute('aria-label', '音量百分比 0 到 100');
    const v = document.createElement('span');
    v.className = 'value';
    v.textContent = String(s.n ?? 20);
    r.addEventListener('input', () => {
      v.textContent = r.value;
      setNum(Number(r.value));
    });
    lab.append(r);
    row.append(lab, v);
    return row;
  }
  if (s.kind === 'night') {
    return selectOf([new Option('开护眼', 'on'), new Option('关护眼', 'off')], s.value === 'off' ? 'off' : 'on', '护眼模式', setVal);
  }
  if (s.kind === 'power') {
    return selectOf(
      [new Option('电源键（休眠）', 'sleep'), new Option('唤醒', 'wake')],
      s.value === 'wake' ? 'wake' : 'sleep',
      '电源或唤醒',
      setVal,
    );
  }
  if (s.kind === 'media') {
    const items = mediaItems || [];
    const v = String(s.value || '');
    /// 只要库里还有东西就优先给下拉：在大屏上用方向键打一串中文文件名不现实。
    /// 想填网址的从下拉最后一项切过去，切过去之后就一直给输入框
    if (items.length && !/^https?:\/\//i.test(v)) {
      const opts = [];
      if (v && !items.some((m) => m.name === v)) opts.push(new Option(`库里已经没有「${v}」了`, v));
      opts.push(...items.map((m) => new Option(`${m.name}（${mediaKindText(m.kind)} · ${humanSize(m.bytes)}）`, m.name)));
      opts.push(new Option('改填一个网址…', '__url__'));
      const picker = selectOf(opts, v, '要播放的素材', (picked) => {
        if (picked === '__url__') {
          autoDraft.steps[i].value = '';
          markAutoDirty();
          renderAutoSteps();
          return;
        }
        setVal(picked);
      });
      /// 「先传到设备再播放」：设备自带播放器只认本地文件的机型，
      /// 推地址过去只会开出浏览器 / 下载框 / 第三方播放器的预览小窗，放不成全屏。
      /// 代价是占设备存储，所以做成显式开关，不替用户默认选它
      const lab = document.createElement('label');
      lab.className = 'checkline';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.local === true;
      cb.onchange = () => {
        autoDraft.steps[i].local = cb.checked;
        markAutoDirty();
      };
      const sub = document.createElement('span');
      sub.className = 'muted';
      sub.textContent = '（用设备自带播放器，占设备存储）';
      lab.append(cb, document.createTextNode('先传到设备再播放'), sub);
      const box = document.createElement('div');
      box.className = 'stepcol';
      box.append(picker, lab);
      return box;
    }
    return textOf(v, '媒体库文件名或网址', '库里挑一个，或者填 https://', setVal, 'automediaurl');
  }
  if (s.kind === 'text') return textOf(s.value || '', '要输入的文字', '送进设备当前聚焦的输入框', setVal);
  if (s.kind === 'url') return textOf(s.value || '', '网址', 'https://', setVal);
  if (s.kind === 'wait') {
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('label');
    lab.className = 'slider';
    const n = document.createElement('input');
    n.type = 'number';
    n.min = '0.2';
    n.max = '600';
    n.step = '0.1';
    n.inputMode = 'decimal';
    /// 存的是毫秒，显示的是秒：服务端的单位是 ms，人想的是「等 3 秒」
    n.value = String((s.n ?? 1000) / 1000);
    n.setAttribute('aria-label', '等待秒数');
    const v = document.createElement('span');
    v.className = 'value';
    v.textContent = '秒';
    n.addEventListener('input', () => setNum(Math.round(Number(n.value) * 1000)));
    lab.append(n);
    row.append(lab, v);
    return row;
  }
  return null;
}

// ---- 保存 / 运行 / 删除 ----

async function saveAuto({ quiet } = {}) {
  const bad = autoDraftProblem();
  if (bad) throw new Error(bad);
  const r = await api('/api/automation/save', autoDraft, `${autoDraft.id ? '保存' : '新建'}脚本`, quiet);
  /// 回填服务端归一化之后的成品：页面上看到的就是盘上存的那一份，所见即所存
  autoDraft = JSON.parse(JSON.stringify(r.script));
  if (!quiet) log(r.detail, 'ok');
  renderAutoEdit();
  await loadAuto();
  return r;
}

async function runAuto(id, holder) {
  const s = autoData?.scripts.find((x) => x.id === id);
  if (!s) {
    log('这条脚本已经不在了，可能刚被删掉', 'warn');
    return;
  }
  const box = holder || autoHolders.get(id);
  const r = await api('/api/automation/run', { id }, `运行 ${s.name}`);
  log(r.detail || (r.ok ? '已开始执行' : '这次没有执行'), r.ok ? 'ok' : 'warn');
  if (!r.job) return;
  autoRuns.set(s.id, r.job);
  if (box) paintAutoRun(box, r.job);
  paintAutoRunFor(s.id, r.job);
  watchAuto(r.job.id, s.id);
}

/// 作业轮询：所有正在跑的脚本共用一个 700ms 的定时器，跑完的自动摘掉。
/// 用轮询而不是流式推送，是为了刷新页面回来还能接上同一次运行
function watchAuto(jobId, scriptId) {
  autoWatching.set(jobId, scriptId);
  if (!autoTimer) autoTimer = setInterval(() => void tickAuto(), 700);
  void tickAuto();
}

function stopAutoTimer() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
}

async function tickAuto() {
  if (!autoWatching.size) {
    stopAutoTimer();
    return;
  }
  for (const [jobId, scriptId] of [...autoWatching]) {
    let d;
    try {
      d = await api(`/api/automation/run/status?job=${encodeURIComponent(jobId)}`);
    } catch (e) {
      /// 轮询自己失败（服务重启、断网）不能把界面永远停在「执行中」
      autoWatching.delete(jobId);
      log(`读不到运行进度：${e.message}`, 'err');
      continue;
    }
    if (d.gone) {
      autoWatching.delete(jobId);
      continue;
    }
    autoRuns.set(scriptId, d.job);
    paintAutoRunFor(scriptId, d.job);
    if (!d.running) {
      autoWatching.delete(jobId);
      log(`${d.job.name}：${d.job.detail}`, d.job.ok ? 'ok' : 'err');
      /// 跑完把「上次运行」那一行和运行记录刷一遍。列表重画时结果会按 scriptId 回填，
      /// 所以卡片下面那份逐步结果不会因为这次重画而消失
      await loadAuto().catch(() => {});
    }
  }
  if (!autoWatching.size) stopAutoTimer();
}

// ---- 接线 ----

$('#btn-auto-refresh').onclick = loadAuto;
$('#btn-media-refresh').onclick = () => loadMedia().catch((e) => log(e.message, 'err'));
/// 上传：和 APK 上传同一套（POST 原始字节流），支持一次选多个，一个一个传。
/// 传的过程中把进度写在卡片右上角，不弹东西挡界面 —— 一次几百兆，弹窗一挡
/// 用户就会以为死住了
$('#mediafile').onchange = async (e) => {
  const list = [...(e.target.files || [])];
  e.target.value = '';
  if (!list.length) return;
  let done = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    $('#mediameta').textContent = `正在上传 ${f.name}（${humanSize(f.size)}）${list.length > 1 ? ` · ${i + 1}/${list.length}` : ''}`;
    $('#mediameta').classList.remove('warn');
    const t0 = performance.now();
    try {
      const res = await fetch(srv(`/api/media/upload?name=${encodeURIComponent(f.name)}`), { method: 'POST', body: f });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error || d.ok === false) throw new Error(d.error || d.detail || `HTTP ${res.status}`);
      done += 1;
      recordOp({ t: Date.now(), text: `加入媒体库 ${d.name}`, detail: d.detail, cmd: '/api/media/upload', kind: 'ok', ms: Math.round(performance.now() - t0) });
    } catch (err) {
      recordOp({ t: Date.now(), text: `加入媒体库 ${f.name}`, detail: err.message, cmd: '/api/media/upload', kind: 'err', ms: Math.round(performance.now() - t0) });
    }
  }
  /// 传完统一重读一次清单：服务端才是权威，不在前端自己拼"应该有哪些"
  await loadMedia({ quiet: true }).catch(() => {});
  if (done && autoDraft) renderAutoSteps();
};
$('#btn-auto-add').onclick = () => newAuto();
/// 分段被点回「编辑」而手上还没有草稿时，把空状态画出来（否则那一屏是空白的）
$('#auto-seg').addEventListener('click', (e) => {
  if (e.target.closest('button[data-seg="edit"]') && !autoDraft) renderAutoEdit();
});

$('#btn-auto-engine').onclick = async () => {
  const b = $('#btn-auto-engine');
  const next = !(autoData?.engine?.enabled !== false);
  b.disabled = true;
  try {
    const r = await api('/api/automation/engine', { enabled: next }, next ? '开启自动触发' : '暂停自动触发');
    log(r.detail, 'ok');
    await loadAuto();
  } catch (e) {
    log(e.message, 'err');
  } finally {
    b.disabled = false;
  }
};

$('#autoname').addEventListener('input', (e) => {
  if (!autoDraft) return;
  autoDraft.name = e.target.value;
  markAutoDirty();
});

$('#autotrig').onclick = (e) => {
  const b = e.target.closest('button[data-trig]');
  if (!b || !autoDraft) return;
  const kind = b.dataset.trig;
  /// 换触发方式时先把另一种的取值按控件上的现值带上：来回切一次不会把填好的时间抹掉
  autoDraft.trigger = {
    kind,
    at: kind === 'daily' ? $('#autoat').value || autoDraft.trigger.at || '08:00' : undefined,
    delayMs: kind === 'connect' ? Number($('#autodelay').value || 10) * 1000 : undefined,
  };
  renderAutoEdit();
};

$('#autoat').addEventListener('input', (e) => {
  if (!autoDraft) return;
  autoDraft.trigger.at = e.target.value;
  markAutoDirty();
});

$('#autodelay').addEventListener('input', (e) => {
  const sec = Number(e.target.value);
  $('#autodelayv').textContent = `${sec}s`;
  if (!autoDraft) return;
  autoDraft.trigger.delayMs = sec * 1000;
  markAutoDirty();
});

$('#btn-auto-step-add').onclick = () => {
  if (!autoDraft) newAuto();
  if (autoDraft.steps.length >= 24) {
    log('一条脚本最多 24 步', 'warn');
    return;
  }
  autoDraft.steps.push(autoStepDefault($('#autoadd').value));
  renderAutoSteps();
  markAutoDirty();
};

$('#btn-auto-save').onclick = async () => {
  const b = $('#btn-auto-save');
  b.disabled = true;
  const old = b.textContent;
  b.textContent = '保存中…';
  try {
    await saveAuto();
    autoSeg('list');
  } catch (e) {
    log(e.message, 'err');
  } finally {
    b.disabled = false;
    b.textContent = old;
  }
};

$('#btn-auto-run').onclick = async () => {
  const b = $('#btn-auto-run');
  b.disabled = true;
  const old = b.textContent;
  try {
    /// 先存再跑：跑的是服务端盘上那一份，不能是页面上这个还没落盘的草稿
    b.textContent = '保存中…';
    await saveAuto({ quiet: true });
    b.textContent = '运行中…';
    await runAuto(autoDraft.id, $('#autorun'));
  } catch (e) {
    log(e.message, 'err');
  } finally {
    b.disabled = false;
    b.textContent = old;
  }
};

armConfirm($('#btn-auto-del'), '删除', async () => {
  if (!autoDraft?.id) {
    log('这条脚本还没保存，不用删', 'warn');
    return;
  }
  const r = await api('/api/automation/del', { id: autoDraft.id }, `删除 ${autoDraft.name}`);
  log(r.detail, 'ok');
  autoRuns.delete(autoDraft.id);
  autoDraft = null;
  renderAutoEdit();
  autoSeg('list');
  await loadAuto();
});

armConfirm($('#btn-hist-clear'), '清空运行记录', async () => {
  const r = await api('/api/automation/history/clear', {}, '清空运行记录');
  log(r.detail, 'ok');
  autoRuns.clear();
  await loadAuto();
});

function paintTextPaths(t) {
  const via = $('#textvia');
  const note = $('#textnote');
  if (!via) return;
  const offline = !state?.online;
  for (const id of ['#btn-text-send', '#btn-text-enter', '#btn-text-del', '#btn-text-clear']) {
    const b = $(id);
    if (b) b.disabled = offline;
  }
  if (offline || !t) {
    via.textContent = offline ? '设备离线' : '读取中…';
    via.classList.toggle('warn', offline);
    if (note) {
      note.textContent = offline
        ? '去「连接」接上设备。'
        : '正在探测文字通路…';
    }
    return;
  }
  const zh = t.adbKeyboard;
  via.textContent = zh ? '英文数字 + 中文' : t.input ? '仅英文数字' : '发不出文字';
  via.classList.toggle('warn', !t.input && !zh);
  if (!note) return;
  /// 能输入时右上角已经写了能力，底部不再复述同一句
  note.textContent = !t.input && !zh ? '设备收不了文字' : '';
  note.title = !t.input && !zh
    ? '这台设备没有可用的文字输入方式，只能用方向键和确认键'
    : zh
      ? '设备装了 ADBKeyBoard，中文也能直接发过去'
      : '只能发英文和数字；要输中文得先在设备上装一个输入法（如 ADBKeyBoard）';
}

/// 手势落点按设备分辨率取相对位置，任何设备都不用改配置。
/// 行程取画面的 22%：太短会被认出一次点击，太长会滑过头
function gestureLine(kind) {
  const s = state?.screen;
  if (!s?.w || !s?.h) return null;
  const cx = Math.round(s.w / 2);
  const cy = Math.round(s.h / 2);
  const dy = Math.max(40, Math.round(s.h * 0.22));
  const dx = Math.max(40, Math.round(s.w * 0.22));
  if (kind === 'up') return { x1: cx, y1: cy + dy, x2: cx, y2: cy - dy, ms: 280 };
  if (kind === 'down') return { x1: cx, y1: cy - dy, x2: cx, y2: cy + dy, ms: 280 };
  if (kind === 'left') return { x1: cx + dx, y1: cy, x2: cx - dx, y2: cy, ms: 280 };
  if (kind === 'right') return { x1: cx - dx, y1: cy, x2: cx + dx, y2: cy, ms: 280 };
  if (kind === 'hold') return { x1: cx, y1: cy, x2: cx, y2: cy, ms: 1200 };
  return null;
}

function paintGestureCap(screen) {
  const cap = $('#gesturecap');
  const grid = $('#gestrid');
  if (!cap || !grid) return;
  const live = !!state?.online;
  const ok = live && !!screen?.w && !!screen?.h;
  $$('button', grid).forEach((b) => (b.disabled = !ok));
  cap.classList.toggle('warn', !live);
  cap.textContent = !live
    ? '连上后按设备分辨率发送。'
    : !screen?.w
      ? '读不到分辨率，手势没法换算落点。'
      : `按 ${screen.w}×${screen.h} 换算落点`;
}

const GESTURE_CN = { up: '上滑', down: '下滑', left: '左滑', right: '右滑', double: '双击', hold: '长按' };

$('#gestgrid').onclick = async (e) => {
  const b = e.target.closest('button[data-gesture]');
  if (!b || b.disabled) return;
  const g = b.dataset.gesture;
  const s = state?.screen;
  if (!s?.w || !s?.h) {
    log('读不到设备分辨率，这一下手势没发出去', 'warn');
    return;
  }
  b.classList.add('fire');
  setTimeout(() => b.classList.remove('fire'), 280);
  try {
    if (g === 'double') {
      const cx = Math.round(s.w / 2);
      const cy = Math.round(s.h / 2);
      /// 两下要真的分开发：合成一次 tap 设备只会认成单击
      await api('/api/tap', { x: cx, y: cy }, '双击 第 1 下', true);
      await new Promise((r) => setTimeout(r, 110));
      const r = await api('/api/tap', { x: cx, y: cy }, `双击 · ${cx},${cy}`);
      log(r.detail || `已双击 ${cx},${cy}`, r.ok ? 'ok' : 'warn');
      return;
    }
    const line = gestureLine(g);
    if (!line) return;
    const r = await api('/api/swipe', line, `${GESTURE_CN[g]} · 手势`);
    log(r.detail || `已发送${GESTURE_CN[g]}`, r.ok ? 'ok' : 'warn');
  } catch (err) {
    log(err.message, 'err');
  }
};
/// 触控板：像鼠标一样用。这台设备有没有鼠标驱动、有哪几个键、能不能滚轮，
/// 全由后端实测（state.mouse）决定，页面只表达意图，不写死任何一台设备。
/// 手势：单指拖动=移动光标；轻点=左键；按住不动 350ms=锁住左键可拖拽选中；双指拖动=滚轮。
/// 右键/中键/侧键这些不靠手势歧义，走下面的辅助按键，触屏和鼠标都能点。
const tpPad = $('#touchpad');
const tpCursor = $('#tpCursor');
const tpAux = $('#tp-aux');
const tpTrace = $('#tpTrace');
const tpLine = $('#tpLine');
const tpOrigin = $('#tpOrigin');
const tpHead = $('#tpHead');
const TP_HOLD_MS = 350; // 按住不动这么久 = 锁住左键（拖拽/选中文字）
const TP_MOVE_SLOP = 4; // 超过这个位移就不算「轻点」，同时取消按住判定
const TP_WHEEL_PX = 24; // 双指拖动多少像素算一格滚轮
const TP_FLUSH_MS = 40; // 末尾余量最迟这么久补发一次，避免指示器和设备光标越走越偏

let tpActive = false;
let tpX = 0.5;
let tpY = 0.5;
let tpMoved = false;
let tpTravel = 0; // 本次按下累计行程，用来区分「轻点」和「拖动」
let tpHoldBtn = null; // 当前由触控板按住不放按键
let tpLongTimer = null;
let tpFlushTimer = null;
let tpLastMove = 0;
let tpPendingX = 0;
let tpPendingY = 0;
/// 多指状态：pointerId → {x,y}。两指时切滚轮，不再当成移动
const tpPointers = new Map();
let tpWheelAcc = 0;
let tpWheelAccX = 0;
/// 左键「按住」开关：开着时光标移动期间左键一直是按下态（拖文件、框选）
let tpLockLeft = false;
/// 绝对坐标触屏模式：设备没有独立鼠标驱动时，面板 = 设备整块屏幕，点在哪就是设备上的哪
let tpAbsStart = null;

/// 触屏模式判定：在线、已读到鼠标能力且不是 evdev，但读到了屏幕分辨率 → 面板按平行映射用
const tpAbsMode = () => !!state?.online && !!state?.mouse && state.mouse.via !== 'evdev' && !!(state?.screen?.w && state?.screen?.h);

/// 面板内某点 → 设备像素坐标：左上角映射到 (0,0)，右下角到 (w-1,h-1)
function absPoint(clientX, clientY) {
  if (!tpAbsMode()) return null;
  const r = tpPad?.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) return null;
  const nx = state.screen.w;
  const ny = state.screen.h;
  const x = ((clientX - r.left) / r.width) * nx;
  const y = ((clientY - r.top) / r.height) * ny;
  return { x: Math.round(Math.min(nx - 1, Math.max(0, x))), y: Math.round(Math.min(ny - 1, Math.max(0, y))) };
}

/// 这台设备能不能用触控板：离线、能力还没读到、没有鼠标驱动都算不能用
function mouseCap() {
  if (!state?.online) return { ok: false, why: '设备离线，触控板发不出去' };
  const m = state.mouse;
  if (!m) return { ok: false, why: '正在探测设备鼠标能力…' };
  if (m.via !== 'evdev') return { ok: false, why: m.note || '设备没有鼠标驱动' };
  return { ok: true, m };
}

function tpFlush() {
  clearTimeout(tpFlushTimer);
  tpFlushTimer = null;
  const dx = Math.round(tpPendingX);
  const dy = Math.round(tpPendingY);
  tpPendingX -= dx;
  tpPendingY -= dy;
  if (!dx && !dy) return;
  api('/api/mouse', { mode: 'move', dx, dy }, '鼠标移动', true).catch(() => {});
}

/// 光标移动节流：每帧发一次相对位移，最多每 12ms 一次；没发出去的余量攒着补发
function tpMove(dx, dy) {
  tpPendingX += dx;
  tpPendingY += dy;
  const now = performance.now();
  if (now - tpLastMove < 12) {
    if (!tpFlushTimer) tpFlushTimer = setTimeout(tpFlush, TP_FLUSH_MS);
    return;
  }
  tpLastMove = now;
  tpFlush();
}

function updateCursorPos(clientX, clientY) {
  if (!tpPad || !tpCursor) return;
  /// 触屏模式：指示点直接跟手指走，面板四边就是设备屏幕四边
  if (tpAbsMode() && typeof clientX === 'number') {
    const r = tpPad.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      tpCursor.style.left = `${Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 100}%`;
      tpCursor.style.top = `${Math.max(0, Math.min(1, (clientY - r.top) / r.height)) * 100}%`;
      tpCursor.classList.add('abs');
      return;
    }
  }
  tpCursor.classList.remove('abs');
  tpCursor.style.left = `${Math.max(0, Math.min(1, tpX)) * 100}%`;
  tpCursor.style.top = `${Math.max(0, Math.min(1, tpY)) * 100}%`;
}

/// 拖动轨迹：起点到指尖画一条线，抬手后自动隐去。
/// 触屏模式下没有鼠标指针，没有这条线用户没法确认「这一下滑向哪」
function paintTrace(clientX, clientY) {
  if (!tpPad || !tpTrace || !tpAbsStart) return;
  const r = tpPad.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x0 = tpAbsStart.x - r.left;
  const y0 = tpAbsStart.y - r.top;
  const x1 = clientX - r.left;
  const y1 = clientY - r.top;
  const len = Math.hypot(x1 - x0, y1 - y0);
  /// 没拖开就不画，否则轻点也会闪一条零长度的线
  if (len < 12) {
    tpTrace.hidden = true;
    return;
  }
  tpTrace.hidden = false;
  tpLine.style.width = `${len}px`;
  tpLine.style.transform = `translate(${x0}px, ${y0}px) rotate(${Math.atan2(y1 - y0, x1 - x0)}rad)`;
  tpOrigin.style.left = `${x0}px`;
  tpOrigin.style.top = `${y0}px`;
  tpHead.style.left = `${x1}px`;
  tpHead.style.top = `${y1}px`;
}

function clearTrace() {
  if (tpTrace) tpTrace.hidden = true;
}

/// 按住/松开必须成对：只 down 不 up 会把按键永远留在按下状态
function tpPress(btn, label) {
  tpHoldBtn = btn;
  tpPad?.classList.add('held');
  return api('/api/mouse', { mode: 'down', btn }, label, true).catch(() => {});
}

function tpRelease() {
  clearTimeout(tpLongTimer);
  tpLongTimer = null;
  if (!tpHoldBtn) return;
  const btn = tpHoldBtn;
  tpHoldBtn = null;
  tpPad?.classList.remove('held');
  const cn = { left: '左键', right: '右键', middle: '中键', side: '侧键', extra: '前进键' }[btn] || btn;
  void api('/api/mouse', { mode: 'up', btn }, `松开${cn}`, true).catch(() => {});
}

/// 双指拖动 = 滚轮。攒够一格（TP_WHEEL_PX）发一次，方向和真实滚轮一致
function tpWheelFromPinch(dy, dx) {
  const m = state?.mouse;
  tpWheelAcc += dy;
  tpWheelAccX += dx;
  while (Math.abs(tpWheelAcc) >= TP_WHEEL_PX) {
    const notch = tpWheelAcc > 0 ? 1 : -1;
    tpWheelAcc -= notch * TP_WHEEL_PX;
    const dir = notch > 0 ? 'down' : 'up';
    if (m?.wheel === false) continue;
    void api('/api/mouse', { mode: 'scroll', dir, amount: 1 }, `滚轮${dir}`, true).catch(() => {});
  }
  if (m?.hwheel && Math.abs(tpWheelAccX) >= TP_WHEEL_PX) {
    const notch = tpWheelAccX > 0 ? 1 : -1;
    tpWheelAccX -= notch * TP_WHEEL_PX;
    const dir = notch > 0 ? 'right' : 'left';
    void api('/api/mouse', { mode: 'scroll', dir, amount: 1 }, `横向滚轮${dir}`, true).catch(() => {});
  }
}

tpPad?.addEventListener('pointerdown', (e) => {
  if (!tpPad) return;
  /// 触屏模式：面板就是设备屏幕，按下位置即设备坐标，抬手=点按、拖动=滑动
  if (tpAbsMode()) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    clearTrace();
    tpAbsStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    tpPointers.clear();
    tpPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      tpPad.setPointerCapture(e.pointerId);
    } catch {
      /* 老 webview 没有就算了 */
    }
    tpPad.classList.add('active');
    updateCursorPos(e.clientX, e.clientY);
    e.preventDefault();
    return;
  }
  const cap = mouseCap();
  if (!cap.ok) {
    log(cap.why, 'warn');
    return;
  }
  tpPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  tpActive = true;
  tpMoved = false;
  tpTravel = 0;
  tpWheelAcc = 0;
  tpWheelAccX = 0;
  try {
    tpPad.setPointerCapture(e.pointerId);
  } catch {
    /* 某些浏览器对已经释放的 pointer 会抛，忽略即可 */
  }
  tpPad.classList.add('active');
  e.preventDefault();

  /// 第二根手指落下：这一下是滚轮，不是点击，取消按住判定并松开可能按住的键
  if (tpPointers.size >= 2) {
    clearTimeout(tpLongTimer);
    tpLongTimer = null;
    tpRelease();
    return;
  }

  /// 按住不动 = 锁左键，之后拖动就是拖拽；一旦移动超过阈值就取消（见 pointermove）
  clearTimeout(tpLongTimer);
  tpLongTimer = setTimeout(() => {
    tpLongTimer = null;
    if (!tpActive || tpMoved || tpHoldBtn) return;
    tpPress('left', '按住左键');
    log('已锁住左键，拖动就是拖拽；松手自动释放', 'ok');
  }, TP_HOLD_MS);

  /// 左键按住开关开着：这一下直接按下左键，抬起时松开
  if (tpLockLeft && !tpHoldBtn) tpPress('left', '按住左键');
});

tpPad?.addEventListener('pointermove', (e) => {
  /// 触屏模式：只更新指示点，抬手时才决定点按还是滑动
  if (tpAbsMode() && tpAbsStart) {
    updateCursorPos(e.clientX, e.clientY);
    paintTrace(e.clientX, e.clientY);
    return;
  }
  if (!tpActive || !tpPad) return;
  const cap = mouseCap();
  if (!cap.ok) return;
  const prev = tpPointers.get(e.pointerId);
  if (!prev) return;
  const dxPx = e.clientX - prev.x;
  const dyPx = e.clientY - prev.y;
  prev.x = e.clientX;
  prev.y = e.clientY;

  const w = tpPad.clientWidth || 1;
  const h = tpPad.clientHeight || 1;

  /// 双指：走滚轮，不动光标
  if (tpPointers.size >= 2) {
    tpWheelFromPinch(dyPx, dxPx);
    return;
  }

  /// 累计行程超过阈值才算「真的在移动」：既取消轻点，也取消按住判定，
  /// 否则用户小幅挪动后停住会凭空按下左键
  tpTravel += Math.abs(dxPx) + Math.abs(dyPx);
  if (tpTravel > TP_MOVE_SLOP && !tpMoved) {
    tpMoved = true;
    if (tpLongTimer) {
      clearTimeout(tpLongTimer);
      tpLongTimer = null;
    }
  }

  tpX = Math.max(0, Math.min(1, tpX + dxPx / w));
  tpY = Math.max(0, Math.min(1, tpY + dyPx / h));
  updateCursorPos();
  tpMove(dxPx, dyPx);
});

function tpEndPointer(e) {
  if (!tpPad) return;
  /// 触屏模式：抬手结算成点按或滑动，直接打到设备坐标
  if (tpAbsStart) {
    const s0 = tpAbsStart;
    tpAbsStart = null;
    clearTrace();
    tpPointers.delete(e.pointerId);
    tpPad.classList.remove('active');
    const dt = performance.now() - s0.t;
    const dist = Math.hypot(e.clientX - s0.x, e.clientY - s0.y);
    const a = absPoint(s0.x, s0.y);
    const b = absPoint(e.clientX, e.clientY);
    if (!a || !b) {
      log('还没读到屏幕分辨率，这一下没发出去', 'warn');
      return;
    }
    /// 原地按下不动 = 长按；轻点 = 点按；拖开 = 滑动
    if (dist < 12) {
      if (dt >= 700) {
        log(`已长按 ${a.x},${a.y}`, 'ok');
        buzz(8);
        void api('/api/swipe', { x1: a.x, y1: a.y, x2: a.x, y2: a.y, ms: Math.min(2000, Math.round(dt)) }, `长按 ${a.x},${a.y}`, true).catch((err) => log(err.message, 'err'));
      } else {
        log(`已点按 ${a.x},${a.y}`, 'ok');
        buzz(8);
        void api('/api/tap', { x: a.x, y: a.y }, `点按 ${a.x},${a.y}`, true).catch((err) => log(err.message, 'err'));
      }
      return;
    }
    log(`已滑动 ${a.x},${a.y} → ${b.x},${b.y}`, 'ok');
    buzz(8);
    void api('/api/swipe', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ms: Math.min(2000, Math.max(60, Math.round(dt))) }, '滑动', true).catch((err) => log(err.message, 'err'));
    return;
  }
  tpPointers.delete(e.pointerId);
  if (tpPointers.size >= 1) {
    tpActive = tpPointers.size > 0;
    return;
  }
  if (!tpActive) return;
  tpActive = false;
  tpPad.classList.remove('active');
  tpFlush();

  /// 抬起先松开按住的键，再决定要不要补一次点击：顺序反了就会既松右键又点左键
  const held = tpHoldBtn;
  const wasMoved = tpMoved;
  tpRelease();
  if (!held && !wasMoved) {
    void api('/api/mouse', { mode: 'click', btn: 'left' }, '左键点击', true)
      .then((r) => r && r.ok === false && log(r.detail || '左键点击没发出去', 'warn'))
      .catch(() => {});
  }
  tpMoved = false;
  tpTravel = 0;
}

/// pointercancel 表示浏览器接管或打断了这次手势，不能当作正常抬手结算。
/// 否则一次来电、滚动接管或系统手势都会在设备上凭空点一下。
function tpCancelPointer(e) {
  if (!tpPad) return;
  tpAbsStart = null;
  tpPointers.delete(e.pointerId);
  if (tpPointers.size) {
    tpActive = true;
    return;
  }
  clearTimeout(tpLongTimer);
  tpLongTimer = null;
  tpActive = false;
  tpMoved = false;
  tpTravel = 0;
  tpPendingX = 0;
  tpPendingY = 0;
  clearTimeout(tpFlushTimer);
  tpFlushTimer = null;
  clearTrace();
  tpPad.classList.remove('active');
  /// 已经按住的鼠标键必须释放，但不要再补发点击或滑动。
  tpRelease();
}

tpPad?.addEventListener('pointerup', tpEndPointer);
tpPad?.addEventListener('pointercancel', tpCancelPointer);

/// 滚轮：鼠标滚轮事件走 scroll 通路。passive:false 才允许 preventDefault，
/// 否则页面会在触控板下面跟着一起滚
const tpWheel = (e) => {
  if (!mouseCap().ok) return;
  e.preventDefault();
  const m = state?.mouse;
  if (e.deltaY) {
    const dir = e.deltaY > 0 ? 'down' : 'up';
    if (m?.wheel === false) return;
    void api('/api/mouse', { mode: 'scroll', dir, amount: Math.max(1, Math.round(Math.abs(e.deltaY) / 60)) }, `滚轮${dir}`, true).catch(() => {});
  } else if (e.deltaX && m?.hwheel) {
    const dir = e.deltaX > 0 ? 'right' : 'left';
    void api('/api/mouse', { mode: 'scroll', dir, amount: Math.max(1, Math.round(Math.abs(e.deltaX) / 60)) }, `横向滚轮${dir}`, true).catch(() => {});
  }
};
tpPad?.addEventListener('wheel', tpWheel, { passive: false });

/// 辅助按键：左/右/中/侧/前进 + 滚轮上下 + 左键按住开关。
/// 按这台设备实测到的能力动态启用，没有的键直接禁用并说明原因
const TP_BUTTONS = [
  { btn: 'left', label: '左键', cn: '左键' },
  { btn: 'right', label: '右键', cn: '右键' },
  { btn: 'middle', label: '中键', cn: '中键' },
  { btn: 'side', label: '后退', cn: '侧键' },
  { btn: 'extra', label: '前进', cn: '前进键' },
];

function buildTpAux() {
  if (!tpAux) return;
  tpAux.replaceChildren();
  for (const b of TP_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.tpClick = b.btn;
    btn.id = `tp-${b.btn}`;
    btn.textContent = b.label;
    tpAux.append(btn);
  }
  for (const dir of ['up', 'down']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.tpScroll = dir;
    btn.textContent = dir === 'up' ? '滚轮▲' : '滚轮▼';
    tpAux.append(btn);
  }
  const lock = document.createElement('button');
  lock.type = 'button';
  lock.className = 'chip';
  lock.id = 'tp-lock';
  lock.textContent = '按住左键';
  tpAux.append(lock);
}
buildTpAux();

tpAux?.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  /// 触屏模式：左键 = 点面板中心；滚轮 = 上下滑动一屏；其余键设备不支持
  if (tpAbsMode()) {
    if (b.dataset.tpClick === 'left') {
      const r = tpPad?.getBoundingClientRect();
      const p = r ? absPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      if (!p) return;
      const res = await api('/api/tap', { x: p.x, y: p.y }, '触屏点按', true).catch(() => null);
      if (res) log(res.detail || (res.ok ? `已点按 ${p.x},${p.y}` : '点按没发出去'), res.ok ? 'ok' : 'warn');
      return;
    }
    if (b.dataset.tpScroll) {
      const dir = b.dataset.tpScroll;
      const ny = state.screen.h;
      const nx = state.screen.w;
      const y1 = dir === 'up' ? Math.round(ny * 0.75) : Math.round(ny * 0.25);
      const y2 = dir === 'up' ? Math.round(ny * 0.25) : Math.round(ny * 0.75);
      const res = await api('/api/swipe', { x1: Math.round(nx / 2), y1, x2: Math.round(nx / 2), y2, ms: 260 }, `触屏滚动${dir}`, true).catch(() => null);
      if (res) log(res.detail || (res.ok ? `已向${dir === 'up' ? '下' : '上'}翻一屏` : '滚动没发出去'), res.ok ? 'ok' : 'warn');
      return;
    }
    return;
  }
  const cap = mouseCap();
  if (!cap.ok) {
    log(cap.why, 'warn');
    return;
  }
  if (b.id === 'tp-lock') {
    tpLockLeft = !tpLockLeft;
    b.classList.toggle('on', tpLockLeft);
    b.setAttribute('aria-pressed', String(tpLockLeft));
    if (!tpLockLeft) tpRelease();
    log(tpLockLeft ? '左键已设为按住模式：在触控板上拖动就是拖拽' : '左键按住模式已关闭', 'ok');
    return;
  }
  if (b.dataset.tpScroll) {
    const dir = b.dataset.tpScroll;
    const r = await api('/api/mouse', { mode: 'scroll', dir, amount: 3 }, `滚轮${dir}`, true).catch(() => null);
    if (r) log(r.detail || (r.ok ? `已滚轮${dir}` : '滚轮没发出去'), r.ok ? 'ok' : 'warn');
    return;
  }
  const btn = b.dataset.tpClick;
  const cn = TP_BUTTONS.find((x) => x.btn === btn)?.cn || btn;
  const r = await api('/api/mouse', { mode: 'click', btn }, `${cn}点击`, true).catch(() => null);
  if (r) log(r.detail || (r.ok ? `已${cn}点击` : `${cn}没发出去`), r.ok ? 'ok' : 'warn');
});

/// 触控板的能力说明、禁用态、辅助按键可用性：跟着每次状态刷新回填，不额外开请求
function paintTouchpad(s) {
  const size = $('#touchpad-size');
  const capEl = $('#tp-cap');
  const m = s?.online ? s.mouse : null;
  const hasMouse = m?.via === 'evdev';
  const hasScreen = !!(s?.screen?.w && s?.screen?.h);
  const dead = !s?.online || (!hasMouse && !hasScreen);
  if (tpPad) {
    tpPad.classList.toggle('off', dead);
    tpPad.classList.toggle('absolute', !dead && !hasMouse);
    tpPad.setAttribute('aria-disabled', String(dead));
    /// 切走设备或换到有鼠标驱动的设备时，别把上一条轨迹留在板上
    if (hasMouse || dead) clearTrace();
  }
  if (!hasMouse) tpRelease();
  if (size) {
    size.textContent = !s?.online
      ? '设备离线'
      : !m
        ? '读取能力中…'
        : hasMouse
          ? m.note || '触控板'
          : hasScreen
            ? '触屏模式 · 点哪点哪'
            : '无鼠标驱动 · 无分辨率';
    size.classList.toggle('warn', !!s?.online && !hasMouse && !hasScreen);
  }
  if (capEl) {
    if (!s?.online) {
      capEl.textContent = '连上后可直接当触控板用。';
      capEl.title = '';
    } else if (dead) {
      capEl.textContent = '读不到鼠标驱动和屏幕分辨率，触控板用不了。';
      capEl.title = '';
    } else if (hasMouse) {
      /// 右上角已写「触控板」或设备实测的鼠标名，这里再平铺手势
      /// 只是在复述。手势全收进悬停提示，面板本身已经可试出来。
      capEl.textContent = '';
      capEl.title = '拖动移动光标 · 轻点=左键 · 按住 350ms 锁住按键 · 双指或滚轮滚动';
    } else {
      capEl.textContent = '';
      capEl.title = `触屏模式：面板就是设备整块屏幕（${s.screen.w}×${s.screen.h}），点在哪就点设备上的哪，按住 350ms 长按`;
    }
  }
  if (!tpAux) return;
  const buttons = hasMouse ? m.buttons || {} : {};
  const cnOf = (id) => TP_BUTTONS.find((x) => x.btn === id)?.cn || '这个键';
  for (const b of $$('button', tpAux)) {
    /// 触屏模式只留真正能用的键：左键 + 上/下翻页。
    /// 其余键在设备上没有对应驱动，摆一排灰按钮只会让人以为「面板坏了」
    b.hidden = !hasMouse && !(b.dataset.tpClick === 'left' || b.dataset.tpScroll);
    if (b.hidden) continue;
    if (b.dataset.tpClick) {
      if (hasMouse) {
        const has = buttons[b.dataset.tpClick] !== undefined;
        b.disabled = !has;
        b.title = has ? '' : (m.name || '设备鼠标') + ' 没有' + cnOf(b.dataset.tpClick);
      } else {
        const canTap = hasScreen && b.dataset.tpClick === 'left';
        b.disabled = !canTap;
        b.title = canTap ? '按指尖当前位置点一下' : '设备没有鼠标驱动，这个键发不出去';
      }
    } else if (b.dataset.tpScroll) {
      const vertical = b.dataset.tpScroll === 'up' || b.dataset.tpScroll === 'down';
      if (hasMouse) {
        b.disabled = !(vertical ? m.wheel : m.hwheel);
        b.title = b.disabled ? (vertical ? '垂直' : '水平') + '滚轮不支持' : '';
        b.textContent = b.dataset.tpScroll === 'up' ? '滚轮▲' : '滚轮▼';
      } else {
        b.disabled = !(hasScreen && vertical);
        b.title = b.disabled ? '设备没有滚轮，也读不到分辨率' : '设备没有滚轮：改用屏幕滑动，效果一样';
        b.textContent = b.dataset.tpScroll === 'up' ? '上翻' : '下翻';
      }
    } else {
      b.disabled = !hasMouse;
      b.title = hasMouse ? '开着时：在触控板上拖动就是拖拽' : '拖拽需要鼠标驱动，设备没有';
    }
  }
  if (!hasMouse) {
    tpLockLeft = false;
    const lock = $('#tp-lock');
    if (lock) {
      lock.classList.remove('on');
      lock.setAttribute('aria-pressed', 'false');
    }
  }
}



const textInput = $('#textin');
async function sendText(submit) {
  const v = textInput.value;
  if (!v.trim()) {
    log('先输入要发送的文字', 'warn');
    textInput.focus();
    return;
  }
  const label = v.length > 14 ? `发送文字「${v.slice(0, 14)}…」` : `发送文字「${v}」`;
  const r = await api('/api/text', { text: v, submit }, label);
  log(r.detail || (r.ok ? '已发送' : '没发出去'), r.ok ? 'ok' : 'warn');
  /// 成功的才清空：失败时把内容留着，用户改一个字就能重发，不用重打
  if (r.ok) textInput.value = '';
  else textInput.select();
}

textInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  void sendText(false).catch((err) => log(err.message, 'err'));
});
/// 发送、回车、退格、全删四颗按钮都要接上。这段之前被一次误粘贴盖掉了：
/// 残留的半截函数体在顶层引用 r，抛 ReferenceError 后整份 app.js 从这里起全不执行
$('#btn-text-send').onclick = () => void sendText(false).catch((err) => log(err.message, 'err'));

const editDevice = (action, label) =>
  api('/api/text', { action }, label)
    .then((r) => log(r.detail, r.ok ? 'ok' : 'warn'))
    .catch((err) => log(err.message, 'err'));
$('#btn-text-enter').onclick = () => editDevice('enter', '设备回车');
$('#btn-text-del').onclick = () => editDevice('backspace', '设备退格');
$('#btn-text-clear').onclick = () => editDevice('clear', '清空设备输入框');

/// 截图：截图本身走 /device.jpg（adb screencap 一帧），存成带序列号与时间戳的文件名。
/// 文件名带上设备与时间，一次截多台设备的图不会互相盖掉
$('#btn-shot').onclick = async () => {
  const b = $('#btn-shot');
  if (!state?.online) {
    log('设备离线，截不到画面', 'warn');
    return;
  }
  const old = b.textContent;
  b.disabled = true;
  b.textContent = '截图中';
  try {
    const r = await fetch(srv(`/device.jpg?_=${Date.now()}`), { cache: 'no-store' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const serial = String(state.profile?.serial || 'device').replace(/[^\w.-]/g, '_');
    const name = `tvdeck-${serial}-${stamp}.png`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    log(`截图已保存 ${name}（${Math.round(blob.size / 1024)} KB）`, 'ok');
  } catch (err) {
    log(`截图失败：${err.message}`, 'err');
  } finally {
    b.disabled = false;
    b.textContent = old;
  }
};

/// 顶部那一条的高度写进 --top-h。
/// 上排只剩两种形态：窄屏是屏幕底部的固定横条（不在这一条里），
/// 900 起并进 app bar 同一条；两种情况下 .p-top 量出来都是「顶部这一条」的真实高度，
/// 不用再按 .p-head + .tabs 相加（display:contents 之后那样量不准）
const measureTop = () => {
  const top = $('#ptop');
  if (!top) return;
  // 1180 起导航变成左侧竖栏，p-top 因 display:contents 量出来是 0；
  // 内容列的顶边此时由第一块内容的真实位置决定，不能再沿用「顶部栏高度」。
  const wide = matchMedia('(min-width: 1180px)').matches;
  if (wide) {
    const first = top.parentElement.querySelector('.pane.on');
    const paneTop = first ? first.getBoundingClientRect().top : top.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty('--top-h', `${Math.max(0, Math.round(paneTop - top.getBoundingClientRect().top))}px`);
    return;
  }
  document.documentElement.style.setProperty('--top-h', `${Math.round(top.getBoundingClientRect().height)}px`);
};
measureTop();
window.addEventListener('resize', measureTop);
/// 抽屉只在窄导航布局里有意义。窗口拖宽后入口消失，
/// 状态残留会让「更多」面板一直挂在宽屏上，这里顺手收掉。
window.addEventListener('resize', () => {
  if (moreOpen && matchMedia('(min-width: 1180px)').matches) setMore(false);
});
window.addEventListener('resize', () => {
  if (theater) repaintStage();
});
/// 窗口一高一矮，应用页铺得下几行也跟着变。
/// 只在应用页露着、而且格数真的变了的时候重画：不然拖着窗口边缘改大小会一路重排列表。
/// 用户自己点过「展开全部」就听用户的，不再按窗口收回
window.addEventListener('resize', () => {
  if (curTab !== 'apps' || appsAll) return;
  const apps = state?.profile.apps ?? [];
  if (!apps.length) return;
  const fit = appFitCount(apps);
  /// fit 为 0 表示这一帧量不到，保持现在的样子
  if (fit && Math.min(fit, apps.length) !== appsShown) renderApps();
});
/// 内置浏览器里原生全屏进出时，改动可能只体现在 visualViewport 上，
/// 光听 window resize 会漏掉一次，虚线框就停在旧尺寸
window.visualViewport?.addEventListener('resize', () => {
  if (theater) repaintStage();
});
paintTvBtns();
if (window.ResizeObserver) {
  const ro = new ResizeObserver(measureTop);
  ro.observe($('.p-head'));
  ro.observe($('#tabs'));
}

/// 服务器上的 app.js 一改，这个标记跟着改。页面定期取一份比对：
/// 不一致就说明手里这份是旧的，直接给一个按一下就能刷新的入口，
/// 省得用户对着老页面反复描述「还是不行」
const staleBar = document.createElement('button');
staleBar.type = 'button';
staleBar.id = 'stale';
staleBar.className = 'stale';
staleBar.hidden = true;
staleBar.textContent = '↻ 有新版本，点这里立即换新';
staleBar.title = '手里这份是旧版页面，点这里立即换新';
staleBar.onclick = () => location.reload();

/// 内置浏览器恢复标签页时不会重新拉 index.html，用户看到的是上一次的页面，
/// 「明明改了怎么还是老样子」多半是这么来的。所以检出旧版之后自己换一份：
/// 切到后台立刻换，在前台则等停手（不打断正在拖的画面和正在填的输入框）。
/// 记号记的是「为了离开哪个版本，已经换过几次」：万一换回来的那份仍然旧
/// （发布那一瞬间服务正在重启，页面又抓回了旧 app.js），换满 3 次就收手只留按钮，
/// 免得两边版本号一直对不上时来回刷屏；服务器上换了新版本，计数重新开始
const RELOADED_KEY = 'tvdeck.autoReloaded';
const RELOAD_IDLE_MS = 8000;
const RELOAD_TRY_MAX = 3;
let staleSeen = false;
let reloadTimer = 0;
let seenEtag = '';
let lastWatch = 0;

/// 更早的版本在 sessionStorage 里只存过一个裸版本号（先存过 '1'，后来存过 BUILD）：
/// 一起读成「已经换过 1 次」，用户手里那份老页面也能自己走完这一轮自愈
function reloadMark() {
  try {
    const raw = sessionStorage.getItem(RELOADED_KEY) || '';
    if (raw.startsWith('{')) {
      const o = JSON.parse(raw);
      return { from: String(o.from || ''), tries: Number(o.tries) || 0 };
    }
    return { from: raw, tries: raw ? 1 : 0 };
  } catch {
    return { from: '', tries: 0 };
  }
}

function markReloaded(from) {
  try {
    const old = reloadMark();
    const tries = old.from === from ? old.tries + 1 : 1;
    sessionStorage.setItem(RELOADED_KEY, JSON.stringify({ from, tries }));
  } catch {}
}

function clearReloadMark() {
  try {
    sessionStorage.removeItem(RELOADED_KEY);
  } catch {}
}

/// 这份页面还能不能自己换：同一个旧版本换到第 3 次就停下，只留按钮
function mayAutoReload() {
  const mk = reloadMark();
  return mk.from !== BUILD || mk.tries < RELOAD_TRY_MAX;
}

/// 光标在输入框里、而且填的东西还没落盘：这时候把页面换掉会把人家打了一半的
/// 设备名吞掉（设备名是 blur 那一下才写进 localStorage 的）。
/// 反过来，只是点了一下设备名、内容一个字没改，不算「正在输入」——
/// 以前这里只看 activeElement，光标一落在设备名上页面就再也不会自己换新了，
/// 「明明改了怎么还是老样子」就是走的这条路
const focusSeed = new WeakMap();
const isEditor = (el) =>
  !!el && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
const editorValue = (el) =>
  el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
    ? el.value
    : el.textContent;

document.addEventListener(
  'focusin',
  (e) => {
    if (isEditor(e.target)) focusSeed.set(e.target, editorValue(e.target));
  },
  true,
);

function editInProgress() {
  const ae = document.activeElement;
  if (!isEditor(ae)) return false;
  const seed = focusSeed.get(ae);
  return seed !== undefined && editorValue(ae) !== seed;
}

async function watchBuild() {
  lastWatch = Date.now();
  try {
    /// 不带随机参数、走 no-cache：服务器没改过时由浏览器带上 If-None-Match，
    /// 换回一个空的 304，网络上零字节。
    /// （以前拼了 ?_=时间戳，等于每 45 秒把整份 250KB 脚本重下一遍）
    const r = await fetch('/app.js', { cache: 'no-cache' });
    if (!r.ok) return;
    const etag = r.headers.get('etag') || '';
    if (etag && etag === seenEtag) return;
    seenEtag = etag;
    const m = /const BUILD = ["'](\d{8}-\d{4})["']/.exec(await r.text());
    if (!m) return;
    if (m[1] === BUILD) {
      /// 手里这份就是最新的：把记号清掉，下次发布还能自愈一次
      clearReloadMark();
      return;
    }
    if (!staleBar.isConnected) document.body.append(staleBar);
    staleBar.hidden = false;
    staleSeen = true;
    const auto = mayAutoReload();
    staleBar.title = auto
      ? '手里这份是旧版页面，停手后会自动换新，等不及点这里'
      : '自动换新没成功，点这里立即刷新';
    if (auto) armAutoReload();
  } catch {
    /* 断网或服务正在重启：安静跳过，下一轮再说 */
  }
}

function autoReloadSafe() {
  if (document.hidden) return true;
  /// 全屏看画面、开着抽屉、正在改还没提交的字：都不适合当着用户的面把页面换掉
  if (document.fullscreenElement) return false;
  if (opsOpen || moreOpen) return false;
  return !editInProgress();
}

/// 排一轮：静默满 8 秒且当下安全就换，否则下一轮再看
function armAutoReload() {
  clearTimeout(reloadTimer);
  if (!mayAutoReload()) return;
  reloadTimer = setTimeout(() => {
    if (!autoReloadSafe()) return armAutoReload();
    markReloaded(BUILD);
    location.reload();
  }, RELOAD_IDLE_MS);
}

/// 用户一有动作就把等待重新计时：所谓「停手」是这个意思。
/// 顺手补一次版本比对（10 秒内最多一次）：用户刚碰过页面，正是最该知道自己
/// 看的是旧版的时候，不必干等那一轮 45 秒的巡检
function checkBuildSoon() {
  const now = Date.now();
  if (now - lastWatch < 10000) return;
  void watchBuild();
}

for (const ev of ['pointerdown', 'keydown', 'wheel', 'input']) {
  document.addEventListener(
    ev,
    () => {
      if (staleSeen) armAutoReload();
      checkBuildSoon();
    },
    { capture: true, passive: true },
  );
}

setTimeout(watchBuild, 5000);
setInterval(watchBuild, 45000);
/// 从别的窗口或别的应用切回来：先查一次再谈别的
window.addEventListener('focus', checkBuildSoon);
/// 切回前台先查一次：用户离开那段时间发布的版本，回来就能看到
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    /// 人不在看，直接换掉最省事；回来第一眼就是新版
    if (staleSeen && mayAutoReload() && autoReloadSafe()) {
      markReloaded(BUILD);
      location.reload();
    }
    return;
  }
  void watchBuild();
});
/// bfcache 回来的页面连 visibilitychange 都可能省掉，这里补一次。
/// 只在从缓存里翻回来时才查：正常的首次加载也会派 pageshow，那不是 bfcache，
/// 5 秒后的那次定时查已经覆盖了，何必再多下一份 app.js
window.addEventListener('pageshow', (e) => {
  if (e.persisted) void watchBuild();
});

// ---------------------------------------------------------------- 触屏说明浮层
/// 精简文字时把机制解释折进了 title，但触屏（手机、大屏浏览器）没有 hover，
/// 那些字就等于删掉了。这里补一层：点一下带说明的元素，就地弹出全文。
/// 只在「没有悬停能力」的设备上生效：鼠标端原生 tooltip 够用，而且点一下先弹层
/// 会挡住紧接着的第二次点击。禁用的按钮也管：它点不动，正需要知道为什么。
const NO_HOVER = matchMedia('(hover: none)').matches;

function tipBox() {
  let el = $('#tipbox');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'tipbox';
  el.setAttribute('role', 'tooltip');
  el.hidden = true;
  document.body.append(el);
  return el;
}

function hideTip() {
  const el = $('#tipbox');
  if (el) el.hidden = true;
}

function showTip(anchor, text) {
  const el = tipBox();
  el.anchor = anchor;
  el.textContent = text;
  el.hidden = false;
  /// 先量尺寸再定位：hidden 时量出来是 0
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const pad = 10;
  let x = r.left + r.width / 2 - w / 2;
  x = Math.max(pad, Math.min(x, innerWidth - w - pad));
  /// 默认放在元素下方，放不下（贴近屏幕底）就翻到上方；两边都放不下时
  /// 夹回视口内 —— 锚点在长列表边缘时，宁可浮层压住一点内容，也不能弹到看不见的地方
  let y = r.bottom + 8;
  if (y + h > innerHeight - pad) y = r.top - h - 8;
  y = Math.max(pad, Math.min(y, innerHeight - h - pad));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  clearTimeout(showTip.timer);
  showTip.timer = setTimeout(hideTip, 6000);
}

if (NO_HOVER) {
  /// 用「起笔—抬笔」判定一次点按，而不是听 click：禁用控件在真实触屏上只派
  /// pointerdown/pointerup，click 被浏览器吞掉，而点不动的按钮恰恰最需要看说明
  let press = null;

  document.addEventListener(
    'pointerdown',
    (e) => {
      const box = $('#tipbox');
      const inBox = e.target instanceof Element && box && !box.hidden && box.contains(e.target);
      /// 这一下如果正落在「当前浮层所属的元素」上，先别收：抬笔时按开合切换处理
      const sameAnchor = !!box && !box.hidden && e.target instanceof Element && e.target.closest('[title]') === box.anchor;
      /// 按到别处先收起，再让这一下去干自己的事；浮层里按住（想选文字）不收
      if (!inBox && !sameAnchor) hideTip();
      press =
        inBox || !(e.target instanceof Element)
          ? null
          : { x: e.clientX, y: e.clientY, t: Date.now(), sameAnchor };
    },
    true,
  );

  document.addEventListener(
    'pointerup',
    (e) => {
      const p0 = press;
      press = null;
      if (!p0 || !(e.target instanceof Element)) return;
      if (e.target.closest('#tipbox')) return;
      /// 滑动、长按不算点按：挪得太远或按得太久就放弃弹层
      if (Date.now() - p0.t > 600) return;
      if (Math.abs(e.clientX - p0.x) > 12 || Math.abs(e.clientY - p0.y) > 12) return;
      /// 再点同一处收起：触屏没有「移开鼠标」这个动作
      if (p0.sameAnchor) {
        hideTip();
        return;
      }
      /// 设备画面上的点击是发给设备的，不弹页面浮层
      if (e.target.closest('.tv-screen')) return;
      const el = e.target.closest('[title]');
      if (!el || !el.title) return;
      /// 能点的控件：这一下已经执行了动作，再弹层只是挡视线
      const ctrl = e.target.closest('button, a, input, select, textarea, label, [role="button"]');
      if (ctrl && !ctrl.disabled) return;
      showTip(el, el.title);
    },
    true,
  );

  addEventListener('scroll', hideTip, true);
  addEventListener('resize', hideTip);
}
