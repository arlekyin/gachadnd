/**
 * Генератор арен — погода на важных боях (docs/arena-weather.md)
 *
 * Ливень: тропа раскисает (регион «Грязь» — трудная местность), ручей разливается на клетку шире (регион «Разлив»).
 * Туман Предела: 3–5 клочьев бирюзового тумана — кольцо стен «ограниченный обзор» (сквозь клочок не видно: две
 * такие стены взгляд не проходит; внутрь видно — тьма внутри читалась бы чёрной дырой), сверху плитка тумана;
 * в начале каждого раунда клочья сползают по ветру на 1–2 клетки. Ветер: помеха на дальние атаки оружием
 * (хук dnd5e перед броском — у того, кто бросает), листья по ветру.
 * Погода лежит флагом сцены arenaWeather { kind, wind } — её видят все клиенты. В начале боя — карточка всем с
 * правилом; у Мастера на ней «Другая погода» и «Снять погоду». Регионы, стены, свет и плитки погоды помечены
 * флагом weather, клочья тумана — ещё и номером fog.
 *
 * applyWeather(scene, kind) · clearWeather(scene) · driftFog(scene)
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM } from "../core/socket.js";
import { onRenderChatMessage } from "../core/chat-hooks.js";
import { ribbon, rng } from "./layout.js";

const CELL = 140;
const FLAG = 'arenaWeather';
export const WEATHER = {
    rain: {
        name: 'Ливень', icon: 'fa-cloud-showers-heavy', effect: 'rain',
        rule: 'Всё дальше 30 футов слабо заслонено: помеха на Восприятие по зрению. Открытый огонь гаснет. Тропа раскисла — трудная местность, ручей разлился.'
    },
    fog: {
        name: 'Туман Предела', icon: 'fa-smog', effect: '',
        rule: 'Сквозь клочья тумана не видно; внутри всё слабо заслонено — помеха на Восприятие по зрению. В начале каждого раунда туман сползает по ветру.'
    },
    wind: {
        name: 'Ветер', icon: 'fa-wind', effect: 'leaves',
        rule: 'Помеха на дальние атаки оружием. Газ, дым и туман сносит. Летающий без парения в конце хода снижается на 10 футов.'
    }
};
// Направление ветра: восемь сторон, откуда дует (стрелка — куда)
const WINDS = [['с запада', '→'], ['с северо-запада', '↘'], ['с севера', '↓'], ['с северо-востока', '↙'], ['с востока', '←'], ['с юго-востока', '↖'], ['с юга', '↑'], ['с юго-запада', '↗']];

export const weatherOf = scene => scene?.getFlag(MODULE_ID, FLAG) ?? null;

/** Плитка клочка тумана: рисуется один раз на мир — мягкие бирюзовые клубы на прозрачном */
async function fogTexture() {
    const dir = `worlds/${game.world.id}/gachadnd-arena`, name = 'fog-puff-2.webp', src = `${dir}/${name}`;
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
    try {
        const { files } = await FP.browse('data', dir);
        if (files.some(f => f.endsWith(name))) return src;
    } catch (err) { /* папки ещё нет */ }
    const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d'), R = rng('fog-puff');
    for (let i = 0; i < 40; i++) {
        const a = R.range(0, 6.28), d = R.range(0, S * 0.2), x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d, r = S * R.range(0.12, 0.24);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(196,236,228,0.42)'); g.addColorStop(1, 'rgba(196,236,228,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    }
    const blob = await new Promise(resolve => c.toBlob(resolve, 'image/webp', 0.9));
    await FP.createDirectory('data', dir).catch(() => {});
    await FP.upload('data', dir, new File([blob], name, { type: 'image/webp' }), {}, { notify: false });
    return src;
}

/** Убрать погоду: регионы и плитки погоды, эффект сцены, флаг */
export async function clearWeather(scene) {
    const mine = doc => doc.getFlag(MODULE_ID, 'weather');
    await scene.deleteEmbeddedDocuments('Region', scene.regions.filter(mine).map(r => r.id));
    await scene.deleteEmbeddedDocuments('Tile', scene.tiles.filter(mine).map(t => t.id));
    await scene.deleteEmbeddedDocuments('Wall', scene.walls.filter(mine).map(w => w.id));
    await scene.deleteEmbeddedDocuments('AmbientLight', scene.lights.filter(mine).map(l => l.id));
    await scene.update({ weather: '', [`flags.${MODULE_ID}.-=${FLAG}`]: null });
}

// Стена клочка тумана: не держит шаг, свет и звук; взгляд — «ограниченный» (кольцо из двух таких стен на пути)
const FOG_WALL = { move: 0, sight: 10, light: 0, sound: 0 };
const ringWalls = (x, y, r, n = 14) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r, x + Math.cos(b) * r, y + Math.sin(b) * r].map(Math.round);
});

