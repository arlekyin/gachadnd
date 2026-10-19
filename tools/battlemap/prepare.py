"""
Генератор арен — подготовка арта: python tools/battlemap/prepare.py [биом]

Берёт картинки из assets/battlemap/<биом>/_src/ (как пришли из генератора) и кладёт готовые в assets/battlemap/<биом>/:
- ground-*      — бесшовная текстура 1024×1024 (стык краёв смешивается со сдвинутой копией);
- scatter-*     — лист мелочи на белом фоне режется на отдельные штуки: scatter-tufts-1-1.webp, -1-2 …;
- *-sheet       — лист вариантов любого предмета (2×2, 3×3 на белом): rock-2-sheet → rock-2-1.webp, rock-2-2 …;
- остальное     — предмет: белый фон, связанный с краями, становится прозрачным (мягкий край), обрезка по предмету,
                  длинная сторона — не больше 768 px.
"""
import sys, os, glob
from collections import deque
from PIL import Image, ImageFilter, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIOME = sys.argv[1] if len(sys.argv) > 1 else 'forest'
SRC = os.path.join(ROOT, 'assets', 'battlemap', BIOME, '_src')
OUT = os.path.join(ROOT, 'assets', 'battlemap', BIOME)


def background_mask(im, tol=34):
    """Маска фона: светлые малонасыщенные пиксели, связанные с краем картинки (заливка от краёв)."""
    rgb = im.convert('RGB')
    w, h = rgb.size
    px = rgb.load()
    def is_bg(x, y):
        r, g, b = px[x, y]
        return min(r, g, b) > 255 - tol and max(r, g, b) - min(r, g, b) < 28
    bg = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_bg(x, y) and not bg[y * w + x]: bg[y * w + x] = 1; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(x, y) and not bg[y * w + x]: bg[y * w + x] = 1; q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not bg[ny * w + nx] and is_bg(nx, ny):
                bg[ny * w + nx] = 1; q.append((nx, ny))
    # Замкнутые светлые пятна (между ветвями, в просветах) — тоже фон, если они не крошечные
    for y0 in range(h):
        for x0 in range(w):
            if bg[y0 * w + x0] or not is_bg(x0, y0): continue
            region = [(x0, y0)]; bg[y0 * w + x0] = 2; q.append((x0, y0))
            while q:
                x, y = q.popleft()
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not bg[ny * w + nx] and is_bg(nx, ny):
                        bg[ny * w + nx] = 2; q.append((nx, ny)); region.append((nx, ny))
            if len(region) < 60:
                for x, y in region: bg[y * w + x] = 3
    m = Image.frombytes('L', (w, h), bytes(255 if v in (1, 2) else 0 for v in bg))
    return m


def cutout(im):
    """Предмет без белого фона: альфа — обратная маске фона, край смягчён на 1–2 px, белёсый ореол затемнён."""
    im = im.convert('RGBA')
    bg = background_mask(im)
    alpha = ImageChops.invert(bg).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
    im.putalpha(alpha)
    return im


def unwhite(im):
    """Белый — в прозрачность (как «цвет в альфу»): дымка и свечение становятся полупрозрачными, а не белёсыми.
    Для гнили и друз: у них мягкие края без чёткого силуэта."""
    rgb = im.convert('RGB')
    px = list(rgb.getdata())
    out = []
    for r, g, b in px:
        a = (255 - min(r, g, b)) / 255
        if a < 0.04: out.append((0, 0, 0, 0)); continue
        f = lambda c: max(0, min(255, round((c - 255 * (1 - a)) / a)))
        out.append((f(r), f(g), f(b), round(255 * min(1, a * 1.15))))
    res = Image.new('RGBA', rgb.size)
    res.putdata(out)
    return res


def dehalo(res, src):
    """Бледный ореол по краю (остаток белого фона): у полупрозрачных светлых пикселей альфа гасится — чем ближе
    исходный цвет к белому, тем прозрачнее; плотная середина не трогается."""
    import numpy as np
    a = np.asarray(res, dtype=np.float32).copy()
    light = np.asarray(src.convert('RGB'), dtype=np.float32).min(axis=2)
    keep = np.clip((255 - light) / 110, 0, 1) ** 0.9
    edge = a[..., 3] < 250
    a[..., 3] = np.where(edge, a[..., 3] * keep, a[..., 3])
    return Image.fromarray(a.astype(np.uint8), 'RGBA')


def trim(im, pad=4):
    box = im.getchannel('A').point(lambda a: 255 if a > 12 else 0).getbbox()
    if not box: return im
    x0, y0, x1, y1 = box
    return im.crop((max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad)))


def fit(im, side=768):
    k = side / max(im.size)
    return im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS) if k < 1 else im


