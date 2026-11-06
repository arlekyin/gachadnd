// Обеты на Элите в настоящей Foundry: node tools/foundry/vows.mjs [--headed]
// Вход на Элиту — окно у Мастера и игрока (Claude_player), встреча ждёт; галочки общие, «Готовы» снимается правкой,
// Подмога и Густая стая на выбор; замена у Мастера. Принятые обеты: состав и арена в карточке встречи; напоминание, что
// Мастер учитывает сам. В бою: сон навыка, Потухшие грани, Разорванные нити, Закалка, Месть стаи, Не упокоен, Засада,
// Вторая волна, Смыкание, Голодный Туман; Пульс молчит. Победа — прибавка в добыче один раз, золото и редкий кристалл.
// Снимки vows-*.png.
import { connect, joinAs, joinSpectator, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, combat as startFight } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
const ids = await scene(page, {
    hero: { level: 5 },
    enemies: [{ name: 'Вожак', x: 15, y: 5 }, { name: 'Рядовой 1', x: 14, y: 6 }, { name: 'Рядовой 2', x: 14, y: 4 }]
});
const since = f.log.length;
const saved = await ev(() => Object.fromEntries(['runFloor', 'mapMode', 'floorSceneId', 'effects', 'lootPity'].map(k => [k, game.settings.get('gachadnd', k)])));

// Отряд: герой у игрока, навыки с зарядами и синергией «свет»; вожак сильнее рядовых
const skillIds = await skills(page, ids.hero, ['Ультрафиолет', 'Призма', 'Маяк', 'Вспышка камеры']);
await ev(async ({ hero, enemies }) => {
    await game.settings.set('gachadnd', 'effects', 'off');
    await game.settings.set('gachadnd', 'runFloor', 1);
    await game.settings.set('gachadnd', 'floorSceneId', '');
    await game.settings.set('gachadnd', 'vowsState', {});
    const player = game.users.getName('Claude_player');
    await game.actors.get(hero).update({ [`ownership.${player.id}`]: 3 });
    await player.update({ character: hero });
    await game.actors.get(enemies[0]).update({ 'system.details.cr': 5, 'system.attributes.hp.max': 40, 'system.attributes.hp.value': 40 });
}, ids);

// Карта: следующий узел отряда — Элита
const elite = await ev(async () => {
    const map = await gdt.mod('labyrinth/map.js');
    await map.drawFloor({ mode: 'rows', length: 7, floor: 1 });
    await gdt.settle();
    const scene = (await gdt.mod('labyrinth/scene-travel.js')).mapScene();
    const data = foundry.utils.deepClone(scene.getFlag('gachadnd', 'floorMap'));
    const start = data.nodes.find(n => n.type === 'start');
    data.currentNodeId = start.id;
    const target = data.nodes.find(n => n.id === start.next[0]);
    target.type = 'elite';
    await scene.setFlag('gachadnd', 'floorMap', data);
    for (const w of [...foundry.applications.instances.values()]) if (/gachadnd-(map-terminal|web-overlay)/.test(w.id)) await w.close({ instant: true });
    return target.id;
});

const player = await joinAs(f, 'Claude_player');
const spectator = await joinSpectator(f);
const vowWindow = pg => pg.evaluate(() => {
    const el = document.querySelector('#gachadnd-vows');
    return el ? { vows: [...el.querySelectorAll('.gd-vow-main')].map(b => ({ id: b.dataset.id, on: b.getAttribute('aria-pressed') === 'true' })), swap: el.querySelectorAll('.gd-vow-swap').length, seal: !!el.querySelector('[data-action=seal]'), ready: !!el.querySelector('[data-action=ready]') } : null;
});
const state = () => ev(() => game.settings.get('gachadnd', 'vowsState'));
const encCards = () => ev(() => game.messages.filter(m => m.getFlag('gachadnd', 'encounter')).map(m => m.getFlag('gachadnd', 'encounter')));

