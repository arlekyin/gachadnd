/**
 * Gacha Roguelike dnd5e — рабочий поток холстов Алтаря Памяти
 *
 * Держит один рисовальщик (ядро, связи Слияния, пряди Резонанса или фон Терминала) и вызывает его методы по сообщениям
 * из RendererHost. Время (сердцебиение, импульсы, вспышки) считается здесь: часы потоков разные.
 */

import { MindRenderer } from "./altar-core.js";
import { SynapsesRenderer, WeaveRenderer } from "./altar-synapses.js";
import { NeuralRenderer } from "./neural.js";

const KINDS = { mind: MindRenderer, synapses: SynapsesRenderer, weave: WeaveRenderer, neural: NeuralRenderer };
let renderer = null;

self.addEventListener('message', ({ data: message }) => {
    if (message.type === 'init') renderer = new KINDS[message.kind]({ reducedMotion: message.reducedMotion });
    else renderer?.[message.type]?.(...(message.args ?? []));
});
