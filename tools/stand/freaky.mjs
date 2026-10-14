// Чумовая пятница: node tools/stand/freaky.mjs [--v13]
// Живые участники боя любого размера меняются местами (углом на место угла); кого
// накрыл крупный — выталкивается и получает урон; мёртвый гоблин не участвует. Пять тасовок
// подряд: после каждой никто ни в ком не стоит. Снимок out/freaky_flight.png
import { open, args } from './harness.mjs';

const { v13 } = args();
const stand = await open(`freaky.html${v13 ? '?v13' : ''}`, { width: 1500, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const spots = () => page.evaluate(() => Object.fromEntries(scene.tokens.map(t => [t.id, `${t.x / 50},${t.y / 50}`])));
const overlap = () => page.evaluate(() => {
    const cells = new Map();
    for (const t of scene.tokens) for (let dx = 0; dx < t.width; dx++) for (let dy = 0; dy < t.height; dy++) {
        const k = `${t.x / 50 + dx},${t.y / 50 + dy}`;
        if (cells.has(k)) return `${cells.get(k)} и ${t.id} в ${k}`;
        cells.set(k, t.id);
    }
    return null;
});

const start = await spots();
console.log('   до:', JSON.stringify(start));
let moved = false;
for (let round = 1; round <= 5; round++) {
    const before = await spots();
    await page.evaluate(() => { item.system.uses.spent = 0; window.damaged = []; });
    check(await page.evaluate(() => useSkill()) === true, `тасовка ${round}: навык использован`);
    if (round === 1) {
        // Снимок программным WebGL долгий — один, в середине полёта (наезд 550 мс + половина полёта)
        await page.waitForTimeout(1100);
        await stand.shot('freaky_flight');
        await page.waitForTimeout(2600);
    } else await page.waitForTimeout(3300);
    const after = await spots();
    console.log(`   после ${round}:`, JSON.stringify(after));
    if (round === 1) {
        // Карты: по одной каждому живому участнику, заклинателю — баф; над токенами — названия
        const cards = await page.evaluate(() => Object.fromEntries(scene.tokens.map(t => [t.id, t.actor.effects.filter(e => e.flags.gachadnd?.freakyCard).map(e => e.name)])));
        console.log('   карты:', JSON.stringify(cards));
        check(['caster', 'ogre', 'ally', 'imp'].every(id => cards[id].length === 1) && cards.goblin.length === 0, 'каждому живому — одна карта, мёртвому — нет');
        const casterBuff = await page.evaluate(() => { const e = actor.effects.find(x => x.flags.gachadnd?.freakyCard); return freakyCards.CARDS[e.flags.gachadnd.freakyCard.card].buff; });
        check(casterBuff, 'заклинателю — баф');
        check((await page.evaluate(() => window.texts?.length)) === 4, 'над четырьмя токенами вспыхнули карты');
        check(/Карты/.test(await page.evaluate(() => window.chat)), 'карты в сводке чата');
        // Очередь: выставленная инициатива живых перемешана, мёртвого — нет; ход остался за персонажем
        const inits = await page.evaluate(() => Object.fromEntries(game.combat.combatants.map(c => [c.tokenId, c.initiative])));
        console.log('   инициатива:', JSON.stringify(inits));
        check(inits.goblin === 18 && JSON.stringify([inits.caster, inits.ogre, inits.ally, inits.imp].sort()) === JSON.stringify([20, 15, 12, 8].sort()), 'инициатива живых перемешана, мёртвого — на месте');
        check(await page.evaluate(() => game.combat.combatant.tokenId) === 'caster', 'ход остался за персонажем');
        check(await page.evaluate(() => Math.abs(canvas.stage.scale.x - 0.95) < 1e-6 && canvas.stage.rotation === 0), 'камера вернулась на место');
        // Сроки карт: ход за ходом два раунда; карта держится весь следующий ход существа
        const has = id => page.evaluate(id => scene.tokens.get(id).actor.effects.some(e => e.flags.gachadnd?.freakyCard), id);
        const step = (turn, round) => page.evaluate(([turn, round]) => { Object.assign(game.combat, { turn, round }); return Promise.all(Hooks.events.updateCombat.map(fn => fn(game.combat, { turn, round }))); }, [turn, round]);
        const turnOf = id => page.evaluate(id => game.combat.turns.findIndex(c => c.tokenId === id), id);
        const ally = await turnOf('ally'), caster = await turnOf('caster');
        const log = [];
        for (let round = 1; round <= 2; round++) for (let turn = round === 1 ? caster + 1 : 0; turn < 5; turn++) {
            await step(turn, round);
            log.push(`${round}.${turn}: союзник ${await has('ally') ? '+' : '−'}, персонаж ${await has('caster') ? '+' : '−'}`);
            if (round === 2 && turn === caster) break;
        }
        console.log('   сроки:', log.join(' | '));
        // Союзник: карта есть на его ходу (раунд 1) и снята на следующем; персонаж: держится до его хода в раунде 2 включительно
        const at = (r, t) => log.find(l => l.startsWith(`${r}.${t}:`));
        const allyRound = ally > caster ? 1 : 2;
        check(/союзник \+/.test(at(allyRound, ally)) && (ally + 1 < 5 ? /союзник −/.test(at(allyRound, ally + 1)) : true), 'карта союзника — весь его следующий ход, после — снята');
        check(/персонаж \+/.test(at(2, caster)), 'карта персонажа держится и на его ходу в следующем раунде');
        await step(caster + 1 < 5 ? caster + 1 : 0, 2);
        check(!(await has('caster')), 'карта персонажа снята после его следующего хода');
        await step(caster, 1);
    }
    moved ||= Object.keys(after).some(id => id !== 'goblin' && after[id] !== before[id]);
    const bad = await overlap();
    check(!bad, `тасовка ${round}: никто ни в ком не стоит${bad ? ` (${bad})` : ''}`);
    const chat = await page.evaluate(() => window.chat);
    const damaged = await page.evaluate(() => window.damaged);
    if (/Придавило/.test(chat)) check(damaged.length > 0 && damaged.every(([, n]) => n === 7), `тасовка ${round}: придавленные получили урон ${JSON.stringify(damaged)}`);
    check(await page.evaluate(() => canvas.controls.children.length === 0 && Object.values(toks).every(t => t.renderable !== false)), `тасовка ${round}: картинки убраны, токены видны`);
}
check(moved, 'места менялись');
// Расчёт отдельно: огр 2×2 встаёт на место гоблина, гоблин — на место эльфа рядом (накрыт огром),
// эльф — на место огра; мёртвый сосед под огром сдвигается
const calc = await page.evaluate(() => {
    const t = (id, x, y, w = 1) => ({ id, x: x * 50, y: y * 50, width: w, height: w });
    const ogre = t('ogre', 0, 0, 2), goblin = t('goblin', 10, 10), elf = t('elf', 11, 10), dead = t('dead', 10, 11);
    const fake = { grid: { size: 50 }, dimensions: { width: 1000, height: 1000 }, tiles: [], tokens: [ogre, goblin, elf, dead] };
    const { moves, crushed } = freaky.plan(fake, [ogre, goblin, elf], () => 0.1);
    return { moves: Object.fromEntries(moves.map(m => [m.id, `${m.x / 50},${m.y / 50}`])), crushed };
});
console.log('   расчёт:', JSON.stringify(calc));
check(calc.moves.ogre === '10,10', 'огр встал на место гоблина');
check(calc.moves.elf === '0,0', 'эльф встал на место огра');
check(calc.crushed.includes('goblin') && calc.moves.goblin && !['10,10', '11,10', '10,11', '11,11'].includes(calc.moves.goblin), 'гоблина придавило — вытолкнут из-под огра');
check(calc.moves.dead && !['10,10', '11,10', '10,11', '11,11'].includes(calc.moves.dead), 'мёртвый сосед под огром сдвинут');
if (v13) check(await page.evaluate(() => (window.moves ?? []).every(m => m.action === 'displace')), 'v13: перестановка — displace');

// Вне боя — отказ
await page.evaluate(() => { game.combat.started = false; item.system.uses.spent = 0; });
check(await page.evaluate(() => useSkill()) === false, 'вне боя навык не срабатывает');
await stand.close();
