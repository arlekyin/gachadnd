// События в настоящей Foundry: node tools/foundry/events.mjs [--headed]
// Узел «Событие» на карте (лес и болота, 1 этаж): Мастер открывает дневник — событие выбрано по биому, у всех
// одно состояние. Варианты: без проверки (исход и карточка в чат), с проверкой (бросок игрока, успех/провал,
// исходы всему отряду), навык сразу в Память и напоминание Мастеру; встреченное отмечается; просмотр без узла.
// Снимок — tools/foundry/out/events-*.png.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, PREFIX } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const settle = () => ev(() => gdt.settle());

await install(page);
const ids = await scene(page, { hero: { level: 3 } });
const hero = ids.hero;
const since = f.log.length;
const saved = await ev(() => Object.fromEntries(['runFloor', 'eventsSeen', 'effects', 'floorSceneId', 'devourerOmen', 'dealPreset'].map(k => [k, game.settings.get('gachadnd', k)])));

// Отряд: герой и союзник — персонажи «игрока»; карта: Вход → Событие → Застава → Босс, отряд на Событии
const ally = await ev(async ({ hero, PREFIX }) => {
    const a = await Actor.create({ name: `${PREFIX}: Союзник`, type: 'character', system: { attributes: { hp: { value: 30, max: 30 } } }, prototypeToken: { actorLink: true } });
    await a.createEmbeddedDocuments('Item', [{ name: 'Плут', type: 'class', system: { identifier: 'rogue', levels: 3, hd: { denomination: 'd8' } } }]);
    for (const x of [game.actors.get(hero), a]) Object.defineProperty(x, 'hasPlayerOwner', { get: () => true, configurable: true });
    await game.settings.set('gachadnd', 'runFloor', 1);
    await game.settings.set('gachadnd', 'eventsSeen', []);
    await game.settings.set('gachadnd', 'effects', 'off');
    const { MAP_DATA } = await gdt.mod('labyrinth/map.js');
    const node = (id, row, type, next) => ({ id, row, col: 0, type, label: MAP_DATA.LABELS[type], icon: MAP_DATA.ICONS[type], color: MAP_DATA.COLORS[type], next });
    const nodes = [node('0-0', 0, 'start', ['1-0']), node('1-0', 1, 'event', ['2-0']), node('2-0', 2, 'outpost', ['3-0']), node('3-0', 3, 'boss', [])];
    await canvas.scene.setFlag('gachadnd', 'floorMap', { rows: nodes.map(n => [n]), nodes, currentNodeId: '1-0', visitedNodes: ['0-0', '1-0'] });
    await game.settings.set('gachadnd', 'floorSceneId', canvas.scene.id);
    return a.id;
}, { hero, PREFIX });

const state = () => ev(() => canvas.scene.getFlag('gachadnd', 'floorMap').nodes.find(n => n.id === '1-0').event ?? null);
const reset = () => ev(async () => {
    const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    delete map.nodes.find(n => n.id === '1-0').event;
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
    await canvas.scene.setFlag('gachadnd', 'floorMap', map);
    foundry.applications.instances.get('gachadnd-event')?.close();
    await new Promise(r => setTimeout(r, 300));
});
const open = (id = 'swamp_lights') => ev(async id => {
    if (id) {
        const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
        map.nodes.find(n => n.id === '1-0').event = { id, status: 'open', choice: null, actorId: null, success: null, text: null, lines: [] };
        await canvas.scene.unsetFlag('gachadnd', 'floorMap');
        await canvas.scene.setFlag('gachadnd', 'floorMap', map);
    }
    await game.gachadnd.openEvent();
    await new Promise(r => setTimeout(r, 1200));
}, id);
const click = sel => ev(sel => document.querySelector(`#gachadnd-event ${sel}`)?.click(), sel);
const who = id => ev(id => { const s = document.querySelector('#gachadnd-event [name="who"]'); if (s) { s.value = id; s.dispatchEvent(new Event('change')); } }, id);

