// Навыки света в настоящей Foundry: node tools/foundry/light.mjs [--headed] [--slow[=мс]]
// Девять навыков в компендиуме (редкость, теги, заряды, отдых), кладутся персонажу и экипируются,
// синергия тега «свет» проходит пороги 2/4/6.
import { connect, checker, moduleErrors } from './harness.mjs';
import { install, scene, skills } from './fixtures.mjs';

const LIGHT = {
    'Ультрафиолет': { rarity: 'gray', uses: 1, period: 'sr' },
    'Скорость света': { rarity: 'green', uses: 1, period: 'initiative' },
    'Призма': { rarity: 'green', uses: 2, period: 'sr' },
    'Солнечная батарея': { rarity: 'blue', uses: 0 },
    'Рикошет': { rarity: 'blue', uses: 2, period: 'sr', damage: '3d8', type: 'radiant' },
    'Маяк': { rarity: 'purple', uses: 1, period: 'sr' },
    'Диско-шар': { rarity: 'purple', uses: 1, period: 'lr' },
    'Вспышка камеры': { rarity: 'red', uses: 1, period: 'lr' },
    'Спотлайт': { rarity: 'red', uses: 1, period: 'lr' }
};

const f = await connect();
const { page } = f;
const { check, summary } = checker();

await install(page);
const ids = await scene(page);

// 1. Компендиум
const pack = await page.evaluate(async names => {
    const docs = await game.packs.get('gachadnd.gacha-skills').getDocuments();
    return Object.fromEntries(names.map(n => {
        const d = docs.find(x => x.name === n);
        if (!d) return [n, null];
        const act = d.system.activities?.contents?.[0];
        const dmg = act?.damage?.parts?.[0];
        return [n, {
            rarity: d.flags.gachadnd?.rarity, tags: d.flags.gachadnd?.tags ?? [],
            uses: Number(d.system.uses?.max) || 0, period: d.system.uses?.recovery?.[0]?.period,
            damage: dmg ? (dmg.custom?.enabled ? dmg.custom.formula : `${dmg.number}d${dmg.denomination}`) : null, type: dmg ? [...dmg.types][0] : null,
            text: d.system.description.value.replace(/<[^>]+>/g, ' ').trim().slice(0, 60)
        }];
    }));
}, Object.keys(LIGHT));
for (const [name, want] of Object.entries(LIGHT)) {
    const got = pack[name];
    const ok = got && got.rarity === want.rarity && got.tags.includes('свет') && got.uses === want.uses
        && (!want.period || got.period === want.period) && (!want.damage || (got.damage === want.damage && got.type === want.type));
    check(`${name}: ${want.rarity}, «свет», заряды ${want.uses || 'нет'}${want.period ? ` / ${want.period}` : ''}`, ok, got ? JSON.stringify({ ...got, text: undefined }) : 'нет в компендиуме');
}

// 2. Синергия света: 2 навыка — Светоч, 4 — Очищение, 6 — Сверхновая
const synergy = () => page.evaluate(hero => game.actors.get(hero).effects.filter(e => /Синерги/.test(e.name)).map(e => e.name).join(' | '), ids.hero);
const names = Object.keys(LIGHT);
const steps = [[2, /Светоч/], [4, /Очищение/], [6, /Сверхновая/]];
let added = 0;
for (const [count, re] of steps) {
    await skills(page, ids.hero, names.slice(added, count));
    added = count;
    // Синергии пересчитываются после создания и экипировки — не сразу
    let s = '';
    for (let i = 0; i < 40 && !re.test(s); i++) { await page.waitForTimeout(150); s = await synergy(); }
    check(`${count} навыков света — порог «${re.source}»`, re.test(s), s || 'синергий нет');
}

await f.shot('light');
const errors = moduleErrors(f.log);
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
process.exit(failed ? 1 : 0);
