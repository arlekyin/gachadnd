// Генератор арен без Foundry: node tools/stand/arena.mjs [настроения через запятую] [--seed=proto] [--only=campfire,statue]
// Планировка и рисунок — те же layout.js и paint.js; снимки — out/arena_<настроение>.png. Для быстрой правки картинки
import fs from 'node:fs';
import path from 'node:path';
import { open, args, ROOT } from './harness.mjs';

const { seed = 'proto', only } = args();
const moods = (process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'day,rot').split(',');
const files = fs.readdirSync(path.join(ROOT, 'assets/battlemap/forest')).filter(f => /\.(png|webp|jpe?g)$/i.test(f)).map(f => `/assets/battlemap/forest/${f}`);
const stand = await open('arena.html', { width: 1400, height: 1000 });
for (const mood of moods) {
    const scheme = await stand.page.evaluate(o => render(o), { files, mood, seed, only: only ? only.split(',') : null });
    await stand.shot(`arena_${mood}`);
    console.log(mood, scheme);
}
await stand.close();