// ---------- Вход на Элиту
await ev(async id => { await (await gdt.mod('labyrinth/map.js')).stepTo(id); await gdt.settle(); }, elite);
await page.waitForSelector('#gachadnd-vows .gd-vow-main', { timeout: 10000 });
await player.page.waitForSelector('#gachadnd-vows .gd-vow-main', { timeout: 10000 });
const gmSees = await vowWindow(page), playerSees = await vowWindow(player.page);
check('вход на Элиту — окно у Мастера и у игрока, предложено до 8 обетов', gmSees?.vows.length >= 4 && gmSees.vows.length <= 8 && playerSees?.vows.length === gmSees.vows.length, JSON.stringify(gmSees));
check('«В бой» и замена — у Мастера, «Готовы» — у игрока', gmSees.seal && gmSees.swap === gmSees.vows.length && playerSees.ready && !playerSees.seal && playerSees.swap === 0);
check('встреча ждёт конца выбора', (await encCards()).length === 0);

// Каждое правило проверяем на нужном наборе: выбор задаём напрямую, щелчками — общая часть
const setOffered = (offered, chosen = []) => ev(async ({ offered, chosen, node }) => { await game.settings.set('gachadnd', 'vowsState', { phase: 'choose', node, offered, chosen, ready: [] }); await gdt.settle(); }, { offered, chosen, node: elite });
const clickVow = async (pg, id) => { await pg.click(`#gachadnd-vows .gd-vow-main[data-id="${id}"]`); await pg.waitForTimeout(400); };

await setOffered(['hunger', 'lapse', 'reinforce', 'horde', 'storm', 'closing']);
await clickVow(player.page, 'horde');
check('игрок отмечает обет — видно у Мастера', (await state()).chosen.includes('horde'));
await clickVow(page, 'reinforce');
let s = await state();
check('Подмога снимает Густую стаю', s.chosen.includes('reinforce') && !s.chosen.includes('horde'), JSON.stringify(s.chosen));
await player.page.click('#gachadnd-vows [data-action=ready]');
await page.waitForTimeout(400);
check('«Готовы» записан', (await state()).ready.length === 1);
await clickVow(page, 'lapse');
check('правка снимает «Готовы»', (await state()).ready.length === 0);
await clickVow(page, 'closing');
await f.shot('vows-window-gm');
await player.shot('vows-window-player');
await ev(async () => { await game.settings.set('gachadnd', 'vowsState', { ...game.settings.get('gachadnd', 'vowsState'), chosen: [] }); await gdt.settle(); });

// Замена: другой обет той же группы
const swapped = await ev(async () => {
    const vows = game.gachadnd.vows;
    const before = vows.state().offered;
    document.querySelector('#gachadnd-vows .gd-vow-swap[data-id="storm"]').click();
    await gdt.settle();
    return { before, after: vows.state().offered };
});
check('замена: обет заменён другим из той же группы', !swapped.after.includes('storm') && swapped.after.length === swapped.before.length, JSON.stringify(swapped.after));

// Что предлагается: у отряда без камней — без Потухших граней; никогда обе разом
const offers = await ev(() => { const out = []; for (let i = 0; i < 40; i++) out.push(game.gachadnd.vows.offer()); return out; });
check('отряду без камней Потухшие грани не выпадают', offers.every(o => !o.includes('facets')));
const groups = await ev(() => Object.fromEntries(Object.entries(game.gachadnd.vows.list).map(([id, v]) => [id, v.group])));
check('не больше двух обетов на группу', offers.every(o => Object.values(Object.groupBy(o, id => groups[id])).every(list => list.length <= 2)));

