// Дары луны в бою в настоящей Foundry: node tools/foundry/boons.mjs [--headed]
// Отметки Сделки на текущем этаже, бой: шёпот Мастеру с кнопками; Эхо Босса встаёт рядом с позвавшим, ходит
// сразу после него, своё (раны не переходят на Босса), рассыпается после своего хода; Пожиратель — прорыв на
// стороне отряда, два хода и уходит, из следующей добычи уносит один кристалл; конец боя убирает Эхо.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, combat, PREFIX } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, { hero: { level: 5 }, enemies: [{ name: 'Босс', x: 9, y: 5 }, { name: 'Прихвостень', x: 9, y: 7 }] });
const [bossId, minionId] = ids.enemies;
const since = f.log.length;
const saved = await ev(() => ({ floor: game.settings.get('gachadnd', 'runFloor'), boons: game.settings.get('gachadnd', 'moonBoons'), tithe: game.settings.get('gachadnd', 'moonTithe'), omen: game.settings.get('gachadnd', 'devourerOmen') }));

await ev(async ({ bossId, PREFIX }) => {
    await game.actors.get(bossId).update({ 'system.details.cr': 5 });
    // Свой Пожиратель на время проверки (в мире может не быть актёра) — удаляется вместе с прочими GD-тест
    if (!game.actors.some(a => a.getFlag('gachadnd', 'creature') === 'devourer')) await Actor.create({
        name: `${PREFIX}: Пожиратель`, type: 'npc', flags: { gachadnd: { creature: 'devourer' } },
        system: { attributes: { hp: { value: 90, max: 90 } }, details: { cr: 8 } }, prototypeToken: { actorLink: true, disposition: -1, width: 2, height: 2 }
    });
    await game.settings.set('gachadnd', 'runFloor', 2);
}, { bossId, PREFIX });

// ---------- Сделка запоминает Босса
const boss = await ev(async () => (await gdt.mod('labyrinth/moon-boons.js')).findBoss());
check('Сделка: Босс боя — самый опасный враг на сцене', boss?.id === bossId, JSON.stringify(boss));
const none = await ev(() => game.gachadnd.callEcho({ callerId: 'x', bossId: 'y' }));
check('без дара Эхо не зовётся', none === null);

await ev(b => game.settings.set('gachadnd', 'moonBoons', [
    { type: 'echo', floor: 1, used: false }, { type: 'echo', floor: 2, used: false, boss: b }, { type: 'devour', floor: 2, used: false }
]), boss);

// ---------- Бой: шёпот Мастеру
const combatId = await combat(page, ids.scene, [ids.hero, bossId, minionId]);
await ev(() => gdt.settle());
await wait(600);
const whisper = await ev(() => {
    const m = game.messages.contents.find(m => m.content.includes('Дары луны'));
    const el = document.querySelector(`[data-message-id="${m?.id}"]`);
    return m && { whisper: m.whisper.length > 0, buttons: [...(el?.querySelectorAll('[data-gd-boon]') ?? [])].map(b => `${b.dataset.gdBoon}${b.disabled ? ':off' : ''}`) };
});
check('начало боя: шёпот Мастеру с двумя кнопками', whisper?.whisper && whisper.buttons.join() === 'echo,devour', JSON.stringify(whisper));

// ---------- Эхо Босса
const echo = await ev(async ({ hero, bossId }) => {
    const c = game.combat;
    const caller = c.combatants.find(x => x.actorId === hero);
    const token = await game.gachadnd.callEcho({ callerId: caller.id, bossId });
    await gdt.settle();
    const order = c.turns.map(t => t.name);
    const callerToken = caller.token;
    return {
        name: token?.name, friendly: token?.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY, linked: token?.actorLink,
        near: token && Math.max(Math.abs(token.x - callerToken.x), Math.abs(token.y - callerToken.y)) <= canvas.grid.size,
        order, after: order.indexOf(token?.name) === order.indexOf(caller.name) + 1,
        used: game.settings.get('gachadnd', 'moonBoons').map(b => b.used).join()
    };
}, { hero: ids.hero, bossId });
check('Эхо: копия Босса рядом с позвавшим, на стороне отряда', /^Эхо: GD-тест: Босс$/.test(echo.name) && echo.friendly && echo.near, JSON.stringify(echo));
check('Эхо: ходит сразу после позвавшего', echo.after, echo.order.join(' → '));
check('Эхо: дар этого этажа потрачен, прошлого — нет', echo.used === 'false,true,false', echo.used);
const own = await ev(async bossId => {
    const token = canvas.scene.tokens.find(t => t.flags.gachadnd?.echo);
    await token.actor.update({ 'system.attributes.hp.value': 5 });
    return { echo: token.actor.system.attributes.hp.value, boss: game.actors.get(bossId).system.attributes.hp.value };
}, bossId);
check('Эхо своё: раны Эха не у Босса', !echo.linked && own.echo === 5 && own.boss === 30, JSON.stringify(own));
const off = await ev(() => [...document.querySelectorAll('[data-gd-boon="echo"]')].every(b => b.disabled));
check('кнопка Эха в шёпоте погасла', off);

