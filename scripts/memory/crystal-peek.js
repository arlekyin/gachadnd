/**
 * Gacha Roguelike dnd5e — Подсказка кристалла
 *
 * Наведите курсор на кристалл в окне распределения, в карточке добычи, в награде события или в магазине —
 * рядом появится описание навыка: редкость, категория, теги и текст навыка из компендиума. Открывать
 * компендиум и искать навык не нужно.
 *
 * Любой элемент с атрибутом data-gd-skill="<id навыка в компендиуме>" получает подсказку: один слушатель
 * на всём документе, навыки подгружаются из компендиума один раз и кэшируются.
 */

import { MODULE_ID } from "../core/constants.js";
import { getSkillPack } from "./crystals.js";

const RARITY = {
    gray: ['Серый', '#9d9d9d'], green: ['Зелёный', '#1eff00'], blue: ['Синий', '#0070dd'],
    purple: ['Фиолетовый', '#a335ee'], red: ['Красный', '#ff003c'], orange: ['Оранжевый', '#ff8000']
};
const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cache = new Map();
async function peekHtml(skillId) {
    if (cache.has(skillId)) return cache.get(skillId);
    const task = (async () => {
        const skill = await getSkillPack()?.getDocument(skillId);
        if (!skill) return null;
        const flags = skill.flags?.[MODULE_ID] ?? {};
        const [label, color] = RARITY[flags.rarity] ?? RARITY.gray;
        const editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
        const body = await editor.enrichHTML(skill.system?.description?.value ?? '', { relativeTo: skill, rollData: skill.getRollData?.() });
        const meta = [label, flags.category, (flags.tags ?? []).join(', ')].filter(Boolean).map(esc).join(' · ');
        return `<div class="gd-peek-head" style="--rarity: ${color}"><strong>${esc(skill.name)}</strong><small>${meta}</small></div><div class="gd-peek-body">${body || '<p>Описание отсутствует.</p>'}</div>`;
    })();
    cache.set(skillId, task);
    return task;
}

let panel = null, current = null;

function place(target) {
    if (!panel) return;
    const r = target.getBoundingClientRect(), w = panel.offsetWidth, h = panel.offsetHeight, gap = 10;
    // Справа от кристалла; не влезает — слева; по вертикали — в пределах экрана
    let x = r.right + gap;
    if (x + w > innerWidth - 8) x = Math.max(8, r.left - gap - w);
    const y = Math.min(Math.max(8, r.top), innerHeight - h - 8);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
}

async function show(target) {
    current = target;
    const html = await peekHtml(target.dataset.gdSkill).catch(() => null);
    if (current !== target || !html || !target.isConnected) return;
    panel ??= Object.assign(document.createElement('div'), { className: 'gd-crystal-peek' });
    panel.innerHTML = html;
    document.body.append(panel);
    place(target);
}

function hide() {
    current = null;
    panel?.remove();
}

document.addEventListener('pointerover', event => {
    const target = event.target.closest?.('[data-gd-skill]');
    if (target === current) return;
    if (!target) return current && hide();
    if (target.dataset.gdSkill) show(target);
});
document.addEventListener('pointerdown', hide, true);
document.addEventListener('wheel', hide, { passive: true, capture: true });
document.addEventListener('pointerout', event => { if (!event.relatedTarget) hide(); });
