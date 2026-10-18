// Звуки паутины в файлы для прослушивания: node tools/sound/render.mjs → tools/sound/out/*.wav
// Тот же синтез, что в игре (scripts/labyrinth/web-sound.js), только в OfflineAudioContext браузера.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tools/sound/out');
fs.mkdirSync(OUT, { recursive: true });
const source = fs.readFileSync(path.join(ROOT, 'scripts/labyrinth/web-sound.js'), 'utf-8');

// Что и в каком порядке звучит: отдельные звуки и сцена «открыть → выбрать → шаг → укус»
const PLAN = {
    open: [['open', 0, null, 3]],
    close: [['close', 0, null, 2]],
    pop: [['pop', 0, 0.2, 0.4]],
    'pop-cascade': Array.from({ length: 14 }, (_, i) => ['pop', i * 0.06, i / 14, 1.2]),
    threads: [['threads', 0, null, 1.8]],
    select: [['select', 0, null, 1.2]],
    step: [['step', 0, 1, 1.6]],
    'step-3': [['step', 0, 3, 2.6]],
    denied: [['denied', 0, null, 0.5]],
    hover: [['hover', 0, null, 0.3]],
    'hover-row': Array.from({ length: 6 }, (_, i) => ['hover', i * 0.18, null, 1.4]),
    bite: [['bite', 0, null, 3]],
    'scene-open': [['open', 0, null, 0], ...Array.from({ length: 30 }, (_, i) => ['pop', 0.45 + i * 0.022, i / 30, 0]), ['threads', 1.2, null, 4]],
    'scene-move': [['select', 0, null, 0], ['select', 0.9, null, 0], ['step', 1.0, 2, 0], ['bite', 2.4, null, 6]]
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
const results = await page.evaluate(async ({ source, plan }) => {
    const mod = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    const wav = buffer => {
        const ch = buffer.getChannelData(0), n = ch.length, data = new DataView(new ArrayBuffer(44 + n * 2));
        const str = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); data.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
        data.setUint32(24, buffer.sampleRate, true); data.setUint32(28, buffer.sampleRate * 2, true);
        data.setUint16(32, 2, true); data.setUint16(34, 16, true); str(36, 'data'); data.setUint32(40, n * 2, true);
        let peak = 0;
        for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]));
        for (let i = 0; i < n; i++) data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, ch[i])) * 32767, true);
        let bin = '';
        const bytes = new Uint8Array(data.buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { b64: btoa(bin), peak };
    };
    const out = {};
    for (const [name, events] of Object.entries(plan)) {
        const len = Math.max(...events.map(([, at, , l]) => at + l), 0.5);
        const ctx = new OfflineAudioContext(1, Math.ceil(44100 * len), 44100);
        const gain = ctx.createGain();
        gain.gain.value = 0.9;
        gain.connect(ctx.destination);
        for (const [sound, at, arg] of events) mod.SOUNDS[sound](ctx, gain, at + 0.01, arg ?? undefined);
        out[name] = wav(await ctx.startRendering());
    }
    return out;
}, { source, plan: PLAN });
for (const [name, { b64, peak }] of Object.entries(results)) {
    fs.writeFileSync(path.join(OUT, `${name}.wav`), Buffer.from(b64, 'base64'));
    console.log(`${name}.wav — пик ${peak.toFixed(2)}`);
}
await browser.close();
