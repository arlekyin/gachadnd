// Песочница для ручной проверки навыков: node tools/foundry/sandbox.mjs
// Запускается после проверок: пересоздаёт сцену «GD-песочница» с героями, у которых выданы и
// экипированы проверяемые навыки, врагами, союзником, стенами, тайными дверями и фонарём, готовит
// бой (не начатый) и оставляет журнал «как проверять». Проверки (префикс «GD-тест») её не трогают.
import { connect } from './harness.mjs';
import { install, skills } from './fixtures.mjs';

export const SANDBOX = 'GD-песочница';

/** Герои песочницы и их навыки. Уровень 10 — 11 слотов: всё экипировано без перегрузки */
const HEROES = [
    {
        name: 'Светоносец', x: 6, y: 8, level: 10,
        skills: ['Ультрафиолет', 'Скорость света', 'Призма', 'Солнечная батарея', 'Рикошет', 'Маяк', 'Диско-шар', 'Вспышка камеры', 'Спотлайт', 'Счётчик ауры']
    },
    {
        name: 'Перегревщик', x: 6, y: 11, level: 5,
        skills: ['Перезарядка', 'Оверклокинг', 'Китти Прайд', 'Давай по новой Миша, всё хуйня']
    }
];
const OTHERS = [
    { name: 'Союзник', type: 'character', x: 4, y: 9, disposition: 1 },
    { name: 'Огнеупорный', type: 'npc', x: 13, y: 8, disposition: -1, traits: { dr: { value: ['fire'] }, di: { value: ['poison'] } } },
    { name: 'Враг', type: 'npc', x: 16, y: 6, disposition: -1 },
    { name: 'Враг 2', type: 'npc', x: 16, y: 11, disposition: -1 }
];

const GUIDE = `
<h2>Песочница навыков</h2>
<p>Сцену, героев и бой пересоздаёт <code>node tools/foundry/sandbox.mjs</code> — после проверок Claude. Всё здесь можно ломать.</p>
<p><strong>Бой</strong> подготовлен, но не начат: «Начать бой» в трекере. Навыки, которым нужен бой, без него откажут.</p>
<h3>Светоносец (уровень 10)</h3>
<ul>
<li><strong>Ультрафиолет</strong> — в верхней стене две тайные двери: ближняя в 25 футах проступает, дальняя (справа) — нет.</li>
<li><strong>Скорость света</strong> — в чужой ход: ход Светоносца начинается сразу, свой ход в этом раунде он пропускает.</li>
<li><strong>Призма</strong> — затем атака мечом по Огнеупорному (сопротивление огню, иммунитет к яду): урон делится на 7 типов при применении из чата.</li>
<li><strong>Солнечная батарея</strong> — заряд за конец хода на ярком свету. Ночь: Освещение сцены → темнота 1; фонарь слева внизу светит и ночью. Заряды видно в окне использования.</li>
<li><strong>Рикошет</strong> — прицел мышью, луч отражается от стен комнаты до двух раз; Esc или правая кнопка — отмена.</li>
<li><strong>Маяк</strong> — конус ставится мышью, колесо поворачивает луч. Каждый раунд луч поворачивается на 90°.</li>
<li><strong>Диско-шар</strong> — в бою: 6 цветных пятен, кто на пятне — тянет карту Пятницы.</li>
<li><strong>Вспышка камеры</strong> — в бою: снимок; повторное использование — проявка (места и ПЗ).</li>
<li><strong>Спотлайт</strong> — в бою: сначала выберите цель (T) — она станет звездой; без цели звезда — сам. Повторное использование переводит луч на новую цель. Кнопка «Подыграть» — в карточке чата.</li>
<li><strong>Счётчик ауры</strong> — в бою; повторное использование — панель с позёрством.</li>
</ul>
<h3>Перегревщик (уровень 5)</h3>
<ul>
<li>Потратьте заряд Китти Прайд, затем Перезарядка или Оверклокинг (цена 2d6 ПЗ) — заряд вернётся заёмным. Со второго заёмного использования до долгого отдыха — бросок к100.</li>
</ul>
`;

const f = await connect();
const { page } = f;
await install(page);

