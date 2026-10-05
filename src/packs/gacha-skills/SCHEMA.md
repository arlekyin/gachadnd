# Схема YAML-навыков

Один файл — один навык. Папка определяет категорию. `node build.mjs` проверяет каждый файл и при любой ошибке останавливает сборку с указанием файла и поля.

| Папка | Категория |
|---|---|
| `anomaly` | АНОМАЛИЯ |
| `damage` | УРОН |
| `defense` | ЗАЩИТА |
| `memory` | ПАМЯТЬ |
| `mobility` | МОБИЛЬНОСТЬ |
| `resource` | РЕСУРС |
| `synergy` | СИНЕРГИЯ |
| `utility` | УТИЛИТА |

## Поля

| Поле | Обязательно | Значения |
|---|---|---|
| `id` | да | Ровно 16 латинских букв и цифр. Уникален. Не меняется после публикации. |
| `name` | да | Уникально (без учёта регистра). |
| `rarity` | да | `gray`, `green`, `blue`, `purple`, `red` |
| `category` | нет | Если указано — должно совпадать с категорией папки. |
| `tags` | нет | Список тегов из словаря синергий (`scripts/synergy-data.js`). |
| `description` | да | Текст. Пустая строка — новый абзац, одиночный перенос — `<br>`. HTML экранируется. |
| `activation` | нет | `none` (по умолчанию, пассивный навык), `action`, `bonus`, `reaction`, `special`, `minute`, `hour`, `day`, `shortRest`, `longRest`, `encounter`, `turnStart`, `turnEnd`, `legendary`, `mythic`, `lair`, `crew` |
| `uses` | нет | Целое число > 0. Если указан `recovery`, а `uses` нет — 1 заряд. |
| `recovery` | нет | См. таблицу ниже. |
| `range` | нет | Дальность в футах. |
| `target` | нет | `{ type, value }`: шаблон области. `type`: `cone`, `cube`, `cylinder`, `line`, `radius`, `sphere`, `square`, `wall`, `circle`; `value` — размер в футах. |
| `save` | нет | `{ ability, dc, on_save }` — см. ниже. |
| `damage` | нет | Список `{ formula, type }`. |
| `changes` | нет | Список изменений Active Effect `{ key, mode, value }`. Действуют, пока навык находится на листе. |
| `max_stacks` | нет | Целое число > 0. |
| `tagEmitter` | нет | `true` — навык излучает выбранный тег (Сингулярность). |

`range`, `target`, `save`, `damage`, `uses`, `recovery` допустимы только при `activation`, отличном от `none`.

## recovery

| Значение | Период dnd5e | Когда восстанавливается |
|---|---|---|
| `short` | `sr` | Короткий и длинный отдых |
| `long` | `lr` | Длинный отдых |
| `day` | `day` | Новый день |
| `turn` | `turn` | Каждый ход в бою (1 раз в ход) |
| `round` | `turnStart` | Начало вашего хода (1 раз в раунд) |
| `combat` | `initiative` | Бросок инициативы (1 раз за бой) |
| `floor` | `gachaFloor` | Кнопка «Создать Этаж» в Карте Разлома или `game.gachadnd.recoverUses('gachaFloor')` |
| `run` | `gachaRun` | `game.gachadnd.recoverUses('gachaRun')` |
| `scene` | `gachaScene` | `game.gachadnd.recoverUses('gachaScene')` |
| `none` | — | Никогда |

## save

- `ability`: `str`, `dex`, `con`, `int`, `wis`, `cha`.
- `dc` (по умолчанию `spellcasting`):
  - `spellcasting` — сложность заклинаний персонажа; без заклинательной характеристики — 8 + бонус мастерства;
  - `universal` — 8 + бонус мастерства + наивысший модификатор характеристики;
  - `str` … `cha` — сложность по указанной характеристике;
  - число — фиксированная сложность;
  - `{ formula: "8 + @prof" }` — произвольная формула.
- `on_save`: `half` (по умолчанию), `none`, `full` — урон при успешном спасброске.

## damage

- `formula`: формула броска, например `3d8`, `1 + @prof`.
- `type`: `acid`, `bludgeoning`, `cold`, `fire`, `force`, `lightning`, `necrotic`, `piercing`, `poison`, `psychic`, `radiant`, `slashing`, `thunder`; лечение — `healing`, `temphp`.
- Лечение — только одна запись, без урона и без `save`.

## changes

- `key`: путь в данных актёра, начинается с `system.` или `flags.` (например `system.bonuses.mwak.attack`, `system.skills.ste.roll.mode`).
- `mode`: `add`, `override`, `upgrade`, `downgrade`, `multiply`, `custom`.
- `value`: значение, записывается строкой.

## Пример

```yaml
id: JqCKPHlCBj5lY2B9
name: Фус-Ро-Да
rarity: purple
tags:
  - взрыв
  - движение
description: Каждое существо в 15-футовом конусе совершает спасбросок Силы...
activation: action
recovery: short
target:
  type: cone
  value: 15
save:
  ability: str
damage:
  - formula: 3d8
    type: thunder
```
