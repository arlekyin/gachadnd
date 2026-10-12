// Выпадение кристаллов: node tools/stand/loot.mjs [--rarity=red|purple] [--calm] [--at=500,1000]
// Красный — сцена (кадрами по 16 мс), фиолетовый — вспышка краёв (реальное время). Снимки
// out/loot_<редкость>_<мс>.png. В конце — вернулась ли сцена.
import { open, args } from './harness.mjs';

const { rarity = 'red', calm, at } = args();
const stand = await open(`loot.html${calm ? '?calm' : ''}`);
await stand.page.evaluate(() => step(0));
await stand.page.evaluate(r => go(r), rarity);
if (rarity === 'purple') {
    // Вспышка — CSS-анимация в реальном времени
    for (const ms of [120, 300, 650]) { await stand.page.waitForTimeout(ms === 120 ? 120 : ms - 120); await stand.shot(`loot_purple_${ms}`); }
    await stand.page.waitForTimeout(500);
} else {
    const shots = at ? String(at).split(',').map(Number) : [250, 600, 900, 1000, 1200, 1700, 2300];
    let t = 0;
    for (let next = 16; next <= 2900; next += 16) {
        const shot = shots.find(s => s > t && s <= next);
        if (shot !== undefined) { await stand.page.evaluate(x => step(x), shot); await stand.shot(`loot_red_${calm ? 'c_' : ''}${shot}`); }
        await stand.page.evaluate(x => step(x), next);
        t = next;
    }
}
const state = await stand.page.evaluate(() => ({ done: window.done, scale: canvas.stage.scale.x, overlays: document.querySelectorAll('.gd-impact,.gd-letterbox').length }));
console.log('конец:', JSON.stringify(state), state.overlays ? '— НА ЭКРАНЕ ОСТАЛИСЬ СЛОИ' : '');
await stand.close();
