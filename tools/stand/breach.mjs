// Прорыв Пожирателя: node tools/stand/breach.mjs [--calm] [--at=900,2000]
// Время идёт кадрами по 16 мс; снимки out/breach_<мс>.png. В конце — вернулась ли сцена.
import { open, args } from './harness.mjs';

const { calm, at } = args();
const shots = at ? String(at).split(',').map(Number) : [400, 900, 1300, 1700, 2000, 2300, 2450, 2700, 3100];
const end = Math.max(4300, ...shots);
const stand = await open(`breach.html${calm ? '?calm' : ''}`);
await stand.page.evaluate(() => step(0));
await stand.page.evaluate(() => go());
let t = 0;
for (let next = 16; next <= end; next += 16) {
    const shot = shots.find(s => s > t && s <= next);
    if (shot !== undefined) { await stand.page.evaluate(x => step(x), shot); await stand.shot(`breach_${calm ? 'c_' : ''}${shot}`); }
    await stand.page.evaluate(x => step(x), next);
    t = next;
}
const state = await stand.page.evaluate(() => ({
    done: window.done, scale: canvas.stage.scale.x, rotation: canvas.stage.rotation,
    overlays: document.querySelectorAll('.gd-impact,.gd-letterbox').length
}));
console.log('конец:', JSON.stringify(state), state.overlays ? '— НА ЭКРАНЕ ОСТАЛИСЬ СЛОИ' : '');
await stand.close();
