export interface DialApp {
  name: string;
  properties: Record<string, string>;
}

export interface DialInfo {
  ip: string;
  port: number;
  friendlyName: string;
  modelName: string;
  manufacturer: string;
  apps: DialApp[];
  rawDescription: string;
}

const timeoutFetch = (url: string, init: RequestInit = {}, ms = 4000) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

function tagAll(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1].trim());
}

export async function describe(ip: string, port = 8008): Promise<DialInfo> {
  const root = await (await timeoutFetch(`http://${ip}:${port}/ssdp/dial.xml`)).text().catch(() => '');
  const desc = root.match(/<dial:deviceDescription>([\s\S]*?)<\/dial:deviceDescription>/)?.[1] ?? '';
  const url = desc.startsWith('http') ? desc : `http://${ip}:${port}/dial/description`;
  const rawDescription = await (await timeoutFetch(url)).text().catch(() => root);

  const names = tagAll(rawDescription, 'app:name');
  const apps: DialApp[] = names.map((name) => ({ name, properties: {} }));
  for (const app of apps) {
    const res = await timeoutFetch(`http://${ip}:${port}/apps/${encodeURIComponent(app.name)}`).catch(() => null);
    if (!res) continue;
    const body = await res.text().catch(() => '');
    for (const m of body.matchAll(/<app:property\s+app:key="([^"]*)"[^>]*>([\s\S]*?)<\/app:property>/g)) {
      app.properties[m[1]] = m[2].trim();
    }
  }

  return {
    ip,
    port,
    friendlyName: tagAll(rawDescription, 'friendlyName')[0] ?? '',
    modelName: tagAll(rawDescription, 'modelName')[0] ?? '',
    manufacturer: tagAll(rawDescription, 'manufacturer')[0] ?? '',
    apps,
    rawDescription,
  };
}

export async function launchApp(ip: string, name: string, params: Record<string, string> = {}, port = 8008) {
  const query = new URLSearchParams(params).toString();
  const res = await timeoutFetch(`http://${ip}:${port}/apps/${encodeURIComponent(name)}${query ? `?${query}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
    body: '{}',
  });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text().catch(() => '') };
}

export async function stopApp(ip: string, name: string, port = 8008) {
  const res = await timeoutFetch(`http://${ip}:${port}/apps/${encodeURIComponent(name)}`, { method: 'DELETE' });
  return res.status;
}
