/**
 * Gacha Roguelike dnd5e — холсты Алтаря в рабочем потоке
 *
 * Ядро сознания, связи Слияния, пряди Резонанса и фон Терминала рисуются каждый кадр. В основном потоке это занимало
 * его вместе с Foundry: пока холст меняется каждый кадр, браузер ещё и пересчитывает стили всех
 * CSS-анимаций окна. Рисовальщики не трогают DOM, поэтому работают в рабочем потоке через OffscreenCanvas:
 * основной поток только меряет разметку при изменении размера и передаёт числа.
 *
 * RendererHost — посредник: вызывает методы рисовальщика в рабочем потоке, а без поддержки
 * OffscreenCanvas или модульных рабочих потоков — у копии рисовальщика в основном потоке. Картинка одна.
 */

const SUPPORTED = typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined'
    && !!globalThis.HTMLCanvasElement && 'transferControlToOffscreen' in HTMLCanvasElement.prototype;

export const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export class RendererHost {
    /**
     * @param {string} kind      Рисовальщик в рабочем потоке: 'mind' | 'synapses' | 'weave' | 'neural'.
     * @param {Function} Local   Класс того же рисовальщика для основного потока.
     */
    constructor(kind, Local) {
        this.kind = kind;
        this.Local = Local;
        this.worker = null;
        this.local = null;
        if (!SUPPORTED) return;
        try {
            this.worker = new Worker(new URL('./altar-render-worker.js', import.meta.url), { type: 'module' });
            this.worker.addEventListener('error', () => this.#fallback());
            this.worker.postMessage({ type: 'init', kind, reducedMotion: reducedMotion() });
        } catch (err) {
            this.#fallback();
        }
    }

    // Холст, уже отданный рабочему потоку, вернуть нельзя: картинка появится со следующей перерисовкой слоя
    #fallback() {
        this.worker?.terminate();
        this.worker = null;
        console.warn(`gachadnd | Алтарь (${this.kind}): рабочий поток недоступен, рисую в основном потоке.`);
    }

    #localRenderer() {
        return this.local ??= new this.Local({ reducedMotion: reducedMotion() });
    }

    /** Вызов метода рисовальщика; холсты среди аргументов передаются рабочему потоку */
    call(method, ...args) {
        if (!this.worker) return this.#localRenderer()[method]?.(...args);
        const transfer = [];
        const sent = args.map(arg => {
            if (arg instanceof HTMLCanvasElement) {
                const offscreen = arg.transferControlToOffscreen();
                transfer.push(offscreen);
                return offscreen;
            }
            return arg;
        });
        this.worker.postMessage({ type: method, args: sent }, transfer);
    }

    /** Окно закрыто: рабочий поток завершается */
    dispose() {
        this.call('stop');
        this.worker?.terminate();
        this.worker = null;
    }
}
