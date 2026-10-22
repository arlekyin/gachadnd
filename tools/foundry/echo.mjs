// Эхо в настоящей Foundry: node tools/foundry/echo.mjs [--headed]
// Накопление (+1 за навык, лишние слоты в начале боя), голос по тегам, перегрузки больше нет; шёпот; Видения —
// кровь (виньетка, капли у раненых), разум (фантомы в бою), аномалия (следующий к20 выпадает тем, что в помехах);
// наплыв: «сыграть» — Вдохновение, эхо 4; «заглушить» с провалом — Видение на полную до отдыха; долгий отдых;
// шкала в Терминале Тумана.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, use, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, { hero: { level: 5 }, enemies: [{ name: 'Босс', x: 9, y: 5 }, { name: 'Прихвостень', x: 11, y: 7 }] });
const [bossId, minionId] = ids.enemies;
const since = f.log.length;
const echo = () => ev(hero => game.gachadnd.echo.state(game.actors.get(hero)), ids.hero);
const setEcho = patch => ev(async ({ hero, patch }) => { await game.gachadnd.echo.set(game.actors.get(hero), patch); await gdt.settle(); }, { hero: ids.hero, patch });
// Видение показывается у Мастера на выбранном токене персонажа без игрока-владельца
const control = () => ev(hero => { const t = canvas.tokens.placeables.find(x => x.actor?.id === hero); t.control({ releaseOthers: true }); }, ids.hero);
const vision = () => ev(() => game.gachadnd.echo.visionState?.());

// ---------- Накопление и голос
const sk = await skills(page, ids.hero, ['Кровавая цена']);
await ev(hero => game.actors.get(hero).unsetFlag('gachadnd', 'echo'), ids.hero);
await use(page, ids.hero, sk['Кровавая цена']);
await wait(400);
let e = await echo();
check('использовал навык крови: эхо +1, голос — кровь', e.value === 1 && e.tags['кровь'] === 1 && (await ev(h => game.gachadnd.echo.voice(game.actors.get(h)), ids.hero)) === 'кровь', JSON.stringify(e));

// Лишние слоты: перегрузки нет, в начале боя — эхо за слот
const over = await ev(async hero => {
    const actor = game.actors.get(hero);
    await actor.setFlag('gachadnd', 'extra_slots', -8);
    const syn = await gdt.mod('memory/synergy/synergy.js'); await syn.updateActorSynergies(actor); await gdt.settle();
    const m = await gdt.mod('memory/echo/echo.js');
    return { over: m.overloadOf(actor), overloadEffect: !!actor.effects.find(x => x.flags?.gachadnd?.is_system_effect), int: actor.system.abilities.int.value };
}, ids.hero);
const combatId = await combat(page, ids.scene, [ids.hero, bossId, minionId]);
await wait(600);
e = await echo();
check('слоты сверх лимита: эффекта перегрузки нет, в начале боя +эхо за каждый слот', over.over > 0 && !over.overloadEffect && e.value === 1 + over.over, JSON.stringify({ over, e }));

// ---------- Шёпот
await setEcho({ value: 5 });
const whisper = await ev(async hero => {
    const actor = game.actors.get(hero), before = game.messages.size;
    await game.gachadnd.echo.voiceLine(actor, 'crit', { force: true });
    const m = game.messages.contents.slice(before).find(x => x.flags?.gachadnd?.echo);
    return { text: m?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), whisper: m?.whisper.length ?? 0 };
}, ids.hero);
check('шёпот: строка голоса крови шёпотом', /Голос крови/.test(whisper.text ?? '') && whisper.whisper > 0, JSON.stringify(whisper));

// ---------- Видение крови
await ev(boss => game.actors.get(boss).update({ 'system.attributes.hp.value': Math.floor(game.actors.get(boss).system.attributes.hp.max / 3) }), bossId);
await setEcho({ value: 10 });
await control();
await wait(2600);
let v = await vision();
check('Видение крови: виньетка, капли у раненого Босса', v?.voice === 'кровь' && v.dom.some(d => /blood/.test(d)) && v.nodes > 0, JSON.stringify(v));
await f.shot('echo-blood');