const turn = () => ev(async () => { await game.combat.nextTurn(); await new Promise(r => setTimeout(r, 1500)); await gdt.settle(); return { name: game.combat.combatant?.name, echo: canvas.scene.tokens.filter(t => t.flags.gachadnd?.echo).length }; });
let t = await turn();
check('ход Эха: оно ещё на месте', /^Эхо/.test(t.name) && t.echo === 1, JSON.stringify(t));
t = await turn();
const dust = await ev(() => ({ chat: game.messages.contents.some(m => m.content.includes('рассыпается')), fighter: game.combat.combatants.some(c => /^Эхо/.test(c.name)) }));
check('ход Эха закончился — рассыпалось, из боя убрано', t.echo === 0 && !dust.fighter && dust.chat, JSON.stringify({ ...t, ...dust }));

// ---------- Натравить Пожирателя
const dev = await ev(async () => {
    const token = await game.gachadnd.callDevourer({ point: { x: 1400, y: 1000 } });
    await gdt.settle();
    await new Promise(r => setTimeout(r, 1500));
    const combatant = game.combat.combatants.find(c => c.tokenId === token?.id);
    return {
        friendly: token?.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY, linked: token?.actorLink, alpha: token?._source.alpha, shown: token?.object?.alpha,
        initiative: combatant?.initiative, tithe: game.settings.get('gachadnd', 'moonTithe'), omen: game.settings.get('gachadnd', 'devourerOmen')
    };
});
check('Пожиратель: прорыв на стороне отряда, свой токен, виден', dev.friendly && !dev.linked && dev.alpha > 0.5 && dev.shown > 0.5, JSON.stringify(dev));
check('Пожиратель: в бою с инициативой', Number.isFinite(dev.initiative), String(dev.initiative));
check('Пожиратель: предвестие охоты не включено', dev.omen !== 'here', String(dev.omen));
check('Пожиратель: плата из добычи отмечена', dev.tithe?.floor === 2, JSON.stringify(dev.tithe));
const devTurns = [];
for (let i = 0; i < 10; i++) {
    const r = await ev(async () => {
        await game.combat.nextTurn(); await new Promise(r => setTimeout(r, 1500)); await gdt.settle();
        const token = canvas.scene.tokens.find(t => t.flags.gachadnd?.moonDevourer);
        return { now: game.combat.combatant?.name ?? '', here: !!token, turns: token?.flags.gachadnd.moonDevourer.turns ?? null };
    });
    devTurns.push(r);
    if (!r.here) break;
}
const gone = devTurns.findIndex(r => !r.here);
const hisTurns = devTurns.slice(0, gone).filter(r => /Пожиратель/.test(r.now)).length;
check('Пожиратель: два своих хода — и ушёл', gone > 0 && hisTurns === 2, devTurns.map(r => `${r.now}:${r.here ? r.turns : 'ушёл'}`).join(' | '));

// ---------- Плата: кристалл из добычи
const loot = async () => ev(async hero => {
    const actor = game.actors.get(hero);
    actor.getActiveTokens()[0]?.control({ releaseOthers: true });
    const before = actor.items.filter(i => i.flags.gachadnd?.is_crystal_item).length;
    const { GachaLootTerminal } = await gdt.mod('memory/loot.js');
    await new GachaLootTerminal().generateLoot('normal', 3, 'gray');
    await gdt.settle();
    const card = game.messages.contents.at(-1)?.content ?? '';
    return { got: actor.items.filter(i => i.flags.gachadnd?.is_crystal_item).length - before, taken: /уносит свою плату/.test(card), tithe: game.settings.get('gachadnd', 'moonTithe') };
}, ids.hero);
let l = await loot();
check('добыча после Пожирателя: одного кристалла нет, в карточке — что унёс', l.got === 2 && l.taken && !l.tithe?.floor, JSON.stringify(l));
l = await loot();
check('следующая добыча — целиком', l.got === 3 && !l.taken, JSON.stringify(l));

// ---------- Конец боя убирает Эхо
await ev(async b => {
    await game.settings.set('gachadnd', 'moonBoons', [{ type: 'echo', floor: 2, used: false, boss: b }]);
    const caller = game.combat.combatants.find(c => c.actor?.type === 'character');
    await game.gachadnd.callEcho({ callerId: caller.id, bossId: b.id });
    await game.combat.delete();
    await new Promise(r => setTimeout(r, 1800));
    await gdt.settle();
}, boss);
check('конец боя: Эхо убрано со сцены', await ev(() => !canvas.scene.tokens.some(t => t.flags.gachadnd?.echo || t.flags.gachadnd?.moonDevourer)));

await ev(async s => {
    await game.settings.set('gachadnd', 'runFloor', s.floor);
    await game.settings.set('gachadnd', 'moonBoons', s.boons);
    await game.settings.set('gachadnd', 'moonTithe', s.tithe);
    await game.settings.set('gachadnd', 'devourerOmen', s.omen);
}, saved);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
