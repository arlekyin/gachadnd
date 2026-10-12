// Кулаки Сайтамы отдельно: node tools/stand/fists.mjs [--calm] [--at=260,400]
// Время идёт кадрами по 16 мс; снимки out/fists_<n|c>_<мс>.png в заданные моменты.
// В консоли — время подготовки кулаков и моменты ударов.
import { open, args } from './harness.mjs';

const { calm, at } = args();
const shots = at ? String(at).split(',').map(Number) : [260, 320, 370, 400, 470, 1100, 1160, 1195, 1260, 1330, 1420, 1520];
const stand = await open('fists.html');
console.log('подготовка кулаков, мс:', await stand.page.evaluate(() => prepMs));
await stand.page.evaluate(c => go(c), !!calm);
let t = 0;
for (let next = 16; next <= Math.max(...shots); next += 16) {
    const shot = shots.find(s => s > t && s <= next);
    // Кадр ровно в момент снимка, чтобы время в имени файла было точным
    if (shot !== undefined) { await stand.page.evaluate(x => step(x), shot); await stand.shot(`fists_${calm ? 'c' : 'n'}_${shot}`); }
    await stand.page.evaluate(x => step(x), next);
    t = next;
}
console.log('удары [номер, последний, мс]:', JSON.stringify(await stand.page.evaluate(() => hits)));
await stand.close();
