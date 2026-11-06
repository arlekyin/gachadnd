# Второй этаж — подземелья (утверждено; порядок этажей — позже)

Второй этаж — подземелья: катакомбы, а за Заставой — пещеры. Как сдвинуть остальные этажи (море, глубины, небо) —
решим позже. Подземелье проще моря и понятнее за столом: стены, двери, факелы, колонны — тактика читается
с первого взгляда, а геометрия на сетке проще леса.

## Главное: подземелье у нас уже есть

Сама схема подземелья — это **паутина этажа**: узлы — комнаты, рёбра — проходы; Застава, Пожиратель и Босс — особые
залы. Поэтому генерировать подземелье целиком, как donjon, не нужно. Генератор строит **одну комнату боя** под узел
и встречу — так же, как сейчас лесная арена строится под узел (`arenaFor`, `scripts/labyrinth/encounters.js`).
Размеры прежние: Монстры 24×18, Элита и Застава 28×20, Босс 30×22 клетки.

## Биомы этажа

| Биом | Где | Что это | Кто живёт |
|---|---|---|---|
| `crypt` — **Катакомбы** | до Заставы | кладка, ниши со скелетами, склепы, колонны, факелы | нежить, культисты, звери подземелий |
| `caves` — **Пещеры** | после Заставы | порода, грибы, кристаллы, подземная вода, провалы | чудища, слизи, аберрации |

- `FLOORS` в `scripts/labyrinth/biomes.js`: этаж 2 → `['crypt', 'caves']` (с 29.10.2026). Море и шторм пока не
  стоят ни на одном этаже — куда их, решим позже; их события (бутылка, маяк, риф…) до тех пор не выпадают.
- Пещеры пока строятся схемами и артом катакомб; своих встреч и событий у подземелий ещё нет — встречи берутся из
  всех таблиц, события — общие («any»).
- Набросок под паутиной — `assets/sketches/biome-crypt.webp` и `biome-caves.webp`, промты — в
  `docs/sketch-prompts.md`, тем же стилем, что у прочих биомов.
- События и встречи по биому — отдельной работой: таблицы `Встречи: Катакомбы: …` и `Встречи: Пещеры: …`, свой
  набор событий. В этом документе — только арена.

## Что взять у существующих генераторов

| Подход | Откуда | Что берём |
|---|---|---|
| Комнаты и коридоры, разбиение прямоугольниками | классические рогалики, donjon | основа коридорного боя и связки комнат |
| Наращивание комнат разной формы (прямоугольник, крест, круг, восьмиугольник, пещерный ком) с петлями; озёра, провалы с мостами | Brogue | разнообразие формы без хаоса; провал с мостом как тактический узел |
| Клеточный автомат | генераторы пещер | естественные пещеры: порода, карманы, перешейки |
| Ручные заготовки, сшитые по графу прохода | Spelunky, Enter the Gungeon, Diablo | отдельные «залы-заготовки» (алтарь Босса, решётка Заставы) хорошего качества, генератор их комбинирует |
| Обстановка по назначению комнаты | Dungeon Alchemist, Instant Dungeons | предметы ставятся по смыслу комнаты (склеп, оружейная, святилище), а не россыпью |
| Одна строчка «что это за место» | Watabou One Page Dungeon | подпись арены в карточке встречи: «склеп с тремя саркофагами», «мост над провалом» |
| Свет и тень в готовых наборах | разбор Czepeku (`docs/arena-reference.md`) | «живая муть» над тёмными местами, факелы кучками, стены по кладке, пещеры — ломаной по краю породы |

## Схемы арен

Схема — это тактика, как у леса (`SCHEMES` в `scripts/arena/layout.js`). Выбор — по узлу и врагам (`pickScheme`):
стрелков много — больше длинных линий обзора, ближний бой — теснее.

### Катакомбы

