// Огранка в настоящей Foundry: node tools/foundry/facet.mjs [--headed]
// Камни за ступени синергий; вкладка «Огранка» в Терминале — оружие и категории с тремя гнёздами, шкатулка
// камней; предел камней тега; Разлёт, Перекидка (выбор игрока), Переливание — карточками; Мина — закладка
// в клетку в досягаемости способности и срабатывание, когда туда вошли; В долг — без ячейки, максимум ПЗ меньше
// в начале следующего хода; Переливание — союзнику рядом с героем; Выброс — только ближе к цели; Раскат —
// половина в начале следующего хода; Плата кровью — кнопка в карточке; камни гаснут, если ступень упала;
// игрок вставляет камень сам. Броски: промах по цели — камни молчат; та же атака против КД каждого задетого;
// у Волны — спасбросок в карточке камня; Мина замораживает атаку — наступивший против своего КД. Выброс —
// кнопка в карточке: щелчок по клетке, герой перенёсся.
import { connect, checker, moduleErrors, done, joinAs } from './harness.mjs';
import { install, scene, skills, combat, classKit } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, { hero: { level: 5 }, enemies: [{ name: 'Враг А', x: 6, y: 5 }, { name: 'Враг Б', x: 7, y: 5 }, { name: 'Враг В', x: 6, y: 6 }, { name: 'Союзник', x: 4, y: 5, disposition: 1 }] });
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

// Атака с заданной костью к20 (face), потом урон; вернуть итог атаки и новые карточки
const strike = (itemId, face) => ev(async ({ hero, itemId, face }) => {
    const activity = game.actors.get(hero).items.get(itemId).system.activities.find(x => x.type === 'attack');
    Hooks.once('dnd5e.preRollAttackV2', config => { for (const roll of config.rolls ?? []) Object.assign((roll.options ??= {}), { minimum: face, maximum: face }); });
    const atk = await activity.rollAttack({}, { configure: false }, { create: false });
    const n = game.messages.size;
    const rolls = await activity.rollDamage({}, { configure: false }, {});
    await new Promise(r => setTimeout(r, 1500));
    return { attack: (Array.isArray(atk) ? atk[0] : atk)?.total, total: (rolls ?? []).reduce((s, r) => s + r.total, 0),
        cards: game.messages.contents.slice(n).map(m => ({ id: m.id, text: m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), flags: m.flags.gachadnd ?? {} })) };
}, { hero: ids.hero, itemId, face });
// КД — у актёра токена (враги не связаны с персонажем)
const setAc = (id, ac) => ev(({ id, ac }) => canvas.tokens.placeables.find(t => t.actor?.id === id).actor.update({ 'system.attributes.ac.calc': 'flat', 'system.attributes.ac.flat': ac }), { id, ac });

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

// ---------- Переливание: урон по врагу лечит союзника рядом с героем (Союзник — слева от героя)
await place(weapons['Топор'], 'transfuse');
await target(a);
r = await roll(weapons['Топор'], 'attack');
const tr = r.cards.find(x => /Переливание — Топор/.test(x.text));
check('Переливание: урон Топором по Врагу А — лечение Союзнику рядом с героем, на столько же', tr && /Союзник/.test(tr.text) && tr.text.includes(String(r.total)), JSON.stringify(r.cards.map(x => x.text)));

// ---------- Броски: Разлёт в Мече; Враг Б в латах (КД 25), А и В — КД 12
await unplace(weapons['Меч'], 'hop');
await place(weapons['Меч'], 'spread');
await setAc(b, 25);
await target(a);
r = await strike(weapons['Меч'], 10);
const split = r.cards.find(x => /Разлёт — Меч/.test(x.text))?.text ?? '';
check('Броски: та же атака против КД каждого — Врагу В попадание, Враг Б в латах — «мимо (КД 25)»',
    /попадание/.test(split) && /Враг В/.test(split) && /мимо: GD-тест: Враг Б \(КД 25\)/.test(split), JSON.stringify({ attack: r.attack, cards: r.cards.map(x => x.text) }));
