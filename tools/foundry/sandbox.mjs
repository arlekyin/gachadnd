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
        name: 'Поджигатель', x: 8, y: 12, level: 10,
        skills: ['Это нормально', 'Пол — это лава', 'Раскалённый клинок', 'Феникс', 'Горячая картошка', 'Ссссс…', 'Красная бочка', 'Взрыв трупа', 'Утечка газа', 'Ох, да!']
    },
    {
        name: 'Мясник', x: 9, y: 9, level: 10,
        skills: ['Хлопушка', 'Чутьё мясника', 'Навылет', 'Рандомная хрень, вперёд!', 'Переливание', 'Медленный яд', 'Сверхновая']
    },
    {
        name: 'Перегревщик', x: 6, y: 11, level: 5,
        skills: ['Перезарядка', 'Оверклокинг', 'Стена? Какая стена?', 'Сейв-лоад']
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
<li><strong>Призма</strong> — затем выберите целью Огнеупорного (сопротивление огню, иммунитет к яду) и бросьте урон мечом: в карточке урона цветная строка раскладки на 7 типов, «Применить» — и в чат придёт итог по цели: что срезало сопротивление и иммунитет.</li>
<li><strong>Солнечная батарея</strong> — заряд за конец хода на ярком свету. Ночь: Освещение сцены → темнота 1; фонарь слева внизу светит и ночью. Заряды видно в окне использования.</li>
<li><strong>Рикошет</strong> — прицел мышью, луч отражается от стен комнаты: 2 раза, на ранге II — 3, на III — 4; Esc или правая кнопка — отмена.</li>
<li><strong>Маяк</strong> — конус ставится мышью, колесо поворачивает луч. Каждый раунд луч поворачивается на 90°.</li>
<li><strong>Диско-шар</strong> — в бою: 6 цветных пятен, кто на пятне — тянет карту Пятницы.</li>
<li><strong>Вспышка камеры</strong> — в бою: снимок; повторное использование — проявка (места и ПЗ).</li>
<li><strong>Спотлайт</strong> — в бою: сначала выберите цель (T) — она станет звездой; без цели звезда — сам. Повторное использование переводит луч на новую цель. Кнопка «Подыграть» — в карточке чата.</li>
<li><strong>Счётчик ауры</strong> — в бою; повторное использование — панель с позёрством.</li>
</ul>
<h3>Поджигатель (уровень 10)</h3>
<ul>
<li><strong>Это нормально</strong> — в бою: клетка мышью; огонь расходится каждый раунд, стены его держат. Поджигатель в огне не горит, а получает временные ПЗ.</li>
<li><strong>Пол — это лава</strong> — в бою: кто закончит ход там же, где начал, горит. Свечение по краям экрана. Поднятый токен (высота &gt; 0) не горит.</li>
<li><strong>Раскалённый клинок</strong> — атакуйте мечом выбранную цель: попадания греют клинок (надпись над токеном), нагрев 4 — плавится. Использование навыка — конус сброса жара.</li>
<li><strong>Феникс</strong> — в бою опустите ПЗ Поджигателя до 0: пепел, в начале его хода — возрождение. На карточке — «Растоптать пепел».</li>
<li><strong>Горячая картошка</strong> — в бою: цель вплотную (T). Таймер шёпотом; «Передать своей цели» на карточке.</li>
<li><strong>Ссссс…</strong> — в бою: если к концу следующего хода рядом враг — взрыв; никого — заряд вернётся.</li>
<li><strong>Красная бочка</strong> — две клетки мышью. Ударьте бочку — взрыв и цепная реакция.</li>
<li><strong>Взрыв трупа</strong> — опустите врагу ПЗ до 0, выберите его целью. Убил взрывом — кнопки цепочки.</li>
<li><strong>Утечка газа</strong> — в бою: клетка мышью, облако видно только вам. Урон огнём по кому-то в облаке (или пожар) — взрыв.</li>
<li><strong>Ох, да!</strong> — наведите рывок на стену комнаты: стена разрежется, Поджигатель окажется за ней.</li>
</ul>
<h3>Мясник (уровень 10)</h3>
<ul>
<li><strong>Хлопушка</strong> — бонусным действием: все в 10 футах без реакций до начала своего хода (в бою эффект снимется сам).</li>
<li><strong>Чутьё мясника</strong> — выделите Мясника и опустите врагу ПЗ ниже половины: над ним капля крови (видит только тот, кто ведёт Мясника). Дальше 30 футов — капли нет.</li>
<li><strong>Навылет</strong> — добейте врага мечом Мясника («Применить» в лотке урона): лишний урон — кнопкой в карточке соседу убитого.</li>
<li><strong>Рандомная хрень, вперёд!</strong> — выберите цели (T) и используйте: окно — какой клинок в кого (у Мясника в сумке Кинжал и Ручной топор). Брошенное лежит у цели, «Подобрать» — в карточке; что не подобрали до конца боя — пропадёт.</li>
<li><strong>Переливание</strong> — цель (T) в 30 футах: обмен долями ПЗ; враг кидает спасбросок Телосложения, союзник согласен. Цена — истощение.</li>
<li><strong>Медленный яд</strong> — в бою, цель (T): три раунда считает весь её урон (эффект «Медленный яд: N»), в начале третьего раунда возвращает его ядом.</li>
<li><strong>Сверхновая</strong> — в бою копит урон по Мяснику («Сверхновая: N»); использование — взрыв в 20 футах, Мясник ошеломлён.</li>
</ul>
<h3>Сделка луны</h3>
<p>На сцене начерчена карта этажа, отряд стоит на узле Босса. Откройте Карту этажа (кнопка на панели токенов) и щёлкните по узлу Босса — у всех откроется Сделка. Без игроков в мире отряд — все персонажи этой сцены; Мастер выбирает, за кого кладёт жертвы, щелчком по портрету.</p>
<ul>
<li>Щелчок по карте лота — луна опускает её к себе, это выбранный лот. Щелчок по навыку в руке или по жетону (Кость Хитов, ПЗ, осколок маски — слот Памяти, золото, кристаллы Хранилища) — жертва на чашу. Щелчок по своей гирьке на чаше — забрать.</li>
<li>Набрали цену — полнолуние, печать краснеет. «Скрепить» — жертвы уходят навсегда, лот выдаётся; для Чужой памяти и Сплава — окно выбора.</li>
<li>У Перегревщика 1000 зм и синий кристалл в Хранилище. Сделка — раз за этаж: заново её даст только пересборка песочницы.</li>
</ul>
<h3>Перегревщик (уровень 5)</h3>
<ul>
<li>Потратьте заряд Стена? Какая стена?, затем Перезарядка или Оверклокинг (цена 2d6 ПЗ) — заряд вернётся заёмным. Со второго заёмного использования до долгого отдыха — бросок к100.</li>
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

// Мяснику — что швырять (Рандомная хрень): неэкипированные клинки в сумке
await page.evaluate(hero => game.actors.get(hero).createEmbeddedDocuments('Item', [
    { name: 'Кинжал', type: 'weapon', img: 'icons/weapons/daggers/dagger-straight-blue.webp', system: { type: { value: 'simpleM' }, damage: { base: { number: 1, denomination: 4, types: ['piercing'] } }, equipped: false } },
    { name: 'Ручной топор', type: 'weapon', img: 'icons/weapons/axes/axe-broad-black.webp', system: { type: { value: 'simpleM' }, damage: { base: { number: 1, denomination: 6, types: ['slashing'] } }, equipped: false } }
]), ids.heroes['Мясник']);

// Сделка луны: карта этажа на сцене песочницы, отряд на узле Босса; Перегревщику — золото и кристалл в Хранилище
await page.evaluate(() => game.gachadnd.openMapTerminal());
await page.waitForTimeout(800);
await page.evaluate(() => { document.querySelector('[name="length"]').value = '6'; document.querySelector('[data-action="generate"]')?.click(); });
await page.waitForTimeout(1200);
await page.evaluate(async hero => {
    for (const a of foundry.applications.instances.values()) if (a.constructor.name === 'GachaMapTerminal') await a.close();
    const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    const boss = map.nodes.find(n => n.type === 'boss');
    map.currentNodeId = boss.id;
    map.visitedNodes = [boss.id];
    await canvas.scene.setFlag('gachadnd', 'floorMap', map);
    const actor = game.actors.get(hero);
    await actor.update({ 'system.currency.gp': 1000 });
    const crystals = await import('/modules/gachadnd/scripts/memory/crystals.js');
    const stash = await import('/modules/gachadnd/scripts/memory/stash.js');
    const [crystal] = await actor.createEmbeddedDocuments('Item', [await crystals.randomCrystal('blue')]);
    await stash.depositCrystal(actor, crystal);
}, ids.heroes['Перегревщик']);

const report = await page.evaluate(({ SANDBOX }) => game.actors.filter(a => a.name.startsWith(SANDBOX)).map(a => {
    const memory = a.items.filter(i => i.flags.gachadnd?.skill_name);
    const overload = a.effects.some(e => e.flags?.gachadnd?.is_system_effect);
    return `${a.name.replace(`${SANDBOX}: `, '')}: ${memory.length ? memory.map(i => i.name).join(', ') : 'без навыков'}${overload ? ' — ПЕРЕГРУЗКА' : ''}`;
}), { SANDBOX });
console.log('Песочница готова — сцена «GD-песочница: навыки», журнал «GD-песочница: как проверять»:');
for (const line of report) console.log('  ' + line);
await f.close();
