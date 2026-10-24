# Фоновые звуки арены — кандидаты с Freesound (CC0)

Все звуки ниже — **Creative Commons 0** (общественное достояние): можно встроить в бесплатный модуль без указания
автора. Лицензия проверена 24.10.2026 по странице каждого звука. Файлы не скачивались: скачивание с Freesound
требует входа в аккаунт. Как слушать: на странице звука — кнопка воспроизведения над волной.

**Как будет звучать в игре.** На арене — звук окружения Foundry на всё поле, по кругу (громкость каждый игрок
крутит своим ползунком «Окружение»). Фон — по настроению и погоде: день — лес, ночь — насекомые, ливень, ветер,
туман Предела. Погода заменяет фон, «Снять погоду» возвращает его.

**Куда класть.** `assets/sounds/arena/`. Имя файла начинается с фона: `forest-day`, `forest-night`, `swamp`
(топь днём), `swamp-night`, `rain`, `wind`, `fog`; вариантов сколько угодно — `forest-day-1`, `forest-day-2`…
Модуль находит их сам и не ставит прошлый вариант подряд. Нет файла — тишина (у топи — лесной фон). Формат любой
из `.ogg`, `.mp3`, `.wav`, `.flac`, `.m4a`; большие WAV переведу в `.ogg` и ужму до 1–3 МБ.

**В бою** фон стихает до четверти громкости — настройка «Фон арены в бою» (тише, выключить, как есть).

---

## 1. Ливень

| Звук | Длит. | Автор | Чем подходит |
|---|---|---|---|
| [Rain at night medium](https://freesound.org/people/jgxxx/sounds/704395/) | 1:44 | jgxxx | Ночной лес под сильным дождём, сделан под петлю. Длинный — повтор не слышен. **Мой выбор.** |
| [Heavy_Rain_Loop](https://freesound.org/people/Rubaoliva/sounds/624645/) | 0:15 | Rubaoliva | Сильный ровный ливень, игровая петля. Короткий — на слух может повторяться. |

## 2. Ветер

| Звук | Длит. | Автор | Чем подходит |
|---|---|---|---|
| [wind_forest_08_strong](https://freesound.org/people/teadrinker/sounds/403051/) | 1:21 | teadrinker | Сильный ветер в кронах, листва шуршит, записан петлёй. **Мой выбор.** |
| [Wind through trees (loop)](https://freesound.org/people/NomadApe/sounds/444921/) | 1:10 | NomadApe | Сильный ветер сквозь деревья, бесшовная петля; запись на телефон — чуть грязнее. |
| [Strong Wind](https://freesound.org/people/florianreichelt/sounds/459981/) | 0:43 | florianreichelt | Порывистый сильный ветер без деревьев — злее, но не лесной. |

## 3. Лес днём (фон без погоды)

| Звук | Длит. | Автор | Чем подходит |
|---|---|---|---|
| [Ambiance Natural Forest Birds Wind Loop](https://freesound.org/people/Nox_Sound/sounds/570492/) | 0:30 | Nox_Sound | Птицы и лёгкий ветер, петля. **Мой выбор.** |
| [Forest birds — ambient seamless loop](https://freesound.org/people/Magnesus/sounds/723913/) | 0:27 | Magnesus | Птицы в лесу, бесшовная петля для игры. Без ветра — тише и светлее. |

## 4. Лес ночью

| Звук | Длит. | Автор | Чем подходит |
|---|---|---|---|
| [Night Insects in September (loop)](https://freesound.org/people/NickTayloe/sounds/825635/) | 2:40 | NickTayloe | Ночной хор сверчков и кузнечиков, бесшовная петля. **Мой выбор.** |
| [Summer Night in the Swamp](https://freesound.org/people/hafijur_rahman/sounds/853607/) | 0:33 | hafijur_rahman | Сверчки и лягушки у пруда — для топи. Не петля, склею сам. |

## 5. Туман Предела

| Звук | Длит. | Автор | Чем подходит |
|---|---|---|---|
| [Mystic Forest Ambient](https://freesound.org/people/szegvari/sounds/559389/) | 1:55 | szegvari | Мистический гул с ветром в лесу — «что-то не так с этим лесом». **Мой выбор.** |
| [Ominous Rumble — loopable](https://freesound.org/people/steaq/sounds/593785/) | 3:10 | steaq | Низкий тёмный гул, бесшовная петля. Тяжелее — скорее для Пожирателя. |

---

## Что стоит в модуле (24.10.2026)

Готовые файлы — `python tools/sound/arena.py` из скачанных в `assets/sounds/arena/_src/` (в git и выпуск не идут):
одна громкость, OGG, «Ночь на болоте» склеена в петлю.

| Файл | Звук |
|---|---|
| `forest-day-1`, `forest-day-2` | Nox_Sound 570492, Magnesus 723913 |
| `forest-night-1` | NickTayloe 825635 |
| `swamp-night-1` | hafijur_rahman 853607 |
| `rain-1`, `rain-2` | jgxxx 704395, Rubaoliva 624645 |
| `wind-1`, `wind-2` | teadrinker 403051, florianreichelt 459981 |
| `fog-1`, `fog-2` | szegvari 559389, steaq 593785 |

Если какой-то не понравится — назови настроение, подберу ещё.
