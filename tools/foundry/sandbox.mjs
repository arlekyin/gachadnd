// Песочница для ручной проверки навыков: node tools/foundry/sandbox.mjs
// Запускается после проверок: пересоздаёт сцену «GD-песочница» с героями, у которых выданы и
// экипированы проверяемые навыки, врагами, союзником, стенами, тайными дверями и фонарём, готовит
// бой (не начатый) и оставляет журнал «как проверять». Проверки (префикс «GD-тест») её не трогают.
import { connect } from './harness.mjs';
import { install, skills, classKit } from './fixtures.mjs';

export const SANDBOX = 'GD-песочница';

/** Герои песочницы и их навыки. Уровень 10 — 11 слотов: всё экипировано в пределах лимита */
const HEROES = [
    {
        name: 'Светоносец', x: 6, y: 8, level: 10,
        skills: ['Ультрафиолет', 'Скорость света', 'Призма', 'Солнечная батарея', 'Рикошет', 'Маяк', 'Диско-шар', 'Вспышка камеры', 'Спотлайт', 'Счётчик ауры']
    },
    {
        name: 'Поджигатель', x: 8, y: 12, level: 10,
        skills: ['Это нормально', 'Пол — это лава', 'Раскалённый клинок', 'Феникс', 'Горячая картошка', 'Ссссс…', 'Красная бочка', 'Взрыв трупа', 'Утечка газа', 'Ох, да!']
    },
    {
        name: 'Мясник', x: 9, y: 9, level: 10,
        skills: ['Хлопушка', 'Чутьё мясника', 'Навылет', 'Рандомная хрень, вперёд!', 'Переливание', 'Медленный яд', 'Сверхновая']
    },
    {
        name: 'Перегревщик', x: 6, y: 11, level: 5,
        skills: ['Перезарядка', 'Оверклокинг', 'Стена? Какая стена?', 'Сюжетная броня', 'Само совершенство']
    },
    {
        name: 'Живой', x: 7, y: 6, level: 12,
        // Связки синергий — от тегов: огонь (Уголь, Пироман) + яд, движение + взрыв, кровь + щит
        skills: ['Набить руку', 'Третий раз — за правду', 'Обратный отсчёт', 'Тлеющий уголь', 'Пироман', 'Сомелье', 'Глубокий вдох', 'Ох, да!', 'Голос предков', 'Шипастый панцирь', 'Жажда боя', 'Каска']
    },
    // Эхо: у каждого — свой голос и эхо уже на Видении; echo — что выставить, slots — сдвиг естественного лимита
    { name: 'Эхо: кровь', x: 10, y: 6, level: 6, skills: ['Кровавая цена', 'Бензопила', 'Берсерк', 'Без пощады'], echo: { value: 11, tags: { 'кровь': 11 } } },
    { name: 'Эхо: разум', x: 11, y: 10, level: 6, skills: ['Переговорщик', 'Между небом и землёй', 'Счётчик ауры'], echo: { value: 9, tags: { 'разум': 9 } }, slots: -7 },
    // Огранка: у воина огонь II, кровь I, взрыв I; у жреца кровь II, огонь I, взрыв I — столько камней тега можно вставить.
    // Воин — оружие и черты класса, жрец — заклинания всех категорий; камни вставлены для примера
    { name: 'Огранка: воин', x: 9, y: 8, level: 8, skills: ['Хлопушка', 'Тлеющий уголь', 'Раскалённый клинок', 'Феникс', 'Обратный отсчёт', 'Берсерк', 'Жажда боя'] },
    { name: 'Огранка: жрец', x: 10, y: 9, level: 8, skills: ['Кровавая цена', 'Бензопила', 'Берсерк', 'Жажда боя', 'Хлопушка', 'Обратный отсчёт'] },
    // Огранка новых тегов: свет I, движение I, сталь I — Луч, Разбег, Выверено в мечах, Рокировка — в Ударе
    { name: 'Огранка: страж', x: 8, y: 9, level: 8, skills: ['Фотосинтез', 'Ультрафиолет', 'Краб', 'Лунная походка', 'Крушитель мебели', 'Тюремная заточка'] },
    // Все шесть тегов на ступени I — по камню каждого, собирать самому
    // Огранка броска и цели: проклятье I, казнь I, разум I, аномалия I
    { name: 'Огранка: оракул', x: 10, y: 8, level: 8, skills: ['Полукровка', 'Слышащий шёпот', 'Чтец некрологов', 'Детектор лжи', 'Контрольный', 'Палач'] },
    { name: 'Огранка: мастер', x: 8, y: 8, level: 12, skills: ['Тлеющий уголь', 'Раскалённый клинок', 'Хлопушка', 'Обратный отсчёт', 'Берсерк', 'Жажда боя', 'Фотосинтез', 'Ультрафиолет', 'Краб', 'Лунная походка', 'Крушитель мебели', 'Тюремная заточка'] },
    { name: 'Эхо: аномалия', x: 12, y: 7, level: 6, skills: ['Часы с кукушкой', 'Должник', 'Желудок хроноискателя'], echo: { value: 10, tags: { 'аномалия': 10 } } }
];
const OTHERS = [
    { name: 'Союзник', type: 'character', x: 4, y: 9, disposition: 1 },
    { name: 'Огнеупорный', type: 'npc', x: 13, y: 8, disposition: -1, traits: { dr: { value: ['fire'] }, di: { value: ['poison'] } } },
    { name: 'Враг', type: 'npc', x: 16, y: 6, disposition: -1 },
    { name: 'Враг 2', type: 'npc', x: 16, y: 11, disposition: -1 }
];