| Схема | Что | Тактика | Вес |
|---|---|---|---|
| `hall` — **зал с колоннами** | большой зал, 2–3 ряда колонн, ниши по стенам | укрытия, обход колонн, стрелки прячутся | основная; Элита и Босс — чаще |
| `corridors` — **коридоры** | 2–3 коридора шириной 2–3 клетки, перекрёсток, боковые ниши | строй решает, узкое место, отступать некуда | ближний бой — чаще |
| `rooms` — **связка комнат** | 3–5 комнат, двери между ними, одна петля | бой через двери; кто открыл дверь — тот под ударом | Монстры — чаще |
| `crypt` — **склеп** | зал с саркофагами рядами, ниши-лежанки по стенам | низкие укрытия, нежить «из стен» (ниши у краёв — места появления) | нежить в отряде врагов — чаще |
| `chasm` — **провал** | зал, рассечённый провалом, 1–2 моста | перешеек под ударом, обход по краю, столкнуть с моста | стрелков много — чаще |
| `sanctum` — **святилище** (только Босс) | алтарь на возвышении в дальнем конце, дорожка-ковёр, жаровни, колонны по бокам | у Босса — позиция, у отряда — укрытия на подходе | Босс |
| `gate` — **застава** (только Застава) | решётка или баррикада поперёк, бойницы, за ней караульная | штурм узкого места: решётку поднимают, баррикаду обходят | Застава |

### Пещеры

| Схема | Что | Тактика |
|---|---|---|
| `cavern` — **пещера** | клеточный автомат: большая полость, карманы, 2–3 перешейка | укрытия — валуны, кристаллы и грибы, бой в карманах |
| `lake` — **подземное озеро** | полость с водой посередине, отмели (трудная местность), каменные островки | обход по берегу против брода по воде |
| `fissure` — **расселина** | длинная трещина-провал через пещеру, каменный мост, уступы | как `chasm`, только неровно |
| `grotto` — **грибной грот** | несколько гротов, соединённых лазами, светящиеся грибы | мало света, тёмное зрение решает |
| `mine` — **заброшенная выработка** | прямые штольни с крепью, вагонетка, отвалы породы | коридорный бой в пещере |

## Правила генерации

**План в клетках, потом рисунок** — как у леса: из плана получаются картинка, стены, свет и регионы.

1. **Карта клеток:** порода, пол, дверь, вода, провал, завал. Комнаты — из заготовок формы (прямоугольник, крест,
   круг, восьмиугольник, пещерный ком), пещеры — клеточным автоматом (4–5 проходов, потом убрать мелкие карманы).
2. **Кромки:** отряд входит с одной кромки, враги стоят у противоположной — как сейчас (`startCells`, `formation`).
   Расстояние между строями — 6–10 клеток, чтобы первый ход не был сразу ударом.
3. **Проходимость:** от отряда к врагам всегда есть путь (`connected`, иначе другой сид). Кроме коридоров —
   хотя бы два разных пути (петля), чтобы бой не сводился к одной двери.
4. **Укрытия:** в средней трети поля 3–6 укрытий (колонны — полное, саркофаги, ящики, завалы — половинное), не
   ближе 2 клеток друг к другу. Проверка: у стрелков врага есть линия обзора на кромку отряда, но не на всю.
5. **Стены Foundry по краю пола:** соседние отрезки сливаются в один; пещеры — сглаженная ломаная по краю породы
   (marching squares + упрощение), не больше ~300 отрезков. Колонны — маленькие замкнутые стены.
6. **Двери** — настоящие двери Foundry, режут взгляд. Четыре вида:
   - **открытые** — на главном пути между строями;
   - **закрытые** — в боковые комнаты и на обходные пути;
   - **запертые** (закрытая дверь Foundry с замком) — в боковую комнату или на обход, никогда на единственном пути
     между строями: путь без них всегда есть. Отпереть — проверка, которую решает Мастер; модуль лишь ставит замок;
   - **тайные** (тайная дверь Foundry: игроки её не видят, Мастер видит) — короткий обход или ниша с добычей; не
     больше одной на арену и не на каждой. Найти — тоже решение Мастера.
   Мастер меняет любую дверь как обычно в Foundry.
