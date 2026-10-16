// Огненные навыки в настоящей Foundry: node tools/foundry/blast-fire.mjs [--headed] [--slow[=мс]]
// Компендиум и третий порог «огня»; Это нормально (клетка мышью, распространение, стена, урон в начале
// хода и при заходе, временные ПЗ владельцу); Пол — это лава (стоял — обжёгся, двигался или выше пола —
// нет, свечение); Раскалённый клинок (нагрев от попаданий, урон огнём строкой, плавление, сброс конусом);
// Феникс (пепел, возрождение со вспышкой, растоптать пепел).
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
// После смены хода — ожидание тишины: хуки модуля у Мастера дописывают своё (fixtures: gdt.settle)
const settle = () => page.evaluate(() => gdt.settle());
const chats = () => ev(() => gdt.chats().map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
const hp = id => ev(id => { const h = game.actors.get(id).system.attributes.hp; return h.value + (h.temp ?? 0); }, id);
const turn = () => ev(() => `${game.combat.round}:${game.combat.combatant?.name?.replace('GD-тест: ', '')}`);
const next = async () => { await ev(() => game.combat.nextTurn()); await settle(); return turn(); };
const place = (id, x, y) => ev(async ({ id, x, y }) => { const { placeToken } = await gdt.mod('memory/skills/pick.js'); await placeToken(game.actors.get(id).getActiveTokens()[0].document, x * 100, y * 100); }, { id, x, y });
const clickCell = async (x, y) => {
    const s = await ev(p => { const c = canvas.clientCoordinatesFromCanvas(p); return { x: c.x, y: c.y }; }, { x: x * 100 + 50, y: y * 100 + 50 });
    await page.mouse.move(s.x - 20, s.y - 20); await page.mouse.move(s.x, s.y, { steps: 5 }); await wait(250);
    await page.mouse.down(); await page.mouse.up();
};
/** Использование с выбором на карте: use() → клик → окно dnd5e */
const useAt = async (actor, item, x, y) => {
    await ev(({ actor, item }) => { gdt.p = game.actors.get(actor).items.get(item).system.activities.contents[0].use(); }, { actor, item });
    await wait(900);
    await clickCell(x, y);
    for (let i = 0; i < 20; i++) {
        const w = (await ev(() => gdt.windows())).find(w => w.cls === 'ActivityUsageDialog');
        if (w) { await page.click(`#${w.id} button[data-action="use"]`); break; }
        await wait(150);
    }
    await wait(1500);
};
const useNow = (actor, item) => ev(async ({ actor, item }) => { gdt.warnings.length = 0; return game.actors.get(actor).items.get(item).system.activities.contents[0].use({}, { configure: false }); }, { actor, item });

await install(page);
const ids = await scene(page, {
    hero: { x: 5, y: 5, level: 5 },
    enemies: [{ name: 'Рядом', x: 7, y: 7 }, { name: 'Бегун', x: 12, y: 5 }],
    walls: [{ c: [8, 5, 8, 10] }]
});
const { hero } = ids;
const [A, B] = ids.enemies;

// ---------- Компендиум и синергия
const pack = await ev(async () => {
    const docs = await game.packs.get('gachadnd.gacha-skills').getDocuments();
    return docs.filter(d => d.flags.gachadnd?.blast).map(d => `${d.name}:${d.flags.gachadnd.blast}`).sort();
});
check('компендиум: 10 навыков огня и взрыва с полем blast', pack.length === 10, pack.join(', '));
const S = await skills(page, hero, ['Это нормально', 'Пол — это лава', 'Раскалённый клинок', 'Феникс', 'Горячая картошка', 'Красная бочка']);
// Пересчёт синергий может перезапуститься после экипировки — ждём итога
const synergy = await ev(async hero => {
    const names = () => game.actors.get(hero).effects.filter(e => /Синерги/.test(e.name)).map(e => e.name).join(' | ');
    await gdt.until(() => /Огонь III/.test(names()), 6000);
    return names();
}, hero);
check('шесть навыков с «огнём» — третий порог синергии огня', /Огонь III/.test(synergy), synergy);

for (const a of [hero, A, B]) await ev(async id => { await game.actors.get(id).createEmbeddedDocuments('Item', [{ name: 'GD-тест: меч', type: 'weapon', system: { type: { value: 'martialM', baseItem: 'longsword' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } }]); }, a);
await combat(page, ids.scene, [hero, A, B]);
await wait(600);
await ev(() => gdt.closeForeign());
// Ошибки Foundry при пересоздании сцены фикстурой — не наши: считаем с этого места
const since = f.log.length;

// ---------- Это нормально
await useAt(hero, S['Это нормально'], 6, 7);
const fire = () => ev(() => game.combat.getFlag('gachadnd', 'fire'));
let st = await fire();
check('Это нормально: клетка выбрана мышью — пожар в (6,7)', JSON.stringify(st?.cells) === '[[6,7]]', JSON.stringify(st?.cells));
await f.shot('fine_1');
await ev(() => { gdt.mark(); gdt.dice(6, 6, 6); });
await next(); // ход «Рядом»: ещё раунд 1, огонь в одной клетке — его клетка (7,7) не горит
const hpA0 = await hp(A);
await next(); // Бегун
// Раунд 2: огонь на соседние клетки; «Рядом» начинает ход в (7,7) — в огне
await ev(() => gdt.dice(6, 6, 6));
check('раунд 2', (await next()) === '2:Герой', await turn());
st = await fire();
check('раунд 2: огонь перекинулся на 4 соседние клетки', st.cells.length === 5, JSON.stringify(st.cells));
await next();
check('«Рядом» начал ход в огне — 2d6 = 12', hpA0 - (await hp(A)) === 12, `${hpA0} → ${await hp(A)}`);
// Бегун заходит в огонь в свой ход — в обход стены: сначала встаёт над ней
await place(B, 7, 4);
await next();
const hpB0 = await hp(B);
await ev(() => gdt.dice(6, 2, 3));
await ev(B => game.actors.get(B).getActiveTokens()[0].document.update({ x: 600, y: 600 }), B);
await ev(B => gdt.until(() => (game.actors.get(B).system.attributes.hp.value) < 30, 6000), B);
check('Бегун зашёл в огонь в свой ход — урон', hpB0 - (await hp(B)) === 5, `${hpB0} → ${await hp(B)}`);
// Герой в огне: в начале своего хода — временные ПЗ
await place(hero, 6, 7);
check('раунд 3', (await next()) === '3:Герой', await turn());
const temp = await ev(hero => game.actors.get(hero).system.attributes.hp.temp, hero);
check('владелец в огне — не горит, а получает временные ПЗ = бонус мастерства (3)', temp === 3, String(temp));
st = await fire();
const cells = new Set(st.cells.map(c => c.join(',')));
check('раунд 3: огонь ромбом, но стена (x = 8) его не пропустила', !cells.has('8,7') && cells.has('7,7') && cells.has('4,7') && cells.size === 12, [...cells].join(' '));
await f.shot('fine_3');

// ---------- Пол — это лава (ход героя, раунд 3)
await ev(() => gdt.mark());
await useNow(hero, S['Пол — это лава']);
await wait(1200);
check('лава: флаг и свечение по краям экрана', !!(await ev(() => game.combat.getFlag('gachadnd', 'lava'))) && !!(await page.$('#gd-lava-glow')));
const hpH0 = await hp(hero);
await ev(() => gdt.dice(6, 3, 3));
await next(); // герой стоял — 6 (временные ПЗ 3 поглотят часть)
check('лава: герой закончил ход на месте — 2d6 = 6', hpH0 - (await hp(hero)) === 6, `${hpH0} → ${await hp(hero)}`);
// «Рядом» двигается, Бегун стоит
const a1 = await hp(A);
await place(A, 7, 9);
await ev(() => gdt.dice(6, 1, 1));
await next();
check('лава: «Рядом» сдвинулся — не горит', (await hp(A)) === a1, `${a1} → ${await hp(A)}`);
const b1 = await hp(B);
await ev(B => game.actors.get(B).getActiveTokens()[0].document.update({ elevation: 10 }), B);
await ev(() => gdt.dice(6, 1, 1));
await next();
check('лава: Бегун стоял, но выше пола — не горит', (await hp(B)) === b1, `${b1} → ${await hp(B)}`);

// ---------- Раскалённый клинок: ход героя
await ev(() => game.combat.unsetFlag('gachadnd', 'lava'));
const heat = () => ev(({ hero, id }) => game.actors.get(hero).items.get(id).getFlag('gachadnd', 'bladeHeat') ?? 0, { hero, id: S['Раскалённый клинок'] });
const swing = (d20, melt = []) => ev(async ({ hero, A, d20, melt }) => {
    canvas.tokens.setTargets([game.actors.get(A).getActiveTokens()[0].id]);
    gdt.dice(20, d20);
    if (melt.length) gdt.queue(6, ...melt);
    const act = game.actors.get(hero).items.find(i => i.type === 'weapon').system.activities.find(x => x.type === 'attack');
    await act.rollAttack({}, { configure: false }, {});
    await gdt.sleep(600);
}, { hero, A, d20, melt });
await swing(19);
check('клинок: попадание — нагрев 1', (await heat()) === 1, String(await heat()));
await swing(2);
check('клинок: промах — нагрев не растёт', (await heat()) === 1, String(await heat()));
const dmg = await ev(async hero => {
    const act = game.actors.get(hero).items.find(i => i.type === 'weapon').system.activities.find(x => x.type === 'attack');
    const rolls = await act.rollDamage({}, { configure: false }, {});
    return rolls.map(r => `${r.options.type}:${r.formula}`).join(' | ');
}, hero);
check('клинок: урон оружием + нагрев огнём отдельной строкой', /fire:1$/.test(dmg), dmg);
const h0 = await hp(hero);
await swing(19); await swing(19);
await swing(19, [4, 4]);
await wait(800);
check('клинок: нагрев 4 — плавится: 2d6 = 8 по владельцу, нагрев 0', (await heat()) === 0 && h0 - (await hp(hero)) === 8, `нагрев ${await heat()}, ПЗ ${h0} → ${await hp(hero)}`);
// Холодный — стравить нечего
await useNow(hero, S['Раскалённый клинок']);
check('клинок: холодный — стравить нечего', await ev(() => gdt.warnings.some(w => /холодный/.test(w))));
// Стравить жар 3: конус на восток из клетки героя
await ev(({ hero, id }) => game.actors.get(hero).items.get(id).setFlag('gachadnd', 'bladeHeat', 3), { hero, id: S['Раскалённый клинок'] });
await place(A, 7, 7);
await ev(() => gdt.mark());
await ev(({ hero, id }) => { gdt.p = game.actors.get(hero).items.get(id).system.activities.contents[0].use(); }, { hero, id: S['Раскалённый клинок'] });
// Окно использования, затем предпросмотр конуса dnd5e — и только тогда клик
for (let i = 0; i < 40; i++) {
    const w = (await ev(() => gdt.windows())).find(w => w.cls === 'ActivityUsageDialog');
    if (w) { await page.click(`#${w.id} button[data-action="use"]`); break; }
    await wait(150);
}
await ev(() => gdt.until(() => canvas.templates.preview?.children?.length > 0, 5000));
await wait(300);
const heroCell = await ev(hero => { const t = game.actors.get(hero).getActiveTokens()[0].document; return [t.x / 100, t.y / 100]; }, hero);
await ev(() => gdt.dice(6, 5, 5, 5, 20, 20));
await clickCell(heroCell[0], heroCell[1]);
await ev(() => gdt.until(() => gdt.chats().some(c => /стравливает жар/.test(c)), 6000));
const vent = (await chats()).find(c => /стравливает жар/.test(c));
check('клинок: стравить жар 3 — конус, спасбросок Ловкости, 3d6', /3d6/.test(vent ?? '') && /Ловкости/.test(vent ?? '') && (await heat()) === 0, vent);
check('клинок: шаблон конуса убран', !(await ev(scene => game.scenes.get(scene).templates.size, ids.scene)));

// ---------- Феникс
// Подальше от пожара: иначе в ход соседа огонь съест подложенные кости
await place(hero, 14, 2);
await place(A, 15, 2);
await ev(A => game.actors.get(A).update({ 'system.attributes.hp.value': 30 }), A);
const tex0 = await ev(hero => game.actors.get(hero).getActiveTokens()[0].document.texture.src, hero);
await ev(hero => game.actors.get(hero).update({ 'system.attributes.hp.value': 0, 'system.attributes.hp.temp': 0 }), hero);
await ev(hero => gdt.until(() => /embers/.test(game.actors.get(hero).getActiveTokens()[0]?.document.texture.src), 5000), hero);
const ash = await ev(hero => ({ flag: !!game.actors.get(hero).getFlag('gachadnd', 'phoenixAsh'), tex: game.actors.get(hero).getActiveTokens()[0].document.texture.src }), hero);
check('Феникс: 0 ПЗ — кучка пепла, заряд потрачен', ash.flag && /embers/.test(ash.tex) && (await ev(({ hero, id }) => game.actors.get(hero).items.get(id).system.uses.spent, { hero, id: S['Феникс'] })) === 1, JSON.stringify(ash));
await f.shot('phoenix_ash');
const aBefore = await hp(A);
// Сейчас ход героя: возрождение — в начале его следующего хода; кости — прямо перед ним
do {
    if (await ev(() => /Герой/.test(game.combat.nextCombatant?.name ?? ''))) await ev(() => gdt.dice(6, 6, 6, 6, 6));
    await next();
} while (!/Герой/.test(await turn()));
await wait(1000);
const reborn = await ev(hero => ({ hp: game.actors.get(hero).system.attributes.hp.value, tex: game.actors.get(hero).getActiveTokens()[0].document.texture.src, flag: !!game.actors.get(hero).getFlag('gachadnd', 'phoenixAsh') }), hero);
check('Феникс: в начале хода — возрождение с половиной ПЗ, токен прежний', reborn.hp === 30 && reborn.tex === tex0 && !reborn.flag, JSON.stringify(reborn));
check('Феникс: вспышка — 4d6 = 24 по соседу', aBefore - (await hp(A)) === 24, `${aBefore} → ${await hp(A)}`);
// Растоптать пепел
await ev(({ hero, id }) => game.actors.get(hero).items.get(id).update({ 'system.uses.spent': 0 }), { hero, id: S['Феникс'] });
await ev(hero => game.actors.get(hero).update({ 'system.attributes.hp.value': 0 }), hero);
await wait(1500);
await ev(async () => { await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary'); });
await wait(500);
const card = await ev(() => game.messages.contents.findLast(m => m.flags?.gachadnd?.phoenix)?.id);
await page.click(`#chat [data-message-id="${card}"] [data-phoenix-stomp]`);
await wait(1500);
const stomped = await ev(hero => ({ hp: game.actors.get(hero).system.attributes.hp.value, tex: game.actors.get(hero).getActiveTokens()[0].document.texture.src, flag: !!game.actors.get(hero).getFlag('gachadnd', 'phoenixAsh') }), hero);
check('Феникс: пепел растоптан — токен прежний, ПЗ 0, возрождения нет', stomped.hp === 0 && stomped.tex === tex0 && !stomped.flag, JSON.stringify(stomped));

await ev(() => gdt.resetDice());
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