const GUIDE = `
<h2>Песочница навыков</h2>
<p>Сцену, героев и бой пересоздаёт <code>node tools/foundry/sandbox.mjs</code> — после проверок Claude. Всё здесь можно ломать.</p>
<p><strong>Бой</strong> подготовлен, но не начат: «Начать бой» в трекере. Навыки, которым нужен бой, без него откажут.</p>
<h3>Светоносец (уровень 10)</h3>
<ul>
<li><strong>Ультрафиолет</strong> — в верхней стене две тайные двери: ближняя в 25 футах проступает, дальняя (справа) — нет.</li>
<li><strong>Скорость света</strong> — в чужой ход: ход Светоносца начинается сразу, свой ход в этом раунде он пропускает.</li>
<li><strong>Призма</strong> — затем выберите целью Огнеупорного (сопротивление огню, иммунитет к яду) и бросьте урон мечом: в карточке урона цветная строка раскладки на 7 типов, «Применить» — и в чат придёт итог по цели: что срезало сопротивление и иммунитет.</li>
<li><strong>Солнечная батарея</strong> — заряд за конец хода на ярком свету. Ночь: Освещение сцены → темнота 1; фонарь слева внизу светит и ночью. Заряды видно в окне использования.</li>
<li><strong>Рикошет</strong> — прицел мышью, луч отражается от стен комнаты: 2 раза, на ранге II — 3, на III — 4; Esc или правая кнопка — отмена.</li>
<li><strong>Маяк</strong> — конус ставится мышью, колесо поворачивает луч. Каждый раунд луч поворачивается на 90°.</li>
<li><strong>Диско-шар</strong> — в бою: 6 цветных пятен, кто на пятне — тянет карту Пятницы.</li>
<li><strong>Вспышка камеры</strong> — в бою: снимок; повторное использование — проявка (места и ПЗ).</li>
<li><strong>Спотлайт</strong> — в бою: сначала выберите цель (T) — она станет звездой; без цели звезда — сам. Повторное использование переводит луч на новую цель. Кнопка «Подыграть» — в карточке чата.</li>
<li><strong>Счётчик ауры</strong> — в бою; повторное использование — панель с позёрством.</li>
</ul>
<h3>Поджигатель (уровень 10)</h3>
<ul>
<li><strong>Это нормально</strong> — в бою: клетка мышью; огонь расходится каждый раунд, стены его держат. Поджигатель в огне не горит, а получает временные ПЗ.</li>
<li><strong>Пол — это лава</strong> — в бою: кто закончит ход там же, где начал, горит. Свечение по краям экрана. Поднятый токен (высота &gt; 0) не горит.</li>
<li><strong>Раскалённый клинок</strong> — атакуйте мечом выбранную цель: попадания греют клинок (надпись над токеном), нагрев 4 — плавится. Использование навыка — конус сброса жара.</li>
<li><strong>Феникс</strong> — в бою опустите ПЗ Поджигателя до 0: пепел, в начале его хода — возрождение. На карточке — «Растоптать пепел».</li>
<li><strong>Горячая картошка</strong> — в бою: цель вплотную (T). Таймер шёпотом; «Передать своей цели» на карточке.</li>
<li><strong>Ссссс…</strong> — в бою: если к концу следующего хода рядом враг — взрыв; никого — заряд вернётся.</li>
<li><strong>Красная бочка</strong> — две клетки мышью. Ударьте бочку — взрыв и цепная реакция.</li>
<li><strong>Взрыв трупа</strong> — опустите врагу ПЗ до 0, выберите его целью. Убил взрывом — кнопки цепочки.</li>
<li><strong>Утечка газа</strong> — в бою: клетка мышью, облако видно только вам. Урон огнём по кому-то в облаке (или пожар) — взрыв.</li>
<li><strong>Ох, да!</strong> — наведите рывок на стену комнаты: стена разрежется, Поджигатель окажется за ней.</li>
</ul>
<h3>Мясник (уровень 10)</h3>
<ul>
<li><strong>Хлопушка</strong> — бонусным действием: все в 10 футах без реакций до начала своего хода (в бою эффект снимется сам).</li>
<li><strong>Чутьё мясника</strong> — выделите Мясника и опустите врагу ПЗ ниже половины: над ним капля крови (видит только тот, кто ведёт Мясника). Дальше 30 футов — капли нет.</li>
<li><strong>Навылет</strong> — добейте врага мечом Мясника («Применить» в лотке урона): лишний урон — кнопкой в карточке соседу убитого.</li>
<li><strong>Рандомная хрень, вперёд!</strong> — выберите цели (T) и используйте: окно — какой клинок в кого (у Мясника в сумке Кинжал и Ручной топор). Брошенное лежит у цели, «Подобрать» — в карточке; что не подобрали до конца боя — пропадёт.</li>
<li><strong>Переливание</strong> — цель (T) в 30 футах: обмен долями ПЗ; враг кидает спасбросок Телосложения, союзник согласен. Цена — истощение.</li>
<li><strong>Медленный яд</strong> — в бою, цель (T): три раунда считает весь её урон (эффект «Медленный яд: N»), в начале третьего раунда возвращает его ядом.</li>
<li><strong>Сверхновая</strong> — в бою копит урон по Мяснику («Сверхновая: N»); использование — взрыв в 20 футах, Мясник ошеломлён.</li>
</ul>
<h3>Сделка луны</h3>
<p>На сцене начерчена карта этажа, отряд стоит на узле Босса. Откройте Карту этажа (кнопка на панели токенов) и щёлкните по узлу Босса — у всех откроется Сделка. Без игроков в мире отряд — все персонажи этой сцены; Мастер выбирает, за кого кладёт жертвы, щелчком по портрету.</p>
<ul>
<li>Щелчок по карте лота — луна опускает её к себе, это выбранный лот. Щелчок по навыку в руке или по жетону (Кость Хитов, ПЗ, осколок маски — слот Памяти, золото, кристаллы Хранилища) — жертва на чашу. Щелчок по своей гирьке на чаше — забрать.</li>
<li>Набрали цену — полнолуние, печать краснеет. «Скрепить» — жертвы уходят навсегда, лот выдаётся; для Чужой памяти и Сплава — окно выбора.</li>
<li>У Перегревщика 1000 зм и синий кристалл в Хранилище. Сделка — раз за этаж: заново её даст только пересборка песочницы.</li>
</ul>
<h3>Перегревщик (уровень 5)</h3>
<ul>
<li>Потратьте заряд Стена? Какая стена?, затем Перезарядка или Оверклокинг (цена 2d6 ПЗ) — заряд вернётся заёмным. Со второго заёмного использования до долгого отдыха — бросок к100.</li>
<li><strong>Само совершенство</strong> — в бою: каждое действие нового вида зажигает штрих (точки ✦ над токеном). Навык Памяти и зелье модуль отмечает сам; использование навыка — окно огранки: Манёвр, Помощь, Приём, Окружение кнопками, у Мастера — любой штрих. Передайте ход без нового штриха — «Небрежно». Пять — «Почти» (+1), семь — к20 не ниже 10 до конца следующего хода.</li>
</ul>
<h3>Терминал Тумана — новый вид</h3>
<ul>
<li>Откройте Терминал любого героя: слева наползает Туман, навыки — пластины с камнями. Надетые горят, Память тлеет, пунктир — свободные слоты. Щелчок по пластине — надеть или снять, правый щелчок — лист навыка.</li>
<li>Наведение — навык в латунной панели справа внизу; у синергий загораются ромбы, которые он добавит (или гаснут, если снять), и меняется название ступени.</li>
<li>Метки на пластине: слева вверху — чем используется (зелёный круг — действие, оранжевый треугольник — бонусное, кольцо со стрелкой — реакция, звезда — особое; у пассивных нет), справа — ромбы зарядов. У Перегревщика после заёма — треснувший камень и «заём».</li>
<li>Кнопки в правом верхнем углу — как у карты: «Карта этажа» переключает на паутину, Туман остаётся на месте; на паутине кнопка с мозгом — обратно.</li>
<li>Токен выбирать не нужно: Терминал откроется для своего персонажа (у Мастера — первого героя). Портреты под кнопками справа вверху — листать героев (стрелки или щелчок по портрету); в панели боя — стрелки у имени.</li>
<li>Способности синергий и связок — отдельным полем «Способности» под синергиями: янтарный камень, под названием — откуда (тег и ступень или два тега связки). Наведение или щелчок показывают способность в панели подробностей, применять — кнопкой «Использовать» там (щелчок по ней в поле ничего не тратит).</li>
<li>Начните бой — Терминал станет панелью над хотбаром: щелчок по камню — использовать навык, наведение — карточка. Кнопка с мозгом — Сборка.</li>
</ul>
<h3>Живой (уровень 12) — счётчики, связки синергий, шрамы</h3>
<ul>
<li><strong>Набить руку</strong> — дайте Живому оружие и бросайте урон атакой: зарубки у токена (⚒), пятый удар — критический.</li>
<li><strong>Третий раз — за правду</strong> — два проваленных спасброска с Сл (кнопка в карточке) — счёт ☯ 2, следующий бросок к20 с преимуществом.</li>
<li><strong>Обратный отсчёт</strong> — в бою: выделите врага (T) и используйте. Над ним ⏱ 3, минус один в начале хода Живого; на нуле или при гибели — взрыв.</li>
<li><strong>Тлеющий уголь</strong> — точка мышью; добивайте врагов огнём — 🔥 растёт, каждые 3 — радиус +5 футов.</li>
<li><strong>Связки синергий</strong> — у Живого по 2 навыка огня и яда, движения и взрыва, крови и щита: Чумной костёр, Реактивная тяга и Кровавый бастион — способностями под синергиями в Терминале. Снимите навык яда — Чумной костёр пропадёт.</li>
<li><strong>Чумной костёр</strong> — в бою: облако; кто начнёт в нём ход — карточка огня и яда.</li>
<li><strong>Реактивная тяга</strong> — в свой ход отойдите на 3 клетки: позади взрыв.</li>
<li><strong>Кровавый бастион</strong> — поставьте Союзника рядом и нанесите Живому урон: кнопка в шёпоте даёт союзнику временные ПЗ.</li>
<li><strong>Шрамы</strong> — макрос <code>game.gachadnd.scar(game.actors.getName('GD-песочница: Живой'))</code>: шрам займёт слот, снять его нельзя.</li>
<li><strong>Правило Босса</strong> — в бою: <code>game.gachadnd.bossRule('muffle')</code> или <code>'sleepy'</code>.</li>
</ul>
<h3>Огранка — «Огранка: воин», «жрец», «страж», «оракул» и «мастер»</h3>
<p>У всех пятерых один набор способностей: оружие — Меч, Топор, Рапира, Кинжал (метательный), Длинный лук со стрелами; черты класса — Second Wind (Лечение), Action Surge и Rage (Усиление), Divine Smite (Удар); заклинания — Огненный снаряд, Направляющий луч, Волшебная стрела (Удар), Священное пламя, Пылающие руки, Громовая волна, Огненный шар (Волна), Исцеление ран, Исцеляющее слово, Массовое исцеляющее слово (Лечение), Благословение, Туманный шаг (Усиление), Щит, Адское возмездие (Реакция). Разница — в тегах навыков, то есть в камнях.</p>
<ul>
<li>Терминал → кнопка с камнем. Слева — оружие и категории способностей (Удар, Волна, Лечение, Усиление, Реакция) строками с тремя гнёздами; щелчок по строке — под ней её камни, крестик — вынуть. Справа — камни тегов: ромбы — сколько можно вставить, горят — вставлены. Щелчок по камню вставляет его в выбранную строку — любой камень в любое гнездо.</li>
<li><strong>Воин</strong> (огонь II, кровь I, взрыв I): Топор — Плата кровью и Перекидка; Удар (Divine Smite) — Раскат и Сквозь.</li>
<li><strong>Жрец</strong> (кровь II, огонь I, взрыв I): Лечение — Переливание и Разлёт; Волна — Мина; Удар (Огненный снаряд) — В долг.</li>
<li><strong>Страж</strong> (свет I, движение I, сталь I): Меч — Луч и Выверено (урон без костей, и всем на линии от героя к цели; цель — вплотную, в досягаемости меча); Топор — Разбег (отойдите, начните ход и пройдите 20 футов прямо к цели — атака с преимуществом). Переставьте Разбег на Рокировку — нацельтесь и примените: в карточке появится кнопка обмена местами с целью в 15 футах. Правило камня — подсказкой на его имени в строке «Огранка».</li>
<li><strong>Оракул</strong> (проклятье I, казнь I, разум I, аномалия I): Меч — Сглаз (атака с преимуществом, ваш следующий к20 — с помехой), Без пощады (у Врага ПЗ на половине — преимущество) и Двойное эхо (на кости 1 или 20 — кнопка «Ещё раз»); Удар — Перенаправить (промах Огненным снарядом — кнопки: на кого перенести с тем же броском). Переставьте: Неотвратимо (попадание, урон пополам), Возврат (промах — «Вернуть цену»), Приговор (на Врага выше половины ПЗ — объявляется; ударьте его до половины — карточка «Применить»), Кубик судьбы (к6 в чат), Шальной заряд (ещё раз по случайному существу в 30 футах), Добить (кнопка: лишний урон ближайшему), Отложенный выбор (в бою — напоминание в конце раунда).</li>
<li><strong>Мастер</strong> (все шесть тегов, ступень I): по камню каждого тега, ничего не вставлено — собирайте сами: например, Луч в Волну (Пылающие руки линией), Выверено в лук, Вспышка в Лечение (Исцеляющее слово всем рядом), Мина в Огненный шар.</li>
<li>В бою: нацельтесь и бросьте урон или лечение — карточки покажут, кому ещё досталось. Перекидка — ближайшему к цели. Мина — кнопки «Заложить» (щелчок по точке в 30 футах; войдите туда токеном врага) и «Сразу». Раскат — в начале следующего хода героя. В долг — вместо ячейки кости хитов. Плата кровью — кнопка в карточке способности.</li>
<li><strong>Броски</strong>: бросьте атаку, потом урон. Промах по цели — карточка «камни не сработали». Попадание — тем, кому достался эффект камня, та же атака против их КД (поставьте Врагу 2 КД 20 — увидите «мимо»). У Волны (Пылающие руки, Огненный шар) — кнопка спасброска в карточке камня. Мина пишет по шагам, как заложить и когда сработает; атака в ней «заморожена».</li>
<li>Снимите навык тега — его камни погаснут (последние вставленные), наденьте — вернутся. В бою огранку менять нельзя.</li>
<li>Со стороны игрока: войдите как Claude_player и дайте ему владение героем — Терминал откроется без выбранного токена.</li>
</ul>
<h3>Эхо — три героя с голосами</h3>
<p>Под шкалой эха в Терминале у Мастера две кнопки: <strong>«Шепнуть»</strong> — своя строка придёт игроку голосом (или «Строку голоса» — случайная из голоса) и <strong>«Его экран»</strong> — Видение этого героя у вас на экране, как видит игрок; вверху плашка «Экран: …» с кнопкой «Вернуть свой». Унять эхо можно у Знахаря в Якоре.</p>
<p>Видение рисуется только у того, кто ведёт персонажа. В песочнице игроков нет, поэтому у Мастера оно видно на <strong>выделенном</strong> токене героя без игрока-владельца: выделите героя Эха. Шкала эха и голос — в Терминале Тумана рядом с Пределом разума. Настройка клиента «Видения Эха» — полные, приглушённые, выключены.</p>
<ul>
<li><strong>Эхо: кровь</strong> (эхо 11) — красная виньетка в такт сердцу; у Врага 2 ПЗ ниже половины — за ним капает кровь. Используйте любой навык (Кровавая цена) — эхо дойдёт до 12: <strong>наплыв</strong>, карточка с воспоминанием и кнопками «Сыграть» (Вдохновение) и «Заглушить» (спасбросок Мудрости); у Мастера — «Отложить» и «Заменить желание».</li>
<li><strong>Эхо: разум</strong> (эхо 9, два слота сверх лимита) — начните бой: эхо +2 за лишние слоты, рядом с врагами появится фантом (к 12 эха — второй): копия самого многочисленного врага, а если все разные — самого потрёпанного, со следующим номером в имени, полными ПЗ и своей строкой в трекере. Его видит только этот игрок и Мастер, в мире его нет. Мастер видит его <strong>миражом</strong>: голубоватый, полупрозрачный, дышит, под именем — «мираж: чей»; в трекере строка тоже помечена. Мастер может перетащить мираж мышью и рассеять правым щелчком (с шёпотом голоса или молча). У игрока он неотличим от настоящего. Ходите по очереди: в свой ход фантом подсвечен и идёт к ближайшему герою; встал вплотную — рассеивается, голос шепчет. Выберите его целью и атакуйте: в карточке атака без цели, фантом тает. Один враг в бою — фантома нет. У края экрана изредка что-то мелькает.</li>
<li><strong>Эхо: аномалия</strong> (эхо 10) — рядом с токеном раз в полминуты проступают «сбойные» цифры: это следующий к20 героя. Бросьте любую проверку или спасбросок — выпадет именно это число, затем загадается новое.</li>
<li><strong>Шёпот голоса</strong> (с 4 эха) — строки приходят сами (начало боя, крит, ПЗ ниже половины, использование навыка). Свой шёпот голосом от Мастера: <code>game.gachadnd.echo.whisper(game.actors.getName('GD-песочница: Эхо: кровь'), 'текст')</code>.</li>
<li><strong>Долгий отдых</strong> — эхо −3. Эхо вручную: <code>game.gachadnd.echo.set(actor, { value: 12 })</code>.</li>
</ul>
`;

