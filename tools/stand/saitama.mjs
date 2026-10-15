// Удар Сайтамы целиком: подъезд, вдох, рывок, свет, кулаки, отлёт, «Ок.».
// node tools/stand/saitama.mjs [--calm] [--at=300,1760] [--until=2060]
// Время идёт кадрами по 16 мс; снимки out/saitama_<мс>.png. Звуки моментов — out/saitama-cues.json
// (стенд звука собирает по нему всю сцену).
import fs from 'node:fs';
import path from 'node:path';
import { open, args, OUT } from './harness.mjs';

const { calm, at, until } = args();
const shots = at ? String(at).split(',').map(Number) : [300, 900, 1400, 1650, 1760, 1900, 2150, 2400, 3000, 3700, 4200, 4500, 4800, 5100];
const end = Number(until) || Math.max(6200, ...shots);
const stand = await open(`saitama.html${calm ? '?calm' : ''}`);
await stand.page.evaluate(() => step(0));
await stand.page.evaluate(c => go(c), !!calm);
let t = 0;
for (let next = 16; next <= end; next += 16) {
    const shot = shots.find(s => s > t && s <= next);
    if (shot !== undefined) { await stand.page.evaluate(x => step(x), shot); await stand.shot(`saitama_${calm ? 'c_' : ''}${shot}`); }
    await stand.page.evaluate(x => step(x), next);
    t = next;
}
const cues = await stand.page.evaluate(() => cues);
fs.writeFileSync(path.join(OUT, 'saitama-cues.json'), JSON.stringify(cues, null, 1));
console.log('звуки:', cues.map(([name, ms]) => `${name} ${Math.round(ms)}`).join(', '));
const state = await stand.page.evaluate(() => ({
    done: window.done, scale: canvas.stage.scale.x, rotation: canvas.stage.rotation,
    overlays: document.querySelectorAll('.gd-impact,.gd-letterbox').length, moves: updates.length
}));
console.log('конец:', JSON.stringify(state), state.overlays ? '— НА ЭКРАНЕ ОСТАЛИСЬ СЛОИ' : '');
await stand.close();