// ---------- Состав и арена по обетам
const crew = await ev(async () => {
    const enc = game.gachadnd.encounters;
    const hero = game.actors.filter(a => a.name === 'GD-тест: Герой');
    const count = e => e.creatures.reduce((sum, m) => sum + m.count, 0);
    const base = [], horde = [], second = [];
    // Одно зерно на три сборки: база одна и та же, разница — только от обетов
    const seeded = s => () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 6; i++) {
        const party = [hero[0], hero[0], hero[0], hero[0]];
        const a = await enc.build('elite', { party, biome: 'swamp', rnd: seeded(1000 + i) });
        const b = await enc.build('elite', { party, biome: 'swamp', rnd: seeded(1000 + i), vows: ['horde'] });
        const c = await enc.build('elite', { party, biome: 'swamp', rnd: seeded(1000 + i), vows: ['reinforce', 'second'] });
        base.push(count(a)); horde.push(count(b)); second.push(count(c));
    }
    const arena = enc.arena({ type: 'elite', biome: 'swamp', vows: ['storm', 'narrow', 'pincers'] }, []);
    const plain = enc.arena({ type: 'elite', biome: 'swamp', vows: [] }, [], { rnd: () => 0.99 });
    return { base, horde, second, arena: { cols: arena.cols, rows: arena.rows, weather: arena.weather, pincers: arena.encounter.pincers }, plain: { cols: plain.cols, weather: plain.weather } };
});
check('Густая стая: +4 рядовых на 4 героев', crew.horde.every((v, i) => v === crew.base[i] + 4), JSON.stringify(crew));
check('Подмога + Второй вожак: +2 и ещё вожак', crew.second.every((v, i) => v === crew.base[i] + 3), JSON.stringify(crew.second));
check('Теснина 20×14, Непогода всегда, Клещи в строю', crew.arena.cols === 20 && crew.arena.rows === 14 && !!crew.arena.weather && crew.arena.pincers === true, JSON.stringify(crew.arena));
check('без обетов — как раньше', crew.plain.cols === 28 && !crew.plain.weather);

// ---------- Принять: карточка всем, встреча с обетами, напоминание
await setOffered(['reinforce', 'storm', 'lapse'], ['reinforce', 'storm', 'lapse']);
await page.click('#gachadnd-vows [data-action=seal]');
await page.waitForTimeout(1500);
s = await state();
check('«В бой» — обеты приняты, окно закрыто у всех', s.phase === 'sealed' && !(await vowWindow(page)) && !(await vowWindow(player.page)), JSON.stringify(s));
const cards = await encCards();
check('встреча пришла с обетами', cards.length === 1 && cards[0].vows.includes('reinforce'), JSON.stringify(cards[0]?.vows));
const playerChat = await player.page.evaluate(() => [...document.querySelectorAll('.gd-vow-card')].map(c => ({ text: c.textContent, button: !!c.querySelector('[data-gd-vow]') })));
check('карточка обетов у игрока — без кнопки Мастера', playerChat.some(c => /Обеты приняты/.test(c.text) && !c.button), JSON.stringify(playerChat));
const skipped = await ev(async () => {
    const message = game.messages.find(m => m.getFlag('gachadnd', 'encounter'));
    await game.gachadnd.encounters.resolve(message, 'skip');
    await gdt.settle();
    return message.content;
});
check('«Сам» — напоминание, что учитывает Мастер', /Учитывает Мастер: Непогода|Учитывает Мастер:.*Подмога/.test(skipped), skipped.slice(0, 300));

// ---------- Бой: сон и Потухшие грани, нити, закалка, месть, не упокоен, засада, волна, смыкание, голод
const reset = chosen => ev(async ({ chosen, node }) => {
    for (const c of game.combats.contents) await c.delete();
    await gdt.settle();
    await game.settings.set('gachadnd', 'vowsState', { phase: 'sealed', node, offered: chosen, chosen, ready: [] });
}, { chosen, node: elite });
const fight = () => startFight(page, ids.scene, [ids.hero, ...ids.enemies]);
const hpOf = id => ev(id => { const h = game.actors.get(id).system.attributes.hp; return { value: h.value, max: h.max, temp: h.temp }; }, id);
const heal = () => ev(async ({ hero, enemies }) => {
    for (const id of enemies) await game.actors.get(id).update({ 'system.attributes.hp.value': game.actors.get(id).system.attributes.hp.max, 'system.attributes.hp.temp': 0 });
    await game.actors.get(hero).update({ 'system.attributes.hp.value': 60 });
}, ids);