r = await strike(weapons['Меч'], 1);
check('Броски: промах по Врагу А (1 на кости) — камни молчат, карточка «камни не сработали», Разлёта нет',
    r.cards.some(x => /Промах по GD-тест: Враг А/.test(x.text) && /не сработали/.test(x.text)) && !r.cards.some(x => /Разлёт — Меч/.test(x.text) && /попадание/.test(x.text)), JSON.stringify(r.cards.map(x => x.text)));
await f.shot('facet-rolls');
await setAc(b, 12);
await unplace(weapons['Меч'], 'spread');
await place('wave', 'spread');
await target(a);
r = await roll(kit['burning-hands']);
const saveCard = r.cards.find(x => /Разлёт — Пылающие руки/.test(x.text))?.text ?? '';
check('Броски: Разлёт Огненных ладоней — соседи бросают свой спасбросок Ловкости против Сл, успех — половина',
    /Спасбросок Ловкости Сл \d+ — успех: половина/.test(saveCard), JSON.stringify(r.cards.map(x => x.text)));
await unplace('wave', 'spread');
await place(weapons['Меч'], 'hop');

// ---------- Мина: Огненные ладони (Волна) закладываются в точку и срабатывают, когда туда вошли
await place('wave', 'mine');
await target(b);
r = await roll(kit['burning-hands']);
const mineMsg = r.cards.find(x => x.flags.facetMine);
// Как игрок: кнопка «Заложить» в карточке, потом щелчок мышью по точке на сцене
const spot = mineMsg ? await ev(id => {
    document.querySelector(`[data-message-id="${id}"] [data-gd-mine="place"]`)?.click();
    const p = canvas.stage.worldTransform.apply({ x: 550, y: 450 }), box = canvas.app.view.getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y, notes: [...document.querySelectorAll('#notifications li')].map(n => n.textContent.trim()).filter(t => /Герой|Щёлкните/.test(t)) };
}, mineMsg.id) : null;
if (spot) { await wait(400); await page.mouse.click(spot.x, spot.y); }
const mine = mineMsg ? await ev(async ({ id, scene, enemy }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await sleep(1500);
    const mines = game.scenes.get(scene).getFlag('gachadnd', 'facetMines') ?? [];
    const drawn = !!canvas.interface?.getChildByName?.('gdFacetMines');
    const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const placedText = plain(game.messages.get(id).content);
    // Мина — в клетке (5, 4), рядом с героем: Огненные ладони — «на себя», досягаемость 5 фт.
    // Враг В: по диагонали (6, 3), потом справа (6, 4) — не взрывают; путь вдоль x = 6 мимо клетки мины
    const doc = canvas.tokens.placeables.find(t => t.actor?.id === enemy).document;
    await doc.update({ x: 600, y: 300 }); await sleep(800);
    await doc.update({ x: 600, y: 400 }); await sleep(800);
    const besides = (game.scenes.get(scene).getFlag('gachadnd', 'facetMines') ?? []).length;
    const n = game.messages.size;
    await doc.update({ x: 500, y: 400 });
    await sleep(2000);
    return { placed: mines.length, drawn, placedText, besides, firedText: plain(game.messages.get(id).content), state: game.messages.get(id).getFlag('gachadnd', 'facetMine').state,
        left: (game.scenes.get(scene).getFlag('gachadnd', 'facetMines') ?? []).length,
        cards: game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) };
}, { id: mineMsg.id, scene: ids.scene, enemy: c }) : null;
check('Мина: урон не сразу — «Заложить» и щелчок по соседней клетке (Огненные ладони — 5 фт): заложена, видна на сцене', mineMsg && mine?.placed === 1 && mine.drawn && /Заложена/.test(mine.placedText ?? ''), JSON.stringify({ mineMsg: mineMsg?.text, spot, mine }));
check('Мина: соседняя клетка и диагональ не взрывают — только встав на клетку мины', mine?.besides === 1 && mine.left === 0, JSON.stringify({ besides: mine?.besides, left: mine?.left }));
check('Мина: карточка по шагам — как заложить, кого заденет и чем проверят; после закладки — «Заложена»',
    /Заложить — нажмите и щёлкните клетку/.test(mineMsg?.text ?? '') && /Спасбросок Ловкости/.test(mineMsg?.text ?? '') && /Заложена/.test(mine?.placedText ?? ''), JSON.stringify({ text: mineMsg?.text, placed: mine?.placedText }));
