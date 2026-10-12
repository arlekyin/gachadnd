// Предвестия Пожирателя: node tools/stand/omen.mjs [--calm]
// Снимки каждой стадии — out/omen_<off|3|2|1|here>.png. Шейдер идёт в реальном времени.
import { open, args } from './harness.mjs';

const { calm } = args();
const stand = await open(`omen.html${calm ? '?calm' : ''}`);
for (const stage of ['off', '3', '2', '1', 'here']) {
    await stand.page.evaluate(s => show(s), stage);
    await stand.page.waitForTimeout(1500);
    await stand.shot(`omen_${calm ? 'c_' : ''}${stage}`);
}
console.log('фильтров на сцене после «Здесь»:', await stand.page.evaluate(() => canvas.stage.filters?.length ?? 0));
await stand.page.evaluate(() => show('off'));
console.log('после снятия:', await stand.page.evaluate(() => canvas.stage.filters?.length ?? 0));
await stand.close();
