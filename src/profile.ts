import fs from 'node:fs';
import path from 'node:path';
import { under } from './home.ts';

export interface PictureSetting {
  key: string;
  table: 'system' | 'secure' | 'global';
  value: string;
}

export interface TvApp {
  label: string;
  component: string;
  package: string;
  dialName?: string;
  /// 以下两项来自 scripts/extract-icons.mjs 对 APK 的离线解析，不是设备实时数据
  icon?: string;
  name?: string;
}

export interface Strategy {
  name: string;
  command: string;
  verified: boolean;
  note?: string;
}

export interface DeviceProfile {
  serial: string;
  ip: string;
  model: string;
  /// 给人看的机型名：优先厂商市场名，其次原始型号；模拟器/开发板这类
  /// ro.product.model 是构建目标名（sdk_google_atv64_arm64 之类），单独标出来
  modelFriendly?: string;
  brand: string;
  androidVersion: string;
  buildFingerprint: string;
  apps: TvApp[];
  dialApps: string[];
  picture: PictureSetting[];
  volumeStrategy: Strategy | null;
  capturedAt: string;
  evidenceDir: string;
  /// adb 端口（无线调试改过 tcpip 端口、或走端口转发时不是 5555）。
  /// serial 形如 ip:port 时从这里取，重连和唤醒都跟着走
  port?: number;
}


/// 护眼 = KonkaNightDisplayService 的全屏琥珀遮罩（默认 ARGB 0x1EFF6F00, alpha 30/255）
/// 写 secure/night_display_activated 会触发服务内 ContentObserver → turnOn/turnOff，且可回读验证
export const KONKA_NIGHT_STRATEGY = {
  on: 'settings put secure night_display_activated 1',
  off: 'settings put secure night_display_activated 0',
  color: 'service call konka_night_display 3 i32 {argb}',
  readback: 'settings get secure night_display_activated',
  verified: true,
  note: '2026-10-13 真机验证：开→dumpsys window 出现 ty=2006 全屏遮罩；setColorTransform 收的是 ARGB 整数（不是等级）',
};

export const profilePath = under('profile.json');
export const evidenceRoot = under('evidence');

export function emptyProfile(): DeviceProfile {
  return {
    serial: '',
    ip: '',
    model: '',
    modelFriendly: '',
    brand: '',
    androidVersion: '',
    buildFingerprint: '',
    apps: [],
    dialApps: [],
    picture: [],
    volumeStrategy: null,
    capturedAt: '',
    evidenceDir: '',
  };
}

export function loadProfile(): DeviceProfile {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    // 旧档案可能还带着电视输入源字段；它们不属于通用 ADB 设备模型。
    delete parsed.inputs;
    delete parsed.inputStrategies;
    return { ...emptyProfile(), ...parsed } as DeviceProfile;
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(p: DeviceProfile): string {
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(p, null, 2));
  return profilePath;
}

export function newEvidenceDir(ip: string): string {
  const dir = path.join(evidenceRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}_${ip}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/// 从 getprop 全量表里挑一个「给人看的机型名」。
/// 顺序：厂商市场名 → 模拟器 → 原始型号。不认厂牌也不认具体机型，
/// 换任何一台安卓设备走的都是同一套判定。
const MARKET_KEYS = [
  'ro.product.marketname',
  'ro.config.marketing_name',
  'ro.product.vendor.marketname',
  'ro.product.odm.marketname',
  'ro.product.system.marketname',
];

/// 模拟器/开发镜像的型号字段是构建目标名（sdk_google_atv64_arm64、vbox86p…），
/// 用户看到的是「一串代号」，这里按设备自己报的特征标成模拟器。
export function isEmulator(props: Record<string, string>): boolean {
  if (props['ro.kernel.qemu'] === '1' || props['ro.boot.qemu'] === '1') return true;
  if (/emulator|desktop|nosdcard/.test(props['ro.build.characteristics'] ?? '')) {
    // characteristics 里有 emulator 但真机也可能带；再要一条硬件证据
    if (/^(ranchu|goldfish|qemu|vbox|cuttlefish|emu)/i.test(props['ro.hardware'] ?? '')) return true;
    if (/^(sdk_|emulator_|vbox|cuttlefish)/i.test(props['ro.product.model'] ?? '')) return true;
    if (props['ro.boot.qemu.avd_name']) return true;
  }
  return /^(ranchu|goldfish|vbox86p|cuttlefish|qemu)/i.test(props['ro.hardware'] ?? '') ||
    /^(ranchu|goldfish|vbox|cuttlefish|qemu)/i.test(props['ro.boot.hardware'] ?? '');
}

export function friendlyModel(props: Record<string, string>): string {
  for (const k of MARKET_KEYS) {
    const v = (props[k] ?? '').trim();
    if (v && !/^\$\{|^\?+$/.test(v)) return v;
  }
  const raw = (props['ro.product.model'] ?? '').trim();
  if (isEmulator(props)) {
    // 有实例名时用实例名区分；连实例名都没有才退回系统版本号，避免多台模拟器同名
    const avd = (props['ro.boot.qemu.avd_name'] ?? '').trim();
    const api = (props['ro.build.version.sdk'] ?? '').trim();
    if (avd) return `Android 模拟器 ${avd}`;
    return `Android 模拟器${api ? `（API ${api}）` : ''}`;
  }
  return raw;
}

export function writeEvidence(dir: string, file: string, content: string): string {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