// ---------- Открытие на узле
const biome = await ev(async () => (await gdt.mod('labyrinth/biomes.js')).currentBiome());
check('биом узла до Заставы на 1 этаже — лес и болота', biome === 'swamp', biome);
await open(null);
let st = await state();
const SWAMP = ['swamp_lights', 'hunters_tower', 'hungry_stump', 'bone_trail'];
check('Мастер открыл дневник: событие леса и болот выбрано и записано на узел', SWAMP.includes(st?.id) && st.status === 'open', JSON.stringify(st));
await reset();
await open();
st = await state();
const view = await ev(() => {
    const el = document.getElementById('gachadnd-event');
    return el && { title: el.querySelector('.gd-ev-title')?.textContent, options: el.querySelectorAll('.gd-ev-option[data-action="choose"]').length, who: el.querySelectorAll('[name="who"] option').length, image: !!el.querySelector('.gd-sketch-image image') };
});
check('страница: заголовок, три варианта, «Кто» — отряд, рисунок', view?.title === 'Огоньки над трясиной' && view.options === 3 && view.who === 2 && view.image, JSON.stringify(view));
await f.shot('events-open');

// ---------- Без проверки
await click('[data-i="2"]');
await wait(800);
await settle();
st = await state();
const card = await ev(() => game.messages.contents.at(-1)?.content ?? '');
check('«Обойти»: исход сразу, карточка в чат, событие отмечено встреченным', st.status === 'done' && /Обойти трясину/.test(card) && (await ev(() => game.settings.get('gachadnd', 'eventsSeen'))).includes('swamp_lights'), `${st.status} | ${card.slice(0, 120)}`);
check('после исхода варианты не выбираются', await ev(() => !document.querySelector('#gachadnd-event .gd-ev-option[data-action="choose"]')));

// ---------- С проверкой: бросает выбранный персонаж
await reset();
await open();
await who(ally);
await click('[data-i="1"]');
await wait(800);
st = await state();
check('«Вглубь»: ждём броска того, кто выбран в «Кто»', st.status === 'roll' && st.actorId === ally, JSON.stringify(st));
const before = await ev(({ hero, ally }) => [hero, ally].map(id => game.actors.get(id).items.find(i => i.type === 'class')?.system.hd.spent ?? 0), { hero, ally });
const rewardsBefore = await ev(() => game.messages.contents.filter(m => m.flags?.gachadnd?.eventReward).length);
await click('[data-action="roll"]');
await wait(2500);
await settle();
st = await state();
const after = await ev(({ hero, ally }) => [hero, ally].map(id => game.actors.get(id).items.find(i => i.type === 'class')?.system.hd.spent ?? 0), { hero, ally });
const rewards = await ev(() => game.messages.contents.filter(m => m.flags?.gachadnd?.eventReward).length) - rewardsBefore;
const rolled = await ev(() => game.messages.contents.some(m => m.rolls?.length));
check('бросок навыка — штатный dnd5e, в чате', rolled);
check(st.success ? 'успех: заметная награда каждому из отряда' : 'провал: каждый тратит Кость Хитов',
    st.status === 'done' && (st.success ? rewards === 2 : after.every((v, i) => v === before[i] + 1)), JSON.stringify({ success: st.success, before, after, rewards }));

// ---------- Провал: бросок 1 — каждый тратит Кость Хитов
await reset();
await ev(() => game.settings.set('gachadnd', 'eventsSeen', []));
await open();
await who(hero);
await click('[data-i="1"]');
await wait(800);
const hdBefore = await ev(({ hero, ally }) => [hero, ally].map(id => game.actors.get(id).items.find(i => i.type === 'class')?.system.hd.spent ?? 0), { hero, ally });
await ev(async () => { await (await gdt.mod('core/socket.js')).requestGM('eventOp', { op: 'roll', total: 1 }); await gdt.settle(); });
await wait(800);
st = await state();
const hdAfter = await ev(({ hero, ally }) => [hero, ally].map(id => game.actors.get(id).items.find(i => i.type === 'class')?.system.hd.spent ?? 0), { hero, ally });
check('провал: каждый в отряде тратит Кость Хитов', st.status === 'done' && st.success === false && hdAfter.every((v, i) => v === hdBefore[i] + 1), JSON.stringify({ hdBefore, hdAfter, text: st.text }));

