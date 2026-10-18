# Генератор арен: что нарисовать нейросетью (первый биом — лес и болото)

Карта собирается из маленьких кусков: бесшовные текстуры земли смешиваются по маскам, сверху ложатся наклейки
(пятна мха, листвы, лужи) и предметы (деревья, камни, руины). Вода, свет, туман, тени, настроение (кровь, порча,
ночь) — делает модуль шейдерами, их рисовать **не нужно**.

## Если генерируете в Gemini

Gemini понимает **связное описание обычными предложениями**, а не список тегов; отрицательных промтов и `--tile` у
него нет — запреты пишутся в тексте, лучше утвердительно («линия тонкая и коричневая», а не «без чёрного контура»).
Его сила — **правки диалогом** и **образец картинкой**. Порядок работы:

1. Якорь — промтом ниже. Из 3–4 вариантов выбрать ближайший и доводить правками («оставь всё как есть, но…»).
2. Готовый якорь **прикладывать к каждому следующему запросу**: «Draw it in exactly the same art style as the attached
   image».
3. Белый фон вместо прозрачного; бесшовность текстур доведу сам — достаточно «the texture should be seamless».

**Якорь стиля для Gemini** (одним абзацем):

```
Create a square top-down battle map tile for a tabletop fantasy RPG, seen from perfectly straight above like a map, about 7 by 7 grid squares in area, without drawing the grid. The scene is a small forest clearing: a sandy dirt path crosses it diagonally, two large tree canopies stand on either side, a few grey boulders sit at the base of the trees, and the edge of a dark murky pond is in one corner. The art is a polished hand-painted digital illustration in the style of premium virtual tabletop battle maps: clean shapes, rich but limited colours (warm ochre and olive for the ground, deep greens for foliage, dark teal-green for the water), and strong value contrast. Light comes from the top left: the tops of the canopies and rocks catch warm yellow-green highlights, and their lower right sides fall into deep, cool, dark shadow. Each tree canopy is built from several big rounded clusters of leaves, each cluster lit on its top left and shaded underneath, not drawn as concentric rings. The ground is calm and smooth with soft cloudy variation of light and dark, and almost no texture in the open middle; small details gather only at the edges — little spiky grass tufts and pebbles along the sides of the path, around the rocks and along the shoreline. The pond shore has a thin dark line with a second pale line just inside the water, like a reflection of the bank. All lines are thin, slightly broken and dark sepia brown, used only on the silhouettes of objects; the ground has no outlines. No text, no frame, no grid, no characters.
```

**Правки, если что-то не так** (по одной за раз, к последней картинке):

| Что не так | Что написать |
|---|---|
| бледно, плоско | Keep everything the same, but increase the contrast: make the shadows under and beside the trees and rocks much darker and cooler, and the sunlit tops brighter and warmer. |
| кроны — «штамп», кольца | Keep everything the same, but repaint the tree canopies as clusters of large rounded leaf clumps, each lit on the top left and shaded underneath, without concentric rings. |
| толстый чёрный контур, комикс | Keep everything the same, but make all outlines thin, slightly broken and dark sepia brown, and remove outlines from the ground. |
| земля пёстрая | Keep everything the same, but make the open ground calmer: smooth colour with only soft cloudy variation, and move the small details to the edges of the path, the rocks and the shore. |
| вода серая | Keep everything the same, but paint the water as deep murky teal-green, darker towards the middle, with a pale reflective line just inside the shore. |
| масло, мазок | Keep everything the same, but render it as a clean polished digital painting with smooth soft gradients, not visible thick brush strokes. |

**Отдельные предметы и текстуры в Gemini** — тем же языком, с якорем во вложении:

```
Using exactly the art style of the attached image, draw a single <что> seen from perfectly straight above, centred on a plain white background with empty space around it. Light from the top left with warm highlights on top and darker cool shading on the lower right side of the object itself, but no shadow cast onto the ground. Thin dark sepia outline on its silhouette only.
```

```
Using exactly the art style and palette of the attached image, paint a square seamless tileable ground texture of <что>, seen from straight above, filling the whole square evenly with no distinct objects, calm with soft cloudy light and dark variation, so that copies placed side by side join without visible seams.
```

Подставляйте вместо `<что>` описания из таблиц ниже (их можно оставить по-английски как есть).

## Общие правила (для всех картинок)

- **Вид строго сверху**, без перспективы и наклона камеры (как план). Никаких горизонтов, неба, людей, текста, рамок,
  сетки клеток.
- **Свет — сверху слева**, мягкий, одинаковый на всех картинках. Тени на самих предметах — лёгкие, внутри предмета;
  **падающую тень на землю не рисовать** — её добавит модуль.
- **Стиль — один на всё.** Сначала делается «якорь стиля» (ниже), дальше каждый запрос идёт с ним как с образцом
  стиля (style reference / image prompt) и, по возможности, с тем же seed. Чужие боевые карты как образец не
  использовать — иначе получится копия чужого стиля.
