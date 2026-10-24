// Обмен между игроками в настоящей Foundry: node tools/foundry/trade.mjs [--headed]
// Два игрока (Claude_player — Лира, Claude_trusted — Борк): правый щелчок мышью по токену товарища — окно
// обмена у обоих; поиск в сумке; предложение одного видно другому; правка снимает «Согласен»; оба согласны — Мастер проводит:
// монеты и предметы переехали, запись в чат; Мастеру — шёпот «Наблюдать» и окно с обеими сторонами. Без Мастера
// (его страница закрыта) — каждый проводит свою половину: часть стопки и кристалл переехали, ничего не потерялось.
import { connect, joinAs, checker, moduleErrors, done } from './harness.mjs';
import { install, scene } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, { hero: { x: 3, y: 3 }, enemies: [] });
const since = f.log.length;
// Лира — у Claude_player, Борк — у Claude_trusted: персонажи назначены игрокам, токены рядом
const P = await ev(async ({ sceneId }) => {
    const p1 = game.users.getName('Claude_player'), p2 = game.users.getName('Claude_trusted');
    for (const old of game.actors.filter(a => /^GD-тест: (Лира|Борк)$/.test(a.name))) await old.delete();
    const mk = (name, user, gp, items) => Actor.create({
        name: `GD-тест: ${name}`, type: 'character', ownership: { default: 0, [user.id]: 3 },
        system: { currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 }, attributes: { hp: { value: 20, max: 20 } } },
        prototypeToken: { actorLink: true, disposition: 1 }
    }).then(async a => { await a.createEmbeddedDocuments('Item', items); return a; });
    const lira = await mk('Лира', p1, 50, [
        { name: 'Кинжал', type: 'weapon', system: { quantity: 1, equipped: true } },
        { name: 'Зелье лечения', type: 'consumable', system: { quantity: 3 } },
        { name: 'Кристалл: Хлопушка', type: 'consumable', system: { quantity: 1 }, flags: { gachadnd: { is_crystal_item: true, skill_name: 'Хлопушка', rarity: 'green' } } }
    ]);
    const bork = await mk('Борк', p2, 10, [{ name: 'Верёвка', type: 'loot', system: { quantity: 1 } }]);
    await p1.update({ character: lira.id }); await p2.update({ character: bork.id });
    const scene = game.scenes.get(sceneId), grid = scene.grid.size;
    await scene.createEmbeddedDocuments('Token', [
        { ...lira.prototypeToken.toObject(), actorId: lira.id, name: lira.name, x: 6 * grid, y: 5 * grid },
        { ...bork.prototypeToken.toObject(), actorId: bork.id, name: bork.name, x: 8 * grid, y: 5 * grid }
    ]);
    return { lira: lira.id, bork: bork.id };
}, { sceneId: ids.scene });

// Последняя вошедшая вкладка не получает рассылок сокета (особенность стенда): после игроков входит временный
// «зритель» — его удаляют в конце
await ev(async () => { if (!game.users.getName('GD-тест: зритель')) await User.create({ name: 'GD-тест: зритель', role: 1, password: '' }); });
const p1 = await joinAs(f, 'Claude_player');
const p2 = await joinAs(f, 'Claude_trusted');
const p3 = await joinAs(f, 'GD-тест: зритель');
await wait(1500);

const app = (pg, part) => pg.evaluate(part => {
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    if (!win) return null;
    const col = side => win.element.querySelector(`.gd-trade-col:nth-child(${side})`);
    const text = el => el?.textContent.replace(/\s+/g, ' ').trim() ?? '';
    return { id: win.tradeId, left: text(col(1)), right: text(col(2)), foot: text(win.element.querySelector('.gd-trade-foot')), part };
}, part);

// ---------- Правый щелчок по токену Борка у Лиры — окно у обоих
const spot = await p1.page.evaluate(id => {
    const t = canvas.tokens.placeables.find(t => t.actor?.id === id);
    const p = canvas.stage.worldTransform.apply(t.center), box = canvas.app.view.getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y };
}, P.bork);
await p1.page.mouse.click(spot.x, spot.y, { button: 'right' });
await p1.page.waitForTimeout(2000);
const w1 = await app(p1.page), w2 = await app(p2.page);
check('правый щелчок Лиры по токену Борка — окно обмена у Лиры и сразу у Борка, одна сделка', w1 && w2 && w1.id === w2.id && /Вы отдаёте/.test(w1.left) && /Лира/.test(w2.right), JSON.stringify({ w1, w2 }));

