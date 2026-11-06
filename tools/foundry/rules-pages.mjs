// Журналы правил в настоящей Foundry: node tools/foundry/rules-pages.mjs [папка для снимков] [--headed]
// На всех страницах обоих журналов ссылки целые, страницы не пусты, порядок — с «Памятки» и «Первого забега»;
// «Огранка» — все камни, которые есть в игре (STONES). Снимки — если указана папка.
import { connect, checker, moduleErrors, done } from './harness.mjs';

const shots = process.argv.slice(2).find(a => !a.startsWith('--'));
const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const since = f.log.length;

const report = await ev(async () => {
    const out = {};
    for (const pack of ['gacha-rules', 'gacha-gm']) {
        const [entry] = await game.packs.get(`gachadnd.${pack}`).getDocuments();
        const pages = entry.pages.contents.sort((a, b) => a.sort - b.sort);
        const list = [];
        for (const p of pages) {
            const html = await foundry.applications.ux.TextEditor.implementation.enrichHTML(p.text?.content ?? '');
            const div = document.createElement('div'); div.innerHTML = html;
            list.push({ name: p.name, broken: div.querySelectorAll('a.broken').length, links: div.querySelectorAll('a.content-link').length, size: div.textContent.length });
        }
        out[pack] = list;
    }
    return out;
});
const all = [...report['gacha-rules'], ...report['gacha-gm']];
check('первые страницы — «Памятка» и «Первый забег»', report['gacha-rules'][0]?.name === 'Памятка' && report['gacha-gm'][0]?.name === 'Первый забег');
check(`ссылки целые на всех ${all.length} страницах`, all.every(p => !p.broken), all.filter(p => p.broken).map(p => `${p.name}: ${p.broken}`).join(', '));
check('пустых страниц нет', all.every(p => p.size > 100), all.filter(p => p.size <= 100).map(p => p.name).join(', '));
check('Памятка ведёт на главы правил', report['gacha-rules'][0]?.links >= 10, String(report['gacha-rules'][0]?.links));

// Огранка: каждый камень игры есть в главе и с тегом
const facet = await ev(async () => {
    const { STONES } = await import('/modules/gachadnd/scripts/memory/facet/facet.js');
    const [entry] = await game.packs.get('gachadnd.gacha-rules').getDocuments();
    const text = entry.pages.find(p => p.name === 'Огранка')?.text?.content ?? '';
    const missing = Object.values(STONES).filter(s => !text.includes(`<strong>${s.name}</strong>`)).map(s => s.name);
    return { count: Object.keys(STONES).length, missing };
});
check(`«Огранка»: все ${facet.count} камней игры на странице`, !facet.missing.length, facet.missing.join(', '));

if (shots) {
    for (const [pack, name, file] of [['gacha-rules', 'Памятка', 'rules-memo'], ['gacha-rules', 'Огранка', 'rules-facet'], ['gacha-gm', 'Первый забег', 'rules-first-run']]) {
        await ev(async ({ pack, name }) => {
            for (const app of foundry.applications.instances.values()) if (app.document?.documentName === 'JournalEntry') await app.close();
            const [entry] = await game.packs.get(`gachadnd.${pack}`).getDocuments();
            await entry.sheet.render({ force: true, pageId: entry.pages.find(p => p.name === name).id });
        }, { pack, name });
        await page.waitForTimeout(1500);
        await page.screenshot({ path: `${shots}/${file}.png` });
    }
    await ev(async () => { for (const app of foundry.applications.instances.values()) if (app.document?.documentName === 'JournalEntry') await app.close(); });
}

const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
