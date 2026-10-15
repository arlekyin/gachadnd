// Разовый осмотр документов компендиума навыков: node tools/foundry/inspect.mjs Имя1 Имя2
import { connect } from './harness.mjs';
const names = process.argv.slice(2).filter(a => !a.startsWith('--'));
const f = await connect();
const out = await f.page.evaluate(async names => {
    const pack = game.packs.get('gachadnd.gacha-skills');
    const docs = await pack.getDocuments();
    return docs.filter(d => names.includes(d.name)).map(d => {
        const o = d.toObject();
        delete o.system.description;
        return o;
    });
}, names);
console.log(JSON.stringify(out, null, 1));
await f.close();
