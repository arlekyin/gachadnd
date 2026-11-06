// Терминал Тумана в настоящей Foundry: node tools/foundry/dock.mjs [--headed]
// Сборка в общем Тумане: пластины (надетые, гнёзда, Память), метки действия и зарядов, синергии списком и что они дают;
// наведение — подробности и предпросмотр ступеней; щелчок — надеть; в бою — панель над хотбаром, правила Босса;
// переход Терминал ↔ паутина с общим Туманом.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, { hero: { level: 9 }, enemies: [{ name: 'Враг', x: 9, y: 5 }] });
const since = f.log.length;
// Связка «Реактивная тяга» (движение + взрыв) действует; кровь — 1 из 2 для «Кровавого бастиона»
const equippedIds = await skills(page, ids.hero, ['Перекат', 'Каска', 'Блинк', 'Обратный отсчёт', 'Держите меня семеро', 'Берсерк']);
const spare = await skills(page, ids.hero, ['Бензопила', 'Горячая картошка', 'Пули — это скучно'], { equip: false });

const info = () => ev(() => {
    const app = foundry.applications.instances.get('gachadnd-dock');
    const el = app?.element;
    const rect = el?.getBoundingClientRect();
    return {
        open: !!app?.rendered, mode: app?.mode, bar: el?.classList.contains('bar'),
        fog: !!document.getElementById('gd-fog-layer')?.classList.contains('on'),
        equipped: el?.querySelectorAll('.gd-plate.on[data-item-id]').length ?? 0,
        memory: el?.querySelectorAll('.gd-plate.off[data-item-id]').length ?? 0,
        sockets: el?.querySelectorAll('.gd-plate.socket').length ?? 0,
        tags: [...(el?.querySelectorAll('.gd-syn-row[data-tag]') ?? [])].map(r => r.dataset.tag),
        tiers: [...(el?.querySelectorAll('.gd-syn-row[data-tag] .gd-nx b') ?? [])].map(b => b.textContent).filter(Boolean),
        detail: el?.querySelector('.gd-t-detail h3')?.childNodes[0]?.textContent.trim() ?? null,
        barSkills: el?.querySelectorAll('.gd-bar .gd-act:not(.ab)').length ?? 0,
        left: Math.round(rect?.left ?? -1), bottom: Math.round(rect?.bottom ?? 0),
        hotbarTop: Math.round(document.getElementById('hotbar')?.getBoundingClientRect().top ?? 0),
        z: el ? getComputedStyle(el).zIndex : ''
    };
});

// ---------- Сборка
await ev(async hero => { await game.gachadnd.openTerminal(game.actors.get(hero)); await new Promise(r => setTimeout(r, 1500)); }, ids.hero);
let s = await info();
check('Сборка слева в общем Тумане: 6 пластин горят, 3 в Памяти, гнёзда свободных слотов, под окнами Foundry', s.open && s.mode === 'full' && s.fog && s.equipped === 6 && s.memory === 3 && s.sockets > 0 && s.left === 0 && s.z === '50', JSON.stringify(s));
check('синергии списком: теги надетых и названия действующих ступеней', ['движение', 'взрыв', 'щит', 'кровь'].every(t => s.tags.includes(t)) && s.tiers.length >= 2, JSON.stringify(s));
const marks = await ev(({ roll, helmet, saw }) => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    const plate = id => el.querySelector(`.gd-plate[data-item-id="${id}"]`);
    return { roll: plate(roll)?.querySelector('.gd-ak')?.className, helmet: !!plate(helmet)?.querySelector('.gd-ak'), saw: plate(saw)?.querySelectorAll('.gd-ch u').length };
}, { roll: equippedIds['Перекат'], helmet: equippedIds['Каска'], saw: spare['Бензопила'] });
check('метки на пластине: форма — чем используется (Перекат — реакция), у пассивной нет; ромбы — заряды', /gd-ak r/.test(marks.roll ?? '') && !marks.helmet && marks.saw >= 1, JSON.stringify(marks));