// Регион заперт: на слое регионов (он открывается и при шаблоне заклинания) не показывается, правило работает
const difficult = (name, color, type, shapes) => ({
    name, color, shapes, locked: true, flags: { [MODULE_ID]: { weather: true } },
    behaviors: [{ name: 'Трудная местность', type: 'dnd5e.difficultTerrain', system: { types: [type] } }]
});

/**
 * Поставить погоду на арену (Мастер). Местность арены — из флага сцены arena.terrain (тропа и ручей).
 * @param {Scene} scene
 * @param {'rain'|'fog'|'wind'} kind
 */
export async function applyWeather(scene, kind, { seed = foundry.utils.randomID(6) } = {}) {
    if (!WEATHER[kind]) return null;
    await clearWeather(scene);
    const R = rng(`weather|${seed}`), wind = R.int(0, 7);
    const terrain = scene.getFlag(MODULE_ID, 'arena')?.terrain ?? {};
    const px = v => Math.round(v * CELL);
    const cols = Math.round(scene.width / CELL), rows = Math.round(scene.height / CELL);

    if (kind === 'rain') {
        const regions = [];
        if (terrain.path?.length) regions.push(difficult('Грязь', '#6b5a2e', 'mud', [{ type: 'polygon', points: ribbon(terrain.path, 1.9).map(px) }]));
        if (terrain.stream) regions.push(difficult('Разлив', '#3a7fa8', 'liquid', [{ type: 'polygon', points: ribbon(terrain.stream.path, terrain.stream.width + 2).map(px) }]));
        if (regions.length && CONFIG.RegionBehavior?.dataModels?.['dnd5e.difficultTerrain']) await scene.createEmbeddedDocuments('Region', regions);
    }
    if (kind === 'fog') {
        // Клочья — в средней части поля, не на кромках отряда и врагов
        const src = await fogTexture(), puffs = [];
        for (let tries = 0; tries < 60 && puffs.length < R.int(3, 5); tries++) {
            const x = R.range(cols * 0.25, cols * 0.75), y = R.range(2, rows - 2), r = R.range(1.6, 2.4);
            if (puffs.some(p => Math.hypot(p.x - x, p.y - y) < p.r + r + 0.5)) continue;
            puffs.push({ x, y, r });
        }
        const flags = i => ({ [MODULE_ID]: { weather: true, fog: i } });
        await scene.createEmbeddedDocuments('Wall', puffs.flatMap((p, i) => ringWalls(px(p.x), px(p.y), px(p.r)).map(c => ({ c, ...FOG_WALL, flags: flags(i) }))));
        await scene.createEmbeddedDocuments('Tile', puffs.map((p, i) => ({
            texture: { src }, x: px(p.x - p.r * 1.5), y: px(p.y - p.r * 1.5), width: px(p.r * 3), height: px(p.r * 3),
            alpha: 0.9, flags: { [MODULE_ID]: { weather: true, fog: i } }
        })));
    }
    await scene.update({ weather: WEATHER[kind].effect, [`flags.${MODULE_ID}.${FLAG}`]: { kind, wind } });
    return { kind, wind };
}

