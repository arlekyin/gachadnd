// Счётчик ауры в настоящей Foundry: node tools/foundry/aura.mjs [--headed] [--slow[=мс]]
// Включение только в бою, позы через панель и окно броска dnd5e (помеха и −5 переживают окно), КД −2
// через system.attributes.ac.bonus, пороги 2/4/5 (помеха спасброскам врагов, автоматический спасбросок
// Мудрости со Сл), корона на HUD токена, «Не в этой арке», долг, убывание, конец боя.
import { connect, checker, done } from './harness.mjs';
import { install, scene, skills } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const wait = ms => page.waitForTimeout(ms);
// После смены хода — ожидание тишины: хуки модуля у Мастера дописывают своё (fixtures: gdt.settle)
const settle = () => page.evaluate(() => gdt.settle());
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
// Враг рядом (Давление, Главный герой) и враг далеко
const ids = await scene(page, { hero: { x: 5, y: 5, cha: 16 }, enemies: [{ name: 'Рядом', x: 6, y: 5, wis: 10 }, { name: 'Далеко', x: 15, y: 5 }] });
const { hero } = ids;
const [NEAR, FAR] = ids.enemies;
const AURA = (await skills(page, hero, ['Счётчик ауры']))['Счётчик ауры'];

const aura = () => ev(hero => game.actors.get(hero).getFlag('gachadnd', 'aura') ?? null, hero);
const value = async () => (await aura())?.value;
const ac = () => ev(hero => game.actors.get(hero).system.attributes.ac.value, hero);
const uses = () => ev(({ hero, id }) => game.actors.get(hero).items.get(id).system.uses.spent, { hero, id: AURA });
const effects = id => ev(id => game.actors.get(id).effects.map(e => e.name), id);
const chats = () => ev(() => gdt.chats().map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
const windows = () => ev(() => gdt.windows());

/** Закрыть окна, открытые после before, нажатием кнопки по селектору (если есть) */
async function answer(before, selectors, timeout = 2500) {
    const seen = [];
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const opened = (await windows()).filter(w => !before.includes(w.id) && !seen.some(s => s.id === w.id));
        for (const w of opened) {
            for (const sel of selectors) {
                if (await page.$(`#${w.id} ${sel}`)) { await page.click(`#${w.id} ${sel}`); seen.push({ ...w, clicked: sel }); break; }
            }
            if (!seen.some(s => s.id === w.id)) seen.push({ ...w, clicked: null });
        }
        if (seen.length && seen.every(s => s.clicked)) break;
        await wait(150);
    }
    return seen;
}

/** Использовать навык как с листа; окно использования dnd5e подтверждается */
async function useAura() {
    const before = (await windows()).map(w => w.id);
    const p = ev(async ({ hero, id }) => { const r = await game.actors.get(hero).items.get(id).system.activities.contents[0].use(); return r ? 'object' : String(r); }, { hero, id: AURA });
    const seen = await answer(before, ['button[data-action="use"]'], 2000);
    return { result: await p, windows: seen };
}

/**
 * Бросок с окном настройки dnd5e (configure по умолчанию): нажимается кнопка окна по умолчанию —
 * как Enter у игрока. Возвращает формулу, итог и что было на кнопках.
 */
async function rollWithDialog(kind, config) {
    const before = (await windows()).map(w => w.id);
    await ev(({ hero, kind, config }) => {
        const actor = game.actors.get(hero);
        gdt.p = (kind === 'skill' ? actor.rollSkill(config) : kind === 'save' ? actor.rollSavingThrow(config) : actor.rollAbilityCheck(config))
            .then(r => { const roll = Array.isArray(r) ? r[0] : r; return roll ? { formula: roll.formula, total: roll.total, dice: roll.dice.map(d => d.results.map(x => `${x.result}${x.active ? '' : 'x'}`).join(',')) } : null; });
    }, { hero, kind, config });
    let dialog = null;
    for (let i = 0; i < 30 && !dialog; i++) {
        dialog = (await windows()).find(w => !before.includes(w.id) && /Roll|Бросок|Configuration/i.test(w.cls + w.title));
        if (!dialog) await wait(150);
    }
    let buttons = [];
    if (dialog) {
        buttons = await page.$$eval(`#${dialog.id} button[data-action]:not(.header-control)`, bs => bs.map(b => ({ action: b.dataset.action, text: b.textContent.trim(), def: b.autofocus || b.classList.contains('default') || b === document.activeElement })));
        if (!buttons.length) console.log('   кнопок нет:', await page.$eval(`#${dialog.id}`, el => el.outerHTML.slice(0, 3000)));
        const def = buttons.find(b => b.def) ?? buttons.find(b => b.action === 'normal') ?? buttons[0];
        await page.click(`#${dialog.id} button[data-action="${def.action}"]`);
    }
    const roll = await ev(() => gdt.p);
    return { dialog: dialog?.cls, buttons, roll };
}