const ids = await page.evaluate(async ({ SANDBOX, HEROES, OTHERS, GUIDE }) => {
    const old = d => d.name?.startsWith(SANDBOX);
    for (const c of game.combats.filter(c => old(c.scene ?? {}))) await c.delete();
    await new Promise(r => setTimeout(r, 1000));
    await Actor.deleteDocuments(game.actors.filter(old).map(a => a.id));
    await Scene.deleteDocuments(game.scenes.filter(old).map(s => s.id));
    await JournalEntry.deleteDocuments(game.journal.filter(old).map(j => j.id));

    const grid = 100;
    const scene = await Scene.create({
        name: `${SANDBOX}: навыки`, width: 2400, height: 1600, padding: 0,
        grid: { type: 1, size: grid, distance: 5, units: 'ft' },
        tokenVision: false, fog: { exploration: false },
        environment: { darknessLevel: 0, globalLight: { enabled: true, darkness: { min: 0, max: 0.5 } } }
    });
    const wall = (x0, y0, x1, y1, door = 0) => ({ c: [x0 * grid, y0 * grid, x1 * grid, y1 * grid], door });
    await scene.createEmbeddedDocuments('Wall', [
        // Комната: стены — зеркала Рикошета
        wall(2, 3, 5, 3), wall(5, 3, 7, 3, 2), wall(7, 3, 18, 3), wall(18, 3, 20, 3, 2), wall(20, 3, 22, 3),
        wall(22, 3, 22, 14), wall(22, 14, 2, 14), wall(2, 14, 2, 3)
    ]);
    await scene.createEmbeddedDocuments('AmbientLight', [{ x: 4 * grid, y: 12 * grid, config: { bright: 15, dim: 30, color: '#ffd28a', alpha: 0.4 } }]);

    const weapon = { name: 'Меч', type: 'weapon', system: { type: { value: 'martialM', baseItem: 'longsword' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } };
    const made = {};
    for (const h of HEROES) {
        const a = await Actor.create({
            name: `${SANDBOX}: ${h.name}`, type: 'character',
            system: { abilities: { str: { value: 14 }, dex: { value: 14 }, con: { value: 14 }, wis: { value: 12 }, cha: { value: 16 } }, attributes: { hp: { value: 80, max: 80 } } },
            prototypeToken: { actorLink: true, disposition: 1, displayName: 30, displayBars: 30, bar1: { attribute: 'attributes.hp' } }
        });
        await a.createEmbeddedDocuments('Item', [{ name: 'Воин', type: 'class', system: { identifier: 'fighter', levels: h.level, hd: { denomination: 'd10' } } }, weapon]);
        made[h.name] = a;
    }
    for (const o of OTHERS) {
        made[o.name] = await Actor.create({
            name: `${SANDBOX}: ${o.name}`, type: o.type,
            system: { attributes: { hp: { value: 40, max: 40 }, ...(o.type === 'npc' ? { ac: { calc: 'flat', flat: 13 } } : {}) }, ...(o.type === 'npc' ? { details: { cr: 2 } } : {}), ...(o.traits ? { traits: o.traits } : {}) },
            prototypeToken: { actorLink: true, disposition: o.disposition, displayName: 30, displayBars: 30, bar1: { attribute: 'attributes.hp' } }
        });
        await made[o.name].createEmbeddedDocuments('Item', [weapon]);
    }
    const all = [...HEROES, ...OTHERS];
    await scene.createEmbeddedDocuments('Token', all.map(d => ({ ...made[d.name].prototypeToken.toObject(), actorId: made[d.name].id, name: made[d.name].name, x: d.x * grid, y: d.y * grid })));
    await scene.activate();
    await scene.view();
    // Мир запускается на паузе — в песочнице она мешает
    if (game.paused) game.togglePause(false, { broadcast: true });

    // Бой готов, не начат
    const combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments('Combatant', all.map((d, i) => ({
        tokenId: scene.tokens.find(t => t.actorId === made[d.name].id).id, sceneId: scene.id, actorId: made[d.name].id, initiative: 20 - i * 2
    })));

    await JournalEntry.create({ name: `${SANDBOX}: как проверять`, pages: [{ name: 'Навыки', type: 'text', text: { content: GUIDE } }] });
    return { heroes: Object.fromEntries(HEROES.map(h => [h.name, made[h.name].id])) };
}, { SANDBOX, HEROES, OTHERS, GUIDE });

for (const h of HEROES) await skills(page, ids.heroes[h.name], h.skills);

const report = await page.evaluate(({ SANDBOX }) => game.actors.filter(a => a.name.startsWith(SANDBOX)).map(a => {
    const memory = a.items.filter(i => i.flags.gachadnd?.skill_name);
    const overload = a.effects.some(e => e.flags?.gachadnd?.is_system_effect);
    return `${a.name.replace(`${SANDBOX}: `, '')}: ${memory.length ? memory.map(i => i.name).join(', ') : 'без навыков'}${overload ? ' — ПЕРЕГРУЗКА' : ''}`;
}), { SANDBOX });
console.log('Песочница готова — сцена «GD-песочница: навыки», журнал «GD-песочница: как проверять»:');
for (const line of report) console.log('  ' + line);
await f.close();