// ---------- Видение разума: враг-фантом — настоящий токен только на этом экране
await setEcho({ tags: { 'разум': 20 }, value: 11 });
await wait(2000);
const ph = await ev(hero => ({
    list: game.gachadnd.echo.phantoms(),
    rows: [...ui.combat.element.querySelectorAll('[data-gd-phantom]')].map(r => ({ name: r.querySelector('.name')?.textContent, init: r.querySelector('.token-initiative input')?.value ?? r.querySelector('.token-initiative')?.textContent.trim() })),
    inPlaceables: canvas.tokens.placeables.filter(t => t.gdPhantom).length,
    inWorld: canvas.scene.tokens.size,
    flag: game.actors.get(hero).getFlag('gachadnd', 'echoPhantoms')?.list?.length,
    hp: game.gachadnd.echo.phantoms().map(p => canvas.tokens.get(p.id)?.actor?.system?.attributes?.hp?.value)
}), ids.hero);
check('Видение разума: 2 фантома — токены с полоской ПЗ (ПЗ полные), строки в трекере; в мире их нет', ph.list.length === 2 && ph.list.every(p => p.bars && p.visible) && ph.rows.length === 2 && ph.inPlaceables === 0 && ph.inWorld === 3 && ph.flag === 2 && ph.hp.every(v => v === 30), JSON.stringify(ph));
await f.shot('echo-mind');

// Мастер видит фантом миражом: голубой, полупрозрачный, в имени — чей; в трекере — пометка
const mirage = await ev(() => ({
    list: game.gachadnd.echo.phantoms().map(p => ({ mirage: p.mirage, tint: p.tint, alpha: p.alpha, plate: p.plate })),
    rows: [...ui.combat.element.querySelectorAll('[data-gd-phantom].gd-phantom-mirage .gd-phantom-tag')].map(r => r.textContent)
}));
check('у Мастера фантом — мираж: голубой, полупрозрачный, «мираж: герой» в имени и в трекере', mirage.list.every(p => p.mirage && String(p.tint) === '#9cc4ff' && p.alpha < 0.8 && /мираж: GD-тест: Герой/.test(p.plate)) && mirage.rows.length === 2, JSON.stringify(mirage));
// Мастер переносит и рассеивает
const gmControl = await ev(async ({ hero, id }) => {
    const p0 = game.gachadnd.echo.phantoms().find(p => p.id === id), x = Math.round(p0.x / 100) + 1, y = Math.round(p0.y / 100) + 3;
    await game.gachadnd.echo.phantomControl.move(id, x, y);
    await new Promise(r => setTimeout(r, 600));
    const moved = game.actors.get(hero).getFlag('gachadnd', 'echoPhantoms').list.find(e => e.id === id);
    const before = game.messages.size;
    await game.gachadnd.echo.phantomControl.vanish(id, { whisper: false });
    for (let i = 0; i < 20 && game.gachadnd.echo.phantoms().some(p => p.id === id); i++) await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 600));
    return { moved: moved.x === x * 100 && moved.y === y * 100, gone: game.actors.get(hero).getFlag('gachadnd', 'echoPhantoms').list.find(e => e.id === id).gone, left: game.gachadnd.echo.phantoms().length, whispers: game.messages.size - before };
}, { hero: ids.hero, id: ph.list[1].id });
check('Мастер переносит фантом (место во флаге) и рассеивает молча', gmControl.moved && gmControl.gone === true && gmControl.left === 1 && gmControl.whispers === 0, JSON.stringify(gmControl));

const target = await ev(id => { canvas.tokens.get(id).setTarget(true, { releaseOthers: true }); return [...game.user.targets].map(t => t.id); }, ph.list[0].id);
check('фантом выбирается целью, как настоящий', target.length === 1 && target[0] === ph.list[0].id, JSON.stringify(target));
await ev(() => canvas.tokens.setTargets([]));

// Ход фантома: очередь доходит — он подсвечен в трекере и идёт к герою (дошёл — рассеивается)
const walked = await ev(async () => {
    const start = Object.fromEntries(game.gachadnd.echo.phantoms().map(p => [p.id, { x: p.x, y: p.y }]));
    let sawTurn = false, sawRow = false;
    for (let i = 0; i < 4; i++) {
        await game.combat.nextTurn();
        for (let k = 0; k < 20; k++) {
            await new Promise(r => setTimeout(r, 200));
            if (game.gachadnd.echo.phantoms().some(p => p.turn)) sawTurn = true;
            if (ui.combat.element.querySelector('[data-gd-phantom].active')) sawRow = true;
        }
    }
    const now = game.gachadnd.echo.phantoms();
    const moved = Object.keys(start).filter(id => { const p = now.find(x => x.id === id); return !p || p.x !== start[id].x || p.y !== start[id].y; });
    return { sawTurn, sawRow, moved: moved.length, left: now.length };
});
check('ход фантома: подсвечен в трекере, сдвинулся к герою или рассеялся', walked.sawTurn && walked.sawRow && walked.moved >= 1, JSON.stringify(walked));

