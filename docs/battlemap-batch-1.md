# Лес — первая партия (Gemini, ~25 картинок)

**К каждому запросу прикладывайте якорь** `assets/battlemap/forest/_anchor.webp`. Новый чат для каждого предмета
не нужен: в одном чате с якорем можно идти по списку, но если стиль начнёт «плыть» — начните новый чат и снова
приложите якорь. Не понравилось — правка «Keep everything the same, but …», а не перегенерация.

Готовые картинки — в `assets/battlemap/forest/` под именем из заголовка (`ground-grass-1.png` …). Фон, обрезку и
бесшовность доведу сам.

---

## Земля (бесшовные текстуры)

Общий шаблон, меняется только описание в кавычках `«…»`:

> Using exactly the art style and palette of the attached image, paint a square seamless tileable ground texture of «…», seen from straight above, filling the whole square evenly, with no distinct objects, no trees, no rocks and no path, calm with soft cloudy light and dark variation and only a few tiny details, so that copies placed side by side join without visible seams. Even lighting, no vignette.

| Файл | «…» |
|---|---|
| `ground-grass-1` | short mossy green grass like the open ground in the attached image |
| `ground-forest-floor-1` | dark forest floor under trees: moss, a few fallen leaves and pine needles, slightly darker and cooler than the grass |
| `ground-path-1` | packed sandy dirt like the path in the attached image, with a few small pebbles |
| `ground-mud-1` | wet dark brown mud with a few shallow puddles and grass tufts |
| `ground-riverbed-1` | murky shallow riverbed seen through dark teal-green water, silt and a few sunken stones |

## Деревья и растения (белый фон)

Общий шаблон:

> Using exactly the art style of the attached image, draw a single «…» seen from perfectly straight above, centred on a plain white background, filling about 80% of the image with empty white space around it. Light from the top left: warm highlights on its top left, darker cool shading on its lower right side, but no shadow cast onto the ground. Thin dark sepia outline on its silhouette only. Crisp clean edges.

| Файл | «…» |
|---|---|
| `tree-1` | round leafy tree canopy made of several large leaf clusters, like the trees in the attached image, trunk hidden under the leaves |
| `tree-2` | slightly irregular, larger leafy tree canopy with one side more lopsided, darker green, trunk hidden |
| `pine-1` | pine tree canopy seen from above: dark green needle clusters radiating from the centre in a star-like shape |
| `deadtree-1` | dead leafless tree seen from above: bare twisted grey-brown branches spreading out from the centre |
| `bush-1` | small round leafy bush, like a miniature tree canopy |
| `bush-2` | low fern bush with several fronds radiating out, like the ferns in the attached image |
| `reeds-1` | clump of tall reeds and a few cattails |

## Камни и дерево (белый фон, тот же шаблон, что у деревьев)

| Файл | «…» |
|---|---|
| `rock-1` | medium grey boulder with moss patches on top, like the rocks in the attached image |
| `rock-2` | flatter, wider grey rock slab, slightly cracked, with moss in the cracks |
| `boulder-1` | large rounded mossy boulder, about twice the size of the others |
| `log-1` | fallen mossy tree log lying horizontally across the image, bark visible, one cut end showing the rings |
| `stump-1` | old cut tree stump with visible rings and moss around the edge |
| `ruin-1` | straight horizontal section of ruined stone wall, broken uneven top, moss in the cracks, a few fallen bricks beside it |

## Россыпь — мелочь для краёв (белый фон)

> Using exactly the art style of the attached image, draw a set of eight separate small «…» seen from straight above, evenly spaced apart in a grid on a plain white background, none touching each other. No shadow on the ground. Thin dark sepia outlines.

| Файл | «…» |
|---|---|
| `scatter-tufts-1` | spiky grass tufts, like the tufts along the path in the attached image |
| `scatter-pebbles-1` | small grey pebbles and stones |
| `scatter-twigs-1` | fallen twigs and small branches |
| `scatter-mushrooms-1` | clusters of small brown forest mushrooms |
| `scatter-ferns-1` | small fern sprigs |

## Наше — Туман и Пожиратель

| Файл | Промт |
|---|---|
| `crystal-1` | (шаблон деревьев) cluster of pale teal glowing crystals growing out of the ground, faceted, with a soft teal glow around them |
| `rot-1` | Using exactly the art style of the attached image, paint an irregular patch of black-teal corruption spreading over the ground, seen from straight above, on a plain white background: oily near-black rot in the middle with thin glowing teal veins, its edges breaking up into small creeping tendrils and fading out softly. No shadow, no outline. |
