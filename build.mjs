import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import crypto from 'crypto';

function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

const rarityMap = {
    'серый': { label: 'Серый', img: 'grey_fog_active.webp', color: 'gray' },
    'зелёный': { label: 'Зелёный', img: 'green_fog_active.webp', color: 'green' },
    'синий': { label: 'Синий', img: 'blue_fog_active.webp', color: 'blue' },
    'фиолетовый': { label: 'Фиолетовый', img: 'purple_fog_active.webp', color: 'purple' },
    'красный': { label: 'Красный', img: 'red_fog_active.webp', color: 'red' },
    'gray': { label: 'Серый', img: 'grey_fog_active.webp', color: 'gray' },
    'green': { label: 'Зелёный', img: 'green_fog_active.webp', color: 'green' },
    'blue': { label: 'Синий', img: 'blue_fog_active.webp', color: 'blue' },
    'purple': { label: 'Фиолетовый', img: 'purple_fog_active.webp', color: 'purple' },
    'red': { label: 'Красный', img: 'red_fog_active.webp', color: 'red' }
};

const recoveryMap = {
    'short': 'sr',
    'short rest': 'sr',
    'короткий': 'sr',
    'короткий отдых': 'sr',
    'long': 'lr',
    'long rest': 'lr',
    'длинный': 'lr',
    'длинный отдых': 'lr',
    'day': 'day',
    'день': 'day',
    'забег': 'lr'
};

const BASE_SRC_DIR = './src/packs/gacha-skills';
const DIST_DIR = './dist/packs/gacha-skills';

if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

const categories = fs.readdirSync(BASE_SRC_DIR).filter(item => {
    return fs.statSync(path.join(BASE_SRC_DIR, item)).isDirectory();
});

categories.forEach(category => {
    const currentSrcDir = path.join(BASE_SRC_DIR, category);
    const files = fs.readdirSync(currentSrcDir).filter(file => file.endsWith('.yaml'));

    files.forEach(file => {
        const rawData = fs.readFileSync(path.join(currentSrcDir, file), 'utf8');
        const skill = yaml.load(rawData);

        const rarityKey = skill.rarity ? skill.rarity.toLowerCase() : 'серый';
        const rarityData = rarityMap[rarityKey] || rarityMap['серый'];

        const usesText = skill.uses ? `${skill.uses}/${skill.recovery || 'забег'}` : (skill.recovery || 'Нет');
        const descriptionHtml = `
<p><strong>Категория:</strong> ${skill.category || 'УТИЛИТА'} | <strong>Редкость:</strong> ${rarityData.label}</p>
<p><strong>Теги синергий:</strong> ${(skill.tags || []).join(', ') || 'нет'}</p>
<p><strong>Перезарядка / Условия:</strong> ${usesText}</p>
<hr>
<p>${skill.description}</p>
        `.trim();

        const recoveryInput = skill.recovery ? skill.recovery.toLowerCase().trim() : '';
        const recoverySystemKey = recoveryMap[recoveryInput] || '';
        
        // Автоматическое назначение 1 заряда, если указано восстановление, но пропущен параметр uses
        const usesCount = skill.uses ? `${skill.uses}` : (recoverySystemKey ? "1" : "");
        const recoveryArray = (recoverySystemKey && usesCount) ? [{ period: recoverySystemKey, type: 'recoverAll' }] : [];

        const itemId = skill.id || generateId();

        const item = {
            _id: itemId,
            _key: `!items!${itemId}`,
            name: skill.name,
            type: "feat",
            img: `modules/gachadnd/assets/icons/skills/${rarityData.img}`,
            system: {
                description: {
                    value: descriptionHtml,
                    chat: "",
                    unidentified: ""
                },
                source: "Gacha Roguelike DnD5e",
                type: { value: "feat", subtype: "" },
                uses: {
                    spent: 0,
                    max: usesCount,
                    recovery: recoveryArray
                },
                activities: {}
            },
            flags: {
                gachadnd: {
                    rarity: rarityData.color,
                    rarity_label: rarityData.label,
                    category: skill.category || 'УТИЛИТА',
                    tags: skill.tags || [],
                    cooldown: usesText,
                    is_active: skill.activation && skill.activation !== 'none'
                }
            },
            effects: [],
            folder: null,
            sort: 0,
            ownership: { default: 0 }
        };

        if (skill.activation && skill.activation !== 'none') {
            const activityId = generateId();
            
            let activityType = 'utility';
            let isHeal = false;

            if (skill.save) {
                activityType = 'save';
            } else if (skill.damage && skill.damage.length > 0) {
                isHeal = skill.damage.some(d => d.type === 'healing' || d.type === 'temphp');
                activityType = isHeal ? 'heal' : 'damage';
            }

            const activity = {
                _id: activityId,
                type: activityType,
                name: "Активировать навык",
                activation: {
                    type: skill.activation,
                    value: 1, 
                    condition: "",
                    override: false
                },
                consumption: {
                    targets: usesCount ? [{ type: 'itemUses', value: '1' }] : [],
                    scaling: { allowed: false }
                }
            };

            if (skill.range) {
                activity.range = { value: skill.range, units: "ft" };
            }

            if (skill.target) {
                activity.target = {
                    template: {
                        count: 1,
                        type: skill.target.type,
                        size: `${skill.target.value}`,
                        units: "ft"
                    }
                };
            }

            if (skill.save) {
                activity.save = {
                    ability: [skill.save.ability],
                    dc: {
                        calculation: skill.save.dc?.calculation || "spell",
                        formula: ""
                    }
                };
            }

            if (skill.damage && skill.damage.length > 0) {
                if (isHeal) {
                    activity.healing = {
                        custom: { enabled: true, formula: String(skill.damage[0].formula) },
                        types: [skill.damage[0].type]
                    };
                } else {
                    activity.damage = {
                        parts: skill.damage.map(d => ({
                            custom: { enabled: true, formula: String(d.formula) },
                            number: null,
                            denomination: 0,
                            bonus: "",
                            types: [d.type]
                        }))
                    };
                }
            }

            item.system.activities[activityId] = activity;
        }

        if (skill.changes && skill.changes.length > 0) {
            item.effects.push({
                _id: generateId(),
                _key: `!items!${itemId}!effects!${generateId()}`,
                name: skill.name,
                img: `modules/gachadnd/assets/icons/skills/${rarityData.img}`,
                changes: skill.changes.map(c => ({
                    key: c.key,
                    mode: c.mode === 'add' ? 2 : 0, 
                    value: c.value,
                    priority: 20
                })),
                disabled: false,
                transfer: true,
                flags: {},
                tint: null
            });
        }

        const outputFilename = `${file.replace('.yaml', '')}_${skill.id}.json`;
        fs.writeFileSync(
            path.join(DIST_DIR, outputFilename),
            JSON.stringify(item, null, 2),
            'utf8'
        );
    });
});

console.log('Сборка завершена. База готова к упаковке.');