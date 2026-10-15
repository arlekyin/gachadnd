# Доработать позже

- **Счётчик ауры** (`scripts/memory/skills/aura*.js`, `src/packs/gacha-skills/anomaly/aura_counter.yaml`) — работает, но правила и подача требуют доработки. Проверен в Foundry 13.351 / dnd5e 5.2.5 (`node tools/foundry/aura.mjs`). Открыто: у персонажа с КД `flat` (фиксированное значение) dnd5e не прибавляет `ac.bonus`, поэтому КД −2 от «Открыться» и «Ва-банк» на него не действует.
