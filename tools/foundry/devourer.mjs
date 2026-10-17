// Глубина и Насыщение Пожирателя в настоящей Foundry: node tools/foundry/devourer.mjs [--headed]
// Прорыв включает на листе ровно одну Глубину (этаж) и одно Насыщение (счёт модуля) и ставит ПЗ на максимум;
// 0 ПЗ и съеденная приманка — Насыщение +1; предел — этаж + 1; новый этаж — новая Глубина; кнопки в подвале
// карты; вес в подсказке кристалла; Запах и Настройки в правилах игрока.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, PREFIX } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
const ids = await scene(page, { hero: { level: 5 }, enemies: [] });
const since = f.log.length;
const saved = await ev(() => ({
    floor: game.settings.get('gachadnd', 'runFloor'), satiety: game.settings.get('gachadnd', 'devourerSatiety'),
    omen: game.settings.get('gachadnd', 'devourerOmen'), residents: game.settings.get('gachadnd', 'residentsState')
}));

// Свой Пожиратель из Бестиария; Пожиратели мира на время проверки без флага — их не трогаем
const hidden = await ev(async PREFIX => {
    const others = game.actors.filter(a => a.getFlag('gachadnd', 'creature') === 'devourer');
    for (const a of others) await a.unsetFlag('gachadnd', 'creature');
    const pack = game.packs.get('gachadnd.gacha-bestiary');
    const index = await pack.getIndex({ fields: ['flags.gachadnd.creature'] });
    const entry = index.find(e => e.flags?.gachadnd?.creature === 'devourer');
    const actor = await game.actors.importFromCompendium(pack, entry._id);
    await actor.update({ name: `${PREFIX}: Пожиратель` });
    await game.settings.set('gachadnd', 'devourerSatiety', 0);
    await game.settings.set('gachadnd', 'runFloor', 3);
    return others.map(a => a.id);
}, PREFIX);

const sheet = () => ev(() => {
    const a = game.actors.find(x => x.getFlag('gachadnd', 'creature') === 'devourer');
    const on = a.effects.filter(e => !e.disabled && /^(Глубина|Насыщение) /.test(e.name)).map(e => e.name).sort();
    const { hp } = a.system.attributes;
    return { on, hp: hp.value, max: hp.max, legres: a.system.resources.legres, satiety: game.settings.get('gachadnd', 'devourerSatiety') };
});
const settle = () => ev(async () => { await new Promise(r => setTimeout(r, 400)); await gdt.settle(); });

// ---------- Прорыв: Глубина 3, Насыщения нет, раны зажили
await ev(async () => {
    const a = game.actors.find(x => x.getFlag('gachadnd', 'creature') === 'devourer');
    await a.update({ 'system.attributes.hp.value': 7 });
    const token = await (await gdt.mod('labyrinth/breach.js')).startBreach({ point: { x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2 } });
    window.__gdBreach = token?.id;
});
await settle();
let s = await sheet();
check('прорыв: включена только «Глубина 3»', s.on.join() === 'Глубина 3', s.on.join());
check('прорыв: ПЗ на максимуме (192 на Глубине 3)', s.hp === s.max && s.max === 192, JSON.stringify(s));

// ---------- Насыщение кнопкой Мастера
await ev(() => game.gachadnd.satiety(1));
await settle();
s = await sheet();
check('Насыщение +1: «Насыщение 1» вместе с Глубиной, раны не тронуты', s.on.join() === 'Глубина 3,Насыщение 1' && s.satiety === 1 && s.hp === 192, JSON.stringify(s));
const whisper = await ev(() => {
    const m = game.messages.contents.at(-1);
    return { gm: m?.whisper?.length > 0, text: /Насыщение Пожирателя: <strong>1<\/strong>/.test(m?.content ?? '') };
});
check('смена Насыщения — шёпот Мастеру', whisper.gm && whisper.text, JSON.stringify(whisper));

// ---------- 0 ПЗ: Насыщение +1 сам; повторный 0 — не в счёт
await ev(async () => {
    const a = game.actors.find(x => x.getFlag('gachadnd', 'creature') === 'devourer');
    await a.update({ 'system.attributes.hp.value': 0 });
    await new Promise(r => setTimeout(r, 300));
    await a.update({ 'system.attributes.hp.value': 0 }, { diff: false });
});
await settle();
s = await sheet();
check('0 ПЗ: Насыщение 2 (повтор 0 не считается), легендарное сопротивление выросло', s.satiety === 2 && s.on.includes('Насыщение 2') && s.legres.max === 2, JSON.stringify(s));

// ---------- Предел этажа: 3 + 1
await ev(() => game.gachadnd.satiety(10));
await settle();
s = await sheet();
check('предел Насыщения на 3 этаже — 4', s.satiety === 4 && s.on.join() === 'Глубина 3,Насыщение 4', JSON.stringify(s));
await ev(() => game.gachadnd.satiety(-2));

