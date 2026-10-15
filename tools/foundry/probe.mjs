import { connect } from './harness.mjs';
const f = await connect();
const info = await f.page.evaluate(() => ({
  user: game.user.name, isGM: game.user.isGM, role: game.user.role,
  users: game.users.map(u => `${u.name}${u.isGM?'(GM)':''}${u.active?'*':''}`),
  modules: [...game.modules].filter(m => m.active).map(m => `${m.id}@${m.version}`),
  scene: canvas.scene?.name, scenes: game.scenes.map(s => s.name),
  actors: game.actors.map(a => `${a.name} [${a.type}] items:${a.items.size}`),
  combat: !!game.combat, combats: game.combats.size,
  packs: game.packs.filter(p => p.metadata.packageName === 'gachadnd').map(p => `${p.collection}:${p.index.size}`)
}));
console.log(JSON.stringify(info, null, 1));
await f.shot('probe');
await f.close();