// ---------- Поиск в сумке: «зел» — видно только Зелье; переживает перерисовку от правки товарища
await p1.page.evaluate(() => {
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    win.element.querySelector('.gd-trade-search').focus();
});
await p1.page.keyboard.type('зел');
await p1.page.waitForTimeout(400);
await p2.page.evaluate(() => {
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    const input = win.element.querySelector('input[data-coin="sp"]');
    input.value = '1'; input.dispatchEvent(new Event('change', { bubbles: true }));
});
await p1.page.waitForTimeout(1200);
const search = await p1.page.evaluate(() => {
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    const shown = [...win.element.querySelectorAll('.gd-trade-bag button')].filter(b => !b.hidden).map(b => b.textContent.trim());
    const input = win.element.querySelector('.gd-trade-search');
    const out = { shown, value: input.value, focus: document.activeElement === input };
    input.value = ''; input.dispatchEvent(new Event('input'));
    return out;
});
check('поиск в сумке: «зел» — в списке только Зелье; товарищ поменял своё — запрос и фокус на месте',
    search.shown.length === 1 && /Зелье/.test(search.shown[0]) && search.value === 'зел' && search.focus, JSON.stringify(search));
await p2.page.evaluate(() => {
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    const input = win.element.querySelector('input[data-coin="sp"]');
    input.value = '0'; input.dispatchEvent(new Event('change', { bubbles: true }));
});
await p1.page.waitForTimeout(800);

