// Паутина — второй режим карты этажа в настоящей Foundry: node tools/foundry/web.mjs [--headed]
// Мастер чертит паутину кнопкой окна: зоны вокруг Босса, Заставы, тупики; вход с любого узла внешней зоны, шаг — сосед
// или знакомые тропы (до 3 пройденных подряд за тик); часы этажа; Запах в Охоте — Пожиратель выходит на край,
// идёт к отряду и съедает узлы; вход в съеденный узел — прорыв; победа — поедание стоит; ступени Босса в бою.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, PREFIX } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, { hero: { level: 5 }, enemies: [{ name: 'Босс', x: 9, y: 5 }] });
const [bossId] = ids.enemies;
const since = f.log.length;
const saved = await ev(() => Object.fromEntries(['runFloor', 'mapMode', 'floorSceneId', 'devourerOmen', 'effects'].map(k => [k, game.settings.get('gachadnd', k)])));
await ev(async ({ hero, boss }) => {
    Object.defineProperty(game.actors.get(hero), 'hasPlayerOwner', { get: () => true, configurable: true });
    await game.actors.get(boss).update({ 'system.details.cr': 5 });
    await game.settings.set('gachadnd', 'effects', 'off');
    await game.settings.set('gachadnd', 'runFloor', 1);
}, { hero: ids.hero, boss: bossId });
await skills(page, ids.hero, ['Пироман', 'Прикурить?', 'Сомелье']);

const map = () => ev(() => canvas.scene.getFlag('gachadnd', 'floorMap'));
const click = id => ev(async id => {
    gdt.mark();
    document.querySelector(`#gachadnd-web-overlay [data-node-id="${id}"]`).click();
    await new Promise(r => setTimeout(r, 400));
    await gdt.settle(300, 6000);
    for (const w of foundry.applications.instances.values()) if (!/gachadnd-(map-terminal|web-overlay)/.test(w.id) && /shop|risk|event|doom|portal|deal/i.test(w.id)) await w.close();
}, id);

// ---------- Мастер чертит паутину
await ev(async () => {
    await game.gachadnd.openMapTerminal();
    await new Promise(r => setTimeout(r, 600));
    const el = document.getElementById('gachadnd-map-terminal');
    el.querySelector('[name="mode"]').value = 'web';
    el.querySelector('[name="floor"]').value = '1';
    el.querySelector('[data-action="generate"]').click();
    await new Promise(r => setTimeout(r, 1200));
    await gdt.settle();
});
let m = await map();
const zone = z => m.nodes.filter(n => n.zone === z);
const shape = {
    mode: m?.mode, count: m?.nodes?.length,
    zones: Object.fromEntries(['outer', 'outpost', 'inner', 'boss'].map(z => [z, zone(z).length])),
    // Внешняя зона во внутреннюю — только через Заставы; к Боссу — только из внутренней
    gate: zone('outer').every(n => n.next.every(id => m.nodes.find(x => x.id === id).zone !== 'inner')),
    outposts: zone('outpost').every(n => n.next.some(id => id.startsWith('b')) && n.next.some(id => id.startsWith('c'))),
    bossLinks: m.nodes.find(n => n.id === 'boss').next.every(id => id.startsWith('a')),
    deadEnds: m.nodes.filter(n => n.next.length === 1).length,
    connected: await ev(async () => (await gdt.mod('labyrinth/web-graph.js')).connected(canvas.scene.getFlag('gachadnd', 'floorMap').nodes)),
    mode2: await ev(() => game.settings.get('gachadnd', 'mapMode'))
};
check('сеть: 30–40 узлов, всё связано, внутрь — только через Заставы, к Боссу — из внутренней зоны, есть тупики', shape.mode === 'web' && shape.count >= 30 && shape.count <= 40 && shape.connected && shape.gate && shape.outposts && shape.bossLinks && shape.deadEnds >= 2 && shape.mode2 === 'web', JSON.stringify(shape));
const drawn = await ev(() => {
    const el = document.getElementById('gachadnd-web-overlay');
    return {
        overlay: !!el, window: !!document.getElementById('gachadnd-map-terminal'),
        nodes: el?.querySelectorAll('.gd-map-node').length, lines: el?.querySelectorAll('.gd-map-edges path:not(.zone)').length,
        stages: el?.querySelectorAll('.gd-wo-stages i').length, clock: el?.querySelector('.gd-wo-clock')?.textContent.replace(/\s+/g, ' ').trim(),
        reachable: el?.querySelectorAll('.gd-map-node.reachable').length
    };
});
check('паутина — слой вместо окна: все узлы и пути, 4 ступени Босса, часы; вход — любой узел внешней зоны', drawn.overlay && !drawn.window && drawn.nodes === shape.count && drawn.lines > shape.count - 2 && drawn.stages === 4 && /Шаг 0/.test(drawn.clock) && drawn.reachable === shape.zones.outer, JSON.stringify(drawn));
await f.shot('web-1-drawn');