7. **Провалы и вода** — регионы: вода — «Трудная местность» dnd5e (как ручей в лесу), отмели — тоже; провал — регион
   без автоматики, с подписью «провал» (падение решает Мастер). Завалы — трудная местность.
8. **Свет — два вида темноты:**
   - **полная темнота** — сцена тёмная (темнота 1, без общего света), видно только то, что освещено: факелы на
     стенах, жаровни, светящиеся грибы, алтарь — кучками у входов и важных мест, между ними — темнота. Факелы
     героев и тёмное зрение решают, куда идти. Часть настенных факелов погашена;
   - **условная темнота** — картинка ночная (тёмная, тёплые пятна света нарисованы и стоят светильниками), но
     общий свет включён: видно всё, как ночные карты наборов Czepeku. Для быстрых боёв и для стола, которому не
     нужна возня со светом.
   Какая — у каждой арены своя: по умолчанию Монстры — условная, Элита — то так, то так, Застава и Босс — чаще
   полная; настройка мира «Темнота подземелий»: по встрече / всегда условная / всегда полная. Карточка встречи
   пишет, какая. Над водой и провалом — «живая муть» в цвет биома.
9. **Обстановка по назначению:** у каждой комнаты есть назначение (склеп, оружейная, кладовая, святилище, караульная)
   — оно решает, какие предметы и где: саркофаги рядами, стойки у стен, ящики в углах, алтарь у дальней стены.
   Мелочь (кости, паутина в углах, мох, трещины) — у стен и в углах, середина пола спокойная.
10. **Подпись:** в карточку встречи — одна строка о месте («склеп: три саркофага, ниши со скелетами»).

### Рисунок

- **Пол** — бесшовные текстуры, смешанные по маскам (как земля в лесу): плиты, стёртые плиты, земляной пол,
  каменный пол пещеры, завал.
- **Стены сверху** — почти чёрная масса (у пещер — тёмная порода с крупными трещинами) с тонкой кромкой; вдоль стен на полу — мягкая тень
  (затенение углов). Это главное, что делает подземелье читаемым, — делает модуль, рисовать не нужно.
- **Предметы** — картинками на белом фоне, как деревья и камни леса.
- **Настроения** — те же механизмы, что у леса: пробуждение Босса (бледность и пепел), порча Пожирателя, туман.
  Вместо «ночи» — **полная темнота** (п. 8). Погода боя под землёй: **подтопление**
  (вода поднимается — больше трудной местности), **сквозняк** (гасит часть факелов, помеха на дальние атаки),
  **ядовитые испарения** (туман, ограниченный обзор).

## Тайники и предметы арены

Чтобы отряд не шёл напролом, а смотрел по сторонам: лучшая позиция и лучший ход — не на прямой линии к врагу.
Одно правило на всё: **ценное на арене есть, только пока идёт бой** — после боя обходить комнату незачем.

### Тайники

- **1–2 на арену** (у Босса — 2), осколок Памяти, а не мебель.
- **Вне главного пути:** в нише, в боковой комнате, за запертой или тайной дверью, на краю провала, в саркофаге,
  в обходном коридоре заставы — не ближе 3 клеток к кратчайшему пути строев, не на кромках и не рядом друг с другом.
  Так запертые и тайные двери и обходы получают смысл.
- **Открыть — действие героя рядом.** Выбор: потратить ход и отойти с линии боя ради добычи или бить.
- **Бой кончился — неоткрытые тайники рассеиваются в Туман** (сами, без Мастера). Обходить комнату после боя
  бессмысленно.
- **Добыча маленькая** и из экономики забега (осколки, кристалл, мелочь): соблазн, а не обязанность. Что именно —
  отдельно, вместе с наградами этажа.

### Предметы арены