const f = await connect();
const { page } = f;
await install(page);

const ids = await page.evaluate(async ({ SANDBOX, HEROES, OTHERS, GUIDE }) => {
    const old = d => d.name?.startsWith(SANDBOX);
    for (const c of game.combats.filter(c => old(c.scene ?? {}))) await c.delete();
    await new Promise(r => setTimeout(r, 1000));
    await Actor.deleteDocuments(game.actors.filter(old).map(a => a.id));
    await Scene.deleteDocuments(game.scenes.filter(old).map(s => s.id));
    await JournalEntry.deleteDocuments(game.journal.filter(old).map(j => j.id));

    const grid = 100;
    const scene = await Scene.create({
        name: `${SANDBOX}: навыки`, width: 2400, height: 1600, padding: 0,
        grid: { type: 1, size: grid, distance: 5, units: 'ft' },
        tokenVision: false, fog: { exploration: false },
        environment: { darknessLevel: 0, globalLight: { enabled: true, darkness: { min: 0, max: 0.5 } } }
    });
    const wall = (x0, y0, x1, y1, door = 0) => ({ c: [x0 * grid, y0 * grid, x1 * grid, y1 * grid], door });
    await scene.createEmbeddedDocuments('Wall', [
        // Комната: стены — зеркала Рикошета
        wall(2, 3, 5, 3), wall(5, 3, 7, 3, 2), wall(7, 3, 18, 3), wall(18, 3, 20, 3, 2), wall(20, 3, 22, 3),
        wall(22, 3, 22, 14), wall(22, 14, 2, 14), wall(2, 14, 2, 3)
    ]);
    await scene.createEmbeddedDocuments('AmbientLight', [{ x: 4 * grid, y: 12 * grid, config: { bright: 15, dim: 30, color: '#ffd28a', alpha: 0.4 } }]);

    const weapon = { name: 'Меч', type: 'weapon', system: { type: { value: 'martialM', baseItem: 'longsword' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } };
    const made = {};
    for (const h of HEROES) {
        const a = await Actor.create({
            name: `${SANDBOX}: ${h.name}`, type: 'character',
            system: { abilities: { str: { value: 14 }, dex: { value: 14 }, con: { value: 14 }, wis: { value: 12 }, cha: { value: 16 } }, attributes: { hp: { value: 80, max: 80 } } },
            prototypeToken: { actorLink: true, disposition: 1, displayName: 30, displayBars: 30, bar1: { attribute: 'attributes.hp' } }
        });
        await a.createEmbeddedDocuments('Item', [{ name: 'Воин', type: 'class', system: { identifier: 'fighter', levels: h.level, hd: { denomination: 'd10' } } }, weapon]);
        made[h.name] = a;
    }
    for (const o of OTHERS) {
        made[o.name] = await Actor.create({
            name: `${SANDBOX}: ${o.name}`, type: o.type,
            system: { attributes: { hp: { value: 40, max: 40 }, ...(o.type === 'npc' ? { ac: { calc: 'flat', flat: 13 } } : {}) }, ...(o.type === 'npc' ? { details: { cr: 2 } } : {}), ...(o.traits ? { traits: o.traits } : {}) },
            prototypeToken: { actorLink: true, disposition: o.disposition, displayName: 30, displayBars: 30, bar1: { attribute: 'attributes.hp' } }
        });
        await made[o.name].createEmbeddedDocuments('Item', [weapon]);
    }
    const all = [...HEROES, ...OTHERS];
    await scene.createEmbeddedDocuments('Token', all.map(d => ({ ...made[d.name].prototypeToken.toObject(), actorId: made[d.name].id, name: made[d.name].name, x: d.x * grid, y: d.y * grid })));
    await scene.activate();
    await scene.view();
    // Мир запускается на паузе — в песочнице она мешает
    if (game.paused) game.togglePause(false, { broadcast: true });

    // Бой готов, не начат
    const combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments('Combatant', all.map((d, i) => ({
        tokenId: scene.tokens.find(t => t.actorId === made[d.name].id).id, sceneId: scene.id, actorId: made[d.name].id, initiative: 20 - i * 2
    })));

    await JournalEntry.create({ name: `${SANDBOX}: как проверять`, pages: [{ name: 'Навыки', type: 'text', text: { content: GUIDE } }] });
    return { heroes: Object.fromEntries(HEROES.map(h => [h.name, made[h.name].id])) };
}, { SANDBOX, HEROES, OTHERS, GUIDE });

for (const h of HEROES) await skills(page, ids.heroes[h.name], h.skills);
// Эхо: голос и громкость; лишние слоты — сдвигом естественного лимита; раненый враг для Видения крови
await page.evaluate(async ({ heroes, list, SANDBOX }) => {
    for (const h of list.filter(h => h.echo)) {
        const actor = game.actors.get(heroes[h.name]);
        if (h.slots) await actor.setFlag('gachadnd', 'extra_slots', h.slots);
        await game.gachadnd.echo.set(actor, { ...h.echo, story: {}, surge: null, full: false, foresee: null });
    }
    await game.actors.getName(`${SANDBOX}: Враг 2`)?.update({ 'system.attributes.hp.value': 15 });
}, { heroes: ids.heroes, list: HEROES, SANDBOX });

// Огранка: всем героям Огранки — один набор: оружие разных видов, черты класса и заклинания на каждую категорию
// (Удар, Волна, Лечение, Усиление, Реакция) — чтобы любой камень было куда вставить и с чем бросить
const FACET_HEROES = HEROES.filter(h => h.name.startsWith('Огранка')).map(h => ids.heroes[h.name]);
const FACET_WEAPONS = [['greataxe', 'Топор'], ['rapier', 'Рапира'], ['longbow', 'Длинный лук'], ['dagger', 'Кинжал'], ['arrow', 'Стрелы']];
const FACET_SPELLS = ['fire-bolt', 'sacred-flame', 'guiding-bolt', 'magic-missile', 'burning-hands', 'thunderwave', 'fireball',
    'cure-wounds', 'healing-word', 'mass-healing-word', 'bless', 'misty-step', 'shield', 'hellish-rebuke'];
for (const hero of FACET_HEROES) {
    await page.evaluate(async ({ hero, list }) => {
        // Компендиум может быть переведён — ищем по identifier
        const pack = game.packs.get('dnd5e.items'), index = await pack.getIndex({ fields: ['system.identifier'] });
        const docs = [];
        for (const [key, ru] of list) {
            const e = index.find(x => x.system?.identifier === key);
            if (!e) continue;
            const data = (await pack.getDocument(e._id)).toObject();
            foundry.utils.mergeObject(data, { name: ru, system: key === 'arrow' ? { quantity: 60 } : { equipped: true, proficient: 1 } });
            docs.push(data);
        }
        await game.actors.get(hero).createEmbeddedDocuments('Item', docs);
    }, { hero, list: FACET_WEAPONS });
    await classKit(page, hero, { features: ['Second Wind', 'Action Surge', 'Rage', 'Divine Smite'], caster: { name: 'Жрец', identifier: 'cleric', ability: 'wis' }, spells: FACET_SPELLS });
}
// Камни для примера: воин — Топор и Удар, жрец — Лечение, Волна, Удар, страж — Меч и Топор; у мастера пусто — собирать самому
await page.evaluate(async ({ warrior, cleric, guard, oracle }) => {
    const { placeStone } = await import('/modules/gachadnd/scripts/memory/facet/facet.js');
    const w = game.actors.get(warrior), c = game.actors.get(cleric), g = game.actors.get(guard), o = game.actors.get(oracle);
    const item = (a, name) => a.items.find(i => i.name === name && i.type === 'weapon').id;
    for (const [actor, where, id] of [[w, item(w, 'Топор'), 'pay'], [w, item(w, 'Топор'), 'hop'], [w, 'strike', 'echo'], [w, 'strike', 'through'],
        [c, 'heal', 'transfuse'], [c, 'heal', 'spread'], [c, 'wave', 'mine'], [c, 'strike', 'debt'],
        [g, item(g, 'Меч'), 'beam'], [g, item(g, 'Меч'), 'steady'], [g, item(g, 'Топор'), 'charge'],
        [o, item(o, 'Меч'), 'jinx'], [o, item(o, 'Меч'), 'mercy'], [o, item(o, 'Меч'), 'twin'], [o, 'strike', 'redirect']]) await placeStone(actor, where, id);
}, { warrior: ids.heroes['Огранка: воин'], cleric: ids.heroes['Огранка: жрец'], guard: ids.heroes['Огранка: страж'], oracle: ids.heroes['Огранка: оракул'] });

// Мяснику — что швырять (Рандомная хрень): неэкипированные клинки в сумке
await page.evaluate(hero => game.actors.get(hero).createEmbeddedDocuments('Item', [
    { name: 'Кинжал', type: 'weapon', img: 'icons/weapons/daggers/dagger-straight-blue.webp', system: { type: { value: 'simpleM' }, damage: { base: { number: 1, denomination: 4, types: ['piercing'] } }, equipped: false } },
    { name: 'Ручной топор', type: 'weapon', img: 'icons/weapons/axes/axe-broad-black.webp', system: { type: { value: 'simpleM' }, damage: { base: { number: 1, denomination: 6, types: ['slashing'] } }, equipped: false } }
]), ids.heroes['Мясник']);

// Сделка луны: карта этажа на сцене песочницы, отряд на узле Босса; Перегревщику — золото и кристалл в Хранилище
// Карта — рядами (Сделка луны стоит на узле Босса); поля заголовка — без окна (режим мог остаться «паутина»)
await page.evaluate(async () => {
    const m = await import('/modules/gachadnd/scripts/labyrinth/map.js');
    const form = document.createElement('div');
    form.innerHTML = '<input name="length" value="6"><input name="mode" value="rows">';
    await m.drawFloorFrom(form);
});
await page.waitForTimeout(600);
await page.evaluate(async hero => {
    for (const a of foundry.applications.instances.values()) if (a.constructor.name === 'GachaMapTerminal') await a.close();
    const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    const boss = map.nodes.find(n => n.type === 'boss');
    map.currentNodeId = boss.id;
    map.visitedNodes = [boss.id];
    await canvas.scene.setFlag('gachadnd', 'floorMap', map);
    const actor = game.actors.get(hero);
    await actor.update({ 'system.currency.gp': 1000 });
    const crystals = await import('/modules/gachadnd/scripts/memory/crystals.js');
    const stash = await import('/modules/gachadnd/scripts/memory/stash.js');
    const [crystal] = await actor.createEmbeddedDocuments('Item', [await crystals.randomCrystal('blue')]);
    await stash.depositCrystal(actor, crystal);
}, ids.heroes['Перегревщик']);

// Арена: макросы в папке «GD-песочница: арена» — собрать арену с нужным настроением, погодой и схемой
const ARENA_PAGE = `
<h2>Арена</h2>
<p>Макросы — в папке «${SANDBOX}: арена» (вкладка макросов; перетащите на панель). Каждый собирает сцену «Арена» заново
(30–40 секунд) с отрядом — Светоносцем и Поджигателем — слева и двумя врагами справа, и переводит всех на неё.</p>
<ul>
<li><strong>Катакомбы</strong> — арена подземелья (второй этаж): стены по краю пола, двери (открытые, закрытые, запертые с замком, тайные — Мастер видит их на слое стен), провал — регион без автоматики, завал — трудная местность. В полной темноте видно только у горящих факелов и жаровен — войдите игроком с тёмным зрением и без; в условной видно всё. Темнота на все бои — настройка «Темнота подземелий».</li>
<li><strong>День, ночь, порча</strong> — картинка и свет. <strong>Пробуждение 2 и 4</strong> — этаж бледнеет по ступеням Босса, красное ярче; на 3–4-й — пепел (своя погода сцены, ливень его сменяет, после снятия возвращается). На «Пробуждении 4» начните прорыв Пожирателя («Здесь» в предвестиях) — бледность и пепел мягко сойдут за катсцену: эффекты Босса и Пожирателя не складываются. Ночью сцена тёмная, светят друзы; войдите игроком с тёмным зрением и без — видно по-разному.</li>
<li><strong>Ливень, туман, ветер</strong> — погода. Начните бой: в чат придёт карточка с правилом, у Мастера на ней «Другая погода» и «Снять погоду». Туман сползает в начале каждого раунда; в ветер атака луком — с помехой сама.</li>
<li><strong>Чаща</strong> — лесистая арена: падают листья. <strong>Топь ночью</strong> — лягушки и сверчки.</li>
<li><strong>Трудная местность</strong> — вода, топь, подлесок, а под ливнем грязь и разлив: перетащите токен через ручей — линейка посчитает дороже. На слое регионов их не видно.</li>
<li><strong>Фон</strong> — звук по месту и погоде, играет у всех, выбран токен или нет. Громкость — вкладка плейлистов → «Управление громкостью» → блок Gacha Roguelike (фон арены, Терминал, тема героя, всё). В бою фон стихает.</li>
<li><strong>Встреча Босса</strong> — шёпот встречи, как на карте: «На арену» соберёт поле по узлу (30 × 22), строй врагов и погоду.</li>
</ul>`;
await page.evaluate(async ({ SANDBOX, ARENA_PAGE }) => {
    const folderName = `${SANDBOX}: арена`;
    const old = game.folders.filter(f => f.type === 'Macro' && f.name === folderName);
    for (const f of old) { await Macro.deleteDocuments(game.macros.filter(m => m.folder?.id === f.id).map(m => m.id)); await f.delete(); }
    const folder = await Folder.create({ name: folderName, type: 'Macro', color: '#2f4a2f' });
    const party = `['Светоносец', 'Поджигатель'].map(n => game.actors.getName('${SANDBOX}: ' + n)?.id).filter(Boolean)`;
    const enemies = `['Враг', 'Враг 2'].map(n => game.actors.getName('${SANDBOX}: ' + n)?.id).filter(Boolean)`;
    const build = opts => `const { scene } = await game.gachadnd.arena.generate({ ${opts}, party: ${party}, enemies: ${enemies} });
await scene.activate();`;
    const list = [
        ['Арена: день', build("mood: 'day'"), 'icons/magic/light/explosion-star-glow-yellow.webp'],
        ['Арена: ночь', build("mood: 'night'"), 'icons/magic/control/silhouette-hold-change-blue.webp'],
        ['Арена: пробуждение 2', build("mood: 'blood', stage: 2"), 'icons/magic/death/blood-corruption-vomit-red.webp'],
        ['Арена: пробуждение 4', build("mood: 'blood', stage: 4"), 'icons/magic/death/projectile-skull-fire-orange-red.webp'],
        ['Арена: порча', build("mood: 'rot'"), 'icons/magic/unholy/orb-glowing-green.webp'],
        ['Арена: ливень', build("mood: 'day', weather: 'rain'"), 'icons/magic/water/projectile-water-rings.webp'],
        ['Арена: туман', build("mood: 'day', weather: 'fog'"), 'icons/magic/air/fog-gas-smoke-swirling-gray.webp'],
        ['Арена: ветер', build("mood: 'day', weather: 'wind'"), 'icons/magic/air/wind-tornado-wall-blue.webp'],
        ['Арена: чаща', build("mood: 'day', scheme: 'thicket'"), 'icons/magic/nature/tree-elm-roots-brown.webp'],
        ['Арена: топь ночью', build("mood: 'night', scheme: 'swamp'"), 'icons/creatures/amphibians/bullfrog-glass-teal.webp'],
        ['Катакомбы: зал (полная темнота)', build("biome: 'crypt', scheme: 'hall', encounter: { node: 'elite' }, dark: 'full'"), 'icons/environment/settlement/columned-forum.webp'],
        ['Катакомбы: склеп (условная)', build("biome: 'crypt', scheme: 'crypt', encounter: { node: 'elite' }, dark: 'cond'"), 'icons/environment/wilderness/tomb-entrance.webp'],
        ['Катакомбы: связка комнат', build("biome: 'crypt', scheme: 'rooms', cols: 24, rows: 18, encounter: { node: 'mob' }, dark: 'cond'"), 'icons/svg/door-closed.svg'],
        ['Катакомбы: провал', build("biome: 'crypt', scheme: 'chasm', encounter: { node: 'elite' }, dark: 'cond'"), 'icons/environment/settlement/bridge-stone.webp'],
        ['Катакомбы: застава', build("biome: 'crypt', scheme: 'gate', encounter: { node: 'outpost' }, dark: 'full'"), 'icons/environment/settlement/castle-gatehouse.webp'],
        ['Катакомбы: святилище', build("biome: 'crypt', scheme: 'sanctum', cols: 30, rows: 22, encounter: { node: 'boss' }, dark: 'full'"), 'icons/environment/wilderness/cave-entrance.webp'],
        ['Арена: встреча Босса', "await game.gachadnd.encounters.offer('boss');", 'icons/skills/melee/weapons-crossed-swords-yellow.webp']
    ];
    await Macro.createDocuments(list.map(([name, command, img], i) => ({ name, type: 'script', command, img, folder: folder.id, sort: i * 100 })));
    const journal = game.journal.getName(`${SANDBOX}: как проверять`);
    await journal?.createEmbeddedDocuments('JournalEntryPage', [{ name: 'Арена', type: 'text', text: { content: ARENA_PAGE } }]);
}, { SANDBOX, ARENA_PAGE });

// Обеты Элиты: макросы открывают окно без карты; бой на сцене песочницы идёт уже под принятыми обетами
const VOWS_PAGE = `
<h2>Обеты Элиты</h2>
<p>На карте окно открывается само при входе на Элиту. Без карты — макросы в папке «${SANDBOX}: обеты». Обеты отряда считаются по персонажам с владельцем-игроком: раздайте героев макросом обмена или войдите игроком.</p>
<ul>
<li><strong>Обеты: случайные</strong> — окно как в игре, по два на группу. <strong>Обеты: все сразу</strong> — все 16 обетов, чтобы посмотреть любой.</li>
<li>Отметьте обеты, войдя игроком (Claude_player, без пароля): галочки видны всем; «Готовы» снимается при любой правке. Подмога снимает Густую стаю. У Мастера — замена и «В бой».</li>
<li>«В бой» — карточка обетов всем и шёпот встречи с составом уже по обетам. «На арену» учтёт Теснину, Непогоду и Клещи; «Сам» напишет, что учитывать вручную.</li>
<li>Начните бой на сцене (инициативы бросьте): спят навыки, камни гаснут, вожак крепче, в Засаду ходы героев пропускаются, на 3-м раунде приходит Вторая волна, со 2-го раунда Смыкание сжимает поле.</li>
<li>Опустите врага до 0 ПЗ: Месть стаи и Не упокоен. Завершите бой: Голодный Туман забирает заряды, все враги пали — генератор добычи откроется на Элите; живые остались — шёпот «Это победа?».</li>
<li>Прибавка видна в карточке добычи, второй раз не даётся.</li>
</ul>`;
await page.evaluate(async ({ SANDBOX, VOWS_PAGE }) => {
    const folderName = `${SANDBOX}: обеты`;
    for (const f of game.folders.filter(f => f.type === 'Macro' && f.name === folderName)) { await Macro.deleteDocuments(game.macros.filter(m => m.folder?.id === f.id).map(m => m.id)); await f.delete(); }
    const folder = await Folder.create({ name: folderName, type: 'Macro', color: '#5a3d16' });
    await Macro.createDocuments([
        { name: 'Обеты: случайные', type: 'script', command: 'await game.gachadnd.vows.begin();', img: 'icons/sundries/scrolls/scroll-bound-sealed-red.webp', folder: folder.id, sort: 100 },
        { name: 'Обеты: все сразу', type: 'script', command: "await game.gachadnd.vows.begin(); await game.settings.set('gachadnd', 'vowsState', { ...game.gachadnd.vows.state(), offered: Object.keys(game.gachadnd.vows.list) });", img: 'icons/sundries/scrolls/scroll-runed-brown-purple.webp', folder: folder.id, sort: 200 }
    ]);
    const journal = game.journal.getName(`${SANDBOX}: как проверять`);
    await journal?.createEmbeddedDocuments('JournalEntryPage', [{ name: 'Обеты Элиты', type: 'text', text: { content: VOWS_PAGE } }]);
}, { SANDBOX, VOWS_PAGE });

// Обмен: два героя с монетами, вещами и кристаллами; макросы «раздать» (владение и назначение Claude_player и
// Claude_trusted) и «забрать» — владение не раздаётся само, чтобы не путать проверки со стороны игрока
const TRADE_PAGE = `
<h2>Обмен</h2>
<p>На сцене — «Обмен: Лира» и «Обмен: Борк» с монетами, оружием, зельями и кристаллами. Макрос «Обмен: раздать игрокам» в папке «${SANDBOX}: обмен» отдаёт Лиру Claude_player, Борка — Claude_trusted и назначает их персонажами; «Обмен: забрать» — обратно.</p>
<ul>
<li>Войдите двумя игроками (два окна браузера, Claude_player и Claude_trusted, без пароля). Правый щелчок одного по токену другого — окно обмена у обоих.</li>
<li>Слева — что вы отдаёте: монеты (не больше, чем в кошельке), предметы кнопкой «+» из сумки (над ней — поиск по названию) или перетаскиванием с листа, количество для стопки. Справа — предложение товарища, оно обновляется у вас сразу.</li>
<li>Нажмите «Согласен» и поменяйте что-нибудь у второго — «Согласен» снимется у обоих. Оба согласны — вещи переехали, в чате запись для всех.</li>
<li>Мастеру — шёпот «Наблюдать»: окно, где правятся обе стороны, «Провести сейчас» и «Отменить» (подсказка отключается в настройках подсказок).</li>
<li>Без Мастера в игре обмен тоже проходит: каждый проводит свою половину.</li>
</ul>`;
await page.evaluate(async ({ SANDBOX, TRADE_PAGE }) => {
    const scene = game.scenes.getName(`${SANDBOX}: навыки`), grid = scene.grid.size;
    const crystal = (name, rarity) => ({ name: `Кристалл: ${name}`, type: 'consumable', img: `modules/gachadnd/assets/icons/skills/${rarity === 'gray' ? 'grey' : rarity}_fog_crystall.webp`, system: { quantity: 1 }, flags: { gachadnd: { is_crystal_item: true, skill_name: name, rarity } } });
    const mk = (name, gp, items) => Actor.create({
        name: `${SANDBOX}: Обмен: ${name}`, type: 'character',
        system: { currency: { pp: 1, gp, ep: 0, sp: 12, cp: 30 }, attributes: { hp: { value: 30, max: 30 } } },
        prototypeToken: { actorLink: true, disposition: 1, displayName: 30 }
    }).then(async a => { await a.createEmbeddedDocuments('Item', items); return a; });
    const lira = await mk('Лира', 80, [
        { name: 'Кинжал', type: 'weapon', img: 'icons/weapons/daggers/dagger-straight-blue.webp', system: { quantity: 2, equipped: true } },
        { name: 'Зелье лечения', type: 'consumable', img: 'icons/consumables/potions/potion-tube-corked-red.webp', system: { quantity: 3 } },
        crystal('Хлопушка', 'green'), crystal('Голос предков', 'blue')
    ]);
    const bork = await mk('Борк', 15, [
        { name: 'Верёвка', type: 'loot', img: 'icons/sundries/survival/rope-wrapped-brown.webp', system: { quantity: 1 } },
        { name: 'Щит', type: 'equipment', img: 'icons/equipment/shield/heater-steel-worn.webp', system: { quantity: 1 } },
        crystal('Тлеющий уголь', 'gray')
    ]);
    await scene.createEmbeddedDocuments('Token', [lira, bork].map((a, i) => ({ ...a.prototypeToken.toObject(), actorId: a.id, name: a.name, x: (14 + i * 2) * grid, y: 13 * grid })));
    const folderName = `${SANDBOX}: обмен`;
    for (const f of game.folders.filter(f => f.type === 'Macro' && f.name === folderName)) { await Macro.deleteDocuments(game.macros.filter(m => m.folder?.id === f.id).map(m => m.id)); await f.delete(); }
    const folder = await Folder.create({ name: folderName, type: 'Macro', color: '#4a3f2f' });
    const pair = `const pair = [['Claude_player', '${SANDBOX}: Обмен: Лира'], ['Claude_trusted', '${SANDBOX}: Обмен: Борк']];`;
    await Macro.createDocuments([
        { name: 'Обмен: раздать игрокам', type: 'script', img: 'icons/skills/social/trading-justice-scale-yellow.webp', folder: folder.id, sort: 0,
            command: `${pair}
for (const [u, a] of pair) { const user = game.users.getName(u), actor = game.actors.getName(a); if (!user || !actor) continue; await actor.update({ [\`ownership.\${user.id}\`]: 3 }); await user.update({ character: actor.id }); }
ui.notifications.info('Лира — Claude_player, Борк — Claude_trusted.');` },
        { name: 'Обмен: забрать', type: 'script', img: 'icons/skills/social/trading-justice-scale-gray.webp', folder: folder.id, sort: 100,
            command: `${pair}
for (const [u, a] of pair) { const user = game.users.getName(u), actor = game.actors.getName(a); if (!user || !actor) continue; await actor.update({ [\`ownership.\${user.id}\`]: 0 }); if (user.character?.id === actor.id) await user.update({ character: null }); }
ui.notifications.info('Герои обмена — снова у Мастера.');` }
    ]);
    const journal = game.journal.getName(`${SANDBOX}: как проверять`);
    await journal?.createEmbeddedDocuments('JournalEntryPage', [{ name: 'Обмен', type: 'text', text: { content: TRADE_PAGE } }]);
}, { SANDBOX, TRADE_PAGE });

// Голоса на карте: страница журнала; кнопки на сцене не нужны — карту чертит Мастер, голосуют игроки
const VOTES_PAGE = `
<h2>Голоса на карте</h2>
<p>Игрок щелчком отмечает узел, куда хочет идти. Это только выбор: отряд ведёт Мастер.</p>
<ul>
<li>Мастер: откройте карту этажа, начертите этаж (паутиной или рядами) и сделайте первый шаг. Назначьте игроку персонажа в настройках пользователя: его портрет встанет на орбиту, без персонажа — аватар.</li>
<li>Войдите игроком (второе окно браузера, Claude_player или Claude_trusted, без пароля) и откройте карту. Щёлкните любой узел, даже недоступный: оправа загорится цветом игрока, вокруг появится кольцо с портретом. Мастер видит то же.</li>
<li>Повторный щелчок снимает отметку, щелчок по другому узлу переносит. Только за узел под отрядом голосовать нельзя.</li>
<li>Второй игрок на том же узле: оправа делится на два цвета, на кольце два портрета. При наведении подсказка на паутине называет выбравших.</li>
<li>Шаг Мастера гасит все отметки. Вышедший из игры игрок исчезает с орбиты.</li>
</ul>`;
await page.evaluate(async ({ SANDBOX, VOTES_PAGE }) => {
    const journal = game.journal.getName(`${SANDBOX}: как проверять`);
    await journal?.createEmbeddedDocuments('JournalEntryPage', [{ name: 'Голоса на карте', type: 'text', text: { content: VOTES_PAGE } }]);
}, { SANDBOX, VOTES_PAGE });

const report = await page.evaluate(({ SANDBOX }) => game.actors.filter(a => a.name.startsWith(SANDBOX)).map(a => {
    const memory = a.items.filter(i => i.flags.gachadnd?.skill_name);
    const echo = a.flags.gachadnd?.echo?.value;
    return `${a.name.replace(`${SANDBOX}: `, '')}: ${memory.length ? memory.map(i => i.name).join(', ') : 'без навыков'}${echo ? ` — эхо ${echo}` : ''}`;
}), { SANDBOX });
console.log('Песочница готова — сцена «GD-песочница: навыки», журнал «GD-песочница: как проверять» (страницы «Навыки», «Арена», «Обмен», «Голоса на карте»), макросы — папки «GD-песочница: арена» и «GD-песочница: обмен»:');
for (const line of report) console.log('  ' + line);
await f.close();
