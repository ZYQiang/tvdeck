// 对比三种注入写法的往返开销：4 次 sendevent / 2 次 sendevent / 预生成 evdev blob 一次 cat
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SERIAL = '192.168.1.8:5555';
const DEV = '/dev/input/event4';

// arm64 struct input_event = 24 字节：time(16) + type u16 + code u16 + value i32
const ev = (type, code, value) => {
  const b = Buffer.alloc(24);
  b.writeUInt16LE(type, 16);
  b.writeUInt16LE(code, 18);
  b.writeInt32LE(value, 20);
  return b;
};
const blob = (code) => Buffer.concat([ev(1, code, 1), ev(0, 0, 0), ev(1, code, 0), ev(0, 0, 0)]);

const DIR = '/data/local/tmp/tvdeck_ev';
spawnSync('adb', ['-s', SERIAL, 'shell', `mkdir -p ${DIR}`]);
const local = fs.mkdtempSync('/tmp/tvdeck_ev_');
const push = (f) => spawnSync('adb', ['-s', SERIAL, 'push', `${local}/${f}`, `${DIR}/${f}`]);
for (const code of [114, 115]) {
  fs.writeFileSync(`${local}/k${code}.bin`, blob(code));
  push(`k${code}.bin`);
}

const p = spawn('adb', ['-s', SERIAL, 'shell'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
p.stdout.on('data', (d) => {
  buf += d.toString();
  for (;;) {
    const i = buf.indexOf('\n');
    if (i < 0) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    const m = line.match(/^@@(\d+)/);
    if (m) {
      const t = Number(m[1]);
      const cb = pending.get(t);
      pending.delete(t);
      if (cb) cb(Number(process.hrtime.bigint()) - t);
    }
  }
});
p.stderr.on('data', (d) => process.stderr.write(`[err] ${d}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function once(cmd) {
  return new Promise((resolve) => {
    const t = Number(process.hrtime.bigint());
    pending.set(t, resolve);
    p.stdin.write(`${cmd};echo @@${t}\n`);
    setTimeout(() => resolve(-1), 4000);
  });
}

await wait(1500);
const seq = (code) => `sendevent ${DEV} 1 ${code} 1;sendevent ${DEV} 0 0 0;sendevent ${DEV} 1 ${code} 0;sendevent ${DEV} 0 0 0`;
const seq2 = (code) => `sendevent ${DEV} 1 ${code} 1;sendevent ${DEV} 1 ${code} 0`;
const cases = {
  echo: () => 'true',
  sendevent4: () => `${seq(114)};${seq(115)}`,
  sendevent2: () => `${seq2(114)};${seq2(115)}`,
  blobcat: () => `cat ${DIR}/k114.bin > ${DEV};cat ${DIR}/k115.bin > ${DEV}`,
  blobboth: () => `cat ${DIR}/pair.bin > ${DEV}`,
};
fs.writeFileSync(`${local}/pair.bin`, Buffer.concat([blob(114), blob(115)]));
spawnSync('adb', ['-s', SERIAL, 'push', `${local}/pair.bin`, `${DIR}/pair.bin`]);

for (const [name, fn] of Object.entries(cases)) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const dt = await once(fn());
    if (dt > 0) samples.push(dt / 1e6);
    await wait(120);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name.padEnd(11)} median ${samples[Math.floor(samples.length / 2)]?.toFixed(1)} ms  min ${samples[0]?.toFixed(1)}  all ${samples.map((s) => s.toFixed(0)).join(',')}`);
}
p.kill();
process.exit(0);
