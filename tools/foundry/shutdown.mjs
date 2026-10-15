// Закрыть тестовый мир (перед npm run build): node tools/foundry/shutdown.mjs
import { connect, shutdownWorld, status } from './harness.mjs';
if ((await status()).active) {
    const f = await connect();
    await shutdownWorld(f.page);
    await f.close();
}
console.log('Мир закрыт');