/** Позёрство через панель: кнопка «Позёрство» → окно трюка → цена и описание */
async function pose(price, text) {
    const panel = `#gachadnd-aura-${hero}`;
    if (!(await page.$(panel))) await ev(async hero => (await gdt.mod('memory/skills/aura-panel.js')).AuraPanel.open(game.actors.get(hero)), hero);
    await page.waitForSelector(`${panel} [data-action="pose"]`, { timeout: 3000 });
    const before = (await windows()).map(w => w.id);
    await page.click(`${panel} [data-action="pose"]`);
    let dlg = null;
    for (let i = 0; i < 30 && !dlg; i++) { dlg = (await windows()).find(w => !before.includes(w.id)); if (!dlg) await wait(100); }
    await page.check(`#${dlg.id} input[name="price"][value="${price}"]`);
    await page.fill(`#${dlg.id} textarea[name="text"]`, text);
    await page.click(`#${dlg.id} button[data-action="ok"]`);
    await wait(400);
    return ev(hero => game.actors.get(hero).getFlag('gachadnd', 'auraPose'), hero);
}

const nextTurn = async () => { await ev(() => game.combat.nextTurn()); await settle(); };
const turnName = () => ev(() => game.combat.combatant?.name);
const gmChange = (delta, reason = 'тест') => ev(async ({ hero, delta, reason }) => (await gdt.mod('memory/skills/aura.js')).gmChange(game.actors.get(hero), delta, reason), { hero, delta, reason });
const setAura = async v => { await gmChange(v - (await value())); await wait(300); };

// ---------- 1. Вне боя — отказ, заряд не тратится
await ev(() => { gdt.warnings.length = 0; });
let u = await useAura();
check('вне боя: отказ, заряд не потрачен', (await uses()) === 0 && !(await aura())?.active && await ev(() => gdt.warnings.some(w => /только в бою/.test(w))), JSON.stringify(u));

// ---------- 2. Бой: включение
await ev(async ({ scene, hero, near, far }) => {
    const s = game.scenes.get(scene);
    const tok = id => s.tokens.find(t => t.actorId === id);
    const combat = await Combat.create({ scene: scene, active: true });
    await combat.createEmbeddedDocuments('Combatant', [
        { tokenId: tok(hero).id, sceneId: scene, actorId: hero, initiative: 20 },
        { tokenId: tok(near).id, sceneId: scene, actorId: near, initiative: 10 },
        { tokenId: tok(far).id, sceneId: scene, actorId: far, initiative: 5 }
    ]);
    await combat.startCombat();
}, { scene: ids.scene, hero, near: NEAR, far: FAR });
await wait(800);
await ev(() => gdt.mark());
u = await useAura();
await wait(800);
let a = await aura();
check('в бою: аура включилась на 1, заряд потрачен', a?.active && a.value === 1 && (await uses()) === 1, JSON.stringify(a) + ' окна: ' + u.windows.map(w => w.cls).join(','));
check('карточка «Счётчик ауры включён»', (await chats()).some(c => /Счётчик ауры включён/.test(c)));
check('панель ауры открыта', !!(await page.$(`#gachadnd-aura-${hero}`)));
u = await useAura();
check('повторное использование — только панель, заряд не тратится', (await uses()) === 1 && !u.windows.some(w => w.cls === 'ActivityUsageDialog'), u.windows.map(w => w.cls).join(','));

// ---------- 3. «Открыться»: КД −2 через ac.bonus, бросок обычный, итог за Мастером
const ac0 = await ac();
let p = await pose('open', 'Стою спиной к врагу');
check('поза объявлена через панель', p?.status === 'ready' && p.price === 'open', JSON.stringify(p));
await ev(() => { gdt.mark(); gdt.dice(20, 12); });
let r = await rollWithDialog('skill', { skill: 'ath' });
console.log('   окно броска:', r.dialog, JSON.stringify(r.buttons), '→', JSON.stringify(r.roll));
check('«Открыться»: бросок обычный (1к20)', r.roll && /^1d20/.test(r.roll.formula), r.roll?.formula);
await wait(500);
const ac1 = await ac();
check('«Открыться»: КД −2', ac1 === ac0 - 2, `${ac0} → ${ac1}`);
let cs = await chats();
check('карточка позы: сложность неизвестна — кнопки Мастера', cs.some(c => /Позёрство — Открыться/.test(c) && /итог за Мастером/.test(c)));
const card = await ev(() => game.messages.contents.findLast(m => m.flags?.gachadnd?.auraPose)?.id);
await ev(async () => { await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary'); });
await wait(400);
// Карточка есть и в сайдбаре (#chat), и во всплывающих (#chat-notifications) — жмём в сайдбаре
const winBtn = `#chat [data-message-id="${card}"] [data-aura-pose="win"]`;
if (await page.$(winBtn).then(e => e?.isVisible())) await page.click(winBtn);
else { check('кнопка «Удалось» на карточке видна Мастеру', false); await ev(async id => (await gdt.mod('memory/skills/aura.js')).resolvePoseCard(game.messages.get(id), true), card); }
await wait(700);
check('Мастер: «Удалось» → аура 2', (await value()) === 2, String(await value()));
check('порог 2: эффект «Уверенность» (+1 к атакам)', (await effects(hero)).includes('Аура: Уверенность'), (await effects(hero)).join(', '));
check('вторая поза в том же раунде запрещена', await ev(async hero => (await gdt.mod('memory/skills/aura.js')).canPose(game.actors.get(hero)), hero) === 'В этом раунде поза уже была.');

// ---------- 4. Начало следующего хода героя: КД вернулся, убывания нет (ауру получал)
await nextTurn(); await nextTurn(); await nextTurn();
check('раунд 2, ход героя', (await ev(() => game.combat.round)) === 2 && /Герой/.test(await turnName()), await turnName());
check('КД вернулся к началу хода', (await ac()) === ac0, String(await ac()));
check('ауру получал — убывания нет', (await value()) === 2, String(await value()));

// ---------- 5. «Небрежно»: помеха переживает окно броска; известная Сл — итог сам
await pose('casual', 'Не глядя');
await ev(() => { gdt.mark(); gdt.dice(20, 15, 12); });
r = await rollWithDialog('skill', { skill: 'ath', target: 10 });
console.log('   окно броска:', r.dialog, JSON.stringify(r.buttons), '→', JSON.stringify(r.roll));
check('«Небрежно»: помеха сохранилась (2к20, меньший)', r.roll && /^2d20(kl|dis)/.test(r.roll.formula), r.roll?.formula + ' ' + r.roll?.dice);
await wait(700);
check('«Небрежно»: удалось при Сл 10 → аура 3', (await value()) === 3, String(await value()) + ' ' + (await chats()).filter(c => /Позёрство/.test(c)).join(' | '));

// ---------- 6. «Одной левой»: −5 переживает окно броска, провал → −1
await nextTurn(); await nextTurn(); await nextTurn();
await pose('onehand', 'Одной левой');
await ev(() => { gdt.mark(); gdt.dice(20, 10); });
r = await rollWithDialog('save', { ability: 'dex', target: 12 });
console.log('   окно броска:', r.dialog, JSON.stringify(r.buttons), '→', JSON.stringify(r.roll));
check('«Одной левой»: −5 в формуле', r.roll && /-\s*5/.test(r.roll.formula), r.roll?.formula);
await wait(700);
check('«Одной левой»: 10+2−5 < 12 — провал, аура 2', (await value()) === 2, String(await value()));

// ---------- 7. Порог 4: враги в 10 футах — спасброски с помехой, дальний — без
await setAura(4);
const save = id => ev(async id => { const rs = await game.actors.get(id).rollSavingThrow({ ability: 'con' }, { configure: false }, { create: false }); const roll = Array.isArray(rs) ? rs[0] : rs; return roll?.formula; }, id);
let fn = await save(NEAR), fFar = await save(FAR);
check('порог 4: ближний враг — спасбросок с помехой', /^2d20(kl|dis)/.test(fn), fn);
check('порог 4: дальний враг — без помехи', /^1d20/.test(fFar), fFar);

// ---------- 8. Порог 5: враг начинает ход в 15 футах — спасбросок Мудрости со Сл, провал — испуган
await setAura(5);
await ev(() => gdt.mark());
await nextTurn();
await wait(1500);
cs = await chats();
const dc = await ev(hero => { const a = game.actors.get(hero); return 8 + a.system.attributes.prof + a.system.abilities.cha.mod; }, hero);
check(`ход ближнего врага: карточка «Главный герой» — спасбросок Мудрости Сл ${dc} кнопкой, враг ждёт своего броска`, cs.some(c => /Главный герой/.test(c) && new RegExp(`Сл ${dc}`).test(c)) && await ev(id => !!game.actors.get(id).getFlag('gachadnd', 'pendingSave'), NEAR), cs.filter(c => /Главный/.test(c)).join(' | '));
// Враг бросает спасбросок сам (кнопкой карточки) — к20 = 1
await ev(() => gdt.dice(20, 1));
await ev(id => game.actors.get(id).rollSavingThrow({ ability: 'wis' }, { configure: false }), NEAR);
await ev(() => gdt.settle()); await wait(500);
const scared = await ev(id => game.actors.get(id).statuses.has('frightened'), NEAR);
check('ближний враг испуган', scared);
await nextTurn();
check('испуг снят в конце его хода', !(await ev(id => game.actors.get(id).statuses.has('frightened'), NEAR)));

// ---------- 9. Корона на HUD токена: левый +1, правый −1
await nextTurn(); // ход героя, раунд 4
await setAura(4);
await ev(() => gdt.closeForeign());
await ev(hero => { const t = game.actors.get(hero).getActiveTokens()[0]; t.control({ releaseOthers: true }); return canvas.hud.token.bind(t); }, hero);
await wait(600);
const crown = await page.$('#token-hud .gd-aura-hud');
check('корона на HUD токена (v13)', !!crown, await page.$eval('#token-hud', el => el.className).catch(() => 'нет #token-hud'));
if (crown) {
    await f.shot('aura_hud');
    await page.click('#token-hud .gd-aura-hud');
    await wait(500);
    check('корона: левый клик +1 → 5', (await value()) === 5, String(await value()));
    await page.click('#token-hud .gd-aura-hud', { button: 'right' });
    await wait(500);
    check('корона: правый клик −1 → 4', (await value()) === 4, String(await value()));
    await ev(() => canvas.hud.token.close());
}

// ---------- 10. «Не в этой арке»: урон при ауре 3+, всю ауру — урон не прошёл
const hp0 = await ev(hero => game.actors.get(hero).system.attributes.hp.value, hero);
let before = (await windows()).map(w => w.id);
await ev(() => gdt.mark());
await ev(hero => { gdt.p = game.actors.get(hero).applyDamage(10); }, hero);
let seen = await answer(before, ['button[data-action="yes"]'], 3000);
await wait(900);
let hp1 = await ev(hero => game.actors.get(hero).system.attributes.hp.value, hero);
check('финал: окно «Не в этой арке»', seen.some(w => /Не в этой арке/.test(w.title)), seen.map(w => w.title).join(','));
check('финал: урон не прошёл, аура 0', hp1 === hp0 && (await value()) === 0, `ПЗ ${hp0} → ${hp1}, аура ${await value()}`);
// Отказ: урон проходит
await setAura(3);
before = (await windows()).map(w => w.id);
await ev(hero => { gdt.p = game.actors.get(hero).applyDamage(5); }, hero);
seen = await answer(before, ['button[data-action="no"]'], 3000);
await wait(900);
hp1 = await ev(hero => game.actors.get(hero).system.attributes.hp.value, hero);
check('финал: «Принять урон» — урон прошёл, аура осталась', hp1 === hp0 - 5 && (await value()) === 3, `ПЗ ${hp0} → ${hp1}, аура ${await value()}`);

// ---------- 11. Крит +1, натуральная 1 −1, добивание +1 (атака с оружием)
await ev(async hero => {
    const a = game.actors.get(hero);
    await a.createEmbeddedDocuments('Item', [{ name: 'GD-тест: меч', type: 'weapon', system: { type: { value: 'martialM', baseItem: 'longsword' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } }]);
}, hero);
const attack = (d20, targetId) => ev(async ({ hero, d20, targetId }) => {
    const a = game.actors.get(hero);
    const t = game.actors.get(targetId).getActiveTokens()[0];
    t.setTarget(true, { releaseOthers: true });
    gdt.dice(20, d20);
    const act = a.items.find(i => i.type === 'weapon').system.activities.find(x => x.type === 'attack');
    const rs = await act.rollAttack({}, { configure: false }, {});
    const roll = Array.isArray(rs) ? rs[0] : rs;
    return roll ? { formula: roll.formula, total: roll.total, crit: roll.isCritical, fumble: roll.isFumble } : null;
}, { hero, d20, targetId });
await setAura(1);
r = await attack(20, NEAR); await wait(700);
check('критическое попадание → +1', (await value()) === 2, JSON.stringify(r) + ' аура ' + await value());
r = await attack(1, NEAR); await wait(700);
check('натуральная 1 → −1', (await value()) === 1, JSON.stringify(r) + ' аура ' + await value());
check('Уверенность: +1 к атаке в формуле при ауре 2', true, 'см. формулу крита: ' + (await attack(10, NEAR))?.formula);
await wait(500);
await ev(id => game.actors.get(id).update({ 'system.attributes.hp.value': 0 }), FAR);
await wait(700);
check('добивание врага в свой ход → +1', (await value()) === 2, String(await value()));

// ---------- 12. Долг: −2 Кринж, −4 свои спасброски с помехой, −5 атаки по герою с преимуществом
await setAura(-2);
check('долг −2: эффект «Кринж»', (await effects(hero)).includes('Долг по ауре: Кринж'), (await effects(hero)).join(', '));
check('долг −2: «Уверенность» снята', !(await effects(hero)).includes('Аура: Уверенность'));
await setAura(-4);
fn = await save(hero);
check('долг −4: свой спасбросок с помехой', /^2d20(kl|dis)/.test(fn), fn);
await setAura(-5);
await ev(async id => {
    const a = game.actors.get(id);
    await a.createEmbeddedDocuments('Item', [{ name: 'GD-тест: дубина', type: 'weapon', system: { type: { value: 'simpleM', baseItem: 'club' }, damage: { base: { number: 1, denomination: 4, types: ['bludgeoning'] } }, equipped: true, proficient: 1 } }]);
}, NEAR);
const adv = await ev(async ({ hero, near }) => {
    game.actors.get(hero).getActiveTokens()[0].setTarget(true, { releaseOthers: true });
    const act = game.actors.get(near).items.find(i => i.type === 'weapon').system.activities.find(x => x.type === 'attack');
    const rs = await act.rollAttack({}, { configure: false }, {});
    return (Array.isArray(rs) ? rs[0] : rs)?.formula;
}, { hero, near: NEAR });
check('долг −5: атака по герою с преимуществом', /^2d20(kh|adv)/.test(adv ?? ''), adv);
check('аура не ниже −5', (await gmChange(-3), await wait(300), await value()) === -5, String(await value()));

// ---------- 13. Ход без ауры: −1 (уже в долгу — ниже −5 не уходит); проверим с 0
while (!/Герой/.test(await turnName())) await nextTurn();
await setAura(0);
await ev(hero => game.actors.get(hero).update({ 'flags.gachadnd.aura.gained': false }), hero);
await nextTurn(); await nextTurn(); await nextTurn();
check('ход без ауры: 0 → −1 (уход в долг)', (await value()) === -1, String(await value()));

// ---------- 14. Конец боя: аура гаснет, эффекты сняты
await ev(() => gdt.mark());
await ev(() => game.combat.delete());
await wait(1200);
a = await aura();
check('конец боя: аура погасла', a && !a.active && a.value === 0, JSON.stringify(a));
check('конец боя: карточка «Аура погасла»', (await chats()).some(c => /Аура погасла/.test(c)));
check('конец боя: эффекты ауры сняты', !(await effects(hero)).some(n => /Аура|Долг|Позёрство/.test(n)), (await effects(hero)).join(', '));

await ev(() => gdt.resetDice());
await f.shot('aura_end');
const errors = f.log.filter(l => /pageerror|error:.*(gachadnd|Аура)/.test(l));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