2–3 вещи на арену, с которыми можно что-то сделать. Модуль ставит их и пишет в карточку встречи («треснувшая
колонна, жаровни ×2, тайник за запертой дверью»); **что случится — решает Мастер**, подсказка с действием —
отключаемая. На сцене — ничего сверх самих предметов: описания в карточке, не над токенами.

| Схема | Предмет | Что можно сделать |
|---|---|---|
| зал с колоннами | треснувшая колонна (1–2, в средней трети) | обрушить на линию к врагам; за ней остаётся завал |
| коридоры | шаткий свод в узком месте | обвалить: коридор закрыт, враги разделены |
| склеп | саркофаги с крышкой (2) | сдвинуть крышку: внутри тайник или ещё один мертвец |
| провал | верёвочный мост; край провала у прохода | обрубить мост; столкнуть с края |
| святилище | жаровни у возвышения; люстра на цепи | погасить жаровни (цель боя); уронить люстру на ковёр |
| застава | рычаг решётки — на стороне врагов | дотянуться через обход или прорвавшись |
| связка комнат | люстра в самой большой комнате | уронить |
| зал, склеп, комнаты | холодная жаровня в тёмной части поля | зажечь: в полной темноте открывает кусок карты |

### Цели боя (Элита и Босс, изредка)

Кроме «убить всех» — одна цель, которую видно в карточке: погасить жаровни, пока Босс под защитой; дотянуть рычаг,
пока решётка закрыта; вынести пленника. Немного — иначе каждый бой станет заданием. Сейчас в макете — только у
святилища.

## Сверка с готовыми наборами