def seamless(im, size=1024):
    """Бесшовность по осям по очереди: по X смешать со сдвинутой по X копией (у левого и правого края — копия, она там
    непрерывна; её шов посередине закрыт оригиналом), затем так же по Y."""
    def ramp(n, horizontal):
        line = []
        for i in range(n):
            d = min(i, n - 1 - i) / (n / 2)
            t = min(1.0, d / 0.45)
            line.append(int(255 * t * t * (3 - 2 * t)))
        m = Image.new('L', (n, n))
        m.putdata([line[x] for y in range(n) for x in range(n)] if horizontal else [line[y] for y in range(n) for x in range(n)])
        return m
    a = im.convert('RGB').resize((size, size), Image.LANCZOS)
    a = Image.composite(a, ImageChops.offset(a, size // 2, 0), ramp(size, True))
    a = Image.composite(a, ImageChops.offset(a, 0, size // 2), ramp(size, False))
    return a


def split_sheet(im, grow=15):
    """Лист мелочи: отдельные штуки — связные пятна непрозрачного (с расширением, чтобы части одной штуки слиплись)."""
    cut = cutout(im)
    a = cut.getchannel('A').point(lambda v: 255 if v > 40 else 0).filter(ImageFilter.MaxFilter(grow))
    w, h = a.size
    data = a.load()
    seen = bytearray(w * h)
    pieces = []
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            if data[x, y] == 0 or seen[y * w + x]: continue
            q = deque([(x, y)]); seen[y * w + x] = 1
            x0 = x1 = x; y0 = y1 = y
            own = [(x, y)]
            while q:
                cx, cy = q.popleft()
                own.append((cx, cy))
                x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and data[nx, ny]:
                        seen[ny * w + nx] = 1; q.append((nx, ny))
            if (x1 - x0) * (y1 - y0) > 900:
                m = Image.new('L', (x1 - x0 + 1, y1 - y0 + 1), 0)
                mp = m.load()
                for cx, cy in own: mp[cx - x0, cy - y0] = 255
                piece = cut.crop((x0, y0, x1 + 1, y1 + 1))
                piece.putalpha(ImageChops.darker(piece.getchannel('A'), m))
                pieces.append(trim(piece))
    return pieces


def main():
    os.makedirs(OUT, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(SRC, '*'))):
        name, _ = os.path.splitext(os.path.basename(path))
        im = Image.open(path)
        if name.startswith('ground-'):
            seamless(im).save(os.path.join(OUT, f'{name}.webp'), quality=90)
            print('земля', name)
        elif name.startswith('scatter-'):
            for f in glob.glob(os.path.join(OUT, f'{name}-*.webp')): os.remove(f)
            # Травинки пучка лежат врозь — их склеивает расширение; листья и кости — отдельные штуки, почти без него
            pieces = split_sheet(im, 3 if any(k in name for k in ('leaves', 'bones')) else 15)
            # Обрезки и крошки (меньше трети самой крупной штуки) — прочь: растянутые до размера штуки, они мылятся
            top = max((max(p.size) for p in pieces), default=0)
            pieces = [p for p in pieces if max(p.size) >= top / 3]
            for i, p in enumerate(pieces, 1): fit(p, 256).save(os.path.join(OUT, f'{name}-{i}.webp'), quality=92)
            print('россыпь', name, len(pieces), 'шт.')
        elif name.endswith('-sheet'):
            # Лист вариантов: каждый вариант — отдельный предмет того же вида
            base = name[:-len('-sheet')]
            for f in glob.glob(os.path.join(OUT, f'{base}-*.webp')): os.remove(f)
            pieces = [p for p in split_sheet(im) if max(p.size) > 64]
            for i, p in enumerate(pieces, 1): fit(p).save(os.path.join(OUT, f'{base}-{i}.webp'), quality=92)
            print('лист вариантов', base, len(pieces), 'шт.')
        elif name.startswith('vignette-'):
            # Сцена на клочке земли, край которого тает в белое: внутри — непрозрачно, по краю — «цвет в альфу»
            cut = cutout(im)
            inner = cut.getchannel('A').filter(ImageFilter.MinFilter(41)).filter(ImageFilter.GaussianBlur(14))
            soft = unwhite(im)
            alpha = ImageChops.lighter(inner, soft.getchannel('A'))
            res = Image.composite(im.convert('RGBA'), soft, inner)
            res.putalpha(alpha)
            res = dehalo(res, im)
            # Акварельный край сам светлеет к белому — бледная полоса читается ореолом: маска сужается внутрь
            a = res.getchannel('A')
            res.putalpha(ImageChops.darker(a, a.filter(ImageFilter.MinFilter(61)).filter(ImageFilter.GaussianBlur(18))))
            fit(trim(res), 1400).save(os.path.join(OUT, f'{name}.webp'), quality=92)
            print('виньетка', name)
        elif name.startswith('rot-'):
            fit(trim(unwhite(im))).save(os.path.join(OUT, f'{name}.webp'), quality=92)
            print('мягкий край', name)
        else:
            fit(trim(cutout(im))).save(os.path.join(OUT, f'{name}.webp'), quality=92)
            print('предмет', name)


if __name__ == '__main__':
    main()
