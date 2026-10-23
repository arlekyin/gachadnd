// Встречи на боевых узлах в настоящей Foundry: node tools/foundry/encounters.mjs [--headed]
// Бюджет опыта dnd5e 2024 по узлу и уровням отряда; состав из одной стаи биома, все имена стай есть в SRD;
// вход на узел — шёпот Мастеру с составом и кнопками; «Другой состав» меняет стаю; «На эту сцену» ставит врагов
// и создаёт бой с отрядом; «На арену» строит арену с отрядом и врагами. В конце всё созданное убирается.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

// Состав с крупными существами (2×2): крокодилы и гигантские пауки — на них видно, налезают ли токены
const bigCrew = () => ev(async () => {
    const index = await game.packs.get('dnd5e.monsters').getIndex({ fields: ['system.details.cr'] });
    const get = n => index.find(e => (e.originalName ?? e.name) === n);
    return [['Crocodile', 3], ['Giant Spider', 2], ['Zombie', 2]].map(([n, count]) => { const e = get(n); return { key: n, name: e.name, id: e._id, cr: e.system.details.cr, xp: 100, count }; });
});
// Токены сцены: внутри карты и без наложений
const layoutOf = sceneId => ev(sceneId => {
    const sc = game.scenes.get(sceneId), g = sc.grid.size;
    const boxes = sc.tokens.map(t => ({ x: t.x, y: t.y, w: (t.width || 1) * g, h: (t.height || 1) * g, big: (t.width || 1) > 1 }));
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
    }
    const outside = boxes.filter(b => b.x < 0 || b.y < 0 || b.x + b.w > sc.width || b.y + b.h > sc.height).length;
    // Стена целиком за картой (кольца у кромки чуть выходят за край — это нормально)
    const walls = sc.walls.filter(w => w.c.every((v, i) => v < -g || v > (i % 2 ? sc.height : sc.width) + g)).length;
    return { tokens: boxes.length, big: boxes.filter(b => b.big).length, overlaps, outside, walls, padding: sc.padding };
}, sceneId);

await install(page);
const ids = await scene(page, { hero: { level: 1 }, enemies: [] });
const since = f.log.length;
// Отряд — четыре героя 1 уровня у игрока (герой сцены и ещё трое без токенов)
const party = await ev(async hero => {
    const player = game.users.getName('Claude_player');
    const owner = { [`ownership.${player.id}`]: 3 };
    await game.actors.get(hero).update(owner);
    const more = [];
    for (let i = 1; i <= 3; i++) {
        const a = await Actor.create({ name: `GD-тест: Спутник ${i}`, type: 'character', ownership: { default: 0, [player.id]: 3 } });
        await a.createEmbeddedDocuments('Item', [{ name: 'Воин', type: 'class', system: { identifier: 'fighter', levels: 1, hd: { denomination: 'd10' } } }]);
        more.push(a.id);
    }
    return [hero, ...more];
}, ids.hero);

// ---------- Бюджет и состав
const plan = await ev(async party => {
    const enc = game.gachadnd.encounters;
    const actors = party.map(id => game.actors.get(id));
    const out = { budget: Object.fromEntries(['mob', 'elite', 'outpost', 'boss'].map(t => [t, enc.budget(t, actors)])), runs: [] };
    for (const biome of ['swamp', 'town']) for (const type of ['mob', 'elite', 'outpost', 'boss']) for (let i = 0; i < 6; i++) {
        const e = await enc.build(type, { party: actors, biome });
        out.runs.push({ biome, type, group: e?.group, xp: e?.xp, budget: e?.budget, count: e?.creatures.reduce((s, m) => s + m.count, 0), kinds: e?.creatures.length, leader: e?.creatures[0]?.xp });
    }
    // Все имена стай нашлись в SRD
    const index = await game.packs.get('dnd5e.monsters').getIndex();
    const known = new Set(index.contents.map(e => e.originalName ?? e.name));
    const src = await (await fetch('/modules/gachadnd/scripts/labyrinth/encounters.js')).text();
    const block = src.slice(src.indexOf('const PACKS_BY_BIOME'), src.indexOf('PACKS_BY_BIOME.labyrinth'));
    out.missing = [...block.matchAll(/'([A-Z][^']+)'|"([A-Z][^"]+)"/g)].map(m => m[1] ?? m[2]).filter(n => !known.has(n));
    return out;
}, party);
check('бюджет на 4 героев 1 уровня: Монстры 300, Элита 400, Застава 800 (уровень 2), Босс 500', JSON.stringify(plan.budget) === JSON.stringify({ mob: 300, elite: 400, outpost: 800, boss: 500 }), JSON.stringify(plan.budget));
check('все монстры стай нашлись в SRD dnd5e', !plan.missing.length, plan.missing.join(', '));
const bad = plan.runs.filter(r => !r.group || r.xp > r.budget || r.xp < r.budget * 0.3 || r.count > 6 || r.kinds > 3);
check('48 составов (болото и город, 4 узла): в бюджете, не меньше трети, не больше 6 существ и 3 видов', !bad.length, JSON.stringify(bad.slice(0, 3)));

