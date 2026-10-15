// Разрез Ямато (Вергилий): node tools/stand/slash.mjs [--calm] [--h] [--dpr=1.25] [--slow=100]
// Кадр идёт в реальном времени, замедленный в slow раз (программный WebGL медленный): снимки
// out/slash_<вариант>_<s|1|2|end>.png — начало, первый кадр, второй (инверсия), конец. В конце
// проверяется, что сцена вернулась: фильтры сняты, масштаб прежний, слоёв поверх нет.
import { open, args } from './harness.mjs';

const { calm, h, dpr = 1, slow = 100 } = args();
const tag = [h ? 'h' : 'v', calm && 'calm', dpr != 1 && `d${dpr}`].filter(Boolean).join('_');
const query = new URLSearchParams({ slow, ...(calm ? { calm: '' } : {}) });
const stand = await open(`slash.html?${query}`, { dpr: Number(dpr) });
await stand.shot(`slash_${tag}_0`);
await stand.page.evaluate(direction => go(direction), h ? 0 : 92);
const t0 = Date.now();
// Моменты для slow = 100; при другом замедлении — пропорционально
for (const [ms, name] of [[500, 's'], [10000, '1'], [19000, '2'], [27000, 'end']]) {
    await stand.page.waitForTimeout(Math.max(0, ms * slow / 100 - (Date.now() - t0)));
    await stand.shot(`slash_${tag}_${name}`);
}
const state = await stand.page.evaluate(() => ({
    filters: canvas.stage.filters?.length ?? 0, scale: canvas.stage.scale.x,
    marks: toks.target.effects.visible, overlays: document.querySelectorAll('.gd-impact').length
}));
console.log('конец:', JSON.stringify(state), state.filters || state.overlays ? '— СЦЕНА НЕ ВЕРНУЛАСЬ' : '');
await stand.close();
