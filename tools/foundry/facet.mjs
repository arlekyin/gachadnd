// Огранка в настоящей Foundry: node tools/foundry/facet.mjs [--headed]
// Камни за ступени синергий; вкладка «Огранка» в Терминале — оружие и категории с тремя гнёздами, шкатулка
// камней; предел камней тега; Разлёт, Перекидка (выбор игрока), Переливание — карточками; Мина — закладка
// в точку и срабатывание, когда туда вошли; В долг — без ячейки, ПЗ в начале следующего хода; Раскат —
// половина в начале следующего хода; Плата кровью — кнопка в карточке; камни гаснут, если ступень упала;
// игрок вставляет камень сам.
import { connect, checker, moduleErrors, done, joinAs } from './harness.mjs';
import { install, scene, skills, combat, classKit } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, { hero: { level: 5 }, enemies: [{ name: 'Враг А', x: 6, y: 5 }, { name: 'Враг Б', x: 7, y: 5 }, { name: 'Враг В', x: 6, y: 6 }] });
const [a, b, c] = ids.enemies;
const since = f.log.length;
// По два навыка огня, крови и взрыва — по камню каждого тега
const sk = await skills(page, ids.hero, ['Хлопушка', 'Тлеющий уголь', 'Обратный отсчёт', 'Берсерк', 'Жажда боя']);
const weapons = await ev(async hero => {
    const actor = game.actors.get(hero);
    const mk = name => ({ name, type: 'weapon', system: { type: { value: 'martialM' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } });
    const items = await actor.createEmbeddedDocuments('Item', [mk('Меч'), mk('Топор')]);
    return Object.fromEntries(items.map(i => [i.name, i.id]));
}, ids.hero);
const kit = await classKit(page, ids.hero, { features: ['Second Wind'], spells: ['burning-hands', 'cure-wounds', 'hellish-rebuke'], caster: { name: 'Жрец', identifier: 'cleric' } });

const place = (where, stone) => ev(async ({ hero, where, stone }) => (await gdt.mod('memory/facet/facet.js')).placeStone(game.actors.get(hero), where, stone), { hero: ids.hero, where, stone });
const unplace = (where, stone) => ev(async ({ hero, where, stone }) => (await gdt.mod('memory/facet/facet.js')).removeStone(game.actors.get(hero), where, stone), { hero: ids.hero, where, stone });
const target = (...actorIds) => ev(list => {
    game.user.targets.forEach(t => t.setTarget(false, { releaseOthers: false }));
    list.forEach((id, i) => canvas.tokens.placeables.find(t => t.actor?.id === id)?.setTarget(true, { releaseOthers: i === 0 }));
}, actorIds);
// Бросок урона (или лечения) активности; вернуть тексты новых карточек
const roll = (itemId, pick = null) => ev(async ({ hero, itemId, pick }) => {
    const item = game.actors.get(hero).items.get(itemId);
    const activity = pick ? item.system.activities.find(x => x.type === pick) : item.system.activities.contents[0];
    const n = game.messages.size;
    const rolls = await activity.rollDamage({}, { configure: false }, {});
    await new Promise(r => setTimeout(r, 1500));
    return { total: (rolls ?? []).reduce((s, r) => s + r.total, 0), cards: game.messages.contents.slice(n).map(m => ({ id: m.id, text: m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), flags: m.flags.gachadnd ?? {} })) };
}, { hero: ids.hero, itemId, pick });