// ---------- Вход на узел — шёпот; «Другой состав»; «На эту сцену»
const offer = await ev(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const n = game.messages.size;
    const h = await gdt.mod('labyrinth/horsemen.js');
    await h.onNodeEntered('elite');
    for (let i = 0; i < 20 && !game.messages.contents.slice(n).some(m => m.getFlag('gachadnd', 'encounter')); i++) await sleep(200);
    const msg = game.messages.contents.slice(n).find(m => m.getFlag('gachadnd', 'encounter'));
    const first = msg?.getFlag('gachadnd', 'encounter');
    const html = document.querySelector(`[data-message-id="${msg?.id}"]`);
    const buttons = html ? [...html.querySelectorAll('[data-gd-enc]')].map(b => b.dataset.gdEnc) : [];
    await game.gachadnd.encounters.resolve(msg, 'reroll');
    await sleep(500);
    const second = game.messages.get(msg.id).getFlag('gachadnd', 'encounter');
    return { id: msg?.id, whisper: !!msg?.whisper?.length, buttons, first: first?.group, second: second?.group, leader: first?.creatures?.[0]?.name };
});
check('вход на Элиту — шёпот Мастеру с составом и кнопками «На арену», «На эту сцену», «Другой состав», «Сам»',
    offer.whisper && ['arena', 'here', 'reroll', 'skip'].every(b => offer.buttons.includes(b)), JSON.stringify(offer));
check('«Другой состав» — другая стая', offer.second && offer.second !== offer.first, JSON.stringify(offer));
await f.shot('encounters-1-offer');

const crew = await bigCrew();
const here = await ev(async ({ id, hero, crew }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const msg = game.messages.get(id);
    await msg.setFlag('gachadnd', 'encounter', { ...msg.getFlag('gachadnd', 'encounter'), creatures: crew });
    const enc = msg.getFlag('gachadnd', 'encounter');
    const before = canvas.scene.tokens.size;
    await game.gachadnd.encounters.resolve(msg, 'here');
    await sleep(800);
    const combat = game.combats.find(c => c.scene?.id === canvas.scene.id);
    return {
        want: enc.creatures.reduce((s, m) => s + m.count, 0), added: canvas.scene.tokens.size - before,
        combatants: combat?.combatants.size ?? 0, hero: !!combat?.combatants.find(c => c.actorId === hero), started: !!combat?.started,
        state: game.messages.get(id).getFlag('gachadnd', 'encounter').state, folder: !!game.folders.find(f => f.name === 'Лабиринт: монстры')
    };
}, { id: offer.id, hero: ids.hero, crew });
const hereLayout = await layoutOf(ids.scene);
check('«На эту сцену»: крупные существа (2×2) не налезают друг на друга и на героя', hereLayout.big === 5 && !hereLayout.overlaps, JSON.stringify(hereLayout));
check('«На эту сцену»: все враги на сцене, бой создан с ними и с героем, но не начат', here.added === here.want && here.combatants === here.want + 1 && here.hero && !here.started && here.state === 'placed' && here.folder, JSON.stringify(here));
await f.shot('encounters-2-here');

// ---------- «На арену»
const arena = await ev(async ({ party, crew }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const c of game.combats.contents) await c.delete();
    const msg = await game.gachadnd.encounters.offer('boss');
    await msg.setFlag('gachadnd', 'encounter', { ...msg.getFlag('gachadnd', 'encounter'), creatures: crew });
    const enc = msg.getFlag('gachadnd', 'encounter');
    await game.gachadnd.encounters.resolve(msg, 'arena');
    for (let i = 0; i < 60 && msg.getFlag('gachadnd', 'encounter').state !== 'placed'; i++) await sleep(500);
    const sc = game.scenes.find(s => s.getFlag('gachadnd', 'arena'));
    const combat = game.combats.find(c => c.scene?.id === sc?.id);
    return { scene: sc?.id, want: enc.creatures.reduce((s, m) => s + m.count, 0), tokens: sc?.tokens.size, partyIn: party.filter(id => sc?.tokens.some(t => t.actorId === id)).length, combatants: combat?.combatants.size ?? 0, active: game.scenes.active?.id === sc?.id };
}, { party, crew });
const arenaLayout = await layoutOf(arena.scene);
check('«На арену»: без полей у сцены; токены и стены внутри карты, крупные не налезают', arenaLayout.padding === 0 && !arenaLayout.outside && !arenaLayout.walls && !arenaLayout.overlaps && arenaLayout.big === 5, JSON.stringify(arenaLayout));
check('«На арену»: арена с отрядом слева и врагами справа, бой со всеми', arena.tokens === arena.want + arena.partyIn && arena.partyIn >= 1 && arena.combatants === arena.tokens && arena.active, JSON.stringify(arena));
await ev(async () => { canvas.tokens.releaseAll(); await canvas.animatePan({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2, scale: Math.min(innerWidth / canvas.dimensions.width, innerHeight / canvas.dimensions.height) * 0.95, duration: 0 }); canvas.walls.activate(); });
await page.waitForTimeout(1500);
await f.shot('encounters-3-arena');

// ---------- Уборка: бои, токены врагов, спутники, монстры
await ev(async ({ party, scene }) => {
    for (const c of game.combats.contents) await c.delete();
    const arena = game.scenes.find(s => s.getFlag('gachadnd', 'arena'));
    if (arena) await arena.deleteEmbeddedDocuments('Token', arena.tokens.map(t => t.id));
    await game.scenes.get(scene)?.activate();
    for (const id of party.slice(1)) await game.actors.get(id)?.delete();
    const player = game.users.getName('Claude_player');
    await game.actors.get(party[0])?.update({ [`ownership.${player.id}`]: 0 });
    const folder = game.folders.find(f => f.name === 'Лабиринт: монстры');
    if (folder) { await Actor.deleteDocuments(game.actors.filter(a => a.folder?.id === folder.id).map(a => a.id)); await folder.delete(); }
}, { party, scene: ids.scene });

const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
