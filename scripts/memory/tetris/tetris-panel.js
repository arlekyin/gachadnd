/**
 * Gacha Roguelike dnd5e — Тетрис: панель «Следующая / Запас»
 *
 * Обе фигуры видны заранее: решение созревает, пока ходят другие. Кнопка между ними меняет их
 * местами (как Hold в тетрисе) — в любой момент, хода это не требует. Обрушивается всегда «Следующая».
 *
 * Очередь хранится во флаге персонажа: { next, hold, bag }.
 */

import { MODULE_ID } from "../../core/constants.js";
import { COLORS, ENEMIES_TO_BLAST, draw, shapeCells } from "./tetris-pieces.js";

const { ApplicationV2 } = foundry.applications.api;

/** Очередь персонажа; пустая — заполняется (и сохраняется) */
export async function queueOf(actor) {
    const saved = actor.getFlag(MODULE_ID, 'tetris');
    if (saved?.next) return { next: saved.next, hold: saved.hold ?? null, bag: [...(saved.bag ?? [])] };
    const first = draw();
    const queue = { next: first.type, hold: null, bag: first.bag };
    await saveQueue(actor, queue);
    return queue;
}

export function saveQueue(actor, queue) {
    return actor.update({ [`flags.${MODULE_ID}.tetris`]: { next: queue.next, hold: queue.hold, bag: queue.bag } });
}

/** «Следующая» обрушена: из мешка приходит новая */
export async function advanceQueue(actor) {
    const queue = await queueOf(actor);
    const { type, bag } = draw(queue.bag);
    await saveQueue(actor, { next: type, hold: queue.hold, bag });
    TetrisPanel.instance(actor)?.render();
}

/** «Следующая» ↔ «Запас»; запас пуст — в него уходит «Следующая», а из мешка приходит новая */
export async function swapQueue(actor) {
    const queue = await queueOf(actor);
    if (queue.hold) [queue.next, queue.hold] = [queue.hold, queue.next];
    else {
        const { type, bag } = draw(queue.bag);
        Object.assign(queue, { hold: queue.next, next: type, bag });
    }
    await saveQueue(actor, queue);
    return queue;
}

/** Мини-фигура: клетки сеткой */
export function pieceHtml(type, cls = '') {
    if (!type) return `<div class="gd-tetris-piece empty ${cls}"></div>`;
    const cells = shapeCells(type, 0);
    const minX = Math.min(...cells.map(c => c[0])), minY = Math.min(...cells.map(c => c[1]));
    const w = Math.max(...cells.map(c => c[0])) - minX + 1, h = Math.max(...cells.map(c => c[1])) - minY + 1;
    const dots = cells.map(([x, y]) => `<i style="grid-column: ${x - minX + 1}; grid-row: ${y - minY + 1}"></i>`).join('');
    return `<div class="gd-tetris-piece ${cls}" style="--piece: ${COLORS[type]}; --w: ${w}; --h: ${h}">${dots}</div>`;
}

export class TetrisPanel extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-tetris'],
        tag: 'div',
        window: { title: 'Тетрис', icon: 'fas fa-shapes', resizable: false },
        position: { width: 300, height: 'auto' }
    };

    static instance(actor) {
        return foundry.applications.instances?.get(`gachadnd-tetris-${actor.id}`) ?? null;
    }

    static async open(actor, { item = null, onSwap = null } = {}) {
        const app = TetrisPanel.instance(actor) ?? new TetrisPanel(actor, item);
        if (onSwap) app.onSwap = onSwap;
        await app.render({ force: true });
        app.bringToFront?.();
        return app;
    }

    constructor(actor, item = null) {
        super({ id: `gachadnd-tetris-${actor.id}` });
        this.actor = actor;
        this.item = item;
        // Идёт постановка на сцене: смена фигуры перерисовывает её силуэт
        this.onSwap = null;
    }

    get title() {
        return `Тетрис — ${this.actor.name}`;
    }

    #skill() {
        return this.item ?? this.actor.items.find(i => i.flags?.[MODULE_ID]?.tetris) ?? null;
    }

    async _prepareContext() {
        this.queue = await queueOf(this.actor);
        return {};
    }

    async _renderHTML() {
        const { next, hold } = this.queue;
        const skill = this.#skill();
        const left = skill?.system?.uses?.max ? Number(skill.system.uses.value ?? 0) : null;
        return `<div class="gd-tetris">
            <div class="gd-tetris-queue">
                <div class="gd-tetris-slot next"><span>Следующая</span>${pieceHtml(next, 'big')}</div>
                <button type="button" class="gd-tetris-swap" data-swap title="Поменять местами"><i class="fas fa-right-left"></i></button>
                <div class="gd-tetris-slot hold"><span>Запас</span>${pieceHtml(hold)}</div>
            </div>
            <footer class="gd-tetris-status">
                <p>Бонусным действием обрушьте «Следующую». Группа, где сцеплены ${ENEMIES_TO_BLAST} врага и больше, детонирует.</p>
                ${left === null ? '' : `<span class="gd-tetris-uses" title="Обрушений до конца боя">${left > 0 ? `осталось ${left}` : 'до конца боя — всё'}</span>`}
            </footer>
        </div>`;
    }

    _replaceHTML(html, content) {
        content.innerHTML = html;
        content.querySelector('[data-swap]')?.addEventListener('click', async () => {
            const queue = await swapQueue(this.actor);
            this.onSwap?.(queue);
            this.render();
        });
    }

    _onClose(options) {
        super._onClose?.(options);
        this.onSwap = null;
    }
}