// ---------- Ход: вход, отказ, знакомые тропы. Узлы — из сети: X с двумя соседями во внешней зоне, Y — сосед X,
// Z — сосед Y (не X), W — другой сосед X: из Z в W — Y → X → W за один шаг
// Куда можно с узла до входа на карту: соседи (знакомых троп ещё нет)
const webMovesOf = id => m.nodes.find(n => n.id === id).next;
const plan = (() => {
    const by = id => m.nodes.find(n => n.id === id);
    const outer = id => by(id).zone === 'outer';
    for (const x of zone('outer')) {
        const ns = x.next.filter(outer);
        for (const y of ns) {
            const z = by(y).next.find(id => id !== x.id && outer(id));
            // W не сосед ни Y, ни Z: к нему из Z — только через Y и X (знакомые тропы)
            const w = ns.find(id => id !== y && id !== z && !by(id).next.includes(y) && !by(id).next.includes(z));
            const far = zone('outer').find(n => n.id !== x.id && !x.next.includes(n.id) && !webMovesOf(x.id).includes(n.id))?.id;
            if (z && w && far) return { x: x.id, y, z, w, far };
        }
    }
    return null;
})();
check('в сети нашлась ветка для проверки хода', !!plan, JSON.stringify(plan));
await click(plan.x);
m = await map();
check('вход с узла внешней зоны: отряд там, шаг 1', m.currentNodeId === plan.x && m.web.ticks === 1, JSON.stringify({ at: m.currentNodeId, t: m.web.ticks }));
const lit = await ev(() => ({ open: document.querySelectorAll('#gachadnd-web-overlay .gd-map-edges path.open').length, current: document.querySelectorAll('#gachadnd-web-overlay .gd-map-node.current').length }));
check('слой: отряд отмечен, пути этого шага — красным', lit.current === 1 && lit.open >= 1, JSON.stringify(lit));
await f.shot('web-3-step');
await click(plan.far);
await click('b0');
m = await map();
check('не сосед и внутренняя зона мимо Заставы — отказ', m.currentNodeId === plan.x && m.web.ticks === 1, JSON.stringify({ at: m.currentNodeId, t: m.web.ticks }));
await click(plan.y); await click(plan.z);
m = await map();
const before = m.web.ticks;
await click(plan.w);
m = await map();
check('знакомые тропы: Z → Y → X → W за один шаг', m.currentNodeId === plan.w && m.web.ticks === before + 1, JSON.stringify({ at: m.currentNodeId, t: m.web.ticks, before, plan }));
const chat = await ev(() => game.messages.contents.slice(gdt._mark).map(x => x.content).join(' '));
check('чат: «знакомыми тропами»', /знакомыми тропами/.test(chat), chat.slice(0, 200));
// Кадр для глаза: пройденные узлы зачёркнуты, на полях — запись Летописи
await ev(async ({ x }) => {
    const mp = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    mp.chronicle = [...(mp.chronicle ?? []), { kind: 'burn', text: 'Герой: «Пироман»', nodeId: x }];
    await canvas.scene.setFlag('gachadnd', 'floorMap', mp);
    await new Promise(r => setTimeout(r, 800));
}, { x: plan.x });
await f.shot('web-4-path');
const stepFresh = () => ev(async () => {
    const w = await gdt.mod('labyrinth/web-graph.js');
    const mp = canvas.scene.getFlag('gachadnd', 'floorMap');
    const moves = w.webMoves(mp);
    const id = Object.keys(moves).find(k => !mp.visitedNodes.includes(k) && !w.isEaten(mp, k)) ?? Object.keys(moves)[0];
    return id;
});

// ---------- Пожиратель: Запах в Охоте — выходит на край и идёт к отряду
await ev(async hero => {
    const inv = await gdt.mod('memory/inventory.js');
    for (let i = 0; i < 5; i++) await inv.giveCrystal(game.actors.get(hero), { skillName: 'Красная бочка' });
}, ids.hero);
const scent = await ev(async () => (await gdt.mod('labyrinth/anchor.js')).partyScent());
await click(await stepFresh());
m = await map();
const spawn = { at: m.web.devourer, eaten: m.web.eaten, scent: scent.value, state: scent.state };
check('Охота: Пожиратель вышел во внешнюю зону и съел узел', !!m.web.devourer && m.nodes.find(n => n.id === m.web.devourer).zone === 'outer' && m.web.eaten.includes(m.web.devourer), JSON.stringify(spawn));
const d0 = await ev(async () => { const w = await gdt.mod('labyrinth/web-map.js'); const mp = canvas.scene.getFlag('gachadnd', 'floorMap'); return w.distance(mp, mp.web.devourer, mp.currentNodeId); });
await click(await stepFresh());
m = await map();
const d1 = await ev(async () => { const w = await gdt.mod('labyrinth/web-map.js'); const mp = canvas.scene.getFlag('gachadnd', 'floorMap'); return mp.web.devourer ? w.distance(mp, mp.web.devourer, mp.currentNodeId) : 0; });
// Заставы не съедаются: шаг Пожирателя на Заставу съеденных не прибавляет
check('Пожиратель идёт к отряду (скорость 2 — Запах на 4 выше Охоты) и съедает узлы на пути', d1 <= d0 && m.web.eaten.length >= 1 && (m.web.eaten.length >= 2 || m.nodes.find(n => n.id === m.web.devourer)?.zone === 'outpost') && Array.isArray(m.web.touched), JSON.stringify({ d0, d1, eaten: m.web.eaten, touched: m.web.touched }));
await f.shot('web-2-devourer');

