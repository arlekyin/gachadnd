/**
 * Gacha Roguelike dnd5e — Формат испытаний Риска
 *
 * Общая проверка для сборки (build.mjs) и для своих испытаний Мастера, загружаемых в Foundry.
 * Без зависимостей от Foundry.
 */

const isText = v => typeof v === 'string' && v.trim().length > 0;

export const SKILL_KEYS = ['acr', 'ani', 'arc', 'ath', 'dec', 'his', 'ins', 'itm', 'inv', 'med', 'nat', 'prc', 'prf', 'per', 'rel', 'slt', 'ste', 'sur'];
const RISK_CONDITIONS = ['prone', 'poisoned', 'frightened', 'blinded', 'deafened', 'restrained'];

function validateFail(fail, field, err) {
    const { text, hp, condition, ...rest } = fail ?? {};
    Object.keys(rest).forEach(k => err(`${field}.${k}`, 'неизвестное поле (допустимы: text, hp, condition)'));
    if (!isText(text)) err(`${field}.text`, 'обязательное поле: что случилось при провале');
    if (hp !== undefined && !(typeof hp === 'number' && hp > 0)) err(`${field}.hp`, 'множитель уровня — число больше 0');
    if (condition !== undefined && !RISK_CONDITIONS.includes(condition)) err(`${field}.condition`, `«${condition}» — допустимо: ${RISK_CONDITIONS.join(', ')}`);
}

export function validateRisk(risk) {
    const errs = [];
    const err = (field, msg) => errs.push(`${field}: ${msg}`);
    const { id, name, intro, collapse, stages, ...rest } = risk ?? {};
    Object.keys(rest).forEach(k => err(k, 'неизвестное поле (допустимы: id, name, intro, collapse, stages)'));
    if (!/^[a-z0-9_]+$/.test(String(id))) err('id', 'латиница в нижнем регистре, цифры и _');
    if (!isText(name)) err('name', 'обязательное поле');
    if (!isText(intro)) err('intro', 'обязательное поле: сцена для Мастера');
    validateFail(collapse, 'collapse', err);
    if (!Array.isArray(stages) || stages.length < 3) err('stages', 'список не меньше чем из 3 этапов');
    else stages.forEach((stage, i) => {
        const field = `stages[${i}]`;
        const { name: stageName, text, group, approaches, ...extra } = stage ?? {};
        Object.keys(extra).forEach(k => err(`${field}.${k}`, 'неизвестное поле (допустимы: name, text, group, approaches)'));
        if (!isText(stageName)) err(`${field}.name`, 'обязательное поле');
        if (group !== undefined && typeof group !== 'boolean') err(`${field}.group`, 'true или false');
        if (!Array.isArray(approaches) || !approaches.length) return err(`${field}.approaches`, 'нужен хотя бы один подход');
        approaches.forEach((a, j) => {
            const af = `${field}.approaches[${j}]`;
            const { label, skill, dc, fail, ...more } = a ?? {};
            Object.keys(more).forEach(k => err(`${af}.${k}`, 'неизвестное поле (допустимы: label, skill, dc, fail)'));
            if (!isText(label)) err(`${af}.label`, 'обязательное поле');
            if (!SKILL_KEYS.includes(skill)) err(`${af}.skill`, `«${skill}» — допустимо: ${SKILL_KEYS.join(', ')}`);
            if (dc !== undefined && !Number.isInteger(dc)) err(`${af}.dc`, 'поправка к Сл этажа — целое число');
            validateFail(fail, `${af}.fail`, err);
        });
    });
    return errs;
}