check('Мина: Враг В вошёл в точку — сработала, карточка со спасброском, мины больше нет; карточка мины — «Сработала»',
    mine?.left === 0 && mine.cards.some(t => /Мина —/.test(t) && /Враг В/.test(t) && /Спасбросок Ловкости/.test(t)) && /Сработала/.test(mine.firedText), JSON.stringify({ cards: mine?.cards, fired: mine?.firedText }));
await f.shot('facet-3-mine');
await ev(id => canvas.tokens.placeables.find(t => t.actor?.id === id).document.update({ x: 600, y: 600 }), c);

// ---------- Мина в Мече: атака заморожена при закладке; наступил Враг В (КД 12) — та же атака против его КД
await unplace('wave', 'mine');
await place(weapons['Меч'], 'mine');
await target(a);
r = await strike(weapons['Меч'], 10);
const swordMine = r.cards.find(x => x.flags.facetMine);
await f.shot('facet-5-mine-card');
const frozen = swordMine ? await ev(async ({ id, scene, enemy }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    (await gdt.mod('core/socket.js')).requestGM('facetMinePlace', { messageId: id, sceneId: scene, x: 1050, y: 850 });
    await sleep(1200);
    // Проход насквозь: с клетки слева от мины на клетку справа, не останавливаясь на ней
    const doc = canvas.tokens.placeables.find(t => t.actor?.id === enemy).document;
    await doc.update({ x: 900, y: 600 }, { animate: false }); await sleep(600);
    await doc.update({ x: 900, y: 800 }, { animate: false }); await sleep(600);
    const n = game.messages.size;
    await doc.update({ x: 1100, y: 800 });
    await sleep(2500);
    return { left: (game.scenes.get(scene).getFlag('gachadnd', 'facetMines') ?? []).length, at: [doc.x, doc.y],
        cards: game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) };
}, { id: swordMine.id, scene: ids.scene, enemy: c }) : null;
check(`Мина в Мече: атака ${r.attack} заморожена — Враг В прошёл через клетку насквозь, «Атака ${r.attack} — попадание», ему урон ${r.total}`,
    swordMine && /атака \d+/.test(swordMine.text) && frozen?.left === 0 && frozen.at.join() === '1100,800' && frozen.cards.some(t => /Мина — Меч/.test(t) && new RegExp(`Атака ${r.attack}.{0,6}— попадание`).test(t) && /Враг В/.test(t)), JSON.stringify({ text: swordMine?.text, frozen }));
await ev(id => canvas.tokens.placeables.find(t => t.actor?.id === id).document.update({ x: 600, y: 600 }), c);
await unplace(weapons['Меч'], 'mine');

