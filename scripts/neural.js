/**
 * Gacha Roguelike dnd5e — Фон Терминала: нейронная сеть
 *
 * Узлы и связи строятся детерминированно по ключу (id персонажа): сеть одинакова
 * при каждой перерисовке. По связям бегут импульсы; их число растёт с числом
 * экипированных навыков. Фаза анимаций считается от часов, поэтому перерисовка
 * не перезапускает движение.
 */

const WIDTH = 1000;
const HEIGHT = 700;

// Детерминированный генератор псевдослучайных чисел (mulberry32)
function random(seedText) {
    let seed = 0;
    for (const char of String(seedText)) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) | 0;
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {string} key          Ключ сети (id персонажа).
 * @param {number} activeCount  Число экипированных навыков.
 * @returns {string}            Разметка SVG.
 */
export function neuralHtml(key, activeCount = 0) {
    const rand = random(key);
    const now = Date.now();

    const nodes = Array.from({ length: 48 }, () => ({
        x: 20 + rand() * (WIDTH - 40),
        y: 20 + rand() * (HEIGHT - 40),
        r: 1.2 + rand() * 2.2
    }));

    // Каждый узел связан с двумя ближайшими
    const edges = [];
    const seen = new Set();
    nodes.forEach((a, i) => {
        nodes
            .map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.y - b.y) }))
            .filter(n => n.j !== i)
            .sort((p, q) => p.d - q.d)
            .slice(0, 2)
            .forEach(({ j, d }) => {
                const id = i < j ? `${i}-${j}` : `${j}-${i}`;
                if (seen.has(id)) return;
                seen.add(id);
                edges.push({ a: nodes[i], b: nodes[j], len: d });
            });
    });

    const phase = duration => `-${now % Math.round(duration * 1000)}ms`;

    const lines = edges.map(e =>
        `<line x1="${e.a.x.toFixed(1)}" y1="${e.a.y.toFixed(1)}" x2="${e.b.x.toFixed(1)}" y2="${e.b.y.toFixed(1)}"/>`).join('');

    // Импульсы: короткий светящийся штрих бежит по связи
    const pulseCount = Math.min(edges.length, 6 + activeCount * 3);
    const pulses = [];
    for (let k = 0; k < pulseCount; k++) {
        const e = edges[Math.floor(rand() * edges.length)];
        const duration = 2.5 + rand() * 3.5;
        const len = e.len.toFixed(1);
        const reverse = rand() < 0.5;
        const [p1, p2] = reverse ? [e.b, e.a] : [e.a, e.b];
        // Анимация SVG (SMIL): смещение штриха от начала связи к концу; begin < 0 — текущая фаза по часам
        const begin = `-${((now % Math.round(duration * 1000)) / 1000).toFixed(2)}s`;
        pulses.push(`<line class="gd-pulse" x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke-dasharray="14 ${len}">`
            + `<animate attributeName="stroke-dashoffset" from="14" to="-${len}" dur="${duration.toFixed(2)}s" begin="${begin}" repeatCount="indefinite"/>`
            + `<animate attributeName="opacity" values="0;0.9;0.9;0" keyTimes="0;0.1;0.9;1" dur="${duration.toFixed(2)}s" begin="${begin}" repeatCount="indefinite"/>`
            + `</line>`);
    }

    // Узлы мерцают с разными периодами
    const dots = nodes.map(n => {
        const duration = 3 + rand() * 4;
        return `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(1)}" style="--dur: ${duration.toFixed(2)}s; animation-delay: ${phase(duration)}"/>`;
    }).join('');

    return `
        <svg class="gd-neural" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <g class="gd-neural-links">${lines}</g>
            <g class="gd-neural-pulses">${pulses.join('')}</g>
            <g class="gd-neural-nodes">${dots}</g>
        </svg>`;
}