// ---------- Новый этаж — новая Глубина
await ev(() => game.settings.set('gachadnd', 'runFloor', 4));
await settle();
s = await sheet();
check('этаж 4: «Глубина 4» вместо третьей', s.on.join() === 'Глубина 4,Насыщение 2', s.on.join());

// ---------- Приманка Приманщика
const bait = await ev(async () => {
    const state = foundry.utils.deepClone(game.settings.get('gachadnd', 'residentsState') ?? {});
    state.bait = { name: 'Тестовая приманка', rarity: 'blue' };
    await game.settings.set('gachadnd', 'residentsState', state);
    const ctx = { nodeType: 'mob', breach: true, gm: [], players: [], tasks: [] };
    Hooks.callAll('gachadnd.huntBreach', ctx);
    await Promise.all(ctx.tasks);
    return { gm: ctx.gm.join(''), bait: game.settings.get('gachadnd', 'residentsState').bait };
});
await settle();
s = await sheet();
check('приманка съедена: Насыщение 3, Мастеру — что модуль включит сам', s.satiety === 3 && !bait.bait && /модуль включит эффект сам/.test(bait.gm), JSON.stringify({ s, bait }));

// ---------- Подвал карты: счётчик и кнопки
const footer = await ev(async () => {
    await game.gachadnd.openMapTerminal();
    await new Promise(r => setTimeout(r, 600));
    const root = foundry.applications.instances.get('gachadnd-map-terminal')?.element ?? document.querySelector('.gachadnd-map');
    const box = root?.querySelector('.gd-map-satiety');
    if (!box) return { box: false, hasMap: !!root?.querySelector('.gd-map-board .gd-map-node') };
    const before = box.querySelector('b').textContent;
    box.querySelector('[data-delta="1"]').click();
    await new Promise(r => setTimeout(r, 900));
    const after = root.querySelector('.gd-map-satiety b')?.textContent;
    return { box: true, before, after, satiety: game.settings.get('gachadnd', 'devourerSatiety') };
});
if (footer.box) check('подвал карты: «Насыщение 3», «+» — 4', footer.before === '3' && footer.after === '4' && footer.satiety === 4, JSON.stringify(footer));
else check('подвал карты: счётчик есть (на карте нет этажа — пропуск)', !footer.hasMap, JSON.stringify(footer));

// ---------- Вес в подсказке кристалла
const peek = await ev(async () => {
    const pack = game.packs.get('gachadnd.gacha-skills');
    const index = await pack.getIndex({ fields: ['flags.gachadnd.rarity'] });
    const blue = index.find(e => e.flags?.gachadnd?.rarity === 'blue');
    const el = Object.assign(document.createElement('div'), { textContent: 'кристалл' });
    el.dataset.gdSkill = blue._id;
    Object.assign(el.style, { position: 'fixed', left: '40px', top: '40px', width: '60px', height: '30px', zIndex: 10000 });
    document.body.append(el);
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    const text = document.querySelector('.gd-crystal-peek .gd-peek-head small')?.textContent ?? '';
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.remove();
    return text;
});
check('подсказка кристалла: «Синий · вес 2»', /^Синий · вес 2/.test(peek), peek);

// ---------- Правила игрока
const rules = await ev(async () => {
    const pack = game.packs.get('gachadnd.gacha-rules');
    const [journal] = await pack.getDocuments();
    const page = name => journal.pages.find(p => p.name === name)?.text?.content ?? '';
    return {
        smell: /Запах/.test(page('Кристаллы и ранги')) && /вес/.test(page('Кристаллы и ранги')),
        settings: /Спрашивать/.test(page('Настройки')),
        tags: !/Спрашивать/.test(page('Теги и синергии')),
        heat: /Подробно/.test(page('Память и слоты'))
    };
});
check('правила: Запах у кристаллов, срабатывания — на странице «Настройки», перегрев фразой', Object.values(rules).every(Boolean), JSON.stringify(rules));

// ---------- Уборка
await ev(async ({ saved, hidden }) => {
    foundry.applications.instances.get('gachadnd-map-terminal')?.close();
    // Свой Пожиратель уходит до возврата настроек: иначе их смена переключила бы эффекты Пожирателя мира
    for (const t of canvas.scene.tokens.filter(t => t.actor?.getFlag('gachadnd', 'creature') === 'devourer')) await t.delete();
    for (const a of game.actors.filter(a => a.getFlag('gachadnd', 'creature') === 'devourer')) await a.delete();
    await game.settings.set('gachadnd', 'devourerSatiety', saved.satiety);
    await game.settings.set('gachadnd', 'runFloor', saved.floor);
    await game.settings.set('gachadnd', 'devourerOmen', saved.omen);
    await game.settings.set('gachadnd', 'residentsState', saved.residents);
    for (const id of hidden) await game.actors.get(id)?.setFlag('gachadnd', 'creature', 'devourer');
}, { saved, hidden });
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
