# Зарисовки событий — промты

Промт = **стиль** (один для всех) + **сцена** события. Рисунок кладётся в `assets/sketches/<id>.webp`, в YAML события —
`image: { src, w, h }`; если на рисунке есть свет (огонь, окна, огоньки) — `lights` с координатами, их сниму с картинки.

## Стиль

```
graphite pencil and ink sketch in a traveler's field journal, loose confident hand-drawn lines, hatching for shadows,
details concentrated in the center, loose and unfinished towards the edges that fade into blank paper, monochrome,
plain flat white background, no paper texture, no border, no frame, no text, no signature, no people,
19th century expedition sketchbook
```

Негатив: `color, watercolor, paint, photo, photorealistic, 3d render, paper texture, parchment, frame, border, text, letters, watermark, signature, people, gradient background, blurry`

Соотношение 10:7 (около 1024×718). Источники света — пустая белая бумага с лёгким ореолом: свечение кладёт модуль.

## Лес и болота

| Событие | Сцена |
|---|---|
| `swamp_lights` — Огоньки над трясиной | готово |
| `hunters_tower` — Вышка охотников | a rickety wooden hunting tower rising above swamp reeds, half its ladder rungs broken, a leather backpack hanging on a rope from the top platform, a crow sitting on the railing, bare birches and mist behind |
| `hungry_stump` — Пень, который просит | a huge old hollow tree stump overgrown with mushrooms and moss in a dark forest clearing, a deep black hollow in the middle, small broken crystal shards glinting in the moss around it, roots twisting into the ground |
| `bone_trail` — Тропа из костей | a narrow forest path through dense undergrowth littered with gnawed animal bones and antlers, deep claw marks in the mud, a broken young tree bent over the path, dark thicket ahead |

## Город в глуши

| Событие | Сцена |
|---|---|
| `honor_shop` — Лавка без продавца | the interior of a small empty village shop, a wooden counter with jars, bandages and bundles neatly arranged on shelves, an open door letting in light, a small hand-lettered sign board on the counter (blank, no letters) |
| `town_bell` — Колокол на площади | an empty cobblestone town square at dusk surrounded by leaning wooden houses with dark windows, a large bronze bell hanging from a wooden crossbeam in the middle, its rope hanging down, nobody around |
| `supper_for_two` — Ужин на двоих | a dark wooden village house at night, the only lit window, through the window a small table set for two with steaming bowls and a candle, a cloak hanging on a chair; the window light is blank paper |

## Море и острова

| Событие | Сцена |
|---|---|
| `bottle_letter` — Письмо в бутылке | a rocky beach with small waves, a corked glass bottle with a rolled letter inside lying in the foam, in the distance across the water a small island with a single lone tree |
| `white_flag` — Шлюпка с белым флагом | a pirate rowboat approaching a sandy shore, a tattered white flag on a short pole at the bow, several rough silhouettes of sailors at the oars, a larger ship anchored far behind |
| `singing_reef` — Поющий риф | jagged rocks of a reef rising from a calm moonlit sea, waves breaking softly around them, a faint trail of mist curling above the rocks like a song, a small boat in the foreground |

## Море в шторм

| Событие | Сцена |
|---|---|
| `man_overboard` — Человек за бортом | huge storm waves in heavy rain seen from a ship's deck, a broken mast floating in the water with a figure clinging to it, a coiled rope on the wet deck in the foreground |
| `dark_lighthouse` — Маяк без смотрителя | a tall stone lighthouse on a cliff in a raging storm, its lamp dark, the door banging open in the wind, waves smashing against the rocks below, rain slanting across the scene |
| `mast_lightning` — Молния в мачту | a sailing ship's mast struck by lightning in a storm, jagged bolt hitting the top, sparks running down the wet rigging and ropes, dark heavy clouds; the lightning bolt is blank paper |

## Глубины

| Событие | Сцена |
|---|---|
| `diving_bell` — Колокол водолаза | an old brass diving bell lying tilted on the sea floor among seaweed and rocks, a small trapped air bubble inside, something faintly glinting near its inner wall, small fish around, light rays from above |
| `angler_light` — Свет удильщика | pitch-black deep water, a single small glowing lure dangling on a long thin rod coming from the darkness, a vague huge jaw outline barely visible beneath it; the lure light is blank paper |
| `sunken_altar` — Затонувший Алтарь | an ancient stone altar on the sea floor covered with seaweed and coral, a carved stone bowl on top, faintly glowing runes along its sides, columns of a ruined temple behind; the runes are blank paper |

## Небесные острова

| Событие | Сцена |
|---|---|
| `cloud_bridge` — Облачный мост | two floating rocky islands high above the clouds, a long narrow bridge made of dense cloud stretching between them, small trees clinging to the island edges, birds far below |
| `giant_nest` — Гнездо | an enormous bird's nest made of branches on a rocky ledge above the clouds, several large crystals lying in it instead of eggs, a huge bird silhouette circling high in the sky |
| `moon_observatory` — Обсерватория на краю | a small domed stone observatory on the very edge of a floating island, a brass telescope pointing at a large full moon, scratched marks on its wooden door, endless clouds below; the moon is blank paper |
