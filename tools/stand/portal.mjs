// Открытие портала в Предел: node tools/stand/portal.mjs [--calm] [--at=400,1000]
// Время идёт кадрами по 16 мс; снимки out/portal_<мс>.png. В конце — убраны ли слои.
import { open, args } from './harness.mjs';

const { calm, at } = args();
const shots = at ? String(at).split(',').map(Number) : [200, 600, 1000, 1250, 1400, 1600, 1900];
const stand = await open(`portal.html${calm ? '?calm' : ''}`);
await stand.page.evaluate(() => step(0));
await stand.page.evaluate(() => go());
let t = 0;
for (let next = 16; next <= 2200; next += 16) {
    const shot = shots.find(s => s > t && s <= next);
    if (shot !== undefined) { await stand.page.evaluate(x => step(x), shot); await stand.shot(`portal_${calm ? 'c_' : ''}${shot}`); }
    await stand.page.evaluate(x => step(x), next);
    t = next;
}
const state = await stand.page.evaluate(() => ({ done: window.done, overlays: document.querySelectorAll('.gd-impact,.gd-letterbox').length }));
console.log('конец:', JSON.stringify(state), state.overlays ? '— НА ЭКРАНЕ ОСТАЛИСЬ СЛОИ' : '');
await stand.close();