// Сон
await reset(['lapse']);
await fight();
await ev(() => gdt.settle(400));
const sleeping = await ev(hero => game.actors.get(hero).items.filter(i => i.flags?.gachadnd?.asleep).map(i => i.name), ids.hero);
check('Провал в Памяти: один навык спит', sleeping.length === 1, JSON.stringify(sleeping));
await ev(async () => { for (const c of game.combats.contents) await c.delete(); await gdt.settle(600); });
check('конец боя — проснулся', (await ev(hero => game.actors.get(hero).items.filter(i => i.flags?.gachadnd?.asleep).length, ids.hero)) === 0);

// Нити: 4 тега «свет» — ступень II, под обетом — ступень I
const lightCount = () => ev(hero => game.actors.get(hero).effects.filter(e => e.flags?.gachadnd?.is_synergy).map(e => e.name), ids.hero);
const before = await lightCount();
await reset(['threads']);
await fight();
await ev(() => gdt.settle(600));
const during = await ev(async hero => {
    const { TAG_COUNT_MODIFIERS } = await gdt.mod('memory/synergy/synergy.js');
    const counts = { 'свет': 4, 'огонь': 2, 'сталь': 1 };
    for (const m of TAG_COUNT_MODIFIERS) m(game.actors.get(hero), counts);
    return counts;
}, ids.hero);
check('Разорванные нити: 4 → порог 2, 2 → ниже порога, 1 не трогает', during['свет'] === 2 && during['огонь'] === 1 && during['сталь'] === 1, JSON.stringify(during));
await ev(async () => { for (const c of game.combats.contents) await c.delete(); await gdt.settle(800); });
check('конец боя — синергии как были', JSON.stringify(await lightCount()) === JSON.stringify(before), JSON.stringify({ before, after: await lightCount() }));

// Грани
await reset(['facets']);
await fight();
await ev(() => gdt.settle(300));
const stones = await ev(async hero => {
    const { FACET_BLOCKS } = await gdt.mod('memory/facet/facet.js');
    return FACET_BLOCKS.some(b => b(game.actors.get(hero)));
}, ids.hero);
check('Потухшие грани: камни героя в бою заблокированы', stones === true);
await ev(async () => { for (const c of game.combats.contents) await c.delete(); await gdt.settle(300); });
const stonesAfter = await ev(async hero => (await gdt.mod('memory/facet/facet.js')).FACET_BLOCKS.some(b => b(game.actors.get(hero))), ids.hero);
check('после боя камни снова горят', stonesAfter === false);

// Закалка, Месть, Не упокоен
await heal();
await reset(['tempered', 'vengeance', 'undying']);
await fight();
await ev(() => gdt.settle(500));
const [leader, rank1, rank2] = ids.enemies;
const leaderHp = await hpOf(leader);
check('Закалка: вожак 40 → 60 ПЗ', leaderHp.max === 60 && leaderHp.value === 60, JSON.stringify(leaderHp));
await ev(async id => { await game.actors.get(id).update({ 'system.attributes.hp.value': 0 }); await gdt.settle(500); }, rank1);
// Павший на (14, 6): вожак на (15, 5) ближе рядового на (14, 4)
const near = await hpOf(leader), far = await hpOf(rank2);
check('Месть стаи: ближайший к павшему враг получил временные ПЗ, четверть максимума павшего; дальний — нет', near.temp === 8 && far.temp === 0, JSON.stringify({ near, far }));
const heroTemp = await hpOf(ids.hero);
check('герой временных ПЗ не получил', !heroTemp.temp);
await ev(async () => { await game.combat.nextRound(); await gdt.settle(600); });
const risen = await hpOf(rank1);
check('Не упокоен: первый убитый встал с половиной ПЗ', risen.value === 15, JSON.stringify(risen));
await ev(async id => { await game.actors.get(id).update({ 'system.attributes.hp.value': 0 }); await gdt.settle(400); await game.combat.nextRound(); await gdt.settle(400); }, rank1);
check('встаёт только один раз', (await hpOf(rank1)).value === 0);
await ev(async () => { for (const c of game.combats.contents) await c.delete(); await gdt.settle(500); });
check('конец боя — надбавка вожака снята', (await hpOf(leader)).max === 40);