// Удар по фантому: действие потрачено, в карточке нет цели, фантом рассеивается, голос шепчет
await setEcho({ tags: { 'разум': 20 }, value: 11 });
await ev(async hero => {
    const a = game.actors.get(hero), st = a.getFlag('gachadnd', 'echoPhantoms');
    if (st) await a.unsetFlag('gachadnd', 'echoPhantoms');
}, ids.hero);
await wait(1500);
const strike = await ev(async hero => {
    const actor = game.actors.get(hero);
    let [sword] = actor.items.filter(i => i.name === 'Меч');
    sword ??= (await actor.createEmbeddedDocuments('Item', [{ name: 'Меч', type: 'weapon', system: { type: { value: 'martialM' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } }]))[0];
    const activity = sword.system.activities.find(x => x.type === 'attack');
    const [p] = game.gachadnd.echo.phantoms();
    if (!p || !activity) return { p: !!p, activity: !!activity };
    canvas.tokens.get(p.id).setTarget(true, { releaseOthers: true });
    const before = game.messages.size;
    const result = await activity.use({}, { configure: false }, {});
    await activity.rollAttack({}, { configure: false }, {});
    // На программном рендере фантом тает медленно
    for (let i = 0; i < 40 && !game.messages.contents.slice(before).some(m => m.flags?.gachadnd?.echo); i++) await new Promise(r => setTimeout(r, 250));
    const card = game.messages.contents.slice(before).find(m => m.type === 'usage');
    return {
        targetsOnCard: card?.system?.targets?.length ?? null,
        gone: !game.gachadnd.echo.phantoms().some(x => x.id === p.id),
        whisper: game.messages.contents.slice(before).some(m => m.flags?.gachadnd?.echo && /Голос разума/.test(m.content)),
        flagGone: actor.getFlag('gachadnd', 'echoPhantoms')?.list?.find(e => e.id === p.id)?.gone
    };
}, ids.hero);
check('удар по фантому: атака без цели, фантом рассеялся, шёпот голоса', strike.targetsOnCard === 0 && strike.gone && strike.whisper && strike.flagGone === true, JSON.stringify(strike));

// Один враг в бою — фантома нет
const lone = await ev(async ({ hero, minion }) => {
    const c = game.combat;
    await c.combatants.find(x => x.actorId === minion)?.delete();
    await game.actors.get(hero).unsetFlag('gachadnd', 'echoPhantoms');
    await new Promise(r => setTimeout(r, 1500));
    return game.gachadnd.echo.phantoms().length;
}, { hero: ids.hero, minion: minionId });
check('один враг в бою — фантома нет', lone === 0, String(lone));

// ---------- Видение аномалии: следующий к20 выпадает тем, что в помехах
await setEcho({ tags: { 'аномалия': 30 }, value: 11, foresee: null });
await wait(1200);
const anomaly = await ev(async hero => {
    const actor = game.actors.get(hero);
    const m = await gdt.mod('memory/echo/echo.js');
    const foresee = m.echoOf(actor).foresee;
    const [r] = await actor.rollSavingThrow({ ability: 'dex' }, { configure: false }, { create: false });
    await new Promise(res => setTimeout(res, 700));
    return { foresee, rolled: r?.dice?.[0]?.results?.[0]?.result, next: m.echoOf(actor).foresee };
}, ids.hero);
check('аномалия: к20 выпал ровно тем, что было в помехах, и загадано новое число', anomaly.foresee != null && anomaly.rolled === anomaly.foresee && anomaly.next != null, JSON.stringify(anomaly));
await wait(8500);
await f.shot('echo-anomaly');

// ---------- Наплыв: сыграть
await ev(id => game.combats.get(id)?.delete(), combatId);
await wait(400);
await setEcho({ tags: { 'кровь': 30 }, value: 11, story: {} });
const surge = await ev(async hero => {
    const actor = game.actors.get(hero), m = await gdt.mod('memory/echo/echo.js');
    await actor.update({ 'system.attributes.inspiration': false });
    const before = game.messages.size;
    await m.addEcho(actor, 1, ['кровь']);
    await new Promise(r => setTimeout(r, 900));
    const card = game.messages.contents.slice(before).find(x => x.flags?.gachadnd?.echo?.surgeAt);
    const el = document.querySelector(`[data-message-id="${card?.id}"]`);
    const buttons = [...(el?.querySelectorAll('[data-echo]') ?? [])].map(b => b.dataset.echo);
    el?.querySelector('[data-echo="play"]')?.click();
    await new Promise(r => setTimeout(r, 1200));
    return { buttons, memory: el?.querySelector('.gd-echo-memory')?.textContent.slice(0, 60), state: m.echoOf(actor), inspiration: actor.system.attributes.inspiration };
}, ids.hero);
check('наплыв: воспоминание и кнопки; «сыграть» — Вдохновение, эхо 4, воспоминание прочитано', surge.buttons.includes('play') && surge.buttons.includes('mute') && surge.inspiration === true && surge.state.value === 4 && surge.state.story['кровь'] === 1 && !surge.state.surge, JSON.stringify(surge));
await f.shot('echo-surge');

// Заглушить с провалом — Видение на полную до долгого отдыха; отдых снимает
const mute = await ev(async hero => {
    const actor = game.actors.get(hero), m = await gdt.mod('memory/echo/echo.js');
    await m.setEcho(actor, { value: 11 });
    const before = game.messages.size;
    await m.addEcho(actor, 1, ['кровь']);
    await new Promise(r => setTimeout(r, 900));
    const card = game.messages.contents.slice(before).find(x => x.flags?.gachadnd?.echo?.surgeAt);
    const el = document.querySelector(`[data-message-id="${card?.id}"]`);
    gdt.dice(20, 2);
    el?.querySelector('[data-echo="mute"]')?.click();
    await new Promise(r => setTimeout(r, 1500));
    const failed = m.echoOf(actor);
    await actor.longRest({ dialog: false, chat: false });
    await new Promise(r => setTimeout(r, 900));
    return { failed, rested: m.echoOf(actor) };
}, ids.hero);
check('«заглушить», провал: Видение на полную; долгий отдых: −3 эха, полная сила снята', mute.failed.full === true && mute.failed.value === 11 && mute.rested.full === false && mute.rested.value === 8, JSON.stringify(mute));

// ---------- Терминал: шкала эха и голос
const dock = await ev(async hero => {
    await game.gachadnd.openTerminal(game.actors.get(hero)); await new Promise(r => setTimeout(r, 1200));
    const el = foundry.applications.instances.get('gachadnd-dock')?.element?.querySelector('.gd-t-echo');
    return { text: el?.textContent.replace(/\s+/g, ' ').trim(), tip: el?.dataset.tooltip };
}, ids.hero);
check('Терминал: шкала эха и голос рядом с Пределом разума', /8 \/ 12/.test(dock.text ?? '') && /Голос крови/.test(dock.text ?? '') && /воспоминани/.test(dock.tip ?? ''), JSON.stringify(dock));
await f.shot('echo-dock');

// Мастер под шкалой: «Шепнуть» (своя строка голосом) и «Его экран» (Видение игрока у Мастера)
const gm = await ev(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const box = () => foundry.applications.instances.get('gachadnd-dock')?.element?.querySelector('.gd-t-echo');
    const buttons = [...box().querySelectorAll('.gd-echo-gm [data-action]')].map(b => b.dataset.action);
    canvas.tokens.releaseAll(); await sleep(500);
    const without = game.gachadnd.echo.visionState();
    box().querySelector('[data-action="echoPeek"]').click(); await sleep(1000);
    const peek = { banner: document.getElementById('gd-echo-peek')?.textContent.trim(), vision: game.gachadnd.echo.visionState()?.actor, button: box()?.querySelector('[data-action="echoPeek"]')?.textContent.trim() };
    const before = game.messages.size;
    box().querySelector('[data-action="echoWhisper"]').click(); await sleep(800);
    const area = document.querySelector('dialog textarea[name="line"]');
    if (area) { area.value = 'За дверью кто-то есть.'; area.closest('dialog').querySelector('button[data-action="own"]').click(); }
    await sleep(900);
    const line = game.messages.contents.slice(before).find(m => m.flags?.gachadnd?.echo);
    document.querySelector('#gd-echo-peek button')?.click(); await sleep(800);
    return { buttons, without, peek, whisper: line?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), whisperTo: line?.whisper.length, after: game.gachadnd.echo.visionState(), banner: !!document.getElementById('gd-echo-peek') };
});
check('Мастер: «Шепнуть» — своя строка голосом шёпотом; «Его экран» — Видение героя у Мастера и плашка, «Вернуть свой» снимает',
    gm.buttons.join() === 'echoWhisper,echoPeek' && !gm.without && gm.peek.vision === 'GD-тест: Герой' && /Экран: GD-тест: Герой/.test(gm.peek.banner ?? '') && /Свой экран/.test(gm.peek.button ?? '')
    && /Голос крови.*За дверью кто-то есть/.test(gm.whisper ?? '') && gm.whisperTo > 0 && !gm.after && !gm.banner, JSON.stringify(gm));
await ev(() => foundry.applications.instances.get('gachadnd-dock')?.close());

// Порядок: эхо и флаги героя — как до проверки
await ev(async hero => { const a = game.actors.get(hero); await a.unsetFlag('gachadnd', 'echo'); await a.unsetFlag('gachadnd', 'extra_slots'); }, ids.hero);

const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