// ---------- Камни и вкладка
const grains = await ev(async hero => (await gdt.mod('memory/facet/facet.js')).grainsOf(game.actors.get(hero)), ids.hero);
check('камни: по ступени I огня, крови и взрыва — по одному', grains['огонь'] === 1 && grains['кровь'] === 1 && grains['взрыв'] === 1, JSON.stringify(grains));
const tab = await ev(async ({ hero, sword }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await game.gachadnd.openTerminal(game.actors.get(hero)); await sleep(1200);
    const app = foundry.applications.instances.get('gachadnd-dock'), el = () => app.element;
    el().querySelector('[data-action="page"][data-page="facet"]').click(); await sleep(800);
    const rows = [...el().querySelectorAll('.gd-o-row')].map(r => r.querySelector('b').textContent);
    el().querySelector(`.gd-o-row[data-where="${sword}"]`).click(); await sleep(600);
    el().querySelector('.gd-o-stone[data-stone="spread"]').click(); await sleep(1200);
    const stones = game.actors.get(hero).items.get(sword).getFlag('gachadnd', 'stones') ?? [];
    // Огонь — один камень: второй не встаёт, в шкатулке погашен
    el().querySelector('.gd-o-stone[data-stone="hop"]').click(); await sleep(900);
    return {
        rows, stones: stones.map(s => s.id), gem: !!el().querySelector(`.gd-o-row.sel[data-where="${sword}"] .gd-gem`),
        card: el().querySelector('.gd-o-card')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
        tags: el().querySelectorAll('.gd-o-tag').length, hopLocked: el().querySelector('.gd-o-stone[data-stone="hop"]').classList.contains('locked'),
        after: (game.actors.get(hero).items.get(sword).getFlag('gachadnd', 'stones') ?? []).map(s => s.id)
    };
}, { hero: ids.hero, sword: weapons['Меч'] });
check('вкладка «Огранка»: Меч, Топор и категории строками; Разлёт встал в Меч — камень в гнезде и правило под строкой; шкатулка — три тега',
    tab.rows.includes('Меч') && tab.rows.includes('Топор') && tab.rows.includes('Лечение') && tab.rows.includes('Волна') && tab.stones.includes('spread') && tab.gem && /Разлёт/.test(tab.card) && tab.tags === 3, JSON.stringify(tab));
check('огонь I — один камень огня: Перекидка не встаёт и погашена', tab.hopLocked && tab.after.length === 1, JSON.stringify(tab.after));
await f.shot('facet-1-tab');
await ev(() => foundry.applications.instances.get('gachadnd-dock')?.close({ instant: true }));

// ---------- Разлёт: урон по одной цели — тем же соседям
await target(a);
let r = await roll(weapons['Меч'], 'attack');
const spread = r.cards.find(x => /Разлёт — Меч/.test(x.text));
check('Разлёт: урон Мечом по Врагу А — карточка тем же уроном Врагу Б и Врагу В', spread && /Враг Б/.test(spread.text) && /Враг В/.test(spread.text) && spread.text.includes(String(r.total)), JSON.stringify({ total: r.total, cards: r.cards.map(x => x.text) }));

// ---------- Перекидка: два кандидата — выбирает игрок, половина
await unplace(weapons['Меч'], 'spread');
await place(weapons['Меч'], 'hop');
await target(a);
r = await roll(weapons['Меч'], 'attack');
const hopCard = r.cards.find(x => x.flags.facetHop);
const hop = hopCard ? await ev(async ({ id, uuid }) => {
    const n = game.messages.size;
    (await gdt.mod('core/socket.js')).requestGM('facetHopPick', { messageId: id, uuid });
    await new Promise(r => setTimeout(r, 1500));
    return { used: game.messages.get(id).getFlag('gachadnd', 'facetHop').used, cards: game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) };
}, { id: hopCard.id, uuid: await ev(id => canvas.tokens.placeables.find(t => t.actor?.id === id).document.uuid, c) }) : null;
check('Перекидка: кандидатов двое — кнопки; выбран Враг В — ему половина урона',
    hopCard && hop?.used && hop.cards.some(t => /Перекидка — Меч/.test(t) && /Враг В/.test(t) && t.includes(String(Math.floor(r.total / 2)))), JSON.stringify({ total: r.total, hopCard: hopCard?.text, hop }));
await f.shot('facet-2-hop');

// ---------- Переливание: урон по врагу лечит союзника рядом с целью (герой стоит вплотную)
await place(weapons['Топор'], 'transfuse');
await target(a);
r = await roll(weapons['Топор'], 'attack');
const tr = r.cards.find(x => /Переливание — Топор/.test(x.text));
check('Переливание: урон Топором по Врагу А — лечение герою рядом, на столько же', tr && /Герой/.test(tr.text) && tr.text.includes(String(r.total)), JSON.stringify(r.cards.map(x => x.text)));

