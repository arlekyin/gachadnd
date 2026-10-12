// Сцена PIXI как в Foundry: карта 1134×1192 (пол с сеткой и пятнами лавы), камера 0.95 по центру, токены
// с mesh и effects.
// Перед подключением задать window.TOKENS = { id: [картинка, x, y, размер в px, клеток, флаги документа] }.
(() => {
    // Пол карты: цветные пятна нужны, чтобы было видно обесцвечивание и инверсию кадра
    function floor() {
        const g = new PIXI.Graphics();
        g.beginFill(0x2b2622).drawRect(0, 0, 1134, 1192).endFill();
        const spots = [[180, 220, 140, 0xc2410c], [930, 300, 170, 0xb91c1c], [300, 950, 190, 0xea580c], [880, 900, 120, 0x15803d], [560, 120, 90, 0x1d4ed8]];
        for (const [x, y, r, c] of spots) g.beginFill(c, 0.75).drawCircle(x, y, r).endFill();
        g.lineStyle(1, 0x000000, 0.35);
        for (let x = 0; x <= 1134; x += 50) g.moveTo(x, 0).lineTo(x, 1192);
        for (let y = 0; y <= 1192; y += 50) g.moveTo(0, y).lineTo(1134, y);
        return g;
    }
    const app = new PIXI.Application({ width: innerWidth, height: innerHeight, resolution: devicePixelRatio, autoDensity: true, backgroundColor: 0x222222, antialias: true });
    document.body.prepend(app.view);
    Object.assign(app.view.style, { position: 'fixed', inset: '0' });
    const stage = app.stage;
    stage.scale.set(0.95);
    stage.position.set(innerWidth / 2 - 567 * 0.95, innerHeight / 2 - 596 * 0.95);
    stage.addChild(floor());
    const layer = new PIXI.Container();
    stage.addChild(layer);

    // Токен: картинка (mesh) и метки поверх (effects) — модуль прячет их на время кадра
    const token = (id, [src, x, y, size, cells, flags = {}]) => {
        const mesh = PIXI.Sprite.from(src);
        mesh.anchor.set(0.5);
        mesh.position.set(x, y);
        const fit = () => mesh.scale.set(size / mesh.texture.width);
        if (mesh.texture.baseTexture.valid) fit(); else mesh.texture.baseTexture.once('loaded', fit);
        layer.addChild(mesh);
        const effects = new PIXI.Graphics();
        effects.beginFill(0xeeeeee).drawCircle(x, y, size * 0.35).endFill();
        effects.beginFill(0).drawCircle(x - size * 0.12, y, size * 0.08).drawCircle(x + size * 0.12, y, size * 0.08).endFill();
        stage.addChild(effects);
        return { id, mesh, effects, center: { x, y }, visible: true, w: size, h: size, document: { width: cells, height: cells, flags }, renderFlags: { set() {} } };
    };
    const tokens = Object.fromEntries(Object.entries(window.TOKENS).map(([id, spec]) => [id, token(id, spec)]));
    window.toks = tokens;
    window.canvas = {
        ready: true, scene: { id: 'S' }, app, stage,
        dimensions: { size: 50, distance: 5, sceneRect: { x: 0, y: 0, width: 1134, height: 1192 } },
        grid: { size: 50 },
        tokens: { get: id => tokens[id], placeables: Object.values(tokens) }
    };
    // Перемещения токенов (отлёт) записываются, а не применяются
    window.updates = [];
    game.scenes = { get: () => ({ tokens: { get: id => ({ update: (data, options) => { updates.push([id, data, options]); return Promise.resolve(); } }) } }) };
})();