// Засада: герой пропускает первый раунд, навык не применяется
await heal();
await reset(['ambush']);
await fight();
await ev(() => gdt.settle(600));
const ambush = await ev(async ({ hero }) => {
    const c = game.combat;
    const first = { round: c.round, who: c.combatant?.actor?.name };
    const item = game.actors.get(hero).items.find(i => i.system.activities?.size);
    const used = await item?.system.activities.contents[0].use({}, { configure: false }, { create: false }).catch(() => 'ошибка');
    const seen = [];
    for (let i = 0; i < 8 && c.round === 1; i++) { seen.push(c.combatant?.actor?.name); await c.nextTurn(); await gdt.settle(300); }
    return { first, used: used ?? null, seen, round: c.round, now: c.combatant?.actor?.name };
}, ids);
check('Засада: первый ход не у героя, хотя его инициатива выше', !/Герой/.test(ambush.first.who), JSON.stringify(ambush));
check('Засада: герой в первом раунде не ходит', ambush.seen.every(n => !/Герой/.test(n ?? '')), JSON.stringify(ambush.seen));
check('Засада: навык в первом раунде не применяется', !ambush.used, String(ambush.used));
check('во втором раунде герой ходит', ambush.round === 2 && /Герой/.test(ambush.now ?? ''), JSON.stringify(ambush));

// Вторая волна
await reset(['wave']);
await heal();
await fight();
await ev(() => gdt.settle(400));
const wave = await ev(async () => {
    const c = game.combat, sc = c.scene;
    const tokens0 = sc.tokens.size;
    await c.nextRound(); await gdt.settle(300);
    const round2 = sc.tokens.size;
    await c.nextRound(); await gdt.settle(800);
    const fresh = sc.tokens.contents.slice(tokens0);
    await c.nextRound(); await gdt.settle(400);
    return { tokens0, round2, round3: tokens0 + fresh.length, later: sc.tokens.size, fresh: fresh.map(t => ({ name: t.name, x: t.x, y: t.y })), init: c.combatants.filter(cb => fresh.some(t => t.id === cb.tokenId)).map(cb => cb.initiative) };
});
check('Вторая волна: на 3-м раунде столько рядовых, сколько героев; один раз', wave.round2 === wave.tokens0 && wave.round3 === wave.tokens0 + 1 && wave.later === wave.round3, JSON.stringify(wave));
check('волна — рядовые, с инициативой, дальше от врагов, чем отряд', wave.fresh.every(t => /Рядовой/.test(t.name) && t.x < 500) && wave.init.every(i => i !== null), JSON.stringify(wave));
await ev(async () => { const sc = game.combat.scene; const extra = sc.tokens.contents.slice(4).map(t => t.id); for (const c of game.combats.contents) await c.delete(); await sc.deleteEmbeddedDocuments('Token', extra); await gdt.settle(300); });

// Смыкание: герой у кромки получает урон, регион виден
await heal();
await ev(async ({ hero, scene }) => { const t = game.scenes.get(scene).tokens.find(t => t.actorId === hero); await t.update({ x: 0, y: 500 }, { animate: false }); }, ids);
await reset(['closing']);
await fight();
await ev(() => gdt.settle(300));
const closing = await ev(async ({ hero }) => {
    const c = game.combat, sc = c.scene;
    await c.nextRound(); await gdt.settle(800);
    const region = sc.regions.find(r => r.getFlag('gachadnd', 'vowClosing') === c.id);
    return { hp: game.actors.get(hero).system.attributes.hp.value, shapes: region?.shapes.length, turn: c.combatant?.actor?.name, visible: region?.visibility };
}, ids);
check('Смыкание: со 2-го раунда есть регион тумана на всех четырёх сторонах', closing.shapes === 4, JSON.stringify(closing));
check('герой за границей в начале хода теряет ПЗ', closing.hp < 60, JSON.stringify(closing));
await f.shot('vows-closing');
await player.page.waitForTimeout(800);
await player.shot('vows-closing-player');
await ev(async () => { for (const c of game.combats.contents) await c.delete(); await gdt.settle(500); });
check('конец боя — туман убран', (await ev(sc => game.scenes.get(sc).regions.filter(r => r.getFlag('gachadnd', 'vowClosing')).length, ids.scene)) === 0);

