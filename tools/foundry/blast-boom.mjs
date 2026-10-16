// Взрывные навыки в настоящей Foundry: node tools/foundry/blast-boom.mjs [--headed] [--slow[=мс]]
// Горячая картошка (прилипла, таймер шёпотом, передача кнопкой, запреты, взрыв с осколками);
// Ссссс… (взрыв в конце следующего хода, холостой — заряд вернулся); Красная бочка (две клетки
// мышью, урон — взрыв, цепная реакция); Взрыв трупа (четверть ПЗ, труп исчезает, цепочка кнопкой);
// Утечка газа (клетка мышью, отравление, рост облака, поджог уроном огнём); Ох, да! (прицел мышью,
// пролом стены, перенос, спасбросок Силы и ничком).
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
const hp = id => ev(id => game.actors.get(id).system.attributes.hp.value, id);
const setHp = (id, v) => ev(({ id, v }) => game.actors.get(id).update({ 'system.attributes.hp.value': v }), { id, v });
const turn = () => ev(() => `${game.combat.round}:${game.combat.combatant?.name?.replace('GD-тест: ', '')}`);
const next = async () => { await ev(() => game.combat.nextTurn()); await settle(); return turn(); };
const until = async who => { do { await next(); } while (!(await turn()).endsWith(who)); };
const place = (id, x, y) => ev(async ({ id, x, y }) => { const { placeToken } = await gdt.mod('memory/skills/pick.js'); await placeToken(game.actors.get(id).getActiveTokens()[0].document, x * 100, y * 100); }, { id, x, y });
const target = (...actors) => ev(actors => canvas.tokens.setTargets(actors.map(a => game.actors.get(a).getActiveTokens()[0].id)), actors);
const spent = (actor, id) => ev(({ actor, id }) => game.actors.get(actor).items.get(id).system.uses.spent, { actor, id });
const effects = id => ev(id => game.actors.get(id).effects.map(e => e.name), id);
const useNow = (actor, item) => ev(async ({ actor, item }) => { gdt.warnings.length = 0; return game.actors.get(actor).items.get(item).system.activities.contents[0].use({}, { configure: false }); }, { actor, item });
const toScreen = p => ev(p => { const c = canvas.clientCoordinatesFromCanvas(p); return { x: c.x, y: c.y }; }, p);
const clickAt = async (x, y) => {
    const s = await toScreen({ x, y });
    await page.mouse.move(s.x - 20, s.y - 20); await page.mouse.move(s.x, s.y, { steps: 5 }); await wait(250);
    await page.mouse.down(); await page.mouse.up();
};
const clickCell = (x, y) => clickAt(x * 100 + 50, y * 100 + 50);
/** use() с выбором на карте: клики по точкам, затем окно dnd5e */
const useWith = async (actor, item, clicks) => {
    await ev(({ actor, item }) => { gdt.p = game.actors.get(actor).items.get(item).system.activities.contents[0].use(); }, { actor, item });
    await wait(900);
    for (const [x, y] of clicks) { await clickAt(x, y); await wait(500); }
    for (let i = 0; i < 30; i++) {
        const w = (await ev(() => gdt.windows())).find(w => w.cls === 'ActivityUsageDialog');
        if (w) { await page.click(`#${w.id} button[data-action="use"]`); break; }
        await wait(150);
    }
    await wait(1800);
};
const chatButton = async (flag, sel) => {
    await ev(async () => { await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary'); });
    await wait(400);
    const id = await ev(flag => game.messages.contents.findLast(m => m.flags?.gachadnd?.[flag])?.id, flag);
    await page.click(`#chat [data-message-id="${id}"] ${sel}`);
    await wait(1500);
};

await install(page);
const ids = await scene(page, {
    hero: { x: 5, y: 5, level: 5 },
    enemies: [{ name: 'Один', x: 6, y: 5 }, { name: 'Два', x: 8, y: 5 }, { name: 'Три', x: 14, y: 11 }],
    walls: [{ c: [10, 2, 10, 9] }]
});
const { hero } = ids;
const [E1, E2, E3] = ids.enemies;
const S = await skills(page, hero, ['Горячая картошка', 'Ссссс…', 'Красная бочка', 'Взрыв трупа', 'Утечка газа', 'Ох, да!']);
await combat(page, ids.scene, [hero, E1, E2, E3]);
await wait(600);
await ev(() => gdt.closeForeign());
// Ошибки Foundry при пересоздании сцены фикстурой — не наши: считаем с этого места
const since = f.log.length;

// ================= Горячая картошка =================
await target(E2);
await useNow(hero, S['Горячая картошка']);
check('картошка: цель не вплотную — отказ', await ev(() => gdt.warnings.some(w => /вплотную/.test(w))) && (await spent(hero, S['Горячая картошка'])) === 0);
await target(E1);
await ev(() => gdt.mark());
await useNow(hero, S['Горячая картошка']);
await wait(1500);
const bombs = () => ev(() => game.combat.getFlag('gachadnd', 'potatoes') ?? []);
let b = await bombs();
check('картошка: бомба на «Один», таймер 2–5', b.length === 1 && b[0].timer >= 2 && b[0].timer <= 5 && (await effects(E1)).includes('Горячая картошка'), JSON.stringify(b));
check('картошка: таймер — шёпотом владельцу', await ev(() => game.messages.contents.slice(gdt._mark).some(m => m.whisper?.length && /Таймер бомбы/.test(m.content))));
// Передача: «Два» не вплотную — нельзя; вплотную — можно
await next(); // ход «Один»
await target(E2);
await ev(() => { gdt.warnings.length = 0; });
await chatButton('potato', '[data-potato-pass]');
check('картошка: «Два» не вплотную — передать нельзя', (await bombs())[0].holder === (await ev(E1 => game.actors.get(E1).getActiveTokens()[0].id, E1)));
await place(E2, 7, 5);
await chatButton('potato', '[data-potato-pass]');
b = await bombs();
check('картошка: передана «Два» кнопкой на карточке', b[0].holder === (await ev(E2 => game.actors.get(E2).getActiveTokens()[0].id, E2)) && (await effects(E2)).includes('Горячая картошка') && !(await effects(E1)).includes('Горячая картошка'), JSON.stringify(b));
await target(E1);
await chatButton('potato', '[data-potato-pass]');
check('картошка: вернуть тому, кто дал в этом раунде, — нельзя', (await bombs())[0].holder === (await ev(E2 => game.actors.get(E2).getActiveTokens()[0].id, E2)));
// Таймер 1 — взрыв в начале раунда у «Два», осколки — «Один»
await ev(() => game.combat.setFlag('gachadnd', 'potatoes', game.combat.getFlag('gachadnd', 'potatoes').map(b => ({ ...b, timer: 1 }))));
const h1 = await hp(E1), h2 = await hp(E2);
await ev(() => gdt.mark());
await until('Три');
await ev(() => gdt.dice(6, 5, 5, 5));
await next(); // раунд 2
await ev(() => gdt.until(() => gdt.chats().some(c => /взрывается у/.test(c)), 5000));
check('картошка: взрыв у носителя — 3d6 = 15, осколки «Один» — 7', h2 - (await hp(E2)) === 15 && h1 - (await hp(E1)) === 7 && !(await bombs()).length, `Два ${h2}→${await hp(E2)}, Один ${h1}→${await hp(E1)}`);
await setHp(E1, 30); await setHp(E2, 30);

// ================= Ссссс… =================
check('ход героя', (await turn()) === '2:Герой', await turn());
await useNow(hero, S['Ссссс…']);
await wait(1200);
check('ссссс: шипит — эффект на герое', (await effects(hero)).includes('Шипит'));
await until('Герой'); // ход героя раунда 3: вплотную «Один», в 5 футах «Два»
const heroHp = await hp(hero), a1 = await hp(E1), a2 = await hp(E2);
await ev(() => gdt.dice(6, 4, 4, 4, 4, 4, 4));
await ev(() => gdt.queue(20, 1, 1));
await next(); // конец хода героя — взрыв
await ev(() => gdt.until(() => gdt.chats().some(c => /взрывается/.test(c) && /Герой/.test(c)), 5000));
check('ссссс: враг вплотную — взрыв: 6d6 = 24 по «Один» и «Два», герою половина', a1 - (await hp(E1)) === 24 && a2 - (await hp(E2)) === 24 && heroHp - (await hp(hero)) === 12 && !(await effects(hero)).includes('Шипит'), `Один ${a1}→${await hp(E1)}, Два ${a2}→${await hp(E2)}, Герой ${heroHp}→${await hp(hero)}`);
await setHp(E1, 30); await setHp(E2, 30); await setHp(hero, 60);
// Холостой: все ушли
await until('Герой');
await ev(({ hero, id }) => game.actors.get(hero).items.get(id).update({ 'system.uses.spent': 0 }), { hero, id: S['Ссссс…'] });
await useNow(hero, S['Ссссс…']);
await wait(800);
await place(E1, 1, 12); await place(E2, 2, 12);
await until('Герой');
await next();
await wait(800);
check('ссссс: рядом никого — взрыва нет, заряд вернулся', (await spent(hero, S['Ссссс…'])) === 0 && (await chats()).some(c => /шипение стихло/.test(c)), String(await spent(hero, S['Ссссс…'])));

// ================= Красная бочка =================
await place(E3, 7, 8);
await useWith(hero, S['Красная бочка'], [[550, 850], [650, 850]]);
const barrels = () => ev(scene => game.scenes.get(scene).tokens.filter(t => t.flags.gachadnd?.barrel).map(t => `${t.x / 100},${t.y / 100}`), ids.scene);
check('бочка: две бочки в выбранных мышью клетках', JSON.stringify((await barrels()).sort()) === '["5,8","6,8"]', JSON.stringify(await barrels()));
const e3 = await hp(E3);
await ev(() => gdt.mark());
await ev(() => { gdt.dice(6, 3, 3, 3); gdt.queue(20, 1, 1, 1, 1, 1, 1); });
await ev(scene => game.scenes.get(scene).tokens.find(t => t.flags.gachadnd?.barrel && t.x === 500).actor.applyDamage(1), ids.scene);
await ev(() => gdt.until(() => gdt.chats().filter(c => /Красная бочка взрывается/.test(c)).length >= 2, 6000));
await ev(scene => gdt.until(() => !game.scenes.get(scene).tokens.some(t => t.flags.gachadnd?.barrel), 4000), ids.scene);
const booms = (await chats()).filter(c => /Красная бочка взрывается/.test(c)).length;
check('бочка: урон — взрыв, соседняя бочка — следом (цепная реакция)', booms === 2 && !(await barrels()).length, `взрывов ${booms}, бочек ${(await barrels()).length}`);
check('бочка: «Три» рядом — задет обоими взрывами', e3 - (await hp(E3)) >= 9, `${e3} → ${await hp(E3)}`);

// ================= Взрыв трупа =================
await setHp(E3, 0);
await place(E1, 8, 8); await setHp(E1, 1);
await place(E2, 9, 9); await setHp(E2, 30);
await target(E3);
await ev(() => { gdt.mark(); gdt.dice(20, 1, 1, 1, 1); });
await useNow(hero, S['Взрыв трупа']);
await ev(() => gdt.until(() => gdt.chats().some(c => /Цепная реакция/.test(c)), 6000));
check('труп: взорван — урон 7 (четверть от 30), труп исчез', !(await ev(E3 => game.actors.get(E3).getActiveTokens().length, E3)) && (await chats()).some(c => /Взрыв трупа: GD-тест: Три/.test(c) && /Урон: 7/.test(c)), (await chats()).filter(c => /Взрыв трупа/.test(c)).join(' | '));
check('труп: «Один» погиб — кнопка цепочки', (await hp(E1)) === 0 && (await chats()).some(c => /Цепная реакция/.test(c) && /Один/.test(c)));
const e2 = await hp(E2);
await ev(() => gdt.dice(20, 1, 1));
await chatButton('corpseChain', '[data-corpse-chain]');
await ev(() => gdt.until(() => gdt.chats().some(c => /Взрыв трупа: GD-тест: Один/.test(c)), 5000));
check('труп: цепочка кнопкой — «Один» взорван без заряда, задел «Два»', e2 - (await hp(E2)) === 7 && (await spent(hero, S['Взрыв трупа'])) === 1, `${e2} → ${await hp(E2)}, заряды ${await spent(hero, S['Взрыв трупа'])}`);

// ================= Утечка газа =================
await place(E2, 3, 3); await setHp(E2, 30);
await useWith(hero, S['Утечка газа'], [[350, 350]]);
const gas = () => ev(() => game.combat.getFlag('gachadnd', 'gas'));
let g = await gas();
check('газ: вентиль в выбранной клетке, радиус 10', g && g.x === 350 && g.y === 350 && g.radius === 10, JSON.stringify(g));
await ev(() => gdt.dice(20, 1));
await until('Два');
check('газ: «Два» начал ход в газе — отравлен', await ev(E2 => game.actors.get(E2).statuses.has('poisoned'), E2));
await until('Герой');
g = await gas();
check('газ: новый раунд — облако растёт до 15', g.radius === 15, JSON.stringify(g));
const e2b = await hp(E2);
await ev(() => { gdt.mark(); gdt.dice(6, 6, 6, 6); gdt.queue(20, 1); });
await ev(E2 => game.actors.get(E2).applyDamage([{ value: 1, type: 'fire' }]), E2);
await ev(() => gdt.until(() => gdt.chats().some(c => /Газ взрывается/.test(c)), 5000));
// Спасбросок мог уйти чужому броску (кости Dice So Nice) — сверяемся с карточкой взрыва
const gasCard = (await chats()).find(c => /Газ взрывается/.test(c)) ?? '';
const gasLost = Number(/Два — спасбросок \d+: (?:успех|провал) — −(\d+)/.exec(gasCard)?.[1]);
check('газ: огонь в облаке — взрыв 3d6 (радиус 15), облако выгорело', !(await gas()) && /Урон: 18 \(3d6\)/.test(gasCard) && (gasLost === 18 || gasLost === 9) && e2b - (await hp(E2)) === 1 + gasLost, `${e2b} → ${await hp(E2)}; ${gasCard.slice(0, 200)}`);

// ================= Ох, да! =================
await place(hero, 5, 5);
// «Один» взорван как труп — у пролома встаёт «Два»
await place(E2, 10, 5); await setHp(E2, 30);
await ev(E2 => game.actors.get(E2).statuses.has('prone') && game.actors.get(E2).toggleStatusEffect('prone', { active: false }), E2);
const walls0 = await ev(scene => game.scenes.get(scene).walls.size, ids.scene);
await ev(() => { gdt.dice(8, 8, 8); gdt.queue(20, 1); });
await useWith(hero, S['Ох, да!'], [[900, 550]]);
await ev(() => gdt.until(() => gdt.chats().some(c => /проламывает/.test(c)), 6000));
const walls = await ev(scene => game.scenes.get(scene).walls.map(w => w.c.join(',')), ids.scene);
check('ох, да: стена разрезана — пролом шириной в клетку', walls.length === walls0 + 1 && walls.includes('1000,200,1000,500') && walls.includes('1000,600,1000,900'), JSON.stringify(walls));
check('ох, да: герой — в конце рывка за стеной', (await ev(hero => { const t = game.actors.get(hero).getActiveTokens()[0].document; return `${t.x / 100},${t.y / 100}`; }, hero)) === '11,5');
check('ох, да: «Два» у пролома — 2d8 = 16 и ничком', 30 - (await hp(E2)) === 16 && await ev(E2 => game.actors.get(E2).statuses.has('prone'), E2), `${await hp(E2)}`);
await f.shot('ohyeah');

await ev(() => gdt.resetDice());
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