// ---------- Предложения: Лира — Кинжал и 20 зм; Борк — Верёвка; видно друг другу
await p1.page.evaluate(() => {
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    [...win.element.querySelectorAll('.gd-trade-bag button')].find(b => /Кинжал/.test(b.textContent))?.click();
});
await p1.page.waitForTimeout(800);
await p1.page.evaluate(() => {
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    const input = win.element.querySelector('input[data-coin="gp"]');
    input.value = '20'; input.dispatchEvent(new Event('change', { bubbles: true }));
});
await p1.page.waitForTimeout(800);
// Лира согласна — потом Борк кладёт Верёвку: «Согласен» Лиры снимается
await p1.page.evaluate(() => [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-')).element.querySelector('[data-action="ready"]').click());
await p1.page.waitForTimeout(800);
const readyBefore = await app(p2.page);
await p2.page.evaluate(() => {
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    [...win.element.querySelectorAll('.gd-trade-bag button')].find(b => /Верёвка/.test(b.textContent))?.click();
});
await p2.page.waitForTimeout(1200);
const seen = await app(p2.page), seen1 = await app(p1.page);
check('Борк видит предложение Лиры: Кинжал и 20 зм; Лира видит Верёвку Борка', /Кинжал/.test(seen.right) && /20 зм/.test(seen.right) && /Верёвка/.test(seen1.right), JSON.stringify({ seen, seen1 }));
check('Лира согласилась, Борк поменял предложение — «Согласен» Лиры снят', /согласен/.test(readyBefore.right) && !/согласен/.test(seen.right), JSON.stringify({ readyBefore: readyBefore.right, after: seen.right }));
await p1.shot('trade-1-offer');

// ---------- Мастер: шёпот «Наблюдать» и окно с обеими сторонами
const gm = await ev(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const msg = game.messages.contents.findLast(m => m.getFlag('gachadnd', 'tradeWatch'));
    document.querySelector(`[data-message-id="${msg?.id}"] .gd-trade-watch`)?.click();
    await sleep(1200);
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    return { whisper: !!msg && msg.whisper.length > 0, open: !!win, edits: win?.element.querySelectorAll('.gd-trade-bag').length ?? 0, force: !!win?.element.querySelector('[data-action="force"]') };
});
check('Мастеру — шёпот «Наблюдать»: окно сделки, обе стороны правятся, кнопка «Провести сейчас»', gm.whisper && gm.open && gm.edits === 2 && gm.force, JSON.stringify(gm));

// ---------- Оба согласны — Мастер проводит
for (const pl of [p1, p2]) await pl.page.evaluate(() => [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-')).element.querySelector('[data-action="ready"]').click());
await wait(3000);
const after = await ev(({ lira, bork }) => {
    const L = game.actors.get(lira), B = game.actors.get(bork);
    const names = a => a.items.map(i => i.name).sort();
    const card = game.messages.contents.findLast(m => m.content.includes('gd-trade-card') && !m.whisper.length);
    return { lira: { gp: L.system.currency.gp, items: names(L) }, bork: { gp: B.system.currency.gp, items: names(B), dagger: B.items.find(i => i.name === 'Кинжал')?.system.equipped }, card: card?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') ?? '' };
}, P);
check('сделка с Мастером: у Лиры 30 зм и Верёвка, Кинжала нет; у Борка 30 зм и Кинжал (снят с пояса)',
    after.lira.gp === 30 && after.lira.items.includes('Верёвка') && !after.lira.items.includes('Кинжал') && after.bork.gp === 30 && after.bork.items.includes('Кинжал') && after.bork.dagger === false && !after.bork.items.includes('Верёвка'), JSON.stringify(after));
check('запись в чат для всех: кто что отдал', /Лира отдаёт: 20 зм, Кинжал/.test(after.card) && /Борк отдаёт: Верёвка/.test(after.card), after.card);
await f.shot('trade-2-gm');
const gmErrors = moduleErrors(f.log.slice(since));
check('ошибок модуля у Мастера нет', !gmErrors.length, gmErrors.slice(0, 3).join(' | '));

// ---------- Без Мастера: Борк начинает; 2 зелья из 3 и кристалл от Лиры, 5 зм от Борка
await page.close();
await p1.page.waitForTimeout(1500);
const spot2 = await p2.page.evaluate(id => {
    const t = canvas.tokens.placeables.find(t => t.actor?.id === id);
    const p = canvas.stage.worldTransform.apply(t.center), box = canvas.app.view.getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y, gm: !!game.users.activeGM };
}, P.lira);
await p2.page.mouse.click(spot2.x, spot2.y, { button: 'right' });
await p2.page.waitForTimeout(2000);
await p1.page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const win = () => [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    const add = name => [...win().element.querySelectorAll('.gd-trade-bag button')].find(b => b.textContent.includes(name))?.click();
    add('Зелье'); await sleep(700); add('Зелье'); await sleep(700); add('Кристалл'); await sleep(700);
});
await p2.page.evaluate(() => {
    const win = [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-'));
    const input = win.element.querySelector('input[data-coin="gp"]');
    input.value = '5'; input.dispatchEvent(new Event('change', { bubbles: true }));
});
await p2.page.waitForTimeout(900);
for (const pl of [p1, p2]) { await pl.page.evaluate(() => [...foundry.applications.instances.values()].find(a => a.id?.startsWith('gachadnd-trade-')).element.querySelector('[data-action="ready"]').click()); await pl.page.waitForTimeout(500); }
await p1.page.waitForTimeout(3500);
const solo = await p1.page.evaluate(({ lira, bork }) => {
    const L = game.actors.get(lira);
    const qty = (a, n) => a.items.filter(i => i.name.includes(n)).reduce((s, i) => s + (i.system.quantity ?? 1), 0);
    return { gm: !!game.users.activeGM, lira: { gp: L.system.currency.gp, potions: qty(L, 'Зелье'), crystal: qty(L, 'Кристалл') } };
}, P);
const solo2 = await p2.page.evaluate(({ bork }) => {
    const B = game.actors.get(bork);
    const qty = n => B.items.filter(i => i.name.includes(n)).reduce((s, i) => s + (i.system.quantity ?? 1), 0);
    const crystal = B.items.find(i => i.name.includes('Кристалл'));
    return { gp: B.system.currency.gp, potions: qty('Зелье'), crystal: qty('Кристалл'), flag: !!crystal?.getFlag('gachadnd', 'is_crystal_item') };
}, P);
check('без Мастера: каждый провёл свою половину — у Лиры 35 зм, 1 зелье, кристалла нет; у Борка 25 зм, 2 зелья и кристалл (с флагом кристалла)',
    !solo.gm && solo.lira.gp === 35 && solo.lira.potions === 1 && solo.lira.crystal === 0 && solo2.gp === 25 && solo2.potions === 2 && solo2.crystal === 1 && solo2.flag, JSON.stringify({ solo, solo2 }));
await p2.shot('trade-3-solo');

const errors = [...p1.log, ...p2.log].filter(l => /gachadnd|trade/i.test(l) && /error|ошибк/i.test(l));
check('ошибок модуля у игроков нет', !errors.length, errors.slice(0, 3).join(' | '));
// Уборка: Мастер входит заново (его страница закрыта) — персонажи, назначения, «зритель»
const g2 = await joinAs(f, 'Claude');
await g2.page.evaluate(async ({ lira, bork }) => {
    for (const name of ['Claude_player', 'Claude_trusted']) await game.users.getName(name)?.update({ character: null });
    for (const id of [lira, bork]) await game.actors.get(id)?.delete();
    await game.users.getName('GD-тест: зритель')?.delete();
}, P);
await p3.close(); await p1.close(); await p2.close(); await g2.close();
const failed = summary();
await f.close().catch(() => {});
done(failed);