- **Масштаб.** Клетка 5 футов = 140 px. Текстуры земли — 1024×1024 (≈ 7×7 клеток). Предметы — по размеру в клетках
  (указан у каждого), с запасом: дерево на 3 клетки — около 512×512.
- **Фон предметов и наклеек — сплошной белый** (или сплошной ярко-зелёный #00FF00, если предмет светлый). Фон я
  вырежу сам. Предмет целиком в кадре, не обрезан краем, вокруг — немного пустого фона.
- **Бесшовность текстур.** В Midjourney — параметр `--tile`; в других — «seamless tileable texture». Без
  выделяющихся пятен и предметов: текстура повторяется, любая «звезда» на ней будет видна узором.
- **Насыщенность — умеренная.** Модуль сам перекрашивает под ночь, порчу, кровь; слишком яркий исходник плохо
  тонируется.
- Имена файлов — как в списках ниже (`ground-grass-1.png` и т. п.), можно по нескольку вариантов: `-1`, `-2`, `-3`.

Общая «стилевая» часть, которая добавляется в конец каждого запроса:

```
top-down orthographic view, fantasy battle map asset in ink and wash style, thin broken sepia brown linework, calm flat colors with soft cloudy shading, limited palette of two or three hues, fine detail only at the edges and contours, crisp and clean, soft light from the top left, no cast shadow on the ground, no text, no grid, no border
```

Если генератор понимает «отрицательный» запрос (negative prompt / `--no`):

```
oil painting, impasto, thick brush strokes, thick black outlines, comic book, cartoon, blotchy, muddy colors, uniform noisy detail everywhere, photorealistic, hyper detailed, noise, grain, perspective, 3d render, text, watermark, grid
```

**Почему так.** У хороших боевых карт крупные поверхности спокойные (почти плоский цвет и мягкие облачные переходы),
а мелочь собрана у краёв: пучки травы по кромке тропы и берега, камешки и кости точками, двойная линия у воды. Линия —
тонкая, коричневая, местами прерывистая; толстый чёрный контур даёт комикс, крупный мазок — «масло». Цветов мало
(2–3 тона), объём — светлотой. Мелочь для краёв модуль раскидает сам из отдельных картинок (раздел 2а). Земля, по которой ходят, — светлее и спокойнее; препятствия (деревья,
камни, стены) — темнее и насыщеннее: так с одного взгляда видно, где можно пройти. Первый якорь был слишком подробным, второй — слишком «масляным»; цель — между ними: чисто и гладко.
Чужие карты как образец в генератор не подавать — модуль публикуется, а их лицензии обычно это запрещают.

## 0. Якорь стиля (одна картинка)

Не идёт в карту — по ней держим стиль остальных.

```
a small forest clearing seen from directly above, mossy ground, a winding dirt path, two tree canopies, a few rocks and ferns, a shallow murky pond edge, top-down orthographic view, fantasy battle map in ink and wash style, thin broken sepia brown linework, calm flat colors with soft cloudy shading, limited palette, fine detail clustered at edges: grass tufts along the path and the shore, a double line at the water edge, open calm ground in the middle, lighter walkable ground and darker obstacles, soft light from the top left, no text, no grid, no border
```

## 1. Земля — бесшовные текстуры 1024×1024

Шаблон: `seamless tileable texture of <что>, top-down orthographic view, evenly distributed detail, no distinct objects, fantasy battle map ground in ink and wash style, calm flat color with soft cloudy light and dark variation, almost no fine detail, limited palette, soft even light, no text, no grid` + `--tile`

| Файл | Что подставить вместо `<что>` |
|---|---|
| `ground-grass` (3 варианта) | short wild grass with tiny clover and scattered small leaves |
| `ground-forest-floor` (3) | dark forest floor covered with moss, pine needles and fallen leaves |
| `ground-moss` (2) | thick soft green moss with small damp patches |
| `ground-dirt` (2) | packed brown dirt with small pebbles and faint footprints |
| `ground-path` (2) | worn dirt trail ground with flat stones half buried |
| `ground-mud` (2) | wet dark mud with shallow puddles and grass tufts sticking out |
| `ground-bank` (2) | wet muddy riverbank soil with reeds stubble and small stones |
| `ground-riverbed` (2) | shallow murky riverbed, silt, pebbles and sunken leaves, seen through clear water |
| `ground-rock` (2) | rough mossy rocky ground, cracked stone slabs with soil between |
| `ground-roots` (1) | forest soil crossed by thick gnarled tree roots and moss |

## 2. Наклейки — пятна поверх земли (фон белый)

Неправильной формы, края **мягко растворяются** (без жёсткого контура), 256–512 px.

Шаблон: `an irregular patch of <что> with soft fading edges, isolated on a plain white background` + стилевая часть

| Файл | `<что>` |
|---|---|
| `decal-leaves` (4) | fallen autumn and green leaves scattered |
| `decal-moss` (3) | bright green moss growth |
| `decal-ferns` (3) | low ferns and small plants |
| `decal-flowers` (2) | small wild flowers among grass |
| `decal-puddle` (3) | shallow muddy puddle |
| `decal-mushrooms` (2) | cluster of small forest mushrooms |
| `decal-algae` (2) | green swamp algae and duckweed floating on water |
| `decal-pebbles` (2) | scattered pebbles and gravel |
| `decal-bones` (2) | scattered old animal bones and a skull |

## 2а. Россыпь — мелочь для краёв (фон белый, по 6–10 штук на одной картинке, с промежутками)

Модуль раскидывает её гуще у тропы, берега, подножий деревьев и камней. Каждая штука — ¼–½ клетки.

Шаблон: `a set of eight separate small <что>, evenly spaced apart, isolated on a plain white background` + стилевая часть

| Файл | `<что>` |
|---|---|
| `scatter-tufts` (3) | spiky grass tufts seen from above, star shaped |
| `scatter-tufts-dry` (2) | dry yellow spiky grass tufts seen from above |
| `scatter-pebbles` (2) | pebbles and small stones |
| `scatter-twigs` (2) | fallen twigs and small branches |
| `scatter-leaves` (2) | single fallen leaves |
| `scatter-flowers` (2) | tiny wild flower clusters |
| `scatter-bones` (1) | small bones and a skull |

## 3. Предметы (фон белый)

Шаблон: `a single <что>, seen from directly above, isolated on a plain white background, whole object in frame` + стилевая часть

**Деревья и растения** — кроны сверху: круглые, рваные по краю, видна текстура листвы, ствол не виден.

| Файл | Размер | `<что>` |
|---|---|---|
| `tree-oak` (4) | 3–4 клетки | broad leafy oak tree canopy |
| `tree-pine` (3) | 2–3 | pine tree canopy, dark needles radiating from the center |
| `tree-willow` (2) | 4 | weeping willow canopy with drooping long branches |
| `tree-mangrove` (2) | 3 | swamp mangrove tree canopy with tangled roots visible at the edges |
| `tree-dead` (3) | 2–3 | dead leafless tree, bare twisted branches spreading out |
| `bush` (4) | 1 | round leafy bush |
| `bush-thorny` (2) | 1 | dense thorny bramble bush |
| `reeds` (3) | 1 | clump of tall reeds and cattails |
| `lilypads` (3) | 1 | group of lily pads with one white flower, floating |
| `stump` (2) | 1 | old cut tree stump with rings and moss |
| `log` (3) | 2–3 в длину | fallen mossy tree log lying horizontally |
| `roots` (2) | 2 | tangle of exposed gnarled roots |

**Камни**

| Файл | Размер | `<что>` |
|---|---|---|
| `rock-small` (4) | ½ | small mossy rock |
| `rock-medium` (3) | 1 | medium boulder with moss on top |
| `rock-large` (3) | 2 | large flat-topped boulder, cracked, with moss |
| `rock-cluster` (2) | 2 | cluster of several mossy rocks |

**Руины** — дадут стены и укрытия.

| Файл | Размер | `<что>` |
|---|---|---|
| `ruin-wall` (3) | 3×1 | straight section of ruined stone wall, broken top, moss in the cracks, horizontal |
| `ruin-wall-corner` (2) | 2×2 | L-shaped corner of ruined stone wall |
| `ruin-wall-broken` (2) | 2×1 | crumbled low remains of a stone wall with scattered bricks |
| `ruin-pillar` (2) | 1 | broken round stone pillar seen from above, rubble around |
| `ruin-floor` (2) | 3×3 | fragment of old cracked flagstone floor overgrown with grass, irregular edges |
| `gravestone` (3) | 1 | old weathered gravestone lying slightly tilted, moss |
| `bridge-planks` (2) | 2×4 | small wooden plank footbridge, horizontal |

**Наше — Туман и Пожиратель** (это лицо модуля, такого нет в чужих наборах)

| Файл | Размер | `<что>` |
|---|---|---|
| `crystal-cluster` (3) | 1 | cluster of pale teal glowing crystals growing from the ground |
| `crystal-shard` (3) | ½ | single small teal crystal shard stuck in the ground |
| `rot-patch` (4) | 2–3 | irregular patch of black-teal corruption on the ground, oily dark rot with thin teal veins, soft fading edges |
| `rot-tendrils` (3) | 2 | black tendrils with teal sheen creeping across the ground from one side, soft fading edges |
| `fog-altar` (1) | 2 | small ancient stone shrine with a teal crystal on top, seen from above |

## Сколько и в каком порядке

1. Якорь стиля — сначала, и пришлите его мне: проверю, насколько он ложится в отрисовку.
2. Первая партия для прототипа: `ground-grass`, `ground-forest-floor`, `ground-dirt`, `ground-mud`, `ground-riverbed`,
   `tree-oak`, `tree-pine`, `bush`, `reeds`, `rock-medium`, `rock-large`, `log`, `ruin-wall`, `decal-leaves`,
   `decal-moss`, `rot-patch` — по 1–2 варианта (~25 картинок).
3. Остальное — после прототипа, когда будет видно, чего не хватает.

Готовые картинки — в `assets/battlemap/forest/` (папку создам), в исходном размере; фон и подгонку сделаю сам.
Проверьте условия генератора: результаты должны разрешать публикацию в модуле.
