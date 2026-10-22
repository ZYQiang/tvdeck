import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, under } from './home.ts';
import { Adb } from './adb.ts';
import { iconIndex } from './icons.ts';
import { fillLabels, searchKey } from './names.ts';
import type { DeviceProfile } from './profile.ts';

/// 系统级管理：启动项、默认桌面、开机自启。
/// 设计原则 —— 不假设厂商、不假设 root：
///   1. 只走 AOSP 公开接口（cmd package / pm / settings / PackageManager）
///   2. 每条能力先探测再执行，探测结果如实回给页面（不支持就直说不支持）
///   3. 所有写操作都做状态回读，读不回来就标 verified:false
///   4. 任何破坏性动作都先存快照，页面上一键还原

export interface OpResult {
  ok: boolean;
  command: string;
  detail: string;
  verified: boolean;
}

const PKG_RE = /^[A-Za-z0-9._-]+$/;
const COMPONENT_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._$-]+$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shq = (p: string) => `'${String(p).replace(/'/g, `'\\''`)}'`;

const FAIL_RE = /Error|Exception|SecurityException|not found|Unknown command|Permission Denial/i;

/// "com.pkg/.Cls" / "com.pkg/Cls" → "com.pkg.Cls"。
/// dumpsys 的 disabledComponents 段用的是全限定类名，不做这步归一就永远比对不上。
export function expandComponent(component: string): string {
  const [pkg, cls = ''] = component.split('/');
  if (!pkg) return component;
  if (cls.startsWith('.')) return `${pkg}${cls}`;
  if (cls.includes('.')) return cls;
  return cls ? `${pkg}.${cls}` : pkg;
}

export const badPkg = (pkg: string): OpResult | null =>
  PKG_RE.test(pkg) ? null : { ok: false, command: `校验包名 ${pkg}`, detail: '包名字符不合法，拒绝执行', verified: false };

export const badComponent = (c: string): OpResult | null =>
  COMPONENT_RE.test(c) ? null : { ok: false, command: `校验组件 ${c}`, detail: '组件名格式应为 package/Activity', verified: false };

// ---------------------------------------------------------------- 能力探测

export interface Capability {
  key: 'startup' | 'home' | 'autostart';
  label: string;
  level: 'full' | 'partial' | 'none';
  detail: string;
  evidence: string;
}

export interface DeviceFacts {
  sdk: number;
  release: string;
  buildType: string;
  isRoot: boolean;
  canSu: boolean;
  suForm: string;
  hasCmdPackage: boolean;
  hasSetHome: boolean;
  hasQueryReceivers: boolean;
  hasDisableUser: boolean;
  hasAppOps: boolean;
  userCount: number;
  /// 当前前台用户。多用户设备（部分电视有儿童模式/访客用户）上不是 0，
  /// 所有 --user 都要用它，写死 0 会改错用户的设置。
  userId: number;
  /// cmd role 可用时是切 HOME 的第二条通路（部分 ROM 的 set-home-activity 被裁掉）
  hasRole: boolean;
  /// query-receivers/query-activities 支持 --query-flags。
  /// 能带 MATCH_DISABLED_COMPONENTS(512) 就可以一条命令列出「含已禁用」的组件，
  /// 不必去解析几万行的 dumpsys，而且关掉的项仍然在列表里（可逆性靠它）。
  hasQueryFlags: boolean;
  /// secure 表可写 = 不用 root 也能开无障碍豁免（开机自启的后台启动豁免靠它）
  secureWritable: boolean;
  note: string;
}

/// 提权形式不能写死：AOSP 的 su 收的是 "user [command]"，而很多定制 ROM 的
/// su 是 busybox 风格（只认 -c）。这里逐个真跑一次 id，谁能出 uid=0 就用谁。
const SU_FORMS = ['su 0 sh -c %s', 'su root sh -c %s', 'su -c %s'];

export async function suFormOf(adb: Adb): Promise<string> {
  for (const form of SU_FORMS) {
    const probe = form.replace('%s', shq('id'));
    const r = await adb.shellAsync(`${probe} 2>&1`, 8000);
    if (/uid=0\(root\)/.test(r.stdout)) return form;
  }
  return '';
}

/// 一次性把这台设备的"能做哪些事"摸清楚，后面所有动作都按这些事实分支。
/// 不写任何厂商判断 —— 康佳/小米/索尼走的是同一套探测。
/// 探测要跑十来条 shell，缓存 30 秒：一次列表 + 连点几个开关不会重复探测，
/// 但 root/非 root 状态变了（adb root / unroot）30 秒后自然跟上。
const factsCache = new Map<string, { at: number; facts: DeviceFacts }>();
const FACTS_TTL = 30000;

export async function deviceFacts(adb: Adb, fresh = false): Promise<DeviceFacts> {
  const hit = factsCache.get(adb.serial);
  if (!fresh && hit && Date.now() - hit.at < FACTS_TTL) return hit.facts;

  const [sdk, release, buildType, id, cmdPkg, pmHelp, users, appops, curUser, role, secureWrite] = await Promise.all([
    adb.shellAsync('getprop ro.build.version.sdk', 8000),
    adb.shellAsync('getprop ro.build.version.release', 8000),
    adb.shellAsync('getprop ro.build.type', 8000),
    adb.shellAsync('id', 8000),
    /// 帮助有 592 行，任何 head 截断都会把 set-home-activity 这类靠后的子命令切掉
    adb.shellAsync('cmd package 2>&1', 15000),
    adb.shellAsync('pm 2>&1', 15000),
    adb.shellAsync('cmd user list 2>/dev/null || pm list users 2>&1', 12000),
    adb.shellAsync('appops 2>&1 | head -3', 10000),
    /// am get-current-user 是 Android 7+ 的命令；更老的设备读 dumpsys user
    adb.shellAsync('am get-current-user 2>/dev/null || dumpsys user 2>/dev/null | sed -n "s/^Current user: *\\([0-9][0-9]*\\).*/\\1/p"', 12000),
    adb.shellAsync('cmd role 2>&1 | head -3', 10000),
    /// 写一次再删掉，看 secure 表是不是 shell 可写（Android 4.2+ 一般都可写）
    adb.shellAsync('settings put secure tvdeck_probe 1 2>&1 && settings delete secure tvdeck_probe 2>&1', 12000),
  ]);

  const cmdHelp = cmdPkg.stdout;
  /// pm 是 cmd package 的别名，两边的子命令集合要合起来看
  const pmHelpText = pmHelp.stdout;
  const has = (k: string) => new RegExp(`^\\s+${k}\\b`, 'm').test(cmdHelp) || new RegExp(`^\\s+${k}\\b`, 'm').test(pmHelpText);
  const userLines = (users.stdout.match(/UserInfo\{/g) ?? []).length;
  const suForm = await suFormOf(adb);
  const userId = Number(curUser.stdout.trim().match(/^\d+$/)?.[0] ?? '') || 0;
  /// --query-flags 在 Android 7.0(N) 随 cmd package 一起进来；老设备只有 pm 的实现没有这个开关。
  /// 这里看帮助文本而不是看版本号：定制 ROM 会自己裁子命令。
  const hasQueryFlags = /--query-flags/.test(cmdHelp) || /--query-flags/.test(pmHelpText);

  const facts: DeviceFacts = {
    sdk: Number(sdk.stdout.trim()) || 0,
    release: release.stdout.trim(),
    buildType: buildType.stdout.trim(),
    isRoot: /uid=0/.test(id.stdout),
    canSu: suForm !== '',
    suForm,
    hasCmdPackage: /Package manager \(package\) commands/i.test(cmdHelp),
    hasSetHome: has('set-home-activity'),
    hasQueryReceivers: has('query-receivers'),
    hasDisableUser: has('disable-user'),
    hasAppOps: /AppOps service \(appops\) commands/i.test(appops.stdout),
    userCount: userLines || 1,
    userId,
    hasRole: /Role \(role\) commands/i.test(role.stdout),
    hasQueryFlags,
    secureWritable: !/Error|Exception|Permission Denial|not allowed/i.test(secureWrite.stdout + secureWrite.stderr),
    note: '',
  };
  factsCache.set(adb.serial, { at: Date.now(), facts });
  return facts;
}

/// 三项能力的可用性分级。分级只依据上面探测到的客观事实，不猜厂商。
export async function capabilities(adb: Adb, fresh = false): Promise<{ facts: DeviceFacts; items: Capability[] }> {
  const f = await deviceFacts(adb, fresh);
  /// 关自启有两条路，能走通哪条取决于权限：
  ///   组件级（只掐 boot receiver）—— 实测非 root shell 必被 SecurityException 拒，需要 root/su
  ///   包级 disable-user（整个应用停用）—— 非 root shell 就能做，但影响面大
  const compLevel = f.isRoot || f.canSu;
  const pkgLevel = f.hasDisableUser;
  const shellCanManage = compLevel || pkgLevel;

  const items: Capability[] = [
    {
      key: 'home',
      label: '默认桌面',
      level: f.hasSetHome ? 'full' : 'partial',
      detail: f.hasSetHome
        ? '可直接指定，也能还原'
        : f.hasRole
          ? '改走系统角色管理'
          : '只能清默认值后重选',
      evidence: `SDK ${f.sdk} · ${f.hasSetHome ? '可指定桌面' : f.hasRole ? '需走角色管理' : '只能清默认值'}`,
    },
    {
      key: 'startup',
      label: '启动项管理',
      level: compLevel ? 'full' : shellCanManage ? 'partial' : 'none',
      detail: shellCanManage
        ? `逐个开关 · ${compLevel ? '只掐开机接收者' : '停用整个应用'}`
        : '无停用与提权入口，改不了',
      evidence: `${f.hasDisableUser ? '可停用应用' : '不能停用应用'} · 权限=${f.isRoot ? '已有' : f.canSu ? '可提权' : '无'} · 禁用项可查=${f.hasQueryFlags ? '是' : '否'}`,
    },
    {
      key: 'autostart',
      label: '开机自动打开应用',
      level: 'full',
      detail: '随包组件实现',
      evidence: `8.0~14 重启验证 · 安全设置可写=${f.secureWritable ? '是' : '否'}`,
    },
  ];
  return { facts: f, items };
}

// ---------------------------------------------------------------- 默认桌面

export interface HomeCandidate {
  component: string;
  package: string;
  label: string;
  isCurrent: boolean;
  isFallback: boolean;
  isSystem: boolean;
}

export interface HomeState {
  current: string;
  candidates: HomeCandidate[];
  roleHolders: string[];
  canSet: boolean;
  backup: { original?: string; at?: string };
  ms: number;
  note: string;
  /// 切换时实际会走哪条通路（页面显示给用户看，出问题时也知道去哪儿查）
  method: string;
}

/// HOME 候选：query-activities 是 Android 7.0+ 的标准查询，
/// 比解析 dumpsys 稳（dumpsys 输出格式各版本差异大）。
export async function homeState(adb: Adb, profile: DeviceProfile): Promise<HomeState> {
  const t0 = Date.now();
  const facts = await deviceFacts(adb);
  const u = facts.userId;
  /// 同 startup：cmd package 是主路径，pm 只在连 cmd 都没有的老设备上兜底。
  /// 实测 Android 8.0 的 pm 没有 resolve-activity/query-activities。
  const q = facts.hasCmdPackage ? 'cmd package' : 'pm';
  const [list, cur, role, sys] = await Promise.all([
    adb.shellAsync(`${q} query-activities --brief --components -a android.intent.action.MAIN -c android.intent.category.HOME --user ${u} 2>&1`, 30000),
    adb.shellAsync(`${q} resolve-activity --brief --components -a android.intent.action.MAIN -c android.intent.category.HOME --user ${u} 2>&1`, 30000),
    /// role 是 Android 10+ 才有的；老设备这条会报错，下面按空处理
    facts.hasRole
      ? adb.shellAsync(`cmd role get-role-holders android.app.role.HOME --user ${u} 2>&1`, 15000)
      : Promise.resolve({ stdout: '', stderr: '', code: 1, ok: false }),
    adb.shellAsync('pm list packages -s', 30000),
  ]);

  const current = parseComponentLine(cur.stdout);
  const systemPkgs = new Set(
    sys.stdout
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const candidates: HomeCandidate[] = [];
  for (const component of parseComponents(list.stdout)) {
    if (seen.has(component)) continue;
    seen.add(component);
    const pkg = component.split('/')[0];
    candidates.push({
      component,
      package: pkg,
      label: pkg,
      isCurrent: component === current || current.startsWith(`${pkg}/`),
      isFallback: /FallbackHome|fallback/i.test(component),
      isSystem: systemPkgs.has(pkg),
    });
  }
  // 名字统一走 src/names.ts：图标索引 / APK 解析缓存 / profile 真名，都没有就解析一次
  await fillLabels(adb, candidates, (c) => c.package, profile);

  const roleHolders = role.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && PKG_RE.test(l));

  /// 选哪条通路：能力探测的结果决定，页面把 method 显示出来
  const method = facts.hasSetHome
    ? '系统标准接口指定'
    : facts.hasRole
      ? '系统角色管理指定'
      : '清除默认值后重新选择';

  return {
    current,
    candidates,
    roleHolders,
    canSet: candidates.length > 0,
    /// 还原点跟着状态一起回给页面：切过桌面之后，「还原原桌面」才知道该回到哪
    backup: readHomeBackup(),
    ms: Date.now() - t0,
    method,
    note: candidates.length
      ? `${candidates.length} 个桌面候选${roleHolders.length ? ` · 角色持有 ${roleHolders.join('、')}` : ''}`
      : '没有查到桌面候选，可能未开放组件查询',
  };
}

/// 从 pm/cmd package 的输出里抠出所有 "pkg/Class"。两种格式都认：
///   --brief --components  →  一行一个 "com.pkg/.Cls"（新老设备都支持，主路径）
///   非 brief              →  "name=<全限定类名>" 后面跟着 "packageName=<包名>" 块
///                            （少数 ROM 会忽略 --brief，靠这条兜底）
export function parseComponents(text: string): string[] {
  const out: string[] = [];
  let pendingClass = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const brief = line.match(/^([A-Za-z][\w.]*)\/(\S+)$/);
    if (brief) {
      out.push(`${brief[1]}/${brief[2]}`);
      continue;
    }
    const name = line.match(/^name=([A-Za-z][\w.$]*)$/);
    if (name) {
      pendingClass = name[1];
      continue;
    }
    const pkg = line.match(/^packageName=([A-Za-z][\w.]*)$/);
    if (pkg && pendingClass) {
      /// 全限定类名去掉包名前缀就是相对类名，拼回 "pkg/.Cls" 统一格式
      const cls = pendingClass.startsWith(`${pkg[1]}.`) ? pendingClass.slice(pkg[1].length) : `/${pendingClass}`;
      out.push(`${pkg[1]}${cls.startsWith('/') ? cls : `/${cls}`}`);
      pendingClass = '';
    }
  }
  return out;
}

/// 单行版本：只要第一个组件（读"当前桌面"用）
export function parseComponentLine(line: string): string {
  return parseComponents(line)[0] ?? '';
}

/// 设置默认桌面。Android 7.0+ 用 set-home-activity；
/// 没有这个子命令的老设备回退到清掉 preferred 记录后让系统重新弹选择。
/// 无论走哪条，都把改之前的值记进 .tvdeck/home-backup.json，页面上一键还原。
export async function setHomeActivity(adb: Adb, component: string): Promise<OpResult & { previous?: string }> {
  const bad = badComponent(component);
  if (bad) return bad;
  const pkg = component.split('/')[0];
  if (!PKG_RE.test(pkg)) return { ok: false, command: `set-home ${component}`, detail: '包名字符不合法', verified: false };
  const facts = await deviceFacts(adb);
  const u = facts.userId;
  const q = facts.hasCmdPackage ? 'cmd package' : 'pm';
  const resolveCmd = `${q} resolve-activity --brief --components -a android.intent.action.MAIN -c android.intent.category.HOME --user ${u} 2>&1`;
  const readCurrent = async () => parseComponentLine((await adb.shellAsync(resolveCmd, 20000)).stdout);

  const before = await readCurrent();
  if (before) backupHome(before);

  let cmd: string;
  let out = '';
  /// 通路 1：set-home-activity（Android 7.0+ 标准接口，最干净）
  if (facts.hasSetHome) {
    cmd = `cmd package set-home-activity --user ${u} ${shq(component)}`;
    const r = await adb.shellAsync(cmd, 25000);
    out = (r.stdout + r.stderr).trim();
    if (FAIL_RE.test(out)) return { ok: false, command: cmd, detail: out.slice(0, 240), verified: false, previous: before };
  } else if (facts.hasRole) {
    /// 通路 2：HOME 角色。部分 ROM 裁掉了 set-home-activity 但保留了 role。
    /// 注意 role 的 USER_ID 是位置参数，写成 --user 0 会被当成数字解析而报 NumberFormatException。
    cmd = `cmd role add-role-holder android.app.role.HOME ${shq(pkg)} ${u}`;
    const r = await adb.shellAsync(cmd, 25000);
    out = (r.stdout + r.stderr).trim();
    if (FAIL_RE.test(out)) return { ok: false, command: cmd, detail: out.slice(0, 240), verified: false, previous: before };
  } else {
    /// 通路 3：老设备回退 —— 清掉 HOME 的 preferred 记录，再显式启动目标桌面
    cmd = `pm clear-package-preferred-activities ${shq(pkg)}`;
    const r = await adb.shellAsync(cmd, 25000);
    out = (r.stdout + r.stderr).trim();
    if (FAIL_RE.test(out)) return { ok: false, command: cmd, detail: out.slice(0, 240), verified: false, previous: before };
    await adb.shellAsync(`am start -a android.intent.action.MAIN -c android.intent.category.HOME -n ${shq(component)}`, 20000);
  }

  /// 回读：resolve-activity 是系统的真实判定，role 只是登记信息，以 resolve 为准。
  /// 系统改 HOME 是异步的（要等 ActivityManager 重算 preferred），所以轮询而不是睡一次。
  let after = '';
  for (let i = 0; i < 8; i++) {
    after = await readCurrent();
    if (after.split('/')[0] === pkg) break;
    await sleep(300);
  }
  const verified = after.split('/')[0] === pkg;
  return {
    ok: true,
    command: cmd,
    detail: verified
      ? `默认桌面已切到 ${after}（resolve-activity 回读确认）`
      : `命令返回成功，但回读仍是 ${after || '读不到'}，可能被系统或厂商策略改回`,
    verified,
    previous: before,
  };
}

const homeBackupPath = () => under('home-backup.json');

/// 改桌面之前先把原值记下来 —— 换到遥控器操作不了的桌面时能一键还原
export function backupHome(component: string): void {
  try {
    const p = homeBackupPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    /// 原值只记第一次：连换两次桌面时，还原点应该是最初那个
    if (!cur.original) {
      fs.writeFileSync(p, JSON.stringify({ original: component, at: new Date().toISOString() }, null, 2));
    }
  } catch {
    /* 存不下不影响切换本身 */
  }
}

export function readHomeBackup(): { original?: string; at?: string } {
  try {
    return JSON.parse(fs.readFileSync(homeBackupPath(), 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- 启动项管理

export interface StartupItem {
  pkg: string;
  label: string;
  enabled: boolean;
  thirdParty: boolean;
  receivers: number;
  component: string;
  /// 关到哪一层：组件级只掐 boot receiver，包级会把整个应用停用。页面要能区分
  componentOff: boolean;
  pkgOff: boolean;
  /// 可搜索文本：显示名 + 包名 + 中英文同义叫法，和「我的应用」清单同一套
  search: string;
}

export interface StartupState {
  rows: StartupItem[];
  ms: number;
  canToggle: boolean;
  note: string;
  /// 清单里到底用什么手段列出来的（排查用，页面会显示）
  source: string;
}

/// 启动项清单：谁在开机时被拉起 = 谁声明了 BOOT_COMPLETED receiver。
/// 清单必须可逆 —— 被关掉的项也要留在列表里，否则用户关一次就再也找不到它。
///
/// 三种列清单的手段，按「设备支持 + 快」排序，全都不依赖厂商：
///   1. query-receivers --query-flags 512（MATCH_DISABLED_COMPONENTS）
///      —— 一条命令拿到「含已禁用」的全集，实测 55ms，关掉的项仍在列表里
///   2. query-receivers 默认（不带 flags）
///      —— 只列启用的；禁用态另走 dumpsys 的 disabledComponents 段补齐
///   3. dumpsys 的 Receiver Resolver Table
///      —— 老设备没有 cmd package 时用，它本身也保留禁用组件
/// 多条通路的结果取并集：单靠任何一条都可能漏（比如 ROM 裁了 --query-flags）。
const BOOT_ACTIONS = [
  'android.intent.action.BOOT_COMPLETED',
  /// 部分电视/机顶盒用快启广播，走这条的应用同样属于"开机自启"
  'android.intent.action.QUICKBOOT_POWERON',
  'com.htc.intent.action.QUICKBOOT_POWERON',
];

export async function startupItems(adb: Adb, profile: DeviceProfile): Promise<StartupState> {
  const t0 = Date.now();
  const facts = await deviceFacts(adb);
  /// MATCH_DISABLED_COMPONENTS = 0x200；同时带上 MATCH_DISABLED_UNTIL_USED(0x8000)，
  /// 后者在部分 ROM 上把"临时禁用"的接收者也算进来，不想要也无害。
  const flags = facts.hasQueryFlags ? ' --query-flags 33280' : '';
  /// 用 cmd package 而不是 pm：两者在多数设备上是同一个实现的别名，
  /// 但实测 Android 8.0 上 pm 是精简过的老实现（只认 install/uninstall/list/dump 等），
  /// query-receivers / resolve-activity / set-home-activity 全在 cmd package 里。
  /// 只有在设备连 cmd 都没有的极端情况下才退回 pm。
  const q = facts.hasCmdPackage || facts.hasQueryReceivers ? 'cmd package query-receivers' : 'pm query-receivers';

  const recvAll = await Promise.all(
    BOOT_ACTIONS.map((a) => adb.shellAsync(`${q} --brief --components${flags} -a ${a} 2>&1`, 40000)),
  );
  const [third, sys, disabled, dump, dumpAll] = await Promise.all([
    adb.shellAsync('pm list packages -3', 30000),
    adb.shellAsync('pm list packages -s', 30000),
    adb.shellAsync('pm list packages -d', 30000),
    /// 单包清单只用来读 disabledComponents / enabled= 两个状态字段，比无参 dump 小得多
    adb.dumpsysAsync('package', 'packages', 60000),
    /// 只有拿不到 --query-flags 的老设备才需要解析整份 dumpsys 的 Resolver Table
    facts.hasQueryFlags ? Promise.resolve({ stdout: '', stderr: '', code: 0, ok: true }) : adb.dumpsysAsync('package', '', 90000),
  ]);

  const pkgsOf = (text: string) =>
    text
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter((l) => l && PKG_RE.test(l));

  const thirdSet = new Set(pkgsOf(third.stdout));
  const sysSet = new Set(pkgsOf(sys.stdout));
  const disabledSet = new Set(pkgsOf(disabled.stdout));

  /// 一个包可能有多个 boot receiver，按包聚合，但保留组件列表供页面展开看。
  const byPkg = new Map<string, string[]>();
  const addComp = (comp: string) => {
    const pkg = comp.split('/')[0];
    const arr = byPkg.get(pkg) ?? [];
    if (!arr.includes(comp)) arr.push(comp);
    byPkg.set(pkg, arr);
  };

  /// 通路 1/2：query-receivers。--brief --components 的输出就是每行一个 component
  let usedQuery = false;
  for (const r of recvAll) {
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^([A-Za-z][\w.]*)\/(\S+)$/);
      if (!m) continue;
      addComp(`${m[1]}/${m[2]}`);
      usedQuery = true;
    }
  }

  /// 通路 3：dumpsys 的 Receiver Resolver Table（老设备，且它保留禁用组件）
  {
    let inReceiver = false;
    let inBoot = false;
    for (const line of dumpAll.stdout.split('\n')) {
      if (/^Receiver Resolver Table:/.test(line)) {
        inReceiver = true;
        inBoot = false;
        continue;
      }
      /// 换到下一个 Resolver Table 段就说明接收者表结束了
      if (inReceiver && /^(Activity|Service|Provider) Resolver Table:/.test(line)) {
        inReceiver = false;
        inBoot = false;
        continue;
      }
      if (!inReceiver) continue;
      /// 形如 "      android.intent.action.BOOT_COMPLETED:" 是 action 分节标题。
      /// 快启广播也算开机自启，一并收进来。
      if (/^\s{6}\S.*:\s*$/.test(line)) {
        inBoot = BOOT_ACTIONS.some((a) => new RegExp(`${a.replace(/\./g, '\\.')}\\s*:`).test(line));
        continue;
      }
      if (!inBoot) continue;
      /// 形如 "        bd728df com.tvdeck.boot/.BootReceiver"（多包 dump 里不带 filter 尾巴）
      const m = line.match(/^\s+[0-9a-f]+\s+([A-Za-z][\w.]*\/\S+)\s*$/);
      if (!m) continue;
      addComp(m[1]);
    }
  }

  /// 组件级禁用也影响开机自启。dumpsys 的写法各版本不同，这里两种都认：
  ///   Android 10+  : "disabledComponents:" 段，条目是「全限定类名」（com.pkg.Cls）
  ///   更早/定制 ROM : "User 0:" 行里的 enabled=2（组件禁用）/ 3（整包禁用）
  /// 回读必须按全限定名比对：dumpsys 里写的是 com.pkg.Cls，
  /// 而 manifest/命令行里写的是 com.pkg/.Cls，直接字符串比会永远不等。
  /// disabledComponents 嵌在「User N:」块里（缩进 6 空格），多用户设备上每个用户各有一段。
  /// 解析时要跟着 User 块的边界走，否则会把别的用户的禁用状态算到当前用户头上。
  const compDisabled = new Map<string, Set<string>>();
  {
    let cur: string | null = null;
    let inUser = false;
    let inDisabled = false;
    const userRe = new RegExp(`^\\s+User ${facts.userId}:`);
    for (const line of dump.stdout.split('\n')) {
      const head = line.match(/^\s*Package \[([\w.]+)\]/);
      if (head) {
        cur = head[1];
        inUser = false;
        inDisabled = false;
        continue;
      }
      if (!cur) continue;
      /// 包内的任何「User N:」行切换用户上下文
      if (/^\s+User \d+:/.test(line)) {
        inUser = userRe.test(line);
        inDisabled = false;
        continue;
      }
      if (!inUser) continue;
      if (/^\s+disabledComponents:\s*$/.test(line)) {
        inDisabled = true;
        continue;
      }
      /// 同级或更浅缩进的任何 "xxx:" 段都意味着 disabledComponents 段结束
      if (inDisabled && /^\s{0,6}\S.*:\s*$/.test(line)) {
        inDisabled = false;
        continue;
      }
      if (inDisabled) {
        const c = line.trim();
        if (!c) continue;
        const set = compDisabled.get(cur) ?? new Set<string>();
        set.add(c);
        compDisabled.set(cur, set);
      }
    }
  }

  /// 包级禁用：enabled=3（disabled-user）/ 2（disabled）/ 1（enabled）/ 0（default）。
  /// 注意「当前用户」而不是写死 0：多用户电视上要读自己那个用户的段。
  const pkgState = new Map<string, number>();
  {
    let cur: string | null = null;
    for (const line of dump.stdout.split('\n')) {
      const head = line.match(/^\s*Package \[([\w.]+)\]/);
      if (head) {
        cur = head[1];
        continue;
      }
      if (!cur) continue;
      const m = line.match(new RegExp(`^\\s+User ${facts.userId}:.*\\benabled=(\\d+)`));
      if (m && !pkgState.has(cur)) pkgState.set(cur, Number(m[1]));
    }
  }

  const rows: StartupItem[] = [...byPkg.entries()]
    .map(([pkg, comps]) => {
      const offComps = compDisabled.get(pkg);
      /// boot receiver 全被禁用 → 视为"不参与开机自启"。
      /// 组件名要从 "pkg/.Cls" 归一成 "pkg.Cls" 才能和 dumpsys 里的名字对上。
      const allOff = comps.every((c) => offComps?.has(expandComponent(c)));
      const state = pkgState.get(pkg);
      const pkgOff = disabledSet.has(pkg) || state === 2 || state === 3;
      return {
        pkg,
        label: pkg,
        enabled: !pkgOff && !allOff,
        thirdParty: thirdSet.has(pkg),
        receivers: comps.length,
        component: comps[0],
        componentOff: allOff,
        pkgOff,
        /// 名字要等 fillLabels 补完才能算，这里先占位
        search: '',
      };
    });

  // 名字统一走 src/names.ts，排序按补好的名字来
  await fillLabels(adb, rows, (r) => r.pkg, profile);
  for (const r of rows) r.search = searchKey(r.label, r.pkg);
  rows.sort((a, b) => Number(b.thirdParty) - Number(a.thirdParty) || Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label, 'zh'));

  const canToggle = facts.hasDisableUser || facts.isRoot || facts.canSu;
  const offCount = rows.filter((r) => !r.enabled).length;
  const source = usedQuery
    ? facts.hasQueryFlags
      ? '系统组件查询（含已禁用）'
      : '系统组件查询 + 系统转储补禁用态'
    : '系统转储';

  return {
    rows,
    ms: Date.now() - t0,
    canToggle,
    source,
    note: `${rows.length} 个声明了开机自启（第三方 ${rows.filter((r) => r.thirdParty).length}）${offCount ? ` · ${offCount} 个已禁用` : ''}${canToggle ? '' : ' · 需要 adb root 才能修改'}`,
  };
}

/// 开关某个应用的开机自启。
/// 优先做组件级（只掐掉 boot receiver，应用本身还能正常用）——
/// 实测非 root shell 对组件级必被 SecurityException 拒，所以先探测提权形式；
/// 提不了权才退到包级 disable-user（整个应用停用，页面上会标明）。
export async function setStartupItem(adb: Adb, pkg: string, enabled: boolean, component = ''): Promise<OpResult & { level?: string }> {
  const bad = badPkg(pkg);
  if (bad) return bad;
  const verb = enabled ? 'enable' : 'disable';
  const facts = await deviceFacts(adb);
  const elevate = (cmd: string) => (facts.suForm ? facts.suForm.replace('%s', shq(cmd)) : cmd);
  const userArg = `--user ${facts.userId}`;

  if (component && COMPONENT_RE.test(component) && (facts.isRoot || facts.canSu)) {
    const cmd = `pm ${verb} ${userArg} ${shq(component)}`;
    const r = await adb.shellAsync(elevate(cmd), 20000);
    const out = (r.stdout + r.stderr).trim();
    if (!FAIL_RE.test(out) && /new state/i.test(out)) {
      const after = await componentEnabled(adb, pkg, component);
      if (after !== null && after === enabled) {
        return {
          ok: true,
          command: cmd,
          level: 'component',
          detail: `${pkg} 的开机自启已${enabled ? '打开' : '关闭'}（只动开机接收者，应用本身不受影响 · 回读确认）`,
          verified: true,
        };
      }
    }
    /// 组件名在设备上不存在 / 回读对不上时，绝不能顺手退到包级：
    /// 包级会把整个应用停用，用户只想关一个开机自启却丢了应用，属于不可接受的副作用。
    /// 只有"系统拒绝改组件状态"（权限不够）才是该退包级的正当理由。
    const denied = /SecurityException|Permission Denial|not allowed/i.test(out);
    const looksMissing = /does not exist|Unknown component|Unable to find|not found/i.test(out);
    if (!denied && (looksMissing || out === '' || /new state/i.test(out))) {
      return {
        ok: false,
        command: cmd,
        level: 'component',
        detail: looksMissing
          ? `设备上没有 ${component} 这个组件，改不了它的自启`
          : `命令返回成功但回读没变（${out.slice(0, 160) || '无输出'}），为安全没有停用整个应用`,
        verified: false,
      };
    }
  }

  /// 回退：包级。影响面更大（整个应用停用），所以要在文案里说清楚。
  const cmd = `pm ${enabled ? 'enable' : 'disable-user'} ${userArg} ${shq(pkg)}`;
  const r = await adb.shellAsync(elevate(cmd), 25000);
  const out = (r.stdout + r.stderr).trim();
  const denied = /SecurityException|Permission Denial|not allowed/i.test(out);
  const after = await packageEnabled(adb, pkg);
  const verified = after !== null && after === enabled;
  return {
    ok: !denied && verified,
    command: cmd,
    level: 'package',
    detail: verified
      ? `${pkg} 已${enabled ? '启用' : '停用'}（包级：整个应用被${enabled ? '恢复' : '停用'}，不只是开机自启 · pm list -d 回读确认）`
      : denied
        ? `系统拒绝了包级${enabled ? '启用' : '停用'}：${out.slice(0, 200)}。shell 权限改不了这个包，需要先 adb root`
        : `命令已发出但回读状态未变（当前 ${after === null ? '读不到' : after ? '启用' : '禁用'}）：${out.slice(0, 160) || '无输出'}`,
    verified,
  };
}

async function packageEnabled(adb: Adb, pkg: string): Promise<boolean | null> {
  /// 以 dumpsys 的 enabled=N 为准（实测语义：0 默认 / 1 启用 / 2 组件禁用 / 3 整包禁用）。
  /// pm list -d 只反映包级，看不到组件级，所以不能单用它判断。
  const facts = await deviceFacts(adb);
  const r = await adb.shellAsync(`dumpsys package ${shq(pkg)} 2>&1`, 20000);
  const m = r.stdout.match(new RegExp(`^\\s+User ${facts.userId}:.*\\benabled=(\\d+)`, 'm'));
  if (m) return Number(m[1]) === 1 || Number(m[1]) === 0;
  /// 老设备没有这一行时退回 pm list -d
  const d = await adb.shellAsync(`pm list packages -d ${shq(pkg)}`, 15000);
  if (/Unknown|Error/i.test(d.stderr)) return null;
  return !d.stdout.split('\n').some((l) => l.trim().replace(/^package:/, '') === pkg);
}

async function componentEnabled(adb: Adb, pkg: string, component: string): Promise<boolean | null> {
  /// dumpsys 的 disabledComponents 段里写的是全限定类名（com.pkg.Cls），
  /// 命令行给的是 com.pkg/.Cls，必须先归一。用整段解析而不是正则跨行模糊匹配，
  /// 否则 "A.BReceiver" 会被 "A.BReceiver2" 这类前缀命中。
  const facts = await deviceFacts(adb);
  const r = await adb.shellAsync(`dumpsys package ${shq(pkg)} 2>&1`, 20000);
  const want = expandComponent(component);
  const userRe = new RegExp(`^\\s+User ${facts.userId}:`);
  let inDisabled = false;
  /// 是否处在目标用户的块里。dumpsys 没写 User 行的老设备上默认 true，
  /// 否则会一条都读不到而误报"读不到状态"。
  let inUser = !/^\s+User \d+:/m.test(r.stdout);
  let found: boolean | null = null;
  for (const line of r.stdout.split('\n')) {
    /// 只认目标用户那个块里的禁用记录，多用户设备上别的用户的段整段跳过
    if (/^\s+User \d+:/.test(line)) {
      inUser = userRe.test(line);
      inDisabled = false;
      continue;
    }
    if (!inUser) continue;
    if (/^\s+disabledComponents:\s*$/.test(line)) {
      inDisabled = true;
      continue;
    }
    if (/^\s+enabledComponents:\s*$/.test(line)) {
      /// 出现在 enabledComponents 里 = 显式启用
      inDisabled = false;
      continue;
    }
    if (inDisabled && /^\s{0,6}\S.*:\s*$/.test(line)) {
      inDisabled = false;
      continue;
    }
    if (inDisabled && line.trim() === want) found = false;
  }
  if (found === false) return false;
  /// 没出现在 disabledComponents 里：再看 User 0 的 enabled 码兜底
  const m = r.stdout.match(new RegExp(`^\\s+User ${facts.userId}:.*\\benabled=(\\d+)`, 'm'));
  if (m) {
    const code = Number(m[1]);
    if (code === 2 || code === 3) return false;
    return true;
  }
  return /disabledComponents/.test(r.stdout) ? true : null;
}

// ---------------------------------------------------------------- 开机自启

export interface Launchable {
  pkg: string;
  label: string;
  component: string;
  thirdParty: boolean;
  /// 命中的是哪种入口：LAUNCHER（普通应用）、LEANBACK_LAUNCHER（大屏应用）、HOME（桌面）
  category: string;
}

/// 开机自启的候选清单：所有「能被启动的应用」，不只第三方。
/// 大屏设备上最常设的开机目标恰恰是预装的直播/桌面/设置，只列第三方会把它们全漏掉。
/// 三种入口都查：普通应用用 LAUNCHER，大屏应用用 LEANBACK_LAUNCHER，
/// 厂商桌面可能只注册 HOME（实测康佳桌面就是 HOME-only）。
export async function launchables(
  adb: Adb,
  profile: DeviceProfile,
): Promise<{ rows: Launchable[]; ms: number; note: string }> {
  const t0 = Date.now();
  const facts = await deviceFacts(adb);
  const u = facts.userId;
  /// 同 startup：cmd package 是主路径，pm 只在连 cmd 都没有的老设备上兜底
  const q = facts.hasCmdPackage ? 'cmd package' : 'pm';
  const cats = ['LAUNCHER', 'LEANBACK_LAUNCHER', 'HOME'];
  const [lists, third, sys] = await Promise.all([
    Promise.all(
      cats.map((c) =>
        adb.shellAsync(`${q} query-activities --brief --components -a android.intent.action.MAIN -c android.intent.category.${c} --user ${u} 2>&1`, 30000),
      ),
    ),
    adb.shellAsync('pm list packages -3', 30000),
    adb.shellAsync('pm list packages -s', 30000),
  ]);

  const pkgsOf = (text: string) =>
    text
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter((l) => l && PKG_RE.test(l));
  const thirdSet = new Set(pkgsOf(third.stdout));
  const sysSet = new Set(pkgsOf(sys.stdout));

  /// 按包去重：一个应用可能同时注册多个入口（比如既是 LAUNCHER 又是 HOME），
  /// 保留先命中的那个（LAUNCHER 优先，启动行为最可预测）。
  const byPkg = new Map<string, Launchable>();
  cats.forEach((cat, i) => {
    for (const component of parseComponents(lists[i].stdout)) {
      const pkg = component.split('/')[0];
      if (byPkg.has(pkg)) continue;
      byPkg.set(pkg, {
        pkg,
        label: pkg,
        component,
        thirdParty: thirdSet.has(pkg) || !sysSet.has(pkg),
        category: cat,
      });
    }
  });

  const rows = [...byPkg.values()];
  // 开机自启候选常常是预装应用，profile 里没登记名字；这里统一补一次
  await fillLabels(adb, rows, (r) => r.pkg, profile);
  rows.sort((a, b) => Number(b.thirdParty) - Number(a.thirdParty) || a.label.localeCompare(b.label, 'zh'));
  /// 来源写中文：页面上不露 LAUNCHER / LEANBACK_LAUNCHER 这种系统常量
  const CAT_CN: Record<string, string> = { LAUNCHER: '应用入口', LEANBACK_LAUNCHER: '媒体入口', HOME: '桌面入口' };
  const used = cats
    .filter((_, i) => parseComponents(lists[i].stdout).length)
    .map((c) => CAT_CN[c] ?? c)
    .join(' + ');
  return {
    rows,
    ms: Date.now() - t0,
    note: rows.length
      ? `${rows.length} 个可启动应用（第三方 ${rows.filter((r) => r.thirdParty).length}）· 来源 ${used || '无'}`
      : '没有查到可启动应用，可能未开放组件查询',
  };
}

export const BOOT_HELPER_PKG = 'com.tvdeck.boot';
const helperApkPath = () => path.join(APP_ROOT, 'tools', 'tvdeck-boot', 'tvdeck-boot.apk');

export interface AutostartState {
  installed: boolean;
  apkAvailable: boolean;
  enabled: boolean;
  target: string;
  delayMs: number;
  lastRun: number;
  lastResult: string;
  accessibilityOn: boolean;
  alertWindow: string;
  /// helper 是否注册了自测广播（老版本没有，这时非 root 设备没法试跑）
  canSelftest: boolean;
  /// helper 的 targetSdk。33+ 在 Android 11+ 受包可见性限制，
  /// 需要 helper 里声明 <queries> 才能解析到别的应用
  helperTargetSdk: number;
  note: string;
}

export function helperApk(): string {
  return helperApkPath();
}

/// 读 helper 的当前配置。helper 没装就返回 installed:false，页面据此显示"安装"按钮。
export async function autostartState(adb: Adb): Promise<AutostartState> {
  const [present, cfg, a11y, saww, pkgDump] = await Promise.all([
    adb.shellAsync(`pm list packages ${shq(BOOT_HELPER_PKG)}`, 15000),
    adb.shellAsync('cmd content query --uri content://com.tvdeck.boot.config 2>&1', 20000),
    adb.shellAsync('settings get secure enabled_accessibility_services', 15000),
    adb.shellAsync(`appops get ${BOOT_HELPER_PKG} SYSTEM_ALERT_WINDOW 2>&1`, 15000),
    adb.shellAsync(`dumpsys package ${shq(BOOT_HELPER_PKG)} 2>&1`, 20000),
  ]);
  const installed = present.stdout.split('\n').some((l) => l.trim().replace(/^package:/, '') === BOOT_HELPER_PKG);
  const kv: Record<string, string> = {};
  for (const m of cfg.stdout.matchAll(/(\w+)=([^,]*)/g)) kv[m[1]] = m[2].trim();

  const apk = helperApkPath();
  const apkAvailable = fs.existsSync(apk);
  const accessibilityOn = a11y.stdout.includes(BOOT_HELPER_PKG);
  const alertWindow = /allow/.test(saww.stdout) ? 'allow' : /deny/.test(saww.stdout) ? 'deny' : 'default';
  /// 老版本 helper 没注册自测 action，也没声明 queries —— 两个都要能识别出来，
  /// 页面据此提示"重装 helper"，否则用户在非 root 设备上会看到无解的错误
  const canSelftest = /ACTION_SELFTEST/.test(pkgDump.stdout);
  const helperTargetSdk = Number(pkgDump.stdout.match(/targetSdk=(\d+)/)?.[1] ?? 0) || 0;

  return {
    installed,
    apkAvailable,
    enabled: kv.enabled === '1',
    target: kv.target ?? '',
    delayMs: Number(kv.delay_ms ?? 8000) || 8000,
    lastRun: Number(kv.last_run ?? 0) || 0,
    lastResult: kv.last_result ?? '',
    accessibilityOn,
    alertWindow,
    canSelftest,
    helperTargetSdk,
    note: installed
      ? `自启组件已安装${accessibilityOn ? ' · 无障碍豁免已开' : ' · 无障碍豁免未开'}${alertWindow === 'allow' ? ' · 悬浮窗豁免已开' : ''}`
      : apkAvailable
        ? '自启组件未安装，装一次即可开启'
        : '没找到随包附带的自启组件安装包，请先构建再试',
  };
}

/// 安装 helper。签名固定（tools/tvdeck-boot/tvdeck.keystore），
/// 重复安装同签名直接覆盖，配置不会丢。
export async function installHelper(adb: Adb): Promise<OpResult> {
  const apk = helperApkPath();
  if (!fs.existsSync(apk)) return { ok: false, command: '安装自启组件', detail: '自启组件安装包不存在，请先构建再试', verified: false };
  const remote = '/data/local/tmp/tvdeck-boot.apk';
  const push = await adb.pushAsync(apk, remote, 60000);
  if (push.code !== 0 && !/pushed|file pushed/i.test(push.stdout + push.stderr)) {
    return { ok: false, command: `adb push → ${remote}`, detail: (push.stderr + push.stdout).trim().slice(0, 240), verified: false };
  }
  const ins = await adb.shellAsync(`pm install -r -t ${shq(remote)}`, 120000);
  await adb.shellAsync(`rm -f ${shq(remote)}`, 15000);
  const text = (ins.stdout + ins.stderr).trim();
  const after = await adb.shellAsync(`pm list packages ${shq(BOOT_HELPER_PKG)}`, 15000);
  const present = after.stdout.split('\n').some((l) => l.trim().replace(/^package:/, '') === BOOT_HELPER_PKG);
  return {
    ok: /Success/i.test(text) && present,
    command: '推送并安装自启组件',
    detail: present ? `自启组件已安装（${BOOT_HELPER_PKG}，回读确认）` : `安装失败：${text.slice(0, 240) || '无输出'}`,
    verified: present,
  };
}

/// 开启/关闭开机自启。
/// Android 10+ 起后台启动 Activity 会被 BAL 拦下，唯一不需要 root 的通用豁免是无障碍服务
/// （悬浮窗豁免在部分 ROM 上被裁掉，实测 Android 14 仍会被 BAL_BLOCK）。
/// 这里同时把两条豁免都打开，任一条生效即可，并在关闭时干净还原。
export async function setAutostart(
  adb: Adb,
  opts: { enabled: boolean; target?: string; delayMs?: number; mode?: string },
): Promise<OpResult & { accessibilityOn?: boolean }> {
  const st = await autostartState(adb);
  if (!st.installed) {
    const r = await installHelper(adb);
    if (!r.ok) return { ...r, verified: false };
  }
  const target = String(opts.target ?? st.target ?? '').trim();
  /// 目标允许两种写法：包名，或显式组件 "pkg/Cls"。
  /// 后者在 Android 11+ 的包可见性限制下更可靠（helper 不用去 query 别的应用）。
  const targetIsComponent = COMPONENT_RE.test(target);
  if (opts.enabled && !PKG_RE.test(target) && !targetIsComponent) {
    return { ok: false, command: '开机自启配置', detail: '需要先选一个要自动打开的应用', verified: false };
  }
  const delay = Math.max(0, Math.min(180000, Number(opts.delayMs ?? st.delayMs ?? 8000) || 0));
  const mode = ['launch', 'launch_if_home'].includes(String(opts.mode)) ? String(opts.mode) : 'launch';

  const args = [
    `--bind enabled:s:${opts.enabled ? 1 : 0}`,
    `--bind mode:s:${mode}`,
    `--bind delay_ms:i:${delay}`,
  ];
  if (target) args.push(`--bind target:s:${target}`);
  const cmd = `cmd content update --uri content://com.tvdeck.boot.config ${args.join(' ')}`;
  const w = await adb.shellAsync(cmd, 25000);
  const wOut = (w.stdout + w.stderr).trim();

  /// 无障碍豁免：必须保留设备上已有的服务，只做增删自己这一条
  const a11yCmd = `settings get secure enabled_accessibility_services`;
  const cur = (await adb.shellAsync(a11yCmd, 15000)).stdout.trim();
  const svc = `${BOOT_HELPER_PKG}/.BootAccessibilityService`;
  const list = cur && cur !== 'null' ? cur.split(':').filter(Boolean) : [];
  const has = list.some((s) => s.startsWith(BOOT_HELPER_PKG));
  let a11yTouched = false;
  if (opts.enabled && !has) {
    list.push(svc);
    await adb.shellAsync(`settings put secure enabled_accessibility_services ${shq(list.join(':'))}`, 15000);
    await adb.shellAsync('settings put secure accessibility_enabled 1', 15000);
    a11yTouched = true;
  } else if (!opts.enabled && has) {
    const kept = list.filter((s) => !s.startsWith(BOOT_HELPER_PKG));
    await adb.shellAsync(
      kept.length ? `settings put secure enabled_accessibility_services ${shq(kept.join(':'))}` : 'settings delete secure enabled_accessibility_services',
      15000,
    );
    a11yTouched = true;
  }
  /// 悬浮窗豁免能开就开（不报错就行，开不了靠无障碍兜底）
  if (opts.enabled) await adb.shellAsync(`appops set ${BOOT_HELPER_PKG} SYSTEM_ALERT_WINDOW allow`, 15000);

  await sleep(400);
  const after = await autostartState(adb);
  const verified = after.enabled === opts.enabled && (!opts.enabled || after.target === target);
  const a11yOn = after.accessibilityOn;
  return {
    ok: !FAIL_RE.test(wOut) && verified,
    command: cmd,
    detail: verified
      ? opts.enabled
        ? `开机将自动打开 ${target}（延迟 ${(delay / 1000).toFixed(delay % 1000 ? 1 : 0)}s${a11yOn ? '，豁免已开' : '，警告：豁免未生效，可能被系统拦下'}）`
        : '开机自启已关闭'
      : `配置已写入但回读不一致（enabled=${after.enabled} target=${after.target || '空'}）${wOut ? `：${wOut.slice(0, 160)}` : ''}`,
    verified,
    accessibilityOn: a11yOn,
  };
}