Для сверки скачаны три набора Czepeku: Lich Catacomb, Verem Cellars, Mushroom Infested Mines. Лежат в
`G:\foundry\references\czepeku\` — вне репозитория: лицензия личная, только смотреть глазами. В модуль и в Gemini
их не прикладывать. Что видно:

- **Стена — это пустота, а не кладка.** У Verem комнаты вырезаны в ровной почти чёрной массе, без рисунка камней; у
  Lich и в шахтах — тёмная порода с крупными трещинами и тёмно-красными или синими отсветами. Кромка — тонкая линия,
  к полу — мягкая тень. Рисовать «блоки кладки сверху» не нужно: это и проще, и читается лучше.
- **Пол светлее и теплее стены**: охра и песочный камень (Verem), тёплый серо-красный (Lich), холодный сиреневый
  (шахты). Контраст «светлый пол — чёрная масса» и делает план понятным.
- **Свет делает настроение**: красное свечение у Lich, светящиеся грибы и вода у шахт — яркие пятна на тёмном.
  Это наш свет и «живая муть», не картинка.
- **Мелочь — у стен и в углах**: бочки, ящики, полки вдоль стен, середина свободна (Verem).
- **Пещеры** — порода большими тёмными пятнами-островами, проходы между ними, рельсы и вода связывают части.

Поэтому в якоре ниже стена — тёмная масса с тонкой кромкой, а текстуры `wall-top-1` и `wall-rock-1` нужны только
как слабая фактура этой массы.

## Картинки (Gemini, как лес)

Правила и шаблоны промтов — как в `docs/battlemap-assets.md`: вид строго сверху, белый фон, свет сверху-слева,
тонкий сепия-контур только по силуэту. Готовые — в `assets/battlemap/crypt/` и `assets/battlemap/caves/`.

**Якорь стиля катакомб** — готов: `assets/battlemap/crypt/_anchor.webp` (прикладывать к каждому запросу). Его промт
(одним абзацем), плюс правки: ровный свет без пятна факела, тёмная тонкая стена, плиты разного размера со
сломанными швами:

```
Create a square top-down battle map tile for a tabletop fantasy RPG, seen from perfectly straight above like a map, about 7 by 7 grid squares in area, without drawing the grid. The scene is a small underground crypt chamber: an old flagstone floor, two thick stone columns, a closed stone sarcophagus, a narrow corridor leaving from one side through a wooden door, and a wall-mounted torch casting warm light. The art is a polished hand-painted digital illustration in the style of premium virtual tabletop battle maps: clean shapes, a limited palette of warm ochre stone, warm orange torchlight, near-black walls and dark umber shadows, and strong value contrast. Light comes from the top left and from the torch: the tops of the columns and the sarcophagus lid catch highlights, their lower right sides fall into deep cool shadow. The walls are an almost black, flat mass with no visible blocks, separated from the floor by a thin dark line and a soft shadow on the floor along the wall. The floor is warm ochre and sandy stone, clearly lighter than the walls, calm with soft variation, small details only along the walls and in the corners — a few bones, cobwebs, cracks and moss. All lines are thin, slightly broken and dark sepia brown, used only on the silhouettes of objects. No text, no frame, no grid, no characters.
```

**Якорь стиля пещер** (одним абзацем):

```
Create a square top-down battle map tile for a tabletop fantasy RPG, seen from perfectly straight above like a map, about 7 by 7 grid squares in area, without drawing the grid. The scene is a small natural cave: an open area of uneven cave floor, two large dark rock masses rising like islands with a passage between them, a still pool of dark water at one edge, and a cluster of glowing pale-blue mushrooms. The art is a polished hand-painted digital illustration in the style of premium virtual tabletop battle maps: clean shapes, a limited palette of muted violet-grey and warm brown cave floor, near-black rock masses, deep teal water and small bright spots of cold blue mushroom light, with strong value contrast. Light comes from the top left: mushrooms and rocks catch highlights, their lower right sides fall into deep cool shadow. The rock masses are almost black with a few large cracks and a faint coloured sheen, separated from the floor by a thin dark line and a soft shadow on the floor around them. The floor is clearly lighter than the rock, calm with soft variation, small pebbles and mushrooms only along the rock edges. All lines are thin, slightly broken and dark sepia brown, used only on the silhouettes of objects. No text, no frame, no grid, no characters.
```

**Как работать** — как с лесом (`docs/battlemap-batch-1.md`): к каждому запросу прикладывать якорь (для пещер — свой
якорь), подставлять в шаблон вместо `«…»` описание из таблицы (по-английски, как есть). Не понравилось — правка
«Keep everything the same, but …», а не перегенерация. Готовое — в `assets/battlemap/crypt/` или `caves/` под именем
из таблицы; фон, обрезку и бесшовность доведу сам.

### Пол — бесшовные текстуры 1024×1024

Шаблон:

> Using exactly the art style and palette of the attached image, paint a square seamless tileable floor texture of «…», seen from straight above, filling the whole square evenly, with no objects, no walls, no furniture and no bones, calm with soft light and dark variation and only a few tiny details, so that copies placed side by side join without visible seams. Even lighting, no torchlight, no vignette.

| Файл | «…» |
|---|---|
| `crypt/ground-flagstone-1` | old dark, cool grey-brown flagstone floor (a few slabs slightly greyer, a few slightly browner), still lighter than the walls: large slabs of different sizes and shapes (square, long rectangular, a few irregular polygonal), joints that break and change direction instead of forming straight lines; slabs about one grid square or bigger |
| `crypt/ground-flagstone-2` | the same dark cool grey-brown flagstones, more worn and cracked, some slabs missing with dirt between them |
| `crypt/ground-dirt-1` | packed dark earth floor of a cellar with a few pebbles |
| `crypt/ground-rubble-1` | broken stone rubble and gravel spread over the floor |
| `crypt/wall-top-1` | almost black flat stone mass seen from above with only a very faint, barely visible texture (used for the walls) |
| `caves/ground-cave-1` | natural cave floor: mostly flat bedrock in muted violet-grey and cool grey-brown, large soft irregular patches of lighter and darker stone, a few long thin cracks, fine grain and grit; no separate rocks, no rounded bumps, no puddles |
| `caves/ground-cave-wet-1` | the same texture as the dry cave floor, but wet: glossy sheen and thin pale mineral stains along the cracks, no puddles (делать от сухого, приложив его) |
| `caves/wall-rock-1` | almost black cave rock mass seen from above with a few large cracks and a faint coloured sheen (used for the walls) |

### Наклейки — пятна поверх пола (белый фон)

Шаблон (края мягко растворяются, без контура):

> Using exactly the art style and palette of the attached image, draw an irregular patch of «…» seen from straight above, with soft fading edges and no outline, isolated in the centre of a plain white background with empty space around it. Even lighting, no shadow.

| Файл | «…» |
|---|---|
| `crypt/decal-cracks-1` | a web of thin dark cracks in stone |
| `crypt/decal-moss-1` | a patch of dark green moss and damp stains |
| `crypt/decal-cobweb-1` | a dusty cobweb filling a corner (for room corners) |
| `crypt/decal-puddle-1` | a shallow dark puddle on stone |
| `crypt/decal-carpet-1` | a long worn red carpet runner, frayed edges (for the sanctum) |
| `caves/decal-minerals-1` | pale mineral crust and stains on rock |
| `caves/decal-puddle-1` | a shallow dark puddle of still water on cave rock, with a thin glossy rim and a few pebbles under the surface (лужи — только наклейками: в текстуре они повторяются сеткой) |

### Россыпь — мелочь для краёв (по 6–10 на картинке)

Шаблон:

> Using exactly the art style of the attached image, draw a set of eight separate small «…» seen from straight above, evenly spaced apart in a grid on a plain white background, none touching each other. No shadow on the ground. Thin dark sepia outlines.

| Файл | «…» |
|---|---|
| `crypt/scatter-bones-1` | scattered small bones and skull fragments |
| `crypt/scatter-debris-1` | small stone chips and broken masonry bits |
| `caves/scatter-pebbles-1` | small rounded pebbles and rock chips |
| `caves/scatter-mushrooms-1` | tiny pale cave mushrooms in small clusters |

### Предметы (белый фон)

**Ракурс:** плоское и низкое (пол, плиты, саркофаги, столы, кости) — строго сверху. Высокое и стоячее (двери,
решётки, стойки, статуи) можно под небольшим углом, как в Isaac: сверху и чуть спереди — так видна
высота. Тогда в шаблоне вместо «from perfectly straight above» — «from above at a slight three-quarter angle, so its
height is visible».

Шаблон (колонка «Клеток» — для меня, в промт не вставлять):

> Using exactly the art style of the attached image, draw a single «…» seen from perfectly straight above, centred on a plain white background, filling about 80% of the image with empty white space around it. Even soft light from the top left: warm highlights on its top left, darker shading on its lower right side, but no shadow cast onto the ground and no glow of light around it. Thin dark sepia outline on its silhouette only. Crisp clean edges.

| Файл | «…» | Клеток |
|---|---|---|
| `crypt/pillar-round-1` | thick round stone column seen from straight above, capital ring visible | 1 |
| `crypt/pillar-square-1` | square stone pillar with carved edges | 1 |
| `crypt/pillar-broken-1` | broken column stump with fallen chunks around it | 1 |
| `crypt/column-fallen-1` | a long fallen stone column lying on the floor, broken in two | 1×4 |
| `crypt/sarcophagus-1` | closed stone sarcophagus with a carved lid | 1×2 |
| `crypt/sarcophagus-open-1` | open sarcophagus, lid pushed aside, bones inside | 1×2 |
| `crypt/niche-1` | burial niche in a wall seen from above: a skeleton lying on a stone shelf | 1×2 |
| `crypt/bone-pile-1` | heap of bones and skulls | 1 |
| `crypt/crates-1` | two stacked wooden crates and a barrel | 1 |
| `crypt/table-1` | old wooden table with two benches | 2×1 |
| `crypt/weapon-rack-1` | wooden weapon rack with spears and swords, against a wall | 2×1 |
| `crypt/altar-1` | stone altar with candles and a dark cloth | 2×1 |
| `crypt/brazier-1` | iron brazier with burning coals (the glow is added by the module) | 1 |
| `crypt/torch-1` | wall-mounted torch in an iron sconce, seen from above | ½ |
| `crypt/statue-1` | statue of a hooded figure on a plinth | 1 |
| `crypt/rubble-1` | pile of collapsed stone blocks | 1–2 |
| `crypt/door-1` | heavy wooden door with iron bands, closed, seen from above in a doorway | 1 |
| `crypt/door-locked-1` | the same heavy door with a big iron padlock and a chain across it | 1 |
| `crypt/portcullis-1` | iron portcullis grid across a passage | 1×2 |
| `crypt/barricade-1` | barricade of planks, barrels and crates across a passage | 1×3 |
| `crypt/bridge-1` | narrow stone bridge with low parapets | 1×4 |
| `crypt/bridge-wood-1` | rope-and-plank bridge | 1×4 |
| `caves/mushrooms-1` | large glowing pale-blue cave mushrooms (the glow is added by the module) | 1 |
| `caves/crystal-1` | cluster of violet crystals growing from the rock | 1 |
| `caves/rock-1` | large rounded cave boulder | 1–2 |
| `caves/minecart-1` | rusty mine cart on a short piece of rail | 1×2 |
| `caves/rails-1` | straight mine rails on wooden sleepers (seamless along their length) | 1×4 |
| `caves/props-1` | wooden mine support frame (two posts and a beam) across a tunnel | 1×3 |

Провал, вода, свет факелов, тени у стен, туман — делает модуль, рисовать **не нужно**. Итого: 8 текстур,
6 наклеек, 4 россыпи, 30 предметов и второй якорь — около 49 картинок; тайная дверь не рисуется — на картинке она просто стена; первая партия — якорь катакомб, плиты, стена, колонны,
саркофаги, факел, жаровня, дверь, кости, завал (~15) — на ней собирается первый генератор (`hall`, `crypt`, `rooms`).

## Порядок работы

1. **Макет планировок без рисунка** — клетки, стены, все четыре вида дверей, укрытия, свет схемой (оба вида темноты),
   по 6 сидов на каждую схему катакомб; проверить тактику. Сделан: `tools/mockups/dungeon/` — генератор `layout.js`
   (без Foundry, переедет в `scripts/arena`), страница `index.html`, снимки `layout-*.png` (`shots.mjs`).
   Тайники и предметы арены — там же (`pointsOfInterest`).
2. Первая партия картинок (~15) и рисунок катакомб.
3. Генератор в игре: `layout` подземелья, стены и двери, свет, регионы, настройка «Темнота подземелий»; проверка
   `tools/foundry/arena.mjs` — новые случаи, песочница — макросы «Арена: катакомбы …».
4. Пещеры (клеточный автомат, вода, расселины) — вторая партия картинок.
5. События и встречи биомов — отдельно.

## Решения

0. **Сталагмитов нет:** сверху они не читаются ни в каком ракурсе; укрытия в пещерах — валуны, кристаллы, грибы.


1. **Названия биомов:** «Катакомбы» (`crypt`) и «Пещеры» (`caves`).
2. **Этажи:** как сдвинуть море, глубины и небо — решим позже.
3. **Схемы:** утверждены — катакомбы `hall`, `corridors`, `rooms`, `crypt`, `chasm`, `sanctum`, `gate`; пещеры
   `cavern`, `lake`, `fissure`, `grotto`, `mine`.
4. **Темнота:** два вида — полная (видно только освещённое) и условная (ночная картинка, видно всё); по арене и
   настройкой мира (п. 8 правил).
5. **Двери:** открытые, закрытые, запертые и тайные (п. 6 правил); отпереть и найти — решает Мастер.
