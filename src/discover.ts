import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { Adb, connectAsync, connectedDevicesAsync, disconnectAsync } from './adb.ts';

export interface OpenPort {
  ip: string;
  port: number;
}

/// 自动发现只认 ADB，不再把 DIAL / Cast / UPnP 设备混进列表。
/// 5555 是经典无线 ADB 端口；Android 11+ 的无线调试随机端口由 adb mDNS 报告。
const ADB_PORTS = [5555];

export function checkPort(ip: string, port: number, ms = 350): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port, timeout: ms });
    const done = (open: boolean) => {
      sock.destroy();
      resolve(open);
    };
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

/// 连不上时先分清是「IP 都不通」还是「IP 通但 adb 服务没起」，两者的处置动作完全不同
export function pingHost(ip: string, ms = 1500): Promise<boolean> {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = spawn('ping', ['-c', '1', '-t', String(Math.max(1, Math.ceil(ms / 1000))), ip]);
    let out = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0 && /bytes from/i.test(out)));
    setTimeout(() => {
      p.kill('SIGKILL');
      resolve(false);
    }, ms + 700);
  });
}

/// 本机自己的 IPv4。端口探测扫到这些地址会把「本机上开的服务」当成局域网设备：
/// 比如有人 `adb tcpip 5555` 或者本地起了投屏接收端，页面上就会冒出一台能点「连接」的假设备。
function ownIPv4(): Set<string> {
  const set = new Set<string>();
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4') set.add(iface.address);
  }
  return set;
}

/// ARP 表里 (incomplete) 是已经不在网络上的老条目，扫它们每个都要等满超时。
/// -n 关掉反向 DNS：这台机器 259 条 ARP 记录，`arp -a` 实测 49 秒（大量 PTR 查询），
/// 加 -n 只要 8 毫秒。之前 5 秒超时直接把结果截成空表，端口探测拿到 0 个 IP，
/// 局域网里开着 5555 的 ADB 设备从来就没被扫出来过，而且 spawnSync 还会把
/// 事件循环堵满 5 秒，连带把并行的 SSDP 定时器也往后推。
export function arpNeighbors(): string[] {
  const r = spawnSync('arp', ['-n', '-a'], { encoding: 'utf8', timeout: 5000 });
  const ips = new Set<string>();
  for (const line of (r.stdout ?? '').split('\n')) {
    if (/\(incomplete\)/i.test(line)) continue;
    const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/);
    if (!m) continue;
    ips.add(m[1]);
  }
  for (const own of ownIPv4()) ips.delete(own);
  return [...ips];
}

export function localSubnetHosts(): string[] {
  const ips = new Set(arpNeighbors());
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (!iface || iface.family !== 'IPv4' || iface.internal || !iface.netmask) continue;
    const [a, b, c] = iface.address.split('.');
    for (let i = 1; i <= 254; i++) ips.add(`${a}.${b}.${c}.${i}`);
  }
  /// arpNeighbors 已经去掉了本机地址，但网段枚举会把它重新塞回来，这里再删一次
  for (const own of ownIPv4()) ips.delete(own);
  return [...ips];
}

export async function scanPorts(
  ips: string[],
  ports = ADB_PORTS,
  concurrency = 64,
  deadlineMs = 6000,
): Promise<OpenPort[]> {
  const found: OpenPort[] = [];
  // adb 端口排前面：超时时至少已经把最可能的候选试完
  const queue = ips.flatMap((ip) => ports.map((port) => ({ ip, port }))).sort((a, b) => a.port - b.port);
  const until = Date.now() + deadlineMs;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (Date.now() > until) return;
      const job = queue.shift();
      if (!job) return;
      if (await checkPort(job.ip, job.port)) found.push(job);
    }
  });
  await Promise.all(workers);
  return found.sort((x, y) => x.ip.localeCompare(y.ip, undefined, { numeric: true }));
}

export interface AdbCandidate {
  ip: string;
  ports: number[];
  serial: string;
  reason: string;
}