/// 立即试跑一次：走 helper 注册的自测广播。
/// BOOT_COMPLETED 是受保护广播，只有 root 能发，非 root 设备上根本没法自测；
/// 自测 action 是 helper 自己声明的普通广播，adb shell 就能发，
/// 且和真开机走同一个 onReceive → 同一套启动逻辑，所以验证结果等价。
/// 老版本 helper 没注册这个 action，这时退回 root 发 BOOT_COMPLETED。
export async function tryAutostart(adb: Adb): Promise<OpResult> {
  const st = await autostartState(adb);
  if (!st.installed) return { ok: false, command: '试跑', detail: '自启组件还没安装', verified: false };
  if (!st.enabled) return { ok: false, command: '试跑', detail: '开机自启当前是关闭状态，先打开再试跑', verified: false };
  const facts = await deviceFacts(adb);

  /// 先试自测广播（任何权限都能发）
  const selftest = 'am broadcast -a com.tvdeck.boot.ACTION_SELFTEST -p com.tvdeck.boot';
  const supportsSelftest = await adb
    .shellAsync(`dumpsys package ${shq(BOOT_HELPER_PKG)} 2>/dev/null | grep -c ACTION_SELFTEST`, 15000)
    .then((r) => Number(r.stdout.trim()) > 0)
    .catch(() => false);

  if (!supportsSelftest && !facts.isRoot && !facts.canSu) {
    return {
      ok: false,
      command: selftest,
      detail: '这个版本的自启组件不支持试跑。点「安装组件」重装一次即可',
      verified: false,
    };
  }

  const pre = st.lastRun;
  /// 老 helper 只能用受保护广播，那时才需要提权
  const cmd = supportsSelftest
    ? selftest
    : facts.suForm
      ? facts.suForm.replace('%s', shq('am broadcast -a android.intent.action.BOOT_COMPLETED -p com.tvdeck.boot'))
      : 'am broadcast -a android.intent.action.BOOT_COMPLETED -p com.tvdeck.boot';
  await adb.shellAsync(cmd, 25000);
  let after = st;
  /// helper 里有 delay_ms 的延迟，等够 delay + 余量，否则会在它启动前就读结果
  const budgetMs = Math.min(30000, (after.delayMs || 8000) + 8000);
  const rounds = Math.ceil(budgetMs / 500);
  for (let i = 0; i < rounds; i++) {
    await sleep(500);
    after = await autostartState(adb);
    if (after.lastRun > pre) break;
  }
  const ran = after.lastRun > pre;
  return {
    ok: ran && /started:/.test(after.lastResult),
    command: cmd,
    detail: ran
      ? /started:/.test(after.lastResult)
        ? `自启组件已执行：${after.lastResult}`
        : `自启组件已执行但没启动成功：${after.lastResult}`
      : `广播已发但组件没回写结果：可能被系统拦了后台拉起，或 ${(after.delayMs / 1000).toFixed(0)} 秒延迟还没走完`,
    verified: ran,
  };
}