// Голодный Туман: тронутый навык не теряет, нетронутый — минус заряд; перегрев не считается
await heal();
await reset(['hunger']);
await fight();
await ev(() => gdt.settle(300));
const hunger = await ev(async ({ hero }) => {
    const actor = game.actors.get(hero);
    const usable = actor.items.filter(i => i.flags?.gachadnd?.is_active && Number(i.system?.uses?.max) > 0);
    const [touched, idle] = usable;
    const start = Object.fromEntries(usable.map(i => [i.id, Number(i.system.uses.spent) || 0]));
    if (touched) await touched.update({ 'system.uses.spent': start[touched.id] + 1 });
    for (const c of game.combats.contents) await c.delete();
    await gdt.settle(600);
    const out = { touched: touched && { before: start[touched.id], after: actor.items.get(touched.id).system.uses.spent }, idle: idle && { before: start[idle.id], after: actor.items.get(idle.id).system.uses.spent, heat: actor.items.get(idle.id).flags.gachadnd.heat ?? null }, count: usable.length };
    return out;
}, ids);
check('Голодный Туман: у нетронутого навыка −1 заряд', hunger.idle && hunger.idle.after === hunger.idle.before + 1, JSON.stringify(hunger));
check('применённый навык заряд не теряет', hunger.touched && hunger.touched.after === hunger.touched.before + 1, JSON.stringify(hunger.touched));

// Пульс: бой под обетами не считается
await heal();
await reset(['tempered']);
await fight();
await ev(() => gdt.settle(300));
const pulseAfter = await ev(async () => {
    await game.settings.set('gachadnd', 'pulse', { offset: 0, easyStreak: 0, last: null });
    for (const c of game.combats.contents) await c.delete();
    await gdt.settle(500);
    return game.settings.get('gachadnd', 'pulse');
});
check('Пульс не записал бой под обетами', pulseAfter.last === null && pulseAfter.offset === 0, JSON.stringify(pulseAfter));

// ---------- Награда: враги живы — решает Мастер; победа — прибавка один раз
const askWin = await ev(() => game.messages.filter(m => m.getFlag('gachadnd', 'vowCard') && m.whisper.length).length);
check('враги живы — шёпот Мастеру «Это победа?»', askWin >= 1 && (await state()).phase === 'sealed');
const loot = async () => ev(async () => {
    const { GachaLootTerminal } = await gdt.mod('memory/loot.js');
    const app = new GachaLootTerminal();
    const before = game.messages.size;
    await app.generateLoot('elite', 4, 'any');
    await gdt.settle(600);
    const card = game.messages.contents.slice(before).map(m => m.content).find(c => /ДОБЫЧА/.test(c)) ?? '';
    for (const w of [...foundry.applications.instances.values()]) if (/gachadnd-draft/.test(w.id)) await w.close({ instant: true });
    await game.settings.set('gachadnd', 'draftState', {});
    return { lines: /Обеты выполнены/.test(card), card: card.replace(/\s+/g, ' ').slice(-400) };
});
await reset(['ambush', 'closing', 'second']);
const unpaid = await loot();
check('не отмечено победой — прибавки нет', !unpaid.lines, unpaid.card);
await ev(async () => { await game.gachadnd.vows.win(); await gdt.settle(500); });
await f.shot('vows-loot-window');
const looted = await ev(() => ({ selected: document.querySelector('#gachadnd-loot-terminal select[name=room]')?.value, phase: game.settings.get('gachadnd', 'vowsState').phase }));
check('победа открывает генератор на Элите', looted.selected === 'elite' && looted.phase === 'won', JSON.stringify(looted));
await ev(() => foundry.applications.instances.get('gachadnd-loot-terminal')?.close());
const paid = await loot();
const rungs = await ev(() => { const v = game.gachadnd.vows; return v.ladder.map(r => r.min); });
check('вес 9 — прибавка, золото и редкий кристалл в карточке', paid.lines && /фиолетового/.test(paid.card) && /золото ×2/.test(paid.card), paid.card);
check('прибавка один раз', !(await loot()).lines);
check('лестница 0 · 1 · 3 · 5 · 7', rungs.join() === '0,1,3,5,7');

