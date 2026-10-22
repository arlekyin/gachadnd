// Песочница для ручной проверки навыков: node tools/foundry/sandbox.mjs
// Запускается после проверок: пересоздаёт сцену «GD-песочница» с героями, у которых выданы и
// экипированы проверяемые навыки, врагами, союзником, стенами, тайными дверями и фонарём, готовит
// бой (не начатый) и оставляет журнал «как проверять». Проверки (префикс «GD-тест») её не трогают.
import { connect } from './harness.mjs';
import { install, skills } from './fixtures.mjs';

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
        skills: ['Перезарядка', 'Оверклокинг', 'Стена? Какая стена?', 'Сейв-лоад']
    },
    {
        name: 'Живой', x: 7, y: 6, level: 12,
        // Связки синергий — от тегов: огонь (Уголь, Пироман) + яд, движение + взрыв, кровь + щит
        skills: ['Набить руку', 'Третий раз — за правду', 'Обратный отсчёт', 'Тлеющий уголь', 'Пироман', 'Сомелье', 'Глубокий вдох', 'Ох, да!', 'Голос предков', 'Шипастый панцирь', 'Жажда боя', 'Каска']
    },
    // Эхо: у каждого — свой голос и эхо уже на Видении; echo — что выставить, slots — сдвиг естественного лимита
    { name: 'Эхо: кровь', x: 10, y: 6, level: 6, skills: ['Кровавая цена', 'Бензопила', 'Берсерк', 'Без пощады'], echo: { value: 11, tags: { 'кровь': 11 } } },
    { name: 'Эхо: разум', x: 11, y: 10, level: 6, skills: ['Переговорщик', 'Между небом и землёй', 'Счётчик ауры'], echo: { value: 9, tags: { 'разум': 9 } }, slots: -7 },
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

const report = await page.evaluate(({ SANDBOX }) => game.actors.filter(a => a.name.startsWith(SANDBOX)).map(a => {
    const memory = a.items.filter(i => i.flags.gachadnd?.skill_name);
    const echo = a.flags.gachadnd?.echo?.value;
    return `${a.name.replace(`${SANDBOX}: `, '')}: ${memory.length ? memory.map(i => i.name).join(', ') : 'без навыков'}${echo ? ` — эхо ${echo}` : ''}`;
}), { SANDBOX });
console.log('Песочница готова — сцена «GD-песочница: навыки», журнал «GD-песочница: как проверять»:');
for (const line of report) console.log('  ' + line);
await f.close();