// ---------- Вход в съеденный узел — прорыв
const eatenNeighbour = m.web.eaten.find(id => m.nodes.find(n => n.id === m.currentNodeId).next.includes(id));
if (eatenNeighbour) {
    await click(eatenNeighbour);
    const msg = await ev(() => game.messages.contents.slice(gdt._mark).filter(x => /Прорыв/.test(x.content)).length);
    check('вход в съеденный узел — шёпот «Прорыв», предвестие 1', msg >= 1 && await ev(() => game.settings.get('gachadnd', 'devourerOmen')) === '1', eatenNeighbour);
} else {
    await ev(async () => {
        const mp = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
        const near = mp.nodes.find(n => n.id === mp.currentNodeId).next.find(id => !id.startsWith('p'));
        mp.web.eaten.push(near);
        await canvas.scene.setFlag('gachadnd', 'floorMap', mp);
    });
    m = await map();
    const near = m.web.eaten.at(-1);
    await click(near);
    const msg = await ev(() => game.messages.contents.slice(gdt._mark).filter(x => /Прорыв/.test(x.content)).length);
    check('вход в съеденный узел — шёпот «Прорыв», предвестие 1', msg >= 1 && await ev(() => game.settings.get('gachadnd', 'devourerOmen')) === '1', near);
}

// ---------- Победа: поедание стоит
await ev(async () => { Hooks.callAll('gachadnd.devourerDefeated'); await new Promise(r => setTimeout(r, 500)); await gdt.settle(); });
m = await map();
check('Пожиратель побеждён — ушёл с карты, 4 шага тишины', !m.web.devourer && m.web.pausedUntil === m.web.ticks + 4, JSON.stringify({ d: m.web.devourer, p: m.web.pausedUntil, t: m.web.ticks }));

// ---------- Биом и ступени Босса в бою
const inside = await ev(async () => {
    const b = await gdt.mod('labyrinth/biomes.js');
    const mp = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    mp.currentNodeId = mp.nodes.find(n => n.zone === 'outer').id;
    const outside = b.pastOutpost(mp);
    mp.currentNodeId = 'a0';
    return { outside, inside: b.pastOutpost(mp) };
});
check('биом: внутренняя зона — «после Заставы»', !inside.outside && inside.inside, JSON.stringify(inside));
const fight = async ticks => ev(async ({ hero, boss, scene, ticks }) => {
    const mp = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    mp.currentNodeId = 'boss';
    mp.web.ticks = ticks;
    await canvas.scene.setFlag('gachadnd', 'floorMap', mp);
    const sc = game.scenes.get(scene);
    const combat = await Combat.create({ scene, active: true });
    await combat.createEmbeddedDocuments('Combatant', [hero, boss].map((id, i) => ({ tokenId: sc.tokens.find(t => t.actorId === id).id, sceneId: scene, actorId: id, initiative: 20 - i })));
    await combat.startCombat();
    await new Promise(r => setTimeout(r, 800));
    await gdt.settle(400, 6000);
    const rule = combat.getFlag('gachadnd', 'bossRule');
    const hp = game.actors.get(boss).system.attributes.hp;
    const out = { ids: rule?.ids ?? [], max: hp.max, value: hp.value, calm: game.messages.contents.some(x => /Босс спокоен/.test(x.content)) };
    await combat.delete();
    await gdt.settle();
    out.after = game.actors.get(boss).system.attributes.hp.max;
    return out;
}, { hero: ids.hero, boss: bossId, scene: ids.scene, ticks });
let r = await fight(8);
check('Босс в тишине (шаг 8): ступеней нет, «Босс спокоен»', !r.ids.length && r.calm, JSON.stringify(r));
r = await fight(15);
check('шаг 15 — 2 ступени: Глушитель и Крайний спит', r.ids.join() === 'muffle,sleepy' && r.max === 30, JSON.stringify(r));
r = await fight(17);
check('шаг 17 — 3 ступени: ещё +25% ПЗ на бой, после боя — снова 30', r.ids.length === 2 && r.max === 38 && r.after === 30, JSON.stringify(r));

// ---------- Уборка
await ev(async s => {
    foundry.applications.instances.get('gachadnd-map-terminal')?.close();
    foundry.applications.instances.get('gachadnd-web-overlay')?.close();
    for (const [k, v] of Object.entries(s)) await game.settings.set('gachadnd', k, v);
}, saved);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