// ---------- Навык сразу в Память и напоминание Мастеру
await reset();
await ev(() => game.settings.set('gachadnd', 'eventsSeen', []));
await open();
await who(hero);
const skillsBefore = await ev(hero => game.actors.get(hero).items.filter(i => i.flags.gachadnd?.skill_name && !i.flags.gachadnd.is_crystal_item).length, hero);
await click('[data-i="0"]');
await wait(1500);
await settle();
const skillsAfter = await ev(hero => game.actors.get(hero).items.filter(i => i.flags.gachadnd?.skill_name && !i.flags.gachadnd.is_crystal_item).map(i => `${i.name}:${i.flags.gachadnd.rarity}`), hero);
const note = await ev(() => game.messages.contents.some(m => m.whisper?.length && /помеха на проверки Мудрости/.test(m.content)));
check('«Протянуть руку»: зелёный навык у героя в Памяти, шёпот Мастеру', skillsAfter.length === skillsBefore + 1 && skillsAfter.some(s => s.endsWith(':green')) && note, skillsAfter.join(', '));
await f.shot('events-done');

// ---------- Просмотр без узла
await ev(async () => {
    foundry.applications.instances.get('gachadnd-event')?.close();
    await new Promise(r => setTimeout(r, 300));
    await game.gachadnd.previewEvent('swamp_lights');
    await new Promise(r => setTimeout(r, 800));
    document.querySelector('#gachadnd-event [data-i="1"]')?.click();
});
await wait(400);
const preview = await ev(() => document.querySelector('#gachadnd-event .gd-ev-outcome')?.textContent ?? '');
check('просмотр: исход показан, ничего не меняется', /Успех:/.test(preview) && (await state()).status === 'done', preview.slice(0, 80));

// ---------- Новые исходы
const fx = await ev(async ({ hero }) => {
    const actor = game.actors.get(hero);
    const E = await gdt.mod('labyrinth/events.js');
    const inv = await gdt.mod('memory/inventory.js');
    const out = {};
    const apply = list => E.applyEffects(list, { one: actor, who: 'one', title: 'Проверка' });
    // Отдать серый кристалл — получить зелёный
    for (const i of actor.items.filter(i => i.flags.gachadnd?.is_crystal_item)) await i.delete();
    const pack = game.packs.get('gachadnd.gacha-skills');
    const index = await pack.getIndex({ fields: ['flags.gachadnd.rarity', 'flags.gachadnd.undeletable'] });
    const gray = index.find(e => e.flags?.gachadnd?.rarity === 'gray' && !e.flags.gachadnd.undeletable);
    await inv.giveCrystal(actor, { skillId: gray._id, skillName: gray.name });
    out.trade = (await apply([{ take_crystal: true }, { crystal: { rarity: 'up' } }])).join(' | ');
    out.crystals = actor.items.filter(i => i.flags.gachadnd?.is_crystal_item).map(i => i.flags.gachadnd.rarity).join();
    // Продать навык — навык ушёл, золото пришло
    const skillsBefore = actor.items.filter(i => i.flags.gachadnd?.skill_name && !i.flags.gachadnd.is_crystal_item && !i.flags.gachadnd.undeletable).length;
    const goldBefore = actor.system.currency.gp ?? 0;
    out.sell = (await apply([{ take_skill: { pay: 0.35 } }])).join(' | ');
    out.sold = skillsBefore - actor.items.filter(i => i.flags.gachadnd?.skill_name && !i.flags.gachadnd.is_crystal_item && !i.flags.gachadnd.undeletable).length;
    out.gold = (actor.system.currency.gp ?? 0) - goldBefore;
    // Перегрев снят
    await inv.addSkillToMemory(actor, gray.name, { forced: true });
    const sk = actor.items.find(i => i.flags.gachadnd?.skill_name && !i.flags.gachadnd.is_crystal_item && !i.flags.gachadnd.undeletable);
    await sk.update({ 'flags.gachadnd.heat': { borrowed: 1, extra: 2, locked: true } });
    await apply([{ cool: true }]);
    out.heat = JSON.stringify(actor.items.get(sk.id).flags.gachadnd.heat);
    // Навык сгорел
    const n = actor.items.filter(i => i.flags.gachadnd?.skill_name && !i.flags.gachadnd.is_crystal_item && !i.flags.gachadnd.undeletable).length;
    await apply([{ burn_skill: true }]);
    out.burned = n - actor.items.filter(i => i.flags.gachadnd?.skill_name && !i.flags.gachadnd.is_crystal_item && !i.flags.gachadnd.undeletable).length;
    // Предвестие: ближе и дальше
    await game.settings.set('gachadnd', 'devourerOmen', 'off');
    await apply([{ omen: 1, to: 'none' }]);
    out.omenUp = game.settings.get('gachadnd', 'devourerOmen');
    await apply([{ omen: -1, to: 'none' }]);
    out.omenDown = game.settings.get('gachadnd', 'devourerOmen');
    // Подсмотреть лоты Сделки — Сделка предложит их
    await game.settings.set('gachadnd', 'dealPreset', {});
    out.preview = (await apply([{ deal_preview: true, to: 'none' }])).join('');
    const deal = await gdt.mod('labyrinth/moon-deal.js');
    out.preset = (deal.presetDealLots() ?? []).length;
    // Метка луны
    await apply([{ moon_mark: true }]);
    out.mark = !!actor.getFlag('gachadnd', 'moonMark');
    await gdt.settle();
    return out;
}, { hero });
check('отдать кристалл — получить на редкость выше', /отдан/.test(fx.trade) && fx.crystals === 'green', JSON.stringify(fx));
check('продать навык: навык ушёл, золото по редкости', fx.sold === 1 && fx.gold > 0, `${fx.sell}`);
check('снять перегрев и сжечь навык', fx.heat === '{"borrowed":0,"extra":0,"locked":false}' && fx.burned === 1, `${fx.heat}, сгорело ${fx.burned}`);
check('предвестие: ближе — «3», дальше — «нет»', fx.omenUp === '3' && fx.omenDown === 'off', `${fx.omenUp} → ${fx.omenDown}`);
check('лоты Сделки подсмотрены и запомнены для неё', /луна предложит/.test(fx.preview) && fx.preset === 3, fx.preview);
check('метка луны на персонаже', fx.mark);