/** Туман сползает по ветру на 1–2 клетки; у края поля — отражается обратно */
export async function driftFog(scene) {
    const w = weatherOf(scene);
    if (w?.kind !== 'fog') return;
    const a = (w.wind * Math.PI) / 4, step = (1 + Math.round(Math.random())) * CELL;
    let dx = Math.round(Math.cos(a) * step), dy = Math.round(Math.sin(a) * step);
    const fog = doc => doc.getFlag(MODULE_ID, 'fog') !== undefined;
    const tiles = scene.tiles.filter(fog);
    // Центр клочка — середина плитки
    const out = tiles.some(t => { const x = t.x + t.width / 2 + dx, y = t.y + t.height / 2 + dy; return x < CELL * 2 || y < CELL * 2 || x > scene.width - CELL * 2 || y > scene.height - CELL * 2; });
    // Упёрся в край — ветер поворачивает обратно
    if (out) { dx = -dx; dy = -dy; await scene.setFlag(MODULE_ID, FLAG, { ...w, wind: (w.wind + 4) % 8 }); }
    await scene.updateEmbeddedDocuments('Wall', scene.walls.filter(fog).map(wl => ({ _id: wl.id, c: wl.c.map((v, i) => v + (i % 2 ? dy : dx)) })));
    await scene.updateEmbeddedDocuments('Tile', tiles.map(t => ({ _id: t.id, x: t.x + dx, y: t.y + dy })));
}

// ==========================================
// КАРТОЧКА В НАЧАЛЕ БОЯ
// ==========================================

function cardHtml(w) {
    const def = WEATHER[w.kind], [from, arrow] = WINDS[w.wind ?? 0];
    return `<div class="gd-scent-chat gd-weather-card"><i class="fas ${def.icon}"></i> <strong>${def.name}</strong>
        <p>${def.rule}</p><p><small>Ветер ${from} ${arrow}</small></p>
        <div class="gd-stone-buttons gd-weather-gm"><button type="button" data-gd-weather="other"><i class="fas fa-dice"></i> Другая погода</button><button type="button" data-gd-weather="off"><i class="fas fa-sun"></i> Снять погоду</button></div></div>`;
}

export async function postWeatherCard(scene) {
    const w = weatherOf(scene);
    if (!w) return null;
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Лабиринт' }),
        content: cardHtml(w),
        flags: { [MODULE_ID]: { weather: { scene: scene.id } } }
    });
}

Hooks.on('combatStart', combat => {
    if (!isActiveGM() || !weatherOf(combat.scene)) return;
    postWeatherCard(combat.scene).catch(error => console.error(`${MODULE_ID} | погода`, error));
});
Hooks.on('updateCombat', (combat, changed) => {
    if (!isActiveGM() || !('round' in changed) || combat.round < 2) return;
    driftFog(combat.scene).catch(error => console.error(`${MODULE_ID} | туман`, error));
});

onRenderChatMessage((message, html) => {
    const flag = message.getFlag?.(MODULE_ID, 'weather');
    if (!flag || !html?.querySelector) return;
    // Кнопки — только у Мастера
    if (!game.user.isGM) return html.querySelector('.gd-weather-gm')?.remove();
    html.querySelectorAll('[data-gd-weather]').forEach(b => b.addEventListener('click', async event => {
        event.preventDefault();
        const scene = game.scenes.get(flag.scene), w = weatherOf(scene);
        if (!scene || !w) return;
        if (b.dataset.gdWeather === 'off') {
            await clearWeather(scene);
            return message.update({ content: `<div class="gd-scent-chat gd-weather-card"><i class="fas fa-sun"></i> <strong>Погода стихла.</strong></div>` });
        }
        const others = Object.keys(WEATHER).filter(k => k !== w.kind);
        const next = await applyWeather(scene, others[Math.floor(Math.random() * others.length)]);
        return message.update({ content: cardHtml(next) });
    }));
});

// ==========================================
// ВЕТЕР: ПОМЕХА НА ДАЛЬНИЕ АТАКИ ОРУЖИЕМ
// ==========================================

Hooks.on('dnd5e.preRollAttackV2', config => {
    const activity = config.subject;
    const scene = activity?.actor?.token?.parent ?? activity?.actor?.getActiveTokens?.()[0]?.document?.parent ?? canvas.scene;
    if (weatherOf(scene)?.kind !== 'wind') return;
    const attack = activity?.attack?.type;
    const ranged = attack?.value === 'ranged' || String(config.attackMode ?? '').includes('thrown');
    if (ranged && (attack?.classification ?? 'weapon') === 'weapon') config.disadvantage = true;
});