// ---------- Мина: Огненные ладони (Волна) закладываются в точку и срабатывают, когда туда вошли
await place('wave', 'mine');
await target(b);
r = await roll(kit['burning-hands']);
const mineMsg = r.cards.find(x => x.flags.facetMine);
const mine = mineMsg ? await ev(async ({ id, scene, enemy }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    (await gdt.mod('core/socket.js')).requestGM('facetMinePlace', { messageId: id, sceneId: scene, x: 1050, y: 850 });
    await sleep(1200);
    const mines = game.scenes.get(scene).getFlag('gachadnd', 'facetMines') ?? [];
    const drawn = !!canvas.interface?.getChildByName?.('gdFacetMines');
    const n = game.messages.size;
    await canvas.tokens.placeables.find(t => t.actor?.id === enemy).document.update({ x: 1000, y: 800 });
    await sleep(2000);
    return { placed: mines.length, drawn, state: game.messages.get(id).getFlag('gachadnd', 'facetMine').state,
        left: (game.scenes.get(scene).getFlag('gachadnd', 'facetMines') ?? []).length,
        cards: game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) };
}, { id: mineMsg.id, scene: ids.scene, enemy: c }) : null;
check('Мина: урон не сразу — кнопки «Заложить» и «Сразу»; заложена в точку, видна на сцене', mineMsg && mine?.placed === 1 && mine.drawn && mine.state === 'placed', JSON.stringify({ mineMsg: mineMsg?.text, mine }));
check('Мина: Враг В вошёл в точку — сработала, карточка урона, мины больше нет', mine?.left === 0 && mine.cards.some(t => /Мина —/.test(t) && /Враг В/.test(t)), JSON.stringify(mine?.cards));
await f.shot('facet-3-mine');
await ev(id => canvas.tokens.placeables.find(t => t.actor?.id === id).document.update({ x: 600, y: 600 }), c);

// ---------- В долг и Раскат: Исцеление ран без ячейки, ПЗ и половина лечения — в начале следующего хода
await unplace(weapons['Топор'], 'transfuse');
await unplace('wave', 'mine');
await place('heal', 'debt');
await place('heal', 'echo');
const combatId = await combat(page, ids.scene, [ids.hero, a, b, c]);
await wait(800);
const debt = await ev(async ({ hero, id }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const actor = game.actors.get(hero);
    await actor.update({ 'system.attributes.hp.value': 30, 'system.spells.spell1.value': 2 });
    const slotsBefore = actor.system.spells.spell1.value;
    canvas.tokens.placeables.find(t => t.actor?.id === hero).setTarget(true, { releaseOthers: true });
    const activity = actor.items.get(id).system.activities.contents[0];
    // Начать с хода врага, чтобы следующий ход героя был «следующим»
    const heroTurn = game.combat.turns.findIndex(t => t.actorId === hero);
    await game.combat.update({ turn: (heroTurn + 1) % game.combat.turns.length });
    await sleep(400);
    await activity.use({ spell: { slot: 'spell1' } }, { configure: false }, {});
    await sleep(1200);
    await activity.rollDamage({}, { configure: false }, {});
    await sleep(1200);
    const mid = { slots: actor.system.spells.spell1.value, debt: actor.getFlag('gachadnd', 'facetDebt'), echo: (actor.getFlag('gachadnd', 'facetEcho') ?? []).length, hp: actor.system.attributes.hp.value };
    const n = game.messages.size;
    for (let i = 0; i < game.combat.turns.length && game.combat.combatant?.actorId !== hero; i++) { await game.combat.nextTurn(); await sleep(600); }
    await sleep(1200);
    const texts = game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
    return { slotsBefore, ...mid, hpAfter: actor.system.attributes.hp.value, debtAfter: actor.getFlag('gachadnd', 'facetDebt') ?? null, echoCard: texts.some(t => /Раскат —/.test(t)), payCard: texts.some(t => /расплата/.test(t)) };
}, { hero: ids.hero, id: kit['cure-wounds'] });
check('В долг: Исцеление ран не потратило ячейку, долг 5 ПЗ ждёт хода', debt.slotsBefore > 0 && debt.slots === debt.slotsBefore && debt.debt === 5 && debt.hp === 30 && debt.echo === 1, JSON.stringify(debt));
check('начало следующего хода героя: долг снят (−5 ПЗ), Раскат — карточка половины лечения', debt.hpAfter === 25 && !debt.debtAfter && debt.echoCard && debt.payCard, JSON.stringify(debt));
await ev(id => game.combats.get(id)?.delete(), combatId);
await wait(800);

