import { connectedDevices } from './adb.ts';
import { findAdbDevices } from './discover.ts';
import { probe } from './probe.ts';
import { grabFrame, defaultOptions } from './mirror.ts';
import { loadProfile } from './profile.ts';

const [cmd, arg] = process.argv.slice(2);

async function main() {
  if (cmd === 'discover') {
    const cands = await findAdbDevices({ full: arg === '--full' });
    const devs = connectedDevices();
    console.log('adb 已连接:', devs.length ? devs.map((d) => `${d.serial} (${d.state})`).join(', ') : '无');
    if (!cands.length) {
      console.log('局域网没有发现开放网络 ADB 的设备。');
      console.log('设备侧: 设置 → 开发者选项 → 无线调试 / 网络 ADB 调试 打开');
      return;
    }
    for (const c of cands) console.log(`${c.ip}  端口 ${c.ports.join(',')}  ${c.reason}`);
    return;
  }

  if (cmd === 'probe') {
    const p = await probe(arg && /^\d+\./.test(arg) ? arg : undefined, { full: process.argv.includes('--full') });
    console.log(`\n档案已写入 .tvdeck/profile.json，证据在 ${p.evidenceDir}`);
    return;
  }

  if (cmd === 'mirror-check') {
    const f = await grabFrame(defaultOptions);
    console.log(`抓帧成功 ${(f.buf.length / 1024).toFixed(0)}KB，用时 ${f.ms}ms`);
    console.log('若画面全黑: 系统设置 → 隐私与安全性 → 屏幕录制，勾选你的终端/Node');
    return;
  }

  console.log(`用法:
  npm run discover [-- --full]   扫描局域网 ADB 设备
  npm run probe [ip]             取证 + 生成 .tvdeck/profile.json
  npm run mirror-check           验证抓屏权限（自动选用各系统的抓屏工具）
  npm start                      启动 ADB 设备控制台 http://localhost:8787`);
}

main().catch((e) => {
  console.error('失败:', (e as Error).message);
  process.exitCode = 1;
});