// ---------- Наведение: подробности в латунной панели и предпросмотр синергий
const hover = await ev(async id => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    el.querySelector(`.gd-plate[data-item-id="${id}"]`).dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise(r => setTimeout(r, 600));
    const blood = el.querySelector('.gd-syn-row[data-tag="кровь"]');
    return {
        head: el.querySelector('.gd-syn-head b')?.textContent, up: blood?.classList.contains('up'), add: !!blood?.querySelector('.gd-pp u.add'),
        detail: el.querySelector('.gd-t-detail h3')?.childNodes[0]?.textContent.trim(), button: el.querySelector('.gd-t-detail [data-action="toggleEquip"]')?.textContent.trim()
    };
}, spare['Бензопила']);
check('наведение на «Бензопилу»: она в панели подробностей, у крови загорается новый ромб', hover.detail === 'Бензопила' && /Надеть/.test(hover.button ?? '') && hover.up && hover.add && /если надеть «Бензопила»/.test(hover.head ?? ''), JSON.stringify(hover));
await f.shot('dock-1-hover');

// ---------- Способности синергий: своё поле, янтарь, откуда; наведение и щелчок — в панели, не применяют
const ab = await ev(async () => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    const row = [...el.querySelectorAll('.gd-ability')].find(r => /Реактивная тяга/.test(r.textContent));
    const actor = foundry.applications.instances.get('gachadnd-dock').actor, item = actor.items.get(row?.dataset.abilityId);
    const spent = item?.system?.uses?.spent ?? 0;
    row?.dispatchEvent(new PointerEvent('pointerenter'));
    row?.click();
    await new Promise(r => setTimeout(r, 600));
    const d = el.querySelector('.gd-t-detail.ability');
    return {
        rows: el.querySelectorAll('.gd-ability').length, source: row?.querySelector('small')?.textContent.trim(),
        detail: d?.querySelector('h3')?.childNodes[0]?.textContent.trim(), use: !!d?.querySelector('[data-action="useItem"]'),
        notSpent: (item?.system?.uses?.spent ?? 0) === spent
    };
});
check('способности синергий: своё поле, «Реактивная тяга — движение + взрыв», наведение и щелчок показывают её в панели и не применяют (она срабатывает сама — кнопки «Использовать» нет)', ab.rows >= 1 && /движение \+ взрыв/.test(ab.source ?? '') && ab.detail === 'Реактивная тяга' && !ab.use && ab.notSpent, JSON.stringify(ab));
await f.shot('dock-1b-ability');

// ---------- Что дают синергии: ступени без способности — строкой с описанием; наведение на синергию — её ступени
const tiers = await ev(async () => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    const rows = [...el.querySelectorAll('.gd-ability')];
    const calm = rows.filter(r => r.classList.contains('calm'));
    calm[0]?.click();
    await new Promise(r => setTimeout(r, 600));
    const d = el.querySelector('.gd-t-detail.ability');
    const syn = el.querySelector('.gd-syn-row[data-tag="движение"]');
    syn.dispatchEvent(new PointerEvent('pointerenter'));
    const lit = [...el.querySelectorAll('.gd-ability.rel')].map(r => r.querySelector('b').textContent);
    const focus = el.querySelector('.gd-t-abil').classList.contains('focus');
    syn.dispatchEvent(new PointerEvent('pointerleave'));
    // Ромбы Предела разума — по центру гнёзд: центр ромба на окружности r = 24
    const off = [...el.querySelectorAll('.gd-mind svg rect')].map(r => { const b = r.getBBox(), m = r.transform.baseVal.consolidate().matrix;
        const c = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(m); return Math.abs(Math.hypot(c.x - 32, c.y - 32) - 24); });
    return {
        calm: calm.map(r => r.querySelector('b').textContent), source: calm[0]?.querySelector('small')?.textContent.trim(),
        text: d?.querySelector('.gd-t-text')?.textContent.trim().slice(0, 40), sheet: !!d?.querySelector('[data-action="openSheet"]'),
        lit, focus, ringOff: Math.max(...off).toFixed(2)
    };
});
check('ступени без способности — строкой «Тег I: название · ступень I», щелчок — описание без кнопки «Лист»', tiers.calm.length >= 1 && /: /.test(tiers.calm[0]) && /ступень I/.test(tiers.source ?? '') && tiers.text?.length > 10 && !tiers.sheet, JSON.stringify(tiers));
check('наведение на синергию «движение» подсвечивает её ступени и связку', tiers.focus && tiers.lit.some(n => /Реактивная тяга/.test(n)) && tiers.lit.some(n => /^Движение/.test(n)), JSON.stringify(tiers));
check('ромбы Предела разума — по центру гнёзд на кольце', Number(tiers.ringOff) < 0.1, JSON.stringify(tiers));
await ev(async () => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    el.querySelector('.gd-syn-row[data-tag="движение"]').dispatchEvent(new PointerEvent('pointerenter'));
});
await f.shot('dock-1c-tiers');