// ---------- Плата кровью: кнопка в карточке способности
await unplace('heal', 'debt');
await unplace('heal', 'echo');
await place(weapons['Меч'], 'pay');
const pay = await ev(async ({ hero, sword }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const actor = game.actors.get(hero);
    await actor.update({ 'system.attributes.hp.value': 40 });
    await actor.items.get(sword).system.activities.find(x => x.type === 'attack').use({}, { configure: false }, {});
    await sleep(1500);
    const node = [...document.querySelectorAll('#chat .gd-facet-line')].pop() ?? [...document.querySelectorAll('.gd-facet-line')].pop();
    const line = node?.textContent.replace(/\s+/g, ' ').trim() ?? '';
    node?.querySelector('.gd-stone-pay')?.click();
    await sleep(1500);
    return { line, hp: actor.system.attributes.hp.value, level: actor.system.details.level };
}, { hero: ids.hero, sword: weapons['Меч'] });
check('Плата кровью: в карточке Меча строка «Огранка: Перекидка, Плата кровью» и кнопка — нажали, ушли ПЗ по уровню', /Перекидка/.test(pay.line) && /Плата кровью/.test(pay.line) && pay.hp === 40 - pay.level, JSON.stringify(pay));

// ---------- Ступень упала — камень гаснет, но остаётся
const fade = await ev(async ({ hero, skill, sword }) => {
    const actor = game.actors.get(hero);
    const syn = await gdt.mod('memory/synergy/synergy.js');
    const { facetState } = await gdt.mod('memory/facet/facet.js');
    const hop = () => facetState(actor).placements.find(p => p.where === sword && p.id === 'hop');
    await syn.setSkillEquipped(actor.items.get(skill), false); await gdt.settle();
    const dark = { kept: !!hop(), active: !!hop()?.active };
    await syn.setSkillEquipped(actor.items.get(skill), true); await gdt.settle();
    return { ...dark, back: !!hop()?.active };
}, { hero: ids.hero, skill: sk['Тлеющий уголь'], sword: weapons['Меч'] });
check('сняли навык огня — Перекидка в Мече погасла, но осталась в гнезде; надели — загорелась', fade.kept && !fade.active && fade.back, JSON.stringify(fade));

// ---------- Со стороны игрока: Claude_player вставляет камень сам
await ev(async hero => {
    const player = game.users.getName('Claude_player');
    await game.actors.get(hero).update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
}, ids.hero);
const pl = await joinAs(f, 'Claude_player');
const side = await pl.page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await game.gachadnd.openTerminal(); await sleep(1500);
    const app = foundry.applications.instances.get('gachadnd-dock');
    app.element.querySelector('[data-action="page"][data-page="facet"]').click(); await sleep(900);
    app.element.querySelector('.gd-o-row[data-where="react"]').click(); await sleep(700);
    app.element.querySelector('.gd-o-stone[data-stone="cast"]').click(); await sleep(1500);
    return { actor: app.actor.name, react: (app.actor.getFlag('gachadnd', 'facetSlots')?.react ?? []).map(s => s.id) };
});
check('игрок: Терминал без выбранного токена — свой герой; Выброс вставил в Реакцию сам', /Герой/.test(side.actor) && side.react.includes('cast'), JSON.stringify(side));
await pl.shot('facet-4-player');
await pl.close();
// Владение — обратно: с игроком герой — «отряд», и бой на узле Босса последнего этажа ставит правило Босса
await ev(async hero => {
    const player = game.users.getName('Claude_player');
    const actor = game.actors.get(hero);
    await actor.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, 'flags.gachadnd.-=facetSlots': null });
    for (const i of actor.items.filter(i => i.getFlag('gachadnd', 'stones'))) await i.unsetFlag('gachadnd', 'stones');
}, ids.hero);
await wait(600);

const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
