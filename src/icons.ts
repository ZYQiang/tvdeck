import fs from 'node:fs';
import path from 'node:path';

export interface IconMeta {
  file: string;
  label: string;
}

interface Cache {
  mtime: number;
  map: Record<string, IconMeta>;
}

let cache: Cache | null = null;

/// scripts/extract-icons.mjs 从设备 APK 解出的图标索引；按 mtime 缓存，重跑脚本即生效
export function iconIndex(dir: string): Record<string, IconMeta> {
  const file = path.join(dir, 'index.json');
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (cache?.mtime === mtime) return cache.map;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Partial<IconMeta>>;
  const map: Record<string, IconMeta> = {};
  for (const [pkg, v] of Object.entries(raw)) {
    if (v?.file || v?.label) map[pkg] = { file: v.file ?? '', label: v.label ?? '' };
  }
  cache = { mtime, map };
  return map;
}

export function withIcons<T extends { package: string; icon?: string; name?: string }>(
  apps: T[],
  dir: string,
): T[] {
  const idx = iconIndex(dir);
  return apps.map((a) => {
    const m = idx[a.package];
    if (!m) return a;
    return { ...a, ...(m.file ? { icon: `/icons/${m.file}` } : {}), ...(m.label ? { name: m.label } : {}) };
  });
}