// Новый узел снимает обеты; выключенная настройка — без окна
const offState = await ev(async () => {
    Hooks.callAll('gachadnd.nodeEntered', 'mob');
    await gdt.settle(300);
    const cleared = game.settings.get('gachadnd', 'vowsState');
    await game.settings.set('gachadnd', 'hintVows', false);
    Hooks.callAll('gachadnd.nodeEntered', 'elite');
    await gdt.settle(500);
    const off = game.settings.get('gachadnd', 'vowsState');
    const encounter = game.messages.contents.filter(m => m.getFlag('gachadnd', 'encounter')).at(-1)?.getFlag('gachadnd', 'encounter');
    await game.settings.set('gachadnd', 'hintVows', true);
    return { cleared, off, encounter: encounter?.type };
});
check('новый узел снимает обеты', !offState.cleared.phase, JSON.stringify(offState.cleared));
check('настройка выключена — окна нет, встреча сразу', !offState.off.phase && offState.encounter === 'elite', JSON.stringify(offState));

// ---------- Настоящая арена под Тесниной: лес с Клещами и Непогодой, подземелье — враги внутри поля и без наложений
await ev(async () => { for (const c of game.combats.contents) await c.delete(); await gdt.settle(300); });
for (const biome of ['swamp', 'crypt']) {
    const arena = await ev(async ({ biome, enemies, hero }) => {
        const { encounters, arena } = game.gachadnd;
        const crew = [enemies[0], ...enemies.slice(1), enemies[1], enemies[2], enemies[1], enemies[2]];
        const options = encounters.arena({ type: 'elite', biome, vows: ['narrow', 'pincers', 'storm'] }, crew);
        const { why, ...rest } = options;
        const { scene, plan } = await arena.generate({ ...rest, party: [hero], enemies: crew });
        const g = scene.grid.size;
        const boxes = scene.tokens.map(t => ({ x: t.x, y: t.y, w: (t.width || 1) * g, h: (t.height || 1) * g }));
        let overlaps = 0;
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
        }
        const outside = boxes.filter(b => b.x < 0 || b.y < 0 || b.x + b.w > scene.width || b.y + b.h > scene.height).length;
        return { cols: scene.width / g, rows: scene.height / g, tokens: boxes.length, want: crew.length + 1, overlaps, outside, flank: plan.formation?.flank, roles: plan.formation?.roles, weather: !!scene.getFlag('gachadnd', 'arenaWeather'), scheme: plan.scheme };
    }, { biome, enemies: ids.enemies, hero: ids.hero });
    const under = biome === 'crypt';
    check(`Теснина: ${biome} 20×14, все на поле и без наложений`, arena.cols === 20 && arena.rows === 14 && arena.tokens === arena.want && !arena.overlaps && !arena.outside, JSON.stringify(arena));
    if (!under) check('Клещи и Непогода на лесной арене', arena.flank === true && arena.roles.some(r => /flank/.test(r)) && arena.weather, JSON.stringify(arena));
    await f.shot(`vows-arena-${biome}`);
}

// ---------- Уборка
await player.close();
await spectator.close();
await ev(async saved => {
    for (const c of game.combats.contents) await c.delete();
    for (const [k, v] of Object.entries(saved)) await game.settings.set('gachadnd', k, v);
    await game.settings.set('gachadnd', 'vowsState', {});
    await game.users.getName('Claude_player').update({ character: null });
    await game.settings.set('gachadnd', 'pulse', { offset: 0, easyStreak: 0, last: null });
}, saved);

const errors = moduleErrors(f.log.slice(since));
check('нет ошибок модуля', !errors.length, errors.join('\n').slice(0, 800));
const failed = summary();
await f.close();
done(failed);