// ---------- Щелчок по пластине — надеть
await ev(async id => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    el.querySelector(`.gd-plate[data-item-id="${id}"]`).click();
    await new Promise(r => setTimeout(r, 1500));
    await gdt.settle(300, 5000);
}, spare['Бензопила']);
s = await info();
check('щелчок по пластине надел «Бензопилу»: 7 горят', s.equipped === 7 && s.memory === 2, JSON.stringify(s));

// ---------- Бой: панель над хотбаром; правила Босса; конец боя — снова Сборка
await ev(async ({ hero, enemy, scene }) => {
    const sc = game.scenes.get(scene);
    const combat = await Combat.create({ scene, active: true });
    await combat.createEmbeddedDocuments('Combatant', [hero, enemy].map(id => ({ tokenId: sc.tokens.find(t => t.actorId === id).id, sceneId: scene, actorId: id })));
    await combat.startCombat();
    await new Promise(r => setTimeout(r, 1500));
}, { hero: ids.hero, enemy: ids.enemies[0], scene: ids.scene });
s = await info();
check('бой: панель над хотбаром, Туман ушёл, навыки кнопками', s.mode === 'bar' && s.bar && s.barSkills >= 4 && s.bottom <= s.hotbarTop && !s.fog, JSON.stringify(s));
const pop = await ev(async () => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    el.querySelector('.gd-bar .gd-act').dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise(r => setTimeout(r, 200));
    const p = el.querySelector('.gd-bar-pop');
    return { shown: !p.hidden, text: p.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) };
});
check('наведение на кнопку — карточка навыка над панелью', pop.shown && pop.text.length > 10, JSON.stringify(pop));
await f.shot('dock-2-bar');
// Правила Босса: Глушитель на крови, «Крайний спит» — Бензопила спит
const boss = await ev(async ({ hero, saw }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await game.combat.setFlag('gachadnd', 'bossRule', { id: 'muffle', ids: ['muffle', 'sleepy'], tag: 'кровь' });
    await game.actors.get(hero).items.get(saw).setFlag('gachadnd', 'asleep', { reason: 'Крайний спит', combatId: game.combat.id });
    await sleep(800);
    const app = foundry.applications.instances.get('gachadnd-dock');
    const bar = { rules: app.element.querySelector('.gd-bar-rules')?.textContent.replace(/\s+/g, ' ').trim(), asleep: !!app.element.querySelector(`.gd-act.asleep[data-item-id="${saw}"]`) };
    app.element.querySelector('.gd-bar-btns [data-action="mode"]').click();
    await sleep(1500);
    const el = app.element;
    return {
        bar, mode: app.mode, rules: el.querySelector('.gd-t-rules')?.textContent.replace(/\s+/g, ' ').trim(),
        muffled: !!el.querySelector('.gd-syn-row.muffled[data-tag="кровь"]'), plate: !!el.querySelector(`.gd-plate.asleep[data-item-id="${saw}"] .gd-moon`)
    };
}, { hero: ids.hero, saw: spare['Бензопила'] });
check('правила Босса: строка правил, заглушённая кровь перечёркнута, спящий навык — с месяцем (в панели боя и в Сборке)', /Глушитель · кровь/.test(boss.bar.rules ?? '') && boss.bar.asleep && boss.mode === 'full' && /Крайний спит/.test(boss.rules ?? '') && boss.muffled && boss.plate, JSON.stringify(boss));
await f.shot('dock-3-boss');
await ev(async ({ hero, saw }) => { await game.actors.get(hero).items.get(saw).unsetFlag('gachadnd', 'asleep'); await game.combat?.delete(); await new Promise(r => setTimeout(r, 1500)); }, { hero: ids.hero, saw: spare['Бензопила'] });
s = await info();
check('конец боя: снова Сборка в Тумане', s.mode === 'full' && !s.bar && s.equipped === 7 && s.fog, JSON.stringify(s));

