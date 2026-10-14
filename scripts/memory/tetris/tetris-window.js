/**
 * Gacha Roguelike dnd5e — Тетрис: окно сборки
 *
 * Игрок собирает фигуру когда угодно, в том числе пока ходят другие: стол это не задерживает.
 * Деталь берётся кликом (из лотка или с поля), поворачивается колесом, правой кнопкой или R,
 * ставится кликом по полю; Esc возвращает её в лоток. Числа у строк и столбцов загораются,
 * когда совпали, и краснеют, когда клеток больше нужного.
 *
 * Головоломка хранится во флаге персонажа: переживает закрытие окна и перезагрузку.
 */

import { MODULE_ID } from "../../core/constants.js";
import { generate, canPlace, counts, isSolved, pieceCells, rotate } from "./tetris-puzzle.js";

const { ApplicationV2 } = foundry.applications.api;

// Цвета деталей: жёлтый Endfield, бирюза, оранжевый, сирень
const COLORS = ['#ffd43b', '#3fd6c6', '#ff8a4c', '#b58cff'];

// Во флаге положения деталей — списком по порядку деталей: при обновлении документа список
// заменяется целиком, а объект слился бы со старым, и снятая деталь осталась бы на поле
const pack = puzzle => ({ ...puzzle, placed: puzzle.pieces.map(p => puzzle.placed[p.id] ?? null) });
const unpack = saved => ({
    ...saved,
    placed: Object.fromEntries(saved.pieces.map((p, n) => [p.id, saved.placed?.[n] ?? null]).filter(([, at]) => at))
});

/** Головоломка персонажа; нет — новая (и сразу сохраняется) */
export async function puzzleOf(actor) {
    const saved = actor.getFlag(MODULE_ID, 'tetris');
    if (saved?.pieces?.length) return unpack(foundry.utils.deepClone(saved));
    const puzzle = generate();
    await savePuzzle(actor, puzzle);
    return puzzle;
}

export function savePuzzle(actor, puzzle) {
    return actor.update({ [`flags.${MODULE_ID}.tetris`]: pack(puzzle) });
}

/** Собранная фигура персонажа или null */
export function solvedPuzzle(actor) {
    const saved = actor.getFlag(MODULE_ID, 'tetris');
    if (!saved?.pieces?.length) return null;
    const puzzle = unpack(foundry.utils.deepClone(saved));
    return isSolved(puzzle) ? puzzle : null;
}

/** Новая головоломка после развёртывания */
export async function resetPuzzle(actor) {
    await savePuzzle(actor, generate());
    TetrisWindow.instance(actor)?.reload();
}

