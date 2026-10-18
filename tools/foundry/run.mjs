// Прогон проверок в одном браузере: node tools/foundry/run.mjs [имя …] [--no-sandbox] [--headed] [--slow[=мс]] [--keep-world]
// Мир, который прогон запустил сам, в конце закрывается (--keep-world — оставить): иначе лаунчер Foundry
// не может запустить другой мир, пока его не перезапустят
// Без имён — все проверки. Вход в мир один раз на весь прогон; в конце — песочница для ручной проверки
// (--no-sandbox — без неё) и сводка: итог и время каждой проверки.
//   node tools/foundry/run.mjs light-auto blast-fire     — только они, затем песочница
import { args, closeShared } from './harness.mjs';

export const ALL = ['settings', 'overheat', 'aura', 'light', 'light-auto', 'light-zones', 'light-big', 'blast-fire', 'blast-boom', 'windows', 'deal', 'knack', 'names', 'boons', 'residents', 'chronicle', 'events', 'devourer', 'living', 'web', 'dock', 'arena'];

const names = process.argv.slice(2).filter(a => !a.startsWith('--'));
const list = names.length ? names : ALL;
const unknown = list.filter(n => !ALL.includes(n));
if (unknown.length) {
    console.error(`Нет таких проверок: ${unknown.join(', ')}. Есть: ${ALL.join(', ')}`);
    process.exit(2);
}

globalThis.gdRunner = { failed: 0 };
const rows = [];
const started = Date.now();
for (const name of list) {
    console.log(`\n=== ${name} ===`);
    const t0 = Date.now(), before = globalThis.gdRunner.failed;
    let crashed = null;
    try {
        await import(`./${name}.mjs`);
    } catch (error) {
        crashed = error;
        globalThis.gdRunner.failed++;
        console.error(`ПРОВЕРКА УПАЛА: ${error?.message ?? error}`);
    }
    rows.push({ name, ok: globalThis.gdRunner.failed === before, crashed, sec: Math.round((Date.now() - t0) / 1000) });
}
if (!args()['no-sandbox']) {
    console.log('\n=== песочница ===');
    await import('./sandbox.mjs');
}
await closeShared();

console.log('\nСводка:');
for (const r of rows) console.log(`  ${r.ok ? '✔' : '✘'} ${r.name.padEnd(12)} ${String(r.sec).padStart(4)} с${r.crashed ? ` — упала: ${r.crashed.message}` : ''}`);
console.log(`Всего ${Math.round((Date.now() - started) / 1000)} с, с ошибками: ${globalThis.gdRunner.failed}`);
process.exit(globalThis.gdRunner.failed ? 1 : 0);