/// Android 11+ 无线调试会通过 mDNS 公布随机端口。只采信可连接的
/// _adb-tls-connect / _adb 服务，配对端口不能直接拿来执行 adb connect。
export function adbMdnsCandidates(timeoutMs = 3000): AdbCandidate[] {
  const r = spawnSync('adb', ['mdns', 'services'], { encoding: 'utf8', timeout: timeoutMs });
  if (r.error || r.status !== 0) return [];
  const found = new Map<string, AdbCandidate>();
  for (const line of String(r.stdout ?? '').split('\n')) {
    const m = line.match(/(\S+)\s+(_adb[^\s]*)\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/i);
    if (!m) continue;
    const service = m[2].replace(/\.$/, '').toLowerCase();
    if (!/^_adb(?:-tls-connect)?\._tcp$/.test(service)) continue;
    const ip = m[3];
    const port = Number(m[4]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const key = `${ip}:${port}`;
    found.set(key, {
      ip,
      ports: [port],
      serial: key,
      reason: 'ADB 无线调试广播',
    });
  }
  return [...found.values()];
}

export async function findAdbDevices(opts: { full?: boolean; ms?: number } = {}): Promise<AdbCandidate[]> {
  const ms = opts.ms ?? 3000;
  const [mdns, ports] = await Promise.all([
    Promise.resolve(adbMdnsCandidates(ms)),
    scanPorts(
      opts.full ? localSubnetHosts() : arpNeighbors(),
      ADB_PORTS,
      opts.full ? 96 : 64,
      ms + 1500,
    ),
  ]);

  const byIp = new Map<string, AdbCandidate>();
  const add = (ip: string, port: number, reason: string) => {
    const cur = byIp.get(ip) ?? { ip, ports: [], serial: `${ip}:${port}`, reason: '' };
    if (!cur.ports.includes(port)) cur.ports.push(port);
    if (!cur.reason.includes(reason)) cur.reason = cur.reason ? `${cur.reason}, ${reason}` : reason;
    byIp.set(ip, cur);
  };

  for (const c of mdns) add(c.ip, c.ports[0], c.reason);
  for (const p of ports) {
    add(p.ip, p.port, '网络 ADB 调试端口已开放');
  }

  return [...byIp.values()]
    .map((c) => {
      c.ports.sort((a, b) => a - b);
      if (!c.ports.includes(5555)) c.serial = `${c.ip}:${c.ports[0]}`;
      const tags = c.reason.split(', ');
      return { ...c, reason: tags.length > 2 ? `${tags.slice(0, 2).join(', ')}（另 ${tags.length - 2} 条）` : c.reason };
    })
    .sort((a, b) =>
      Number(b.ports.includes(5555)) - Number(a.ports.includes(5555)) ||
      a.ip.localeCompare(b.ip, undefined, { numeric: true }) ||
      a.ports[0] - b.ports[0]);
}

export interface AttachResult {
  ok: boolean;
  verified: boolean;
  command: string;
  detail: string;
  serial?: string;
  model?: string;
  waitedMs?: number;
}

/// 设备侧的连接状态词，页面上不能直接甩 offline / unauthorized 给用户
const STATE_CN: Record<string, string> = {
  device: '在线',
  offline: '离线',
  unauthorized: '等待设备上授权',
  no_permissions: '本机权限不足',
  'recovery': '恢复模式',
  sideload: '侧载模式',
  bootloader: '引导模式',
  host: '本机调试服务',
};

/// 用 IP（可选自定义端口，默认 5555）建立无线 adb：先摘掉可能卡住的旧条目，连上后一定要回读 state=device 才算数
export async function attachAdb(ip: string, budgetMs = 12000, port = 5555): Promise<AttachResult> {
  const t0 = Date.now();
  const serial = `${ip}:${port}`;
  const stale = (await connectedDevicesAsync()).find((d) => d.serial === serial && d.state !== 'device');
  if (stale) await disconnectAsync(serial);
  const c = await connectAsync(ip, port, Math.min(budgetMs, 9000));
  const raw = [c.stdout, c.stderr].join(' ').trim().replace(/\s+/g, ' ');
  // adb 明确说了连不上时不用再等满预算，只多给 1.5 秒等设备表刷新
  const hardFail = /cannot connect|failed to connect|connection refused|host is down|etimedout|no route|unable to connect/i.test(raw);
  const deadline = Date.now() + (hardFail ? 1500 : budgetMs);
  let state = '';
  while (Date.now() < deadline) {
    state = connectedState(await connectedDevicesAsync(), serial);
    if (state === 'device' || state === 'unauthorized') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const waitedMs = Date.now() - t0;
  if (state === 'device') {
    const adb = new Adb(serial);
    const model = (await adb.shellAsync('getprop ro.product.model', 10000)).stdout.trim();
    return {
      ok: true,
      verified: true,
      command: `adb connect ${serial}`,
      detail: `已连上 ${model || '设备'}，调试通道已就绪（用时 ${(waitedMs / 1000).toFixed(1)} 秒）`,
      serial,
      model,
      waitedMs,
    };
  }
  if (state === 'unauthorized') {
    return {
      ok: false,
      verified: false,
      command: `adb connect ${serial}`,
      detail: '设备已应答但还没授权：在设备的弹窗里点「允许 USB 调试」后重试',
      serial,
      waitedMs,
    };
  }
  return {
    ok: false,
    verified: false,
    command: `adb connect ${serial}`,
    detail: `${raw || '设备没有应答'}；等了 ${(waitedMs / 1000).toFixed(1)} 秒仍是 ${STATE_CN[state] || '不在线'}。设备休眠、关机或断电时网络不响应，需先手动唤醒或开机`,
    serial,
    waitedMs,
  };
}

function connectedState(devs: { serial: string; state: string }[], serial: string): string {
  return devs.find((d) => d.serial === serial)?.state ?? '';
}
