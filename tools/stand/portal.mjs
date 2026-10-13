// Открытие портала в Предел: node tools/stand/portal.mjs [--calm] [--travel] [--at=400,1000]
// --travel: переход на сцену Якоря, которая дорисовывается через 600 мс — туман должен её ждать.
// Время идёт кадрами по 16 мс; снимки out/portal_<мс>.png. В конце — убраны ли слои.
import { open, args } from './harness.mjs';

const { calm, at, travel } = args();
const shots = at ? String(at).split(',').map(Number) : [200, 600, 1000, 1250, 1400, 1600, 1900];
const stand = await open(`portal.html?${[calm && 'calm', travel && 'travel'].filter(Boolean).join('&')}`);
await stand.page.evaluate(() => step(0));
await stand.page.evaluate(() => go());
let t = 0;
for (let next = 16; next <= (travel ? 4000 : 3200); next += 16) {
    const shot = shots.find(s => s > t && s <= next);
    if (shot !== undefined) { await stand.page.evaluate(x => step(x), shot); await stand.shot(`portal_${calm ? 'c_' : ''}${shot}`); }
    await stand.page.evaluate(x => step(x), next);
    t = next;
}
const state = await stand.page.evaluate(() => ({ done: window.done, doneAt: window.doneAt, activated: window.activated, arrived: window.arrived, overlays: document.querySelectorAll('.gd-impact,.gd-letterbox').length }));
console.log('конец:', JSON.stringify(state), state.overlays ? '— НА ЭКРАНЕ ОСТАЛИСЬ СЛОИ' : '');
await stand.close();
