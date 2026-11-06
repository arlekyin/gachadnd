// Огранка: проклятье, казнь, разум, аномалия в настоящей Foundry: node tools/foundry/facet-odds.mjs [--headed]
// Сглаз — атака с преимуществом, следующий к20 с помехой; Без пощады — цель на половине ПЗ: преимущество; Неотвратимо —
// урон пополам; Добить — кнопка: лишний урон ближайшему; Перенаправить — промах: кнопки всех соседей цели;
// Двойное эхо — 20 на кости: кнопка «Ещё раз», повтор без цены; Возврат — промах заклинанием: ячейка обратно;
// Приговор — на врага выше половины не применяется, объявляется; упал до половины — карточка «Применить»;
// Шальной заряд — тот же урон случайному в 30 фт; Отложенный выбор — напоминание в конце раунда; Кубик судьбы — к6 в чат.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, classKit } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
// Герой в (5,5); враг А рядом, Б — в 5 фт от А, В — в стороне
const ids = await scene(page, { hero: { level: 5 }, enemies: [
    { name: 'Враг А', x: 6, y: 5 }, { name: 'Враг Б', x: 7, y: 5 }, { name: 'Враг В', x: 6, y: 8 }
] });
const [A, B, V] = ids.enemies;
const since = f.log.length;
// Проклятье, казнь, разум, аномалия — по камню каждого
await skills(page, ids.hero, ['Полукровка', 'Слышащий шёпот', 'Чтец некрологов', 'Детектор лжи', 'Контрольный', 'Палач']);
const W = await ev(async hero => {
    const actor = game.actors.get(hero);
    const mk = name => ({ name, type: 'weapon', system: { type: { value: 'martialM' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } });
    const items = await actor.createEmbeddedDocuments('Item', [mk('Меч'), mk('Топор'), mk('Чистый')]);
    return Object.fromEntries(items.map(i => [i.name, i.id]));
}, ids.hero);
await classKit(page, ids.hero, { spells: ['guiding-bolt'], caster: { name: 'Жрец', identifier: 'cleric' } });
const place = (where, stone) => ev(async ({ hero, where, stone }) => (await gdt.mod('memory/facet/facet.js')).placeStone(game.actors.get(hero), where, stone), { hero: ids.hero, where, stone });
const unplace = (where, stone) => ev(async ({ hero, where, stone }) => (await gdt.mod('memory/facet/facet.js')).removeStone(game.actors.get(hero), where, stone), { hero: ids.hero, where, stone });
const target = id => ev(id => { canvas.tokens.placeables.find(t => t.actor?.id === id)?.setTarget(true, { releaseOthers: true }); }, id);
const hp = (id, value, ac) => ev(async ({ id, value, ac }) => {
    const a = game.actors.get(id);
    await a.update({ 'system.attributes.hp.max': 40, 'system.attributes.hp.value': value, ...(ac ? { 'system.attributes.ac.calc': 'flat', 'system.attributes.ac.flat': ac } : {}) });
}, { id, value, ac });
const flagOf = key => ev(({ hero, key }) => game.actors.get(hero).getFlag('gachadnd', key) ?? null, { hero: ids.hero, key });
/** Бросок атаки оружием: режим преимущества */
const attack = (itemId, { nat = null } = {}) => ev(async ({ hero, itemId, nat }) => {
    if (nat) Hooks.once('dnd5e.preRollAttackV2', c => { for (const r of c.rolls ?? []) Object.assign((r.options ??= {}), { minimum: nat, maximum: nat }); });
    const activity = game.actors.get(hero).items.get(itemId).system.activities.find(a => a.type === 'attack');
    const r = await activity.rollAttack({}, { configure: false }, {});
    const x = Array.isArray(r) ? r[0] : r;
    await new Promise(res => setTimeout(res, 900));
    return { mode: x?.options?.advantageMode ?? null, total: x?.total, ADV: CONFIG.Dice.D20Roll.ADV_MODE.ADVANTAGE, DIS: CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE };
}, { hero: ids.hero, itemId, nat });
const texts = n => ev(n => game.messages.contents.slice(n).map(m => `${m.flavor ?? ''} ${m.content}`.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()), n);
const count = () => ev(() => game.messages.size);

const grains = await ev(async hero => (await gdt.mod('memory/facet/facet.js')).grainsOf(game.actors.get(hero)), ids.hero);
check('камни: проклятье, казнь, разум, аномалия — по одному', ['проклятье', 'казнь', 'разум', 'аномалия'].every(t => grains[t] === 1), JSON.stringify(grains));

// ---------- Сглаз: Меч с преимуществом, следующий к20 (Чистый) — с помехой, потом обычный
await place(W['Меч'], 'jinx');
await target(A); await hp(A, 40, 10);
const j1 = await attack(W['Меч']);
const jFlag = await flagOf('facetJinx');
const j2 = await attack(W['Чистый']);
const j3 = await attack(W['Чистый']);
check('Сглаз: атака с преимуществом; следующий к20 героя — с помехой, дальше обычный',
    j1.mode === j1.ADV && jFlag === true && j2.mode === j2.DIS && j3.mode !== j3.DIS && j3.mode !== j3.ADV, JSON.stringify({ j1: j1.mode, jFlag, j2: j2.mode, j3: j3.mode }));
await unplace(W['Меч'], 'jinx');

// ---------- Без пощады: цель на половине — преимущество, полная — нет
await place(W['Меч'], 'mercy');
await hp(A, 40);
const m1 = await attack(W['Меч']);
await hp(A, 15);
const m2 = await attack(W['Меч']);
check('Без пощады: Враг А с полными ПЗ — без преимущества, на половине — с преимуществом', m1.mode !== m1.ADV && m2.mode === m2.ADV, JSON.stringify({ full: m1.mode, half: m2.mode }));
await unplace(W['Меч'], 'mercy');

// ---------- Неотвратимо: урон пополам
await place(W['Меч'], 'inevitable');
const inev = await ev(async ({ hero, sword }) => {
    const r = await game.actors.get(hero).items.get(sword).system.activities.find(a => a.type === 'attack').rollDamage({}, { configure: false }, {});
    await new Promise(res => setTimeout(res, 800));
    return { formula: r?.[0]?.formula, total: r?.[0]?.total };
}, { hero: ids.hero, sword: W['Меч'] });
check('Неотвратимо: урон Мечом — кости пополам (floor((1d8…)/2))', /floor\(/.test(inev.formula ?? '') && inev.total <= 4 + 5, JSON.stringify(inev));
await unplace(W['Меч'], 'inevitable');

// ---------- Добить: Враг А с 1 ПЗ — кнопка: лишний урон ближайшему к нему существу
await place(W['Топор'], 'finish');
await hp(A, 1, 1);
let n = await count();
await ev(async ({ hero, axe }) => {
    const act = game.actors.get(hero).items.get(axe).system.activities.find(a => a.type === 'attack');
    Hooks.once('dnd5e.preRollAttackV2', c => { for (const r of c.rolls ?? []) Object.assign((r.options ??= {}), { minimum: 15, maximum: 15 }); });
    await act.rollAttack({}, { configure: false }, {});
    await act.rollDamage({}, { configure: false }, {});
    await new Promise(res => setTimeout(res, 1800));
}, { hero: ids.hero, axe: W['Топор'] });
const fin = await ev(async n => {
    const msg = game.messages.contents.slice(n).find(m => m.getFlag('gachadnd', 'facetPass'));
    const before = game.messages.size;
    const text = msg?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') ?? '';
    document.querySelector(`[data-message-id="${msg?.id}"] [data-gd-pass]`)?.click();
    await new Promise(r => setTimeout(r, 1500));
    return { text, used: msg?.getFlag('gachadnd', 'facetPass').used, more: game.messages.contents.slice(before).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) };
}, n);
check('Добить: Враг А с 1 ПЗ — кнопка передать лишнее; нажали — карточка лишнего урона',
    /лишнее \d+/.test(fin.text) && fin.used === true && fin.more.some(t => /Добить — Топор/.test(t) && /Лишнее передано/.test(t)), JSON.stringify(fin));
await unplace(W['Топор'], 'finish');

// ---------- Перенаправить: промах по Врагу А (КД 30) — кнопки соседей; выбор — прицел на Врага Б
await place(W['Топор'], 'redirect');
await hp(A, 40, 30); await hp(B, 40, 5);
n = await count();
await attack(W['Топор'], { nat: 5 });
const red = await ev(async n => {
    const msg = game.messages.contents.slice(n).find(m => m.getFlag('gachadnd', 'facetOdds'));
    const el = document.querySelector(`[data-message-id="${msg?.id}"]`);
    const buttons = [...(el?.querySelectorAll('[data-gd-odds="redirect"]') ?? [])].map(b => b.textContent.trim());
    el?.querySelector('[data-gd-odds="redirect"]')?.click();
    await new Promise(r => setTimeout(r, 1200));
    return { buttons, target: [...game.user.targets][0]?.name ?? null, text: game.messages.get(msg?.id)?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') ?? '' };
}, n);
check('Перенаправить: промах по Врагу А — кнопка Врага Б (рядом), выбор переводит прицел на него',
    red.buttons.some(b => /Враг Б/.test(b)) && /Враг Б/.test(red.target ?? '') && /Перенаправлено/.test(red.text), JSON.stringify(red));
await unplace(W['Топор'], 'redirect');

// ---------- Двойное эхо: 20 на кости — кнопка «Ещё раз», новое применение без цены
await place(W['Топор'], 'twin');
await target(A);
n = await count();
await attack(W['Топор'], { nat: 20 });
const twin = await ev(async n => {
    const msg = game.messages.contents.slice(n).find(m => m.getFlag('gachadnd', 'facetOdds'));
    const before = game.messages.size;
    document.querySelector(`[data-message-id="${msg?.id}"] [data-gd-odds="twin"]`)?.click();
    await new Promise(r => setTimeout(r, 1500));
    return { card: !!msg, used: game.messages.get(msg?.id)?.getFlag('gachadnd', 'facetOdds')?.used, more: game.messages.size - before };
}, n);
check('Двойное эхо: 20 на кости — карточка с кнопкой; «Ещё раз» — новое применение', twin.card && twin.used === true && twin.more >= 1, JSON.stringify(twin));
// Повтор выпал 10 — следующая настоящая 20 снова даёт кнопку; а 20 на самом повторе — нет
const twinCards = async nat => { const n = await count(); await attack(W['Топор'], { nat }); return ev(n => game.messages.contents.slice(n).filter(m => m.getFlag('gachadnd', 'facetOdds')?.uuid).length, n); };
const afterRepeat = await twinCards(10);
const nextTwenty = await twinCards(20);
await ev(async n => {
    const msg = game.messages.contents.slice(n).findLast(m => m.getFlag('gachadnd', 'facetOdds')?.uuid);
    document.querySelector(`[data-message-id="${msg?.id}"] [data-gd-odds="twin"]`)?.click();
    await new Promise(r => setTimeout(r, 1500));
}, 0);
const repeatTwenty = await twinCards(20);
check('Двойное эхо: повтор с 10 не даёт кнопки и не глотает следующую 20; 20 на самом повторе кнопки не даёт', afterRepeat === 0 && nextTwenty === 1 && repeatTwenty === 0, JSON.stringify({ afterRepeat, nextTwenty, repeatTwenty }));
await unplace(W['Топор'], 'twin');

// ---------- Возврат: Направляющий луч мимо (КД 30) — «Вернуть цену»: ячейка 1-го круга обратно
await place('strike', 'refund');
await hp(A, 40, 30); await target(A);
const refund = await ev(async hero => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const actor = game.actors.get(hero), spell = actor.items.find(i => i.system.identifier === 'guiding-bolt');
    await actor.update({ 'system.spells.spell1.value': 2 });
    Hooks.once('dnd5e.preRollAttackV2', c => { for (const r of c.rolls ?? []) Object.assign((r.options ??= {}), { minimum: 3, maximum: 3 }); });
    const act = spell.system.activities.find(a => a.type === 'attack');
    await act.use({ spell: { slot: 'spell1' } }, { configure: false }, {});
    await sleep(800);
    const slotsAfterCast = actor.system.spells.spell1.value;
    const n = game.messages.size;
    await act.rollAttack({}, { configure: false }, {});
    await sleep(1200);
    const msg = game.messages.contents.slice(n).find(m => m.getFlag('gachadnd', 'facetOdds'));
    document.querySelector(`[data-message-id="${msg?.id}"] [data-gd-odds="refund"]`)?.click();
    await sleep(1200);
    return { slotsAfterCast, slotsAfterRefund: actor.system.spells.spell1.value, card: !!msg, jinx: actor.getFlag('gachadnd', 'facetJinx') ?? null };
}, ids.hero);
check('Возврат: ячейка потрачена, промах — «Вернуть цену» вернул её, следующий к20 — с помехой',
    refund.card && refund.slotsAfterCast === 1 && refund.slotsAfterRefund === 2 && refund.jinx === true, JSON.stringify(refund));
await ev(hero => game.actors.get(hero).unsetFlag('gachadnd', 'facetJinx'), ids.hero);
await unplace('strike', 'refund');

// ---------- Приговор: Враг А с полными ПЗ — не применяется, объявлен; упал до половины — карточка «Применить»
await place(W['Меч'], 'verdict');
await hp(A, 40, 10); await target(A);
n = await count();
const verdict = await ev(async ({ hero, sword, A }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const actor = game.actors.get(hero), before = game.messages.size;
    const used = await actor.items.get(sword).system.activities.find(a => a.type === 'attack').use({}, { configure: false }, {});
    await sleep(900);
    const declared = (actor.getFlag('gachadnd', 'facetVerdicts') ?? []).length;
    await game.actors.get(A).update({ 'system.attributes.hp.value': 18 });
    await sleep(1500);
    return { usedNothing: !used, declared, left: (actor.getFlag('gachadnd', 'facetVerdicts') ?? []).length };
}, { hero: ids.hero, sword: W['Меч'], A });
const vt = await texts(n);
check('Приговор: на полного Врага А — не применён, объявлен; ПЗ до половины — карточка «Применить»',
    verdict.usedNothing && verdict.declared === 1 && verdict.left === 0 && vt.some(t => /Приговор/.test(t) && /Применить/.test(t)), JSON.stringify({ verdict, vt: vt.filter(t => /Приговор/.test(t)) }));
await unplace(W['Меч'], 'verdict');

// ---------- Шальной заряд, потом Кубик судьбы (камень аномалии один): тот же урон случайному в 30 фт, к6 — в чат
const useSword = () => ev(async ({ hero, sword }) => {
    await game.actors.get(hero).items.get(sword).system.activities.find(a => a.type === 'attack').use({}, { configure: false }, {});
    await new Promise(r => setTimeout(r, 1500));
    return { target: [...game.user.targets][0]?.name ?? null };
}, { hero: ids.hero, sword: W['Меч'] });
await place(W['Меч'], 'switch');
await hp(A, 40, 5); await hp(B, 40, 5); await hp(V, 40, 5); await target(A);
n = await count();
const stray = await ev(async ({ hero, sword }) => {
    const r = await game.actors.get(hero).items.get(sword).system.activities.find(a => a.type === 'attack').rollDamage({}, { configure: false }, {});
    await new Promise(res => setTimeout(res, 1500));
    return { total: r?.[0]?.total, target: [...game.user.targets][0]?.name };
}, { hero: ids.hero, sword: W['Меч'] });
const swt = await texts(n);
check('Шальной заряд: цель прежняя (Враг А), карточка того же урона случайному существу',
    /Враг А/.test(stray.target ?? '') && swt.some(t => /Шальной заряд — Меч/.test(t) && /Враг [БВ]/.test(t) && t.includes(String(stray.total))), JSON.stringify({ stray, swt }));
await unplace(W['Меч'], 'switch');
await place(W['Меч'], 'fate');
n = await count();
await useSword();
const st = await texts(n);
check('Кубик судьбы: к6 в чат при применении', st.some(t => /Кубик судьбы/.test(t)), JSON.stringify(st.filter(t => /Кубик/.test(t))));
// Старый множитель (6, урон не бросали): новое применение с 2–5 его снимает
const fateStale = await ev(async ({ hero, sword }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const actor = game.actors.get(hero), activity = actor.items.get(sword).system.activities.find(a => a.type === 'attack');
    for (let i = 0; i < 30; i++) {
        await actor.setFlag('gachadnd', 'facetFate', { uuid: activity.uuid, factor: 2 });
        const { message } = await activity.use({}, { configure: false }, {}) ?? {};
        await sleep(1000);
        const n = game.messages.get(message?.id)?.getFlag('gachadnd', 'facetFateRoll');
        if (n > 1 && n < 6) return { n, flag: actor.getFlag('gachadnd', 'facetFate') ?? null };
    }
    return { n: null };
}, { hero: ids.hero, sword: W['Меч'] });
check('Кубик судьбы: на 2–5 старый множитель снят — следующий урон обычный', fateStale.n && fateStale.flag === null, JSON.stringify(fateStale));

await unplace(W['Меч'], 'fate');

// ---------- Отложенный выбор: применили в бою — в конце раунда карточка-напоминание
await place(W['Меч'], 'defer');
n = await count();
const deferred = await ev(async ({ hero, sword, A }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const c of game.combats.contents) await c.delete();
    const scene = canvas.scene;
    const combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments('Combatant', scene.tokens.filter(t => [hero, A].includes(t.actorId)).map(t => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, initiative: t.actorId === hero ? 20 : 5 })));
    await combat.startCombat(); await gdt.settle(400, 4000);
    const actor = game.actors.get(hero);
    await actor.items.get(sword).system.activities.find(a => a.type === 'attack').use({}, { configure: false }, {});
    await sleep(900);
    const waiting = (actor.getFlag('gachadnd', 'facetDeferred') ?? []).length;
    await combat.nextTurn(); await sleep(600);
    const sameRound = (actor.getFlag('gachadnd', 'facetDeferred') ?? []).length;
    await combat.nextTurn(); await sleep(1200);
    const left = (actor.getFlag('gachadnd', 'facetDeferred') ?? []).length;
    await combat.delete();
    return { waiting, sameRound, left };
}, { hero: ids.hero, sword: W['Меч'], A });
const dt = await texts(n);
check('Отложенный выбор: ждёт весь раунд, в конце раунда — карточка «выберите цель»',
    deferred.waiting === 1 && deferred.sameRound === 1 && deferred.left === 0 && dt.some(t => /Отложенный выбор — Меч/.test(t) && /выберите цель/.test(t)), JSON.stringify({ deferred, dt: dt.filter(t => /Отложенный/.test(t)) }));
await unplace(W['Меч'], 'defer');

await f.shot('facet-odds');
await ev(hero => { const a = game.actors.get(hero); return a.deleteEmbeddedDocuments('Item', a.items.filter(i => ['Меч', 'Топор', 'Чистый'].includes(i.name)).map(i => i.id)); }, ids.hero);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
