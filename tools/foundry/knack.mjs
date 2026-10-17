// Навыки, закрывшие пустые редкости тегов, в настоящей Foundry: node tools/foundry/knack.mjs [--headed] [--slow[=мс]]
// Хлопушка (без реакций вне боя и до начала хода в бою), Чутьё мясника (капля над раненым у того, кто
// ведёт персонажа), Навылет (лишний урон из лотка dnd5e — кнопкой соседу), Рандомная хрень (окно выбора,
// атаки и урон, оружие у цели, «Подобрать», пропажа в конце боя), Переливание (обмен долями ПЗ, спасбросок
// врага, союзник согласен, истощение), Медленный яд (счёт урона за 3 раунда и возврат ядом), Сверхновая
// (накопление урона в бою, взрыв со спасбросками, ошеломление, сброс в конце боя).
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const settle = () => page.evaluate(() => gdt.settle());
const chats = () => ev(() => gdt.chats().map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
const lastChat = async () => (await chats()).at(-1) ?? '';
const hp = id => ev(id => game.actors.get(id).system.attributes.hp.value, id);
const setHp = (id, v) => ev(({ id, v }) => game.actors.get(id).update({ 'system.attributes.hp.value': v }), { id, v });
const turn = () => ev(() => `${game.combat.round}:${game.combat.combatant?.name?.replace('GD-тест: ', '')}`);
const next = async () => { await ev(() => game.combat.nextTurn()); await settle(); return turn(); };
const target = (...actors) => ev(actors => canvas.tokens.setTargets(actors.map(a => game.actors.get(a).getActiveTokens()[0].id)), actors);
const spent = (actor, id) => ev(({ actor, id }) => game.actors.get(actor).items.get(id).system.uses.spent, { actor, id });
const resetUses = (actor, id) => ev(({ actor, id }) => game.actors.get(actor).items.get(id).update({ 'system.uses.spent': 0 }), { actor, id });
const effects = id => ev(id => game.actors.get(id).effects.map(e => e.name), id);
const useNow = async (actor, item) => {
    await ev(async ({ actor, item }) => { gdt.warnings.length = 0; gdt.mark(); await game.actors.get(actor).items.get(item).system.activities.contents[0].use({}, { configure: false }); }, { actor, item });
    await settle();
    await wait(400);
};
const chatButton = async (flag, sel) => {
    await ev(async () => { await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary'); });
    await wait(400);
    const id = await ev(flag => game.messages.contents.findLast(m => m.flags?.gachadnd?.[flag])?.id, flag);
    await page.$eval(`#chat [data-message-id="${id}"] ${sel}`, el => el.click());
    await settle();
    await wait(800);
};

await install(page);
const ids = await scene(page, {
    hero: { x: 5, y: 5, level: 5 },
    enemies: [{ name: 'Один', x: 6, y: 5 }, { name: 'Два', x: 7, y: 5 }, { name: 'Три', x: 12, y: 5 }, { name: 'Союзник', x: 4, y: 5, disposition: 1 }]
});
const [A, B, C, ALLY] = ids.enemies;
const hero = ids.hero;
const NAMES = ['Хлопушка', 'Чутьё мясника', 'Навылет', 'Рандомная хрень, вперёд!', 'Переливание', 'Медленный яд', 'Сверхновая'];

// ---------- Компендиум
const pack = await ev(async names => {
    const docs = await game.packs.get('gachadnd.gacha-skills').getDocuments();
    return names.map(n => { const d = docs.find(x => x.name === n); return d ? `${n}:${d.flags.gachadnd.rarity}:${d.flags.gachadnd.knack}:${d.flags.gachadnd.tags.join('+')}` : `${n}:нет`; });
}, NAMES);
check('компендиум: семь навыков knack с редкостями и тегами', pack.every(p => !p.endsWith(':нет')) && pack.join(' ').includes('Хлопушка:gray:firecracker:огонь+взрыв') && pack.join(' ').includes('Сверхновая:red:supernova:взрыв+щит'), pack.join(' | '));
const S = await skills(page, hero, NAMES);
// Меч для лотка урона dnd5e
await ev(hero => game.actors.get(hero).createEmbeddedDocuments('Item', [{ name: 'Меч', type: 'weapon', system: { type: { value: 'martialM' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } }]), hero);

// ---------- Хлопушка вне боя: в 10 футах без реакций, сам — нет
await useNow(hero, S['Хлопушка']);
let fx = await ev(ids => ids.map(id => game.actors.get(id).effects.some(e => e.name === 'Хлопушка: без реакций')), [A, B, C, ALLY, hero]);
check('Хлопушка: Один, Два (10 футов) и Союзник без реакций; Три (далеко) и сам — нет', fx.join() === 'true,true,false,true,false', fx.join());
check('Хлопушка: карточка и заряд', /Хлопок!/.test(await lastChat()) && (await spent(hero, S['Хлопушка'])) === 1, await lastChat());
await ev(ids => Promise.all(ids.map(id => { const a = game.actors.get(id); return a.deleteEmbeddedDocuments('ActiveEffect', a.effects.filter(e => e.name.startsWith('Хлопушка')).map(e => e.id)); })), [A, B, ALLY]);

// ---------- Чутьё мясника: капля над раненым — у того, кто ведёт персонажа (Мастер — выделив токен)
await setHp(A, 10); await setHp(C, 5);
await ev(hero => game.actors.get(hero).getActiveTokens()[0].control({ releaseOthers: true }), hero);
await wait(400);
const drops = () => ev(() => canvas.tokens.placeables.filter(t => t.children.some(c => c.name === 'gdButcherDrop')).map(t => t.document.name.replace('GD-тест: ', '')).sort().join(','));
check('Чутьё мясника: капля над Один (10/30), не над Два (целый) и не над Три (5/30, но в 35 футах)', (await drops()) === 'Один', await drops());
await ev(() => canvas.tokens.releaseAll());
await wait(400);
check('Чутьё мясника: токен не выделен — Мастер каплю не видит', (await drops()) === '', await drops());
await setHp(A, 30); await setHp(C, 30);

// ---------- Навылет: лишний урон из лотка dnd5e — кнопкой соседу убитого
await setHp(A, 5);
const killed = await ev(async ({ hero, A }) => {
    await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary');
    canvas.tokens.setTargets([game.actors.get(A).getActiveTokens()[0].id]);
    const act = game.actors.get(hero).items.find(i => i.type === 'weapon').system.activities.find(x => x.type === 'attack');
    gdt.dice(8, 8);
    const count = game.messages.size;
    await act.rollDamage({}, { configure: false }, {});
    await gdt.until(() => game.messages.size > count, 3000);
    return game.messages.contents.at(-1).id;
}, { hero, A });
// «Применить» в лотке dnd5e: урон сообщения броска с этим сообщением в origin (так зовёт его лоток v14)
await ev(async ({ id, A }) => {
    const message = game.messages.get(id);
    const damages = message.rolls.map(r => ({ value: r.total, type: r.options.type }));
    await game.actors.get(A).applyDamage(damages, { isDelta: true, origin: message, originatingMessage: message });
}, { id: killed, A });
await settle();
await wait(800);
let card = await lastChat();
// Урон меча с синергиями героя (пороги казни и стали прибавляют к атакам оружием) — лишнее сверх 5 ПЗ
const over = await ev(id => game.messages.get(id).rolls.reduce((s, r) => s + r.total, 0), killed) - 5;
check(`Навылет: Один убит (5 ПЗ) — карточка: лишний урон ${over}, кнопка — Два`, (await hp(A)) === 0 && new RegExp(`лишний урон: ${over}`).test(card) && await ev(() => !!game.messages.contents.at(-1).flags.gachadnd?.through), `${card}; ПЗ Одного ${await hp(A)}`);
const twoBefore = await hp(B);
await chatButton('through', '[data-gd-through]');
check('Навылет: остаток ушёл в Два, кнопки погасли', twoBefore - (await hp(B)) === over && await ev(() => game.messages.contents.findLast(m => m.flags.gachadnd?.through).flags.gachadnd.through.done), `${twoBefore} → ${await hp(B)}`);
await setHp(A, 30); await setHp(B, 30);

// ---------- Переливание: враг — спасбросок; провал — обмен долями, истощение
await setHp(hero, 6); await setHp(A, 27);
await target(A);
await ev(() => gdt.dice(20, 1));
await useNow(hero, S['Переливание']);
let ex = await ev(hero => game.actors.get(hero).system.attributes.exhaustion, hero);
check('Переливание: герой 10 % ↔ Один 90 % — герой 54/60, Один 3/30, истощение 1', (await hp(hero)) === 54 && (await hp(A)) === 3 && ex === 1, `${await hp(hero)}, ${await hp(A)}, истощение ${ex}`);
await resetUses(hero, S['Переливание']);
await target(A);
await ev(() => gdt.dice(20, 20));
await useNow(hero, S['Переливание']);
check('Переливание: враг выдержал спасбросок — обмена нет, заряд потрачен', (await hp(hero)) === 54 && (await hp(A)) === 3 && (await spent(hero, S['Переливание'])) === 1 && /не отдаёт/.test(await lastChat()), await lastChat());
await resetUses(hero, S['Переливание']);
await setHp(ALLY, 15);
await target(ALLY);
await useNow(hero, S['Переливание']);
ex = await ev(hero => game.actors.get(hero).system.attributes.exhaustion, hero);
check('Переливание: союзник согласен без спасброска — герой 90 % → 50 %, союзник 50 % → 90 %, истощение 2', (await hp(hero)) === 30 && (await hp(ALLY)) === 27 && ex === 2, `${await hp(hero)}, ${await hp(ALLY)}, истощение ${ex}`);
await ev(hero => game.actors.get(hero).update({ 'system.attributes.exhaustion': 0, 'system.attributes.hp.value': 60 }), hero);
await setHp(A, 30); await setHp(ALLY, 30);

// ---------- Бой: герой, Один, Два, Союзник
await combat(page, ids.scene, [hero, A, B, ALLY]);
await settle();

// Хлопушка в бою: эффект снимается в начале хода существа
await resetUses(hero, S['Хлопушка']);
await useNow(hero, S['Хлопушка']);
check('Хлопушка в бою: Один без реакций', (await effects(A)).includes('Хлопушка: без реакций'), (await effects(A)).join(', '));
await next();
check('Хлопушка: начался ход Одного — реакции вернулись', !(await effects(A)).includes('Хлопушка: без реакций') && (await effects(B)).includes('Хлопушка: без реакций'), `${await turn()}: ${(await effects(A)).join(', ')}`);
while (!(await turn()).endsWith('Герой')) await next();

// Сверхновая: копит урон в бою, взрыв, ошеломление
await useNow(hero, S['Сверхновая']);
check('Сверхновая: копить нечего — отказ, заряд цел', (await spent(hero, S['Сверхновая'])) === 0 && await ev(() => gdt.warnings.some(w => /копить пока нечего/.test(w))));
await ev(hero => game.actors.get(hero).applyDamage(10), hero); await settle();
await ev(hero => game.actors.get(hero).applyDamage(5), hero); await settle();
check('Сверхновая: накоплено 15 (эффект «Сверхновая: 15»)', (await effects(hero)).includes('Сверхновая: 15'), (await effects(hero)).join(', '));
const nova = await ev(ids => ids.map(id => game.actors.get(id).system.attributes.hp.value), [A, B, ALLY, C]);
await ev(() => gdt.dice(20, 1, 1, 20));
await useNow(hero, S['Сверхновая']);
const novaAfter = await ev(ids => ids.map(id => game.actors.get(id).system.attributes.hp.value), [A, B, ALLY, C]);
const lost = nova.map((v, i) => v - novaAfter[i]);
check('Сверхновая: трое в 20 футах — спасбросок Ловкости: провал 15, успех 7; Три вне радиуса', lost.slice(0, 3).sort().join() === '15,15,7' && lost[3] === 0, lost.join(', '));
check('Сверхновая: накопление сброшено, герой ошеломлён', !(await effects(hero)).some(e => e.startsWith('Сверхновая: 1')) && await ev(hero => game.actors.get(hero).statuses.has('stunned'), hero), (await effects(hero)).join(', '));
await ev(ids => ids.forEach(id => game.actors.get(id).update({ 'system.attributes.hp.value': 30 })), [A, B, ALLY]);
await settle();

// Медленный яд: считает урон 3 раунда и возвращает ядом
await target(B);
const round0 = await ev(() => game.combat.round);
await useNow(hero, S['Медленный яд']);
check('Медленный яд: Два отмечен', (await effects(B)).includes('Медленный яд: 0'), (await effects(B)).join(', '));
await ev(b => game.actors.get(b).applyDamage(5), B); await settle();
await ev(b => game.actors.get(b).applyDamage(-3), B); await settle();
await ev(b => game.actors.get(b).applyDamage(7), B); await settle();
check('Медленный яд: урон 5 и 7 посчитан, лечение 3 — нет: «Медленный яд: 12»', (await effects(B)).includes('Медленный яд: 12'), (await effects(B)).join(', '));
const twoHp = await hp(B);
while ((await ev(() => game.combat.round)) < round0 + 3) await next();
await wait(800);
check('Медленный яд: в начале третьего раунда — 12 урона Ядом, отметка снята', twoHp - (await hp(B)) === 12 && !(await effects(B)).some(e => e.startsWith('Медленный яд')), `${twoHp} → ${await hp(B)}; ${await lastChat()}`);

// Рандомная хрень: окно, атаки, оружие у цели, «Подобрать», пропажа в конце боя
await ev(hero => game.actors.get(hero).createEmbeddedDocuments('Item', [
    { name: 'Кинжал', type: 'weapon', img: 'icons/weapons/daggers/dagger-straight-blue.webp', system: { type: { value: 'simpleM' }, damage: { base: { number: 1, denomination: 4, types: ['piercing'] } }, equipped: false } },
    { name: 'Молот', type: 'weapon', img: 'icons/weapons/hammers/hammer-war-spiked.webp', system: { type: { value: 'martialM' }, damage: { base: { number: 1, denomination: 8, types: ['bludgeoning'] } }, equipped: false } }
]), hero);
await setHp(A, 30); await setHp(B, 30);
await target(A, B);
await ev(({ hero, id }) => { gdt.warnings.length = 0; gdt.p = game.actors.get(hero).items.get(id).system.activities.contents[0].use({}, { configure: false }); }, { hero, id: S['Рандомная хрень, вперёд!'] });
await page.waitForSelector('.application.dialog select[name="t0"]', { timeout: 8000 });
const plan = await ev(({ A, B }) => {
    const ta = game.actors.get(A).getActiveTokens()[0].id, tb = game.actors.get(B).getActiveTokens()[0].id;
    const rows = [...document.querySelectorAll('.application.dialog .gd-junk-row')];
    const names = rows.map(r => r.querySelector('span').textContent);
    rows.forEach(r => { r.querySelector('input').checked = false; });
    const set = (name, token) => { const r = rows[names.indexOf(name)]; r.querySelector('input').checked = true; r.querySelector('select').value = token; };
    set('Кинжал', ta); set('Молот', tb);
    return names.join(', ');
}, { A, B });
// Кинжал: к20 = 15 (+5 = 20 против КД 12) — попадание, к4 = 3 (+2 = 5); Молот: к20 = 1 — мимо
// Броски идут в порядке оружия в окне (порядок инвентаря) — кости подкладываются в том же порядке
await ev(order => {
    const steps = { 'Кинжал': [[20, 15], [4, 3]], 'Молот': [[20, 1]] };
    const queue = order.split(', ').flatMap(name => steps[name] ?? []);
    gdt.dice(...queue[0]);
    for (const [faces, v] of queue.slice(1)) gdt.queue(faces, v);
}, plan);
await ev(() => document.querySelector('.application.dialog button[data-action="ok"]').click());
await ev(() => gdt.p);
await settle();
await wait(1000);
const junk = await ev(({ hero, scene }) => ({
    weapons: game.actors.get(hero).items.filter(i => ['Кинжал', 'Молот'].includes(i.name)).length,
    tiles: game.scenes.get(scene).tiles.filter(t => t.flags.gachadnd?.junk).map(t => t.flags.gachadnd.junk.name).sort().join(',')
}), { hero, scene: ids.scene });
card = await lastChat();
check('Рандомная хрень: окно предлагает неэкипированное оружие', /Кинжал/.test(plan) && /Молот/.test(plan) && !/Меч/.test(plan), plan);
check('Рандомная хрень: Кинжал попал по Одному (−5), Молот мимо — Два цел', (await hp(A)) === 25 && (await hp(B)) === 30 && /попадание/.test(card) && /мимо/.test(card), card);
check('Рандомная хрень: оружие ушло из инвентаря и лежит у целей', junk.weapons === 0 && junk.tiles === 'Кинжал,Молот', JSON.stringify(junk));
await chatButton('junk', '[data-gd-junk]');
const picked = await ev(({ hero, scene }) => ({ items: game.actors.get(hero).items.filter(i => ['Кинжал', 'Молот'].includes(i.name)).map(i => i.name), tiles: game.scenes.get(scene).tiles.filter(t => t.flags.gachadnd?.junk).length }), { hero, scene: ids.scene });
check('Рандомная хрень: «Подобрать» вернул предмет, плитка убрана', picked.items.length === 1 && picked.tiles === 1, JSON.stringify(picked));
await ev(() => game.combat.delete());
await settle();
await wait(800);
const gone = await ev(scene => game.scenes.get(scene).tiles.filter(t => t.flags.gachadnd?.junk).length, ids.scene);
check('конец боя: неподобранное пропало, карточка', gone === 0 && /пропало навсегда/.test(await lastChat()), await lastChat());
check('конец боя: Сверхновая сброшена', !(await ev(hero => game.actors.get(hero).getFlag('gachadnd', 'supernova'), hero)));

check('ошибок модуля в консоли нет', !moduleErrors(f.log).length, moduleErrors(f.log).slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
