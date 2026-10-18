// Панель модуля слева — Терминал Тумана в настоящей Foundry: node tools/foundry/dock.mjs [--headed]
// Полная панель: экипированное, созвездие (теги, ступени, связки 2+2), Память; наведение — карточка и
// предпросмотр; щелчок — подробно, двойной — надеть; в бою — полоса, после боя — снова панель.
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
await skills(page, ids.hero, ['Перекат', 'Каска', 'Блинк', 'Обратный отсчёт', 'Держите меня семеро', 'Берсерк']);
const spare = await skills(page, ids.hero, ['Бензопила', 'Горячая картошка', 'Пули — это скучно'], { equip: false });

const info = () => ev(() => {
    const app = foundry.applications.instances.get('gachadnd-dock');
    const el = app?.element;
    return {
        open: !!app?.rendered, mode: app?.mode, strip: el?.classList.contains('strip'),
        equipped: el?.querySelectorAll('.gd-dock-equip .gd-dcard[data-item-id]').length ?? 0,
        memory: el?.querySelectorAll('.gd-dock-grid .gd-dcard[data-item-id]').length ?? 0,
        stars: [...(el?.querySelectorAll('.gd-star') ?? [])].map(s => s.dataset.tag),
        ready: [...(el?.querySelectorAll('.gd-knot.ready') ?? [])].map(k => k.dataset.name),
        near: [...(el?.querySelectorAll('.gd-knot.near') ?? [])].map(k => k.dataset.name),
        fog: !!el?.querySelector('canvas.gd-dock-fog, .gd-dock-backdrop > canvas'),
        detail: !!el?.querySelector('.gd-dock-detail'),
        stripSkills: el?.querySelectorAll('.gd-strip-skill').length ?? 0,
        left: Math.round(el?.getBoundingClientRect().left ?? -1), width: Math.round(el?.getBoundingClientRect().width ?? 0),
        z: el ? getComputedStyle(el).zIndex : ''
    };
});

// ---------- Полная панель
await ev(async hero => { await game.gachadnd.openTerminal(game.actors.get(hero)); await new Promise(r => setTimeout(r, 1200)); }, ids.hero);
let s = await info();
check('панель открыта слева: туман, 6 надетых, 9 в Памяти, под окнами Foundry', s.open && s.mode === 'full' && s.fog && s.equipped === 6 && s.memory === 9 && s.left === 0 && s.z === '50', JSON.stringify(s));
check('созвездие: звёзды тегов, «Реактивная тяга» действует, «Кровавый бастион» — не хватает одного', ['движение', 'взрыв', 'щит', 'кровь'].every(t => s.stars.includes(t)) && s.ready.includes('Реактивная тяга') && s.near.includes('Кровавый бастион'), JSON.stringify(s));

// ---------- Наведение: карточка рядом и предпросмотр
const hover = await ev(async id => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    const card = el.querySelector(`.gd-dock-grid .gd-dcard[data-item-id="${id}"]`);
    card.dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise(r => setTimeout(r, 200));
    const pop = el.querySelector('.gd-dock-pop');
    return {
        pop: !pop.hidden, text: pop.textContent.replace(/\s+/g, ' ').trim().slice(0, 600),
        preview: [...el.querySelectorAll('.gd-star.preview')].map(s => s.dataset.tag),
        soon: [...el.querySelectorAll('.gd-knot.soon')].map(k => k.dataset.name)
    };
}, spare['Бензопила']);
check('наведение на «Бензопилу»: описание рядом, кровь подсвечена, «Кровавый бастион» начнёт действовать', hover.pop && /Бензопила/.test(hover.text) && hover.preview.includes('кровь') && hover.soon.includes('Кровавый бастион') && /Кровавый бастион/.test(hover.text), JSON.stringify(hover));
await f.shot('dock-1-hover');

// ---------- Щелчок — подробно; двойной — надеть
await ev(async id => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    el.querySelector('.gd-dock-pop').hidden = true;
    el.querySelector(`.gd-dock-grid .gd-dcard[data-item-id="${id}"]`).click();
    await new Promise(r => setTimeout(r, 600));
}, spare['Бензопила']);
s = await info();
check('щелчок — подробности справа', s.detail, JSON.stringify(s));
await f.shot('dock-2-detail');
await ev(async id => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    el.querySelector(`.gd-dock-grid .gd-dcard[data-item-id="${id}"]`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
    await gdt.settle(300, 5000);
}, spare['Бензопила']);
s = await info();
check('двойной щелчок надел «Бензопилу»: связка «Кровавый бастион» действует', s.equipped === 7 && s.ready.includes('Кровавый бастион'), JSON.stringify(s));

// ---------- Бой: полоса; конец боя — снова панель
await ev(async ({ hero, enemy, scene }) => {
    const sc = game.scenes.get(scene);
    const combat = await Combat.create({ scene, active: true });
    await combat.createEmbeddedDocuments('Combatant', [hero, enemy].map(id => ({ tokenId: sc.tokens.find(t => t.actorId === id).id, sceneId: scene, actorId: id })));
    await combat.startCombat();
    await new Promise(r => setTimeout(r, 1200));
}, { hero: ids.hero, enemy: ids.enemies[0], scene: ids.scene });
s = await info();
check('бой: панель свернулась в полосу рядом с инструментами Foundry, в ней 7 навыков', s.mode === 'strip' && s.strip && s.stripSkills === 7 && s.left > 0 && s.width < 100, JSON.stringify(s));
await ev(async () => {
    const el = foundry.applications.instances.get('gachadnd-dock').element;
    el.querySelector('.gd-strip-skill').dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise(r => setTimeout(r, 200));
});
await f.shot('dock-3-strip');
await ev(async () => { await game.combat?.delete(); await new Promise(r => setTimeout(r, 1200)); });
s = await info();
check('конец боя: панель развернулась сама', s.mode === 'full' && !s.strip && s.equipped === 7, JSON.stringify(s));

// ---------- Уборка
await ev(() => foundry.applications.instances.get('gachadnd-dock')?.close());
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