// ---------- Выброс в Топоре: кнопка в карточке, щелчок по клетке в 30 фт ближе к цели — герой перенёсся туда
await place(weapons['Топор'], 'cast');
await target(b);
const blinkUse = await ev(async ({ hero, axe }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const n = game.messages.size;
    await game.actors.get(hero).items.get(axe).system.activities.find(a => a.type === 'attack').use({}, { configure: false }, {});
    await sleep(1200);
    const msg = game.messages.contents.slice(n).find(m => m.type === 'usage' || m.getFlag('dnd5e', 'messageType') === 'usage');
    const button = document.querySelector(`[data-message-id="${msg?.id}"] .gd-stone-blink`);
    button?.click();
    const token = canvas.tokens.placeables.find(t => t.actor?.id === hero).document;
    const at = (x, y) => { const p = canvas.stage.worldTransform.apply({ x, y }), box = canvas.app.view.getBoundingClientRect(); return { x: box.left + p.x, y: box.top + p.y }; };
    // (3, 5) — дальше от Врага Б, чем герой; (8, 6) — ближе
    return { id: msg?.id, button: !!button, before: [token.x, token.y], back: at(350, 550), ...at(850, 650) };
}, { hero: ids.hero, axe: weapons['Топор'] });
await wait(400);
await page.mouse.click(blinkUse.back.x, blinkUse.back.y);
await wait(1200);
const away = await ev(hero => { const t = canvas.tokens.placeables.find(t => t.actor?.id === hero).document; return [t.x, t.y]; }, ids.hero);
await ev(id => document.querySelector(`[data-message-id="${id}"] .gd-stone-blink`)?.click(), blinkUse.id);
await wait(400);
const before = await ev(() => game.messages.size);
await page.mouse.click(blinkUse.x, blinkUse.y);
await wait(2000);
const blinked = await ev(({ hero, id, before }) => {
    const token = canvas.tokens.placeables.find(t => t.actor?.id === hero).document;
    return { at: [token.x, token.y], done: !!game.messages.get(id)?.getFlag('gachadnd', 'facetBlinkDone'),
        note: game.messages.contents.slice(before).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).find(t => /Выброс/.test(t)) ?? '' };
}, { hero: ids.hero, id: blinkUse.id, before });
check('Выброс: клетка дальше от цели — не переносит; клетка ближе к Врагу Б — герой в ней, карточка «перенёсся… применяется отсюда»',
    blinkUse.button && away.join() === blinkUse.before.join() && blinked.at.join() === '800,600' && blinked.done && /перенёсся на \d+ футов/.test(blinked.note), JSON.stringify({ blinkUse, away, blinked }));
await ev(({ hero, at }) => canvas.tokens.placeables.find(t => t.actor?.id === hero).document.update({ x: at[0], y: at[1] }, { animate: false }), { hero: ids.hero, at: blinkUse.before });
await unplace(weapons['Топор'], 'cast');
await place('wave', 'mine');

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
    // Лечение — ровно 8: половина Раската не выпадет в 0 на единице
    Hooks.once('dnd5e.preRollDamageV2', config => { for (const roll of config.rolls ?? []) roll.parts = ['8']; });
    await activity.rollDamage({}, { configure: false }, {});
    await sleep(1200);
    const mid = { slots: actor.system.spells.spell1.value, debt: actor.getFlag('gachadnd', 'facetDebt'), echo: (actor.getFlag('gachadnd', 'facetEcho') ?? []).length, hp: actor.system.attributes.hp.value };
    const n = game.messages.size;
    for (let i = 0; i < game.combat.turns.length && game.combat.combatant?.actorId !== hero; i++) { await game.combat.nextTurn(); await sleep(600); }
    await sleep(1200);
    const texts = game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
    const tempmax = actor.system.attributes.hp.tempmax;
    await actor.update({ 'system.attributes.hp.tempmax': 0 });
    return { slotsBefore, ...mid, hpAfter: actor.system.attributes.hp.value, tempmax, debtAfter: actor.getFlag('gachadnd', 'facetDebt') ?? null, echoCard: texts.some(t => /Раскат —/.test(t)), payCard: texts.some(t => /расплата/.test(t)) };
}, { hero: ids.hero, id: kit['cure-wounds'] });
check('В долг: Исцеление ран не потратило ячейку, долг 5 ПЗ ждёт хода', debt.slotsBefore > 0 && debt.slots === debt.slotsBefore && debt.debt === 5 && debt.hp === 30 && debt.echo === 1, JSON.stringify(debt));
check('начало следующего хода героя: долг снят — максимум ПЗ на 5 меньше, текущие те же; Раскат — карточка половины лечения', debt.hpAfter === 30 && debt.tempmax === -5 && !debt.debtAfter && debt.echoCard && debt.payCard, JSON.stringify(debt));
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