// ---------- Проверка характеристики: бросок Телосложения
await ev(async hero => {
    foundry.applications.instances.get('gachadnd-event')?.close();
    const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    map.nodes.find(n => n.id === '1-0').event = { id: 'diving_bell', status: 'roll', choice: 0, actorId: hero, success: null, text: null, lines: [] };
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
    await canvas.scene.setFlag('gachadnd', 'floorMap', map);
    await game.gachadnd.openEvent();
    await new Promise(r => setTimeout(r, 1200));
}, hero);
const rollLine = await ev(() => document.querySelector('#gachadnd-event .gd-ev-roll span')?.textContent ?? '');
await click('[data-action="roll"]');
await wait(2500);
await settle();
st = await state();
const conLabel = await ev(() => game.i18n.localize(CONFIG.DND5E.abilities.con.label));
check('проверка Телосложения: строка броска и исход', rollLine.includes(`${conLabel}, Сл`) && st.status === 'done', `${rollLine} | ${st.status} ${st.success}`);

// ---------- Событие без рисунка — заглушка; спасбросок в подписи варианта
await ev(async () => {
    foundry.applications.instances.get('gachadnd-event')?.close();
    await new Promise(r => setTimeout(r, 300));
    await game.gachadnd.previewEvent('moon_observatory');
    await new Promise(r => setTimeout(r, 800));
});
const blank = await ev(() => ({ blank: !!document.querySelector('#gachadnd-event .gd-ev-blank'), detail: document.querySelector('#gachadnd-event .gd-ev-detail')?.textContent ?? '' }));
check('без рисунка — заглушка; спасбросок в подписи варианта', blank.blank && /спасбросок: Мудрость, Сл/.test(blank.detail), JSON.stringify(blank));
await f.shot('events-blank');

// ---------- Все события колоды открываются в просмотре
const all = await ev(async () => {
    const E = await gdt.mod('labyrinth/events.js');
    const list = await E.loadEvents();
    const bad = [];
    for (const e of list) {
        foundry.applications.instances.get('gachadnd-event')?.close();
        await new Promise(r => setTimeout(r, 150));
        await game.gachadnd.previewEvent(e.id);
        await new Promise(r => setTimeout(r, 350));
        const el = document.getElementById('gachadnd-event');
        const n = el?.querySelectorAll('.gd-ev-option').length ?? 0;
        if (!el || el.querySelector('.gd-ev-title')?.textContent !== e.title || n !== e.options.length) bad.push(`${e.id}: ${n}`);
    }
    return { count: list.length, bad };
});
check(`все события колоды (${all.count}) открываются, варианты на месте`, all.count >= 19 && !all.bad.length, all.bad.join(', '));

await ev(async s => {
    foundry.applications.instances.get('gachadnd-event')?.close();
    for (const [k, v] of Object.entries(s)) await game.settings.set('gachadnd', k, v);
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
}, saved);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