// ---------- Листалка героев: стрелки и портреты; Терминал без выбранного токена — свой или первый персонаж
const roster = await ev(async hero => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const app = () => foundry.applications.instances.get('gachadnd-dock');
    const imgs = app().element.querySelectorAll('.gd-t-roster img').length;
    app().element.querySelector('.gd-t-roster [data-action="nextActor"]').click();
    for (let i = 0; i < 60 && app()?.actor?.id === hero; i++) await sleep(100);
    const moved = app()?.actor?.id !== hero, fog = !!document.getElementById('gd-fog-layer')?.classList.contains('on');
    app().element.querySelector(`.gd-t-roster img[data-actor-id="${hero}"]`)?.click();
    for (let i = 0; i < 60 && app()?.actor?.id !== hero; i++) await sleep(100);
    const back = app()?.actor?.id === hero;
    canvas.tokens.releaseAll();
    const { defaultTerminalActor } = await gdt.mod('dock/dock.js');
    return { imgs, moved, fog, back, fallback: !!defaultTerminalActor() };
}, ids.hero);
check('листалка героев: портреты и стрелки, «следующий» — другой герой без моргания Тумана, портрет — обратно; без выбранного токена Терминал всё равно есть чей', roster.imgs > 1 && roster.moved && roster.fog && roster.back && roster.fallback, JSON.stringify(roster));

// ---------- Переход: Терминал → карта этажа (паутина) → Терминал → Хранилище
// Кнопки — действие «goto»: «tab» в v14 перехватывает встроенный переключатель вкладок
const hop = await ev(async hero => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const on = id => !!foundry.applications.instances.get(id)?.rendered;
    const m = await gdt.mod('labyrinth/map.js');
    const form = document.createElement('div');
    form.innerHTML = '<input name="length" value="6"><input name="mode" value="web">';
    await m.drawFloorFrom(form);
    canvas.tokens.placeables.find(t => t.actor?.id === hero)?.control({ releaseOthers: true });
    const fog = () => !!document.getElementById('gd-fog-layer')?.classList.contains('on');
    let fogGone = false;
    document.querySelector('#gachadnd-dock [data-goto="map"]')?.click();
    for (let i = 0; i < 120 && !on('gachadnd-web-overlay'); i++) { if (!fog()) fogGone = true; await sleep(50); }
    const toMap = { web: on('gachadnd-web-overlay'), dock: on('gachadnd-dock'), fogGone };
    await sleep(500);
    document.querySelector('.gachadnd-web-overlay [data-action="terminal"]')?.click();
    for (let i = 0; i < 120 && !on('gachadnd-dock'); i++) await sleep(100);
    const back = { web: on('gachadnd-web-overlay'), dock: on('gachadnd-dock') };
    await sleep(500);
    document.querySelector('#gachadnd-dock [data-goto="stash"]')?.click();
    await sleep(1500);
    const stash = [...foundry.applications.instances.values()].some(a => /stash/i.test(a.id) && a.rendered);
    for (const a of foundry.applications.instances.values()) if (/stash/i.test(a.id)) await a.close();
    await foundry.applications.instances.get('gachadnd-dock')?.close();
    await sleep(1200);
    const closed = { dock: on('gachadnd-dock'), fog: fog() };
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
    return { toMap, back, stash, closed };
}, ids.hero);
check('переход: Терминал → паутина → Терминал → Хранилище; Туман между вкладками не пропадает, при закрытии уползает', hop.toMap.web && !hop.toMap.dock && !hop.toMap.fogGone && hop.back.dock && !hop.back.web && hop.stash && !hop.closed.dock && !hop.closed.fog, JSON.stringify(hop));

// ---------- Уборка
await ev(() => foundry.applications.instances.get('gachadnd-dock')?.close());
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
