# Доработать позже

- **Счётчик ауры** (`scripts/memory/skills/aura*.js`, `src/packs/gacha-skills/anomaly/aura_counter.yaml`) — работает, но правила и подача требуют доработки. Проверить в Foundry: КД −2 через `system.attributes.ac.bonus`, автоматический спасбросок Мудрости (`rollSavingThrow` с `target`), сохранение помехи и −5 позёрства при открытом окне броска, корона на HUD токена в v13.
- **Перегрев** (`scripts/memory/overheat.js`) — проверить в Foundry: трата заряда активностью dnd5e ловится в `preUpdateItem` (обновление через `actor.updateEmbeddedDocuments`), повторный вызов `activity.use()` после выбора цели у Перезарядки и Оверклокинга (цена 2d6 ПЗ), сброс на долгом отдыхе.
