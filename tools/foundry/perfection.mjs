// Само совершенство в настоящей Foundry: node tools/foundry/perfection.mjs [--headed]
// Удар оружием зажигает штрих сам; манёвр и прочее — кнопкой окна огранки (использование навыка — окно, а не
// карточка); ход без нового штриха — «Небрежно», но не если герой без сознания; пять — «Почти» (+1 эффектом);
// семь — «Само совершенство»: к20 не ниже 10 до конца следующего хода, потом огранка пуста; конец боя гасит.
// Классификация действий: удар, чары, Память, зелье, лечение союзника.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
const ids = await scene(page, { hero: { level: 5 }, enemies: [{ name: 'Враг', x: 7, y: 5 }] });
const since = f.log.length;
const S = await skills(page, ids.hero, ['Само совершенство', 'Хлопушка']);
const SKILL = S['Само совершенство'];
// Меч героя и бой: ходит герой, потом враг
const combatId = await ev(async ({ hero, enemy }) => {
    const actor = game.actors.get(hero);
    await actor.createEmbeddedDocuments('Item', [{ name: 'PF-меч', type: 'weapon', system: { type: { value: 'martialM', baseItem: 'longsword' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } }]);
    for (const c of game.combats.contents) await c.delete();
    const scene = canvas.scene;
    const combat = await Combat.create({ scene: scene.id, active: true });
    const tokens = scene.tokens.filter(t => [hero, enemy].includes(t.actorId));
    await combat.createEmbeddedDocuments('Combatant', tokens.map(t => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, initiative: t.actorId === hero ? 20 : 5 })));
    await combat.startCombat();
    await gdt.settle();
    return combat.id;
}, { hero: ids.hero, enemy: ids.enemies[0] });
const st = () => ev(({ hero, item }) => {
    const i = game.actors.get(hero).items.get(item), a = game.actors.get(hero);
    const fl = i.flags.gachadnd;
    return { strokes: fl.strokes ?? [], counter: fl.counter ?? 0, turnLit: !!fl.turnLit, perfect: !!fl.perfect, almost: a.effects.some(e => e.flags?.gachadnd?.perfectionAlmost) };
}, { hero: ids.hero, item: SKILL });
const light = (id, on = true) => ev(async ({ hero, item, id, on }) => {
    const { light } = await gdt.mod('memory/skills/living/perfection.js');
    await light(game.actors.get(hero).items.get(item), id, { on, by: 'gm' });
    await gdt.settle();
}, { hero: ids.hero, item: SKILL, id, on });
const next = () => ev(async id => { await game.combats.get(id).nextTurn(); await gdt.settle(400, 5000); }, combatId);

// ---------- Классификация действий
const kinds = await ev(async ({ hero, enemy }) => {
    const { strokeOf } = await gdt.mod('memory/skills/living/perfection.js');
    const actor = game.actors.get(hero);
    const fake = (item, activity) => ({ ...activity, item: { flags: {}, actor, ...item } });
    const target = canvas.tokens.placeables.find(t => t.document.actorId === hero);
    target?.setTarget(true, { releaseOthers: true });
    const self = strokeOf(fake({ type: 'consumable', id: 'x' }, { type: 'heal' }));
    canvas.tokens.placeables.find(t => t.document.actorId === enemy)?.setTarget(true, { releaseOthers: true });
    const other = strokeOf(fake({ type: 'feat', id: 'y' }, { type: 'heal' }));
    game.user.targets.forEach(t => t.setTarget(false, { releaseOthers: true }));
    return {
        weapon: strokeOf(fake({ type: 'weapon' }, { type: 'attack', attack: { type: { value: 'melee', classification: 'weapon' } } })),
        spell: strokeOf(fake({ type: 'spell' }, { type: 'attack' })),
        memory: strokeOf(actor.items.getName('Хлопушка').system.activities.contents[0]),
        potion: self, healAlly: other
    };
}, { hero: ids.hero, enemy: ids.enemies[0] });
check('действия: оружие — Удар, заклинание — Чары, навык Памяти — Память, зелье — Окружение, лечение другого — Помощь',
    kinds.weapon === 'strike' && kinds.spell === 'spell' && kinds.memory === 'memory' && kinds.potion === 'prop' && kinds.healAlly === 'help', JSON.stringify(kinds));

// ---------- Удар мечом зажигает штрих сам; использование навыка — окно огранки
const strike = await ev(async ({ hero, item }) => {
    const actor = game.actors.get(hero);
    const sword = actor.items.getName('PF-меч');
    const n = game.messages.size;
    await sword.system.activities.find(a => a.type === 'attack').use({}, { configure: false }, {});
    await gdt.settle();
    // Использование навыка: окно огранки, карточки навыка в чате нет
    const m = game.messages.size;
    await actor.items.get(item).system.activities.contents[0].use({}, { configure: false }, {});
    await gdt.sleep(800);
    const dialog = [...foundry.applications.instances.values()].find(a => a.element?.querySelector?.('.gd-perfection'));
    const rows = dialog?.element.querySelectorAll('.gd-perfection-strokes li').length ?? 0;
    const buttons = dialog?.element.querySelectorAll('[data-stroke]').length ?? 0;
    await dialog?.close();
    return { note: game.messages.contents.slice(n).some(x => /Удар/.test(x.content)), rows, buttons, noCard: game.messages.size === m };
}, { hero: ids.hero, item: SKILL });
let s = await st();
check('удар мечом — штрих «Удар» сам, строка в чат; навык открывает окно огранки (7 штрихов, у Мастера кнопки), без карточки',
    s.strokes.join() === 'strike' && s.counter === 1 && s.turnLit && strike.note && strike.rows === 7 && strike.buttons >= 6 && strike.noCard, JSON.stringify({ s, strike }));

// ---------- Манёвр кнопкой; ход врага; свой ход без нового — «Небрежно»
await light('move');
await next();   // ход врага
await next();   // раунд 2, ход героя
await next();   // герой передал ход, ничего не сделав
s = await st();
check('ход без нового штриха — «Небрежно»: последний (Манёвр) погас', s.strokes.join() === 'strike' && !s.turnLit, JSON.stringify(s));

// ---------- Без сознания — штрих не гаснет
await next();   // раунд 3, ход героя
await ev(hero => game.actors.get(hero).toggleStatusEffect('unconscious', { active: true }), ids.hero);
await next();
s = await st();
await ev(hero => game.actors.get(hero).toggleStatusEffect('unconscious', { active: false }), ids.hero);
check('герой без сознания — «Небрежно» не считается', s.strokes.join() === 'strike', JSON.stringify(s));

// ---------- Пять — «Почти»; семь — совершенство, к20 не ниже 10
await next();   // раунд 4, ход героя
for (const id of ['spell', 'memory', 'move', 'help']) await light(id);
const almost = await st();
for (const id of ['trick', 'prop']) await light(id);
s = await st();
// Снимок: огранка горит (точки над токеном), окно огранки открыто
await ev(async ({ hero, item }) => {
    const { openFacets } = await gdt.mod('memory/skills/living/perfection.js');
    await openFacets(game.actors.get(hero).items.get(item));
    const t = canvas.tokens.placeables.find(x => x.document.actorId === hero);
    if (t) await canvas.animatePan({ x: t.center.x + 250, y: t.center.y, scale: 1.6, duration: 0 });
    document.getElementById('pause')?.classList.remove('paused');
}, { hero: ids.hero, item: SKILL });
await page.waitForTimeout(1200);
await f.shot('perfection');
await ev(() => [...foundry.applications.instances.values()].filter(a => a.element?.querySelector?.('.gd-perfection')).forEach(a => a.close()));
const roll = await ev(async hero => {
    gdt.dice(20, 2);
    const r = await game.actors.get(hero).rollAbilityCheck({ ability: 'str' }, { configure: false }, { create: false });
    gdt.resetDice();
    const r0 = Array.isArray(r) ? r[0] : r;
    return { die: r0?.dice?.[0]?.total, total: r0?.total };
}, ids.hero);
check('пять штрихов — «Почти» (+1 эффектом); семь — «Само совершенство»: к20 с выпавшей 2 считается 10',
    almost.counter === 5 && almost.almost && !almost.perfect && s.perfect && s.counter === 7 && s.almost && roll.die === 10, JSON.stringify({ almost, s, roll }));

// ---------- Совершенство до конца следующего хода, потом всё по новой
await next();   // конец хода героя (в нём пришло совершенство)
const after1 = await st();
await next();   // раунд 5, ход героя
await next();   // конец следующего хода героя
const after2 = await st();
check('совершенство держится до конца следующего хода, потом огранка пуста и «Почти» снят',
    after1.perfect && after1.counter === 7 && !after2.perfect && after2.counter === 0 && !after2.almost, JSON.stringify({ after1, after2 }));

// ---------- Конец боя гасит огранку
await light('strike');
const ended = await ev(async ({ id, hero, item }) => {
    await game.combats.get(id).delete();
    await gdt.settle();
    const fl = game.actors.get(hero).items.get(item).flags.gachadnd;
    return { strokes: fl.strokes ?? [], counter: fl.counter ?? 0 };
}, { id: combatId, hero: ids.hero, item: SKILL });
check('конец боя — огранка гаснет', ended.strokes.length === 0 && ended.counter === 0, JSON.stringify(ended));

await ev(hero => { const a = game.actors.get(hero); return a.deleteEmbeddedDocuments('Item', a.items.filter(i => i.name.startsWith('PF-')).map(i => i.id)); }, ids.hero);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