export class TetrisWindow extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-tetris'],
        tag: 'div',
        window: { title: 'Тетрис', icon: 'fas fa-shapes', resizable: false },
        position: { width: 470, height: 'auto' }
    };

    static instance(actor) {
        return foundry.applications.instances?.get(`gachadnd-tetris-${actor.id}`) ?? null;
    }

    static async open(actor, { item = null } = {}) {
        const existing = TetrisWindow.instance(actor);
        if (existing) {
            await existing.render({ force: true });
            existing.bringToFront?.();
            return existing;
        }
        return new TetrisWindow(actor, item).render({ force: true });
    }

    constructor(actor, item = null) {
        super({ id: `gachadnd-tetris-${actor.id}` });
        this.actor = actor;
        this.item = item;
        this.puzzle = null;
        // Деталь в руке: { id, rot, grab: [x, y] — клетка детали под курсором }
        this.held = null;
        this.hover = null;
    }

    get title() {
        return `Тетрис — ${this.actor.name}`;
    }

    /** Головоломку заменили (развёртывание): перечитать */
    async reload() {
        this.puzzle = null;
        this.held = null;
        if (this.rendered) await this.render();
    }

    #skill() {
        return this.item ?? this.actor.items.find(i => i.flags?.[MODULE_ID]?.puzzle) ?? null;
    }

    async _prepareContext() {
        this.puzzle ??= await puzzleOf(this.actor);
        return {};
    }

    async _renderHTML() {
        return this.#html();
    }

    _replaceHTML(html, content) {
        content.innerHTML = html;
        if (content.dataset.bound) return;
        content.dataset.bound = '1';
        content.addEventListener('pointerdown', event => this.#onPointerDown(event));
        content.addEventListener('pointermove', event => this.#onPointerMove(event));
        content.addEventListener('pointerleave', () => { this.hover = null; this.#paintGhost(); });
        content.addEventListener('contextmenu', event => {
            if (!this.held) return;
            event.preventDefault();
            this.#rotateHeld(1);
        });
        content.addEventListener('wheel', event => {
            if (!this.held) return;
            event.preventDefault();
            this.#rotateHeld(Math.sign(event.deltaY) || 1);
        }, { passive: false });
        this.keys = event => {
            if (!this.held || event.target?.closest?.('input, textarea, [contenteditable]')) return;
            if (event.code === 'KeyR') { this.#rotateHeld(1); event.preventDefault(); event.stopPropagation(); }
            if (event.code === 'Escape') { this.#drop(); event.preventDefault(); event.stopPropagation(); }
        };
        document.addEventListener('keydown', this.keys, true);
    }

    _onClose(options) {
        super._onClose?.(options);
        if (this.keys) document.removeEventListener('keydown', this.keys, true);
    }

    // ==========================================
    // РАЗМЕТКА
    // ==========================================

    #html() {
        const p = this.puzzle;
        const solved = isSolved(p);
        const now = counts(p);
        const color = new Map(p.pieces.map((piece, n) => [piece.id, COLORS[n % COLORS.length]]));
        const cellOf = new Map();
        for (const piece of p.pieces) {
            const at = p.placed[piece.id];
            if (at) for (const [x, y] of pieceCells(piece, at)) cellOf.set(`${x},${y}`, piece.id);
        }
        const blocked = new Set(p.blocked.map(([x, y]) => `${x},${y}`));
        const clue = (want, have, axis, i) => `<div class="gd-tetris-clue ${axis} ${have === want ? 'ok' : have > want ? 'over' : ''}" data-${axis === 'col' ? 'x' : 'y'}="${i}">${want}</div>`;

        let board = '<div class="gd-tetris-corner"></div>';
        board += p.cols.map((want, x) => clue(want, now.cols[x], 'col', x)).join('');
        for (let y = 0; y < p.size; y++) {
            board += clue(p.rows[y], now.rows[y], 'row', y);
            for (let x = 0; x < p.size; x++) {
                const k = `${x},${y}`, id = cellOf.get(k);
                const cls = blocked.has(k) ? 'blocked' : id ? 'filled' : '';
                board += `<div class="gd-tetris-cell ${cls}" data-x="${x}" data-y="${y}"${id ? ` data-piece="${id}" style="--piece: ${color.get(id)}"` : ''}></div>`;
            }
        }

        const tray = p.pieces.filter(piece => !p.placed[piece.id]).map(piece => {
            const held = this.held?.id === piece.id;
            const cells = rotate(piece.cells, held ? this.held.rot : 0);
            const w = Math.max(...cells.map(c => c[0])) + 1, h = Math.max(...cells.map(c => c[1])) + 1;
            const dots = cells.map(([x, y]) => `<i style="grid-column: ${x + 1}; grid-row: ${y + 1}"></i>`).join('');
            return `<button type="button" class="gd-tetris-piece ${held ? 'held' : ''}" data-piece="${piece.id}" style="--piece: ${color.get(piece.id)}; --w: ${w}; --h: ${h}">${dots}</button>`;
        }).join('');

        const skill = this.#skill();
        const left = skill?.system?.uses?.max ? Number(skill.system.uses.value ?? 0) : null;
        const status = solved
            ? '<strong>Фигура собрана.</strong> Используйте навык бонусным действием — она обрушится на поле боя.'
            : this.held
                ? 'Колесо, правая кнопка или R — повернуть. Клик по полю — поставить. Esc — вернуть.'
                : 'Займите клетки так, чтобы в каждой строке и столбце их было столько, сколько указано. Нужны все детали.';
        return `<div class="gd-tetris ${solved ? 'solved' : ''} ${this.held ? 'holding' : ''}">
            <div class="gd-tetris-main">
                <div class="gd-tetris-board" style="--n: ${p.size}">${board}</div>
                <div class="gd-tetris-tray">${tray || '<span class="gd-tetris-empty">Все детали на поле</span>'}</div>
            </div>
            <footer class="gd-tetris-status">
                <p>${status}</p>
                ${left === null ? '' : `<span class="gd-tetris-uses" title="Развёртываний до конца боя">${left > 0 ? `осталось ${left}` : 'до конца боя — всё'}</span>`}
            </footer>
        </div>`;
    }

    // ==========================================
    // ВЗАИМОДЕЙСТВИЕ
    // ==========================================

    #cellAt(event) {
        const cell = event.target.closest?.('.gd-tetris-cell');
        return cell ? [Number(cell.dataset.x), Number(cell.dataset.y)] : null;
    }

    // Куда встанет деталь в руке, если курсор над клеткой [x, y]
    #targetAt([x, y]) {
        const piece = this.puzzle.pieces.find(p => p.id === this.held.id);
        const cells = rotate(piece.cells, this.held.rot);
        const [gx, gy] = this.#grabCell(cells);
        return { piece, at: { rot: this.held.rot, x: x - gx, y: y - gy } };
    }

    // Клетка детали под курсором: та, за которую взяли; после поворота или из лотка — ближайшая к центру
    #grabCell(cells) {
        if (this.held.grab && cells.some(c => c[0] === this.held.grab[0] && c[1] === this.held.grab[1])) return this.held.grab;
        const cx = cells.reduce((s, c) => s + c[0], 0) / cells.length, cy = cells.reduce((s, c) => s + c[1], 0) / cells.length;
        return cells.reduce((best, c) => Math.hypot(c[0] - cx, c[1] - cy) < Math.hypot(best[0] - cx, best[1] - cy) ? c : best);
    }

    #onPointerDown(event) {
        if (event.button !== 0) return;
        const p = this.puzzle;
        const trayPiece = event.target.closest?.('.gd-tetris-piece');
        if (trayPiece) {
            const id = trayPiece.dataset.piece;
            this.held = this.held?.id === id ? null : { id, rot: 0, grab: null };
            return this.render();
        }
        const cell = this.#cellAt(event);
        if (!cell) return this.held ? this.#drop() : undefined;
        if (this.held) {
            const { piece, at } = this.#targetAt(cell);
            if (!canPlace(p, piece, at)) return;
            p.placed[piece.id] = at;
            this.held = null;
            this.#changed();
            return;
        }
        // Клик по детали на поле — взять её; клетка, за которую взяли, остаётся под курсором
        const el = event.target.closest('.gd-tetris-cell');
        const id = el?.dataset.piece;
        if (!id) return;
        const at = p.placed[id];
        const piece = p.pieces.find(x => x.id === id);
        const local = pieceCells(piece, at).findIndex(c => c[0] === cell[0] && c[1] === cell[1]);
        const rotated = rotate(piece.cells, at.rot);
        delete p.placed[id];
        this.held = { id, rot: at.rot, grab: rotated[local] };
        this.hover = cell;
        this.#changed();
    }

    #onPointerMove(event) {
        if (!this.held) return;
        const cell = this.#cellAt(event);
        if (cell?.[0] === this.hover?.[0] && cell?.[1] === this.hover?.[1]) return;
        this.hover = cell;
        this.#paintGhost();
    }

    #rotateHeld(dir) {
        if (!this.held) return;
        this.held.rot = (this.held.rot + dir + 4) % 4;
        this.held.grab = null;
        this.render();
    }

    #drop() {
        this.held = null;
        this.render();
    }

    // Призрак детали под курсором: зелёный — встанет, красный — нет
    #paintGhost() {
        const board = this.element?.querySelector('.gd-tetris-board');
        if (!board) return;
        board.querySelectorAll('.ghost, .ghost-bad').forEach(el => el.classList.remove('ghost', 'ghost-bad'));
        if (!this.held || !this.hover) return;
        const { piece, at } = this.#targetAt(this.hover);
        const ok = canPlace(this.puzzle, piece, at);
        for (const [x, y] of pieceCells(piece, at)) {
            board.querySelector(`.gd-tetris-cell[data-x="${x}"][data-y="${y}"]`)?.classList.add(ok ? 'ghost' : 'ghost-bad');
        }
    }

    async #changed() {
        const solved = isSolved(this.puzzle);
        const was = this.puzzle.solved;
        this.puzzle.solved = solved;
        await this.render();
        this.#paintGhost();
        if (solved && !was) this.element?.querySelector('.gd-tetris')?.classList.add('just-solved');
        clearTimeout(this.saveTimer);
        const data = foundry.utils.deepClone(this.puzzle);
        this.saveTimer = setTimeout(() => savePuzzle(this.actor, data), solved !== was ? 0 : 300);
    }
}
