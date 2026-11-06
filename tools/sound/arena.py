"""
Фон арены — подготовка звуков: python tools/sound/arena.py

Берёт скачанные с Freesound файлы из assets/sounds/arena/_src/ (имена как с сайта: <id>__<автор>__<название>)
и кладёт готовые в assets/sounds/arena/ под именами фонов (docs/arena-sounds.md): OGG Vorbis, одна громкость
(среднеквадратичная — около −22 дБ, пики не выше −1 дБ), не-петли склеиваются в бесшовную петлю.
Исходники (_src) в git и в выпуск не идут. Нужен пакет soundfile (pip install soundfile).
"""
import os, glob
import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'assets', 'sounds', 'arena', '_src')
OUT = os.path.join(ROOT, 'assets', 'sounds', 'arena')

# id звука на Freesound → имя фона; loop — склеить конец с началом (запись не петлёй)
SOUNDS = {
    '570492': ('forest-day-1', False),    # Nox_Sound — птицы и ветер
    '723913': ('forest-day-2', False),    # Magnesus — птицы
    '825635': ('forest-night-1', False),  # NickTayloe — сверчки, кузнечики
    '853607': ('swamp-night-1', True),    # hafijur_rahman — лягушки и сверчки у пруда
    '704395': ('rain-1', False),          # jgxxx — ночной лес под дождём
    '624645': ('rain-2', False),          # Rubaoliva — ровный ливень
    '403051': ('wind-1', False),          # teadrinker — ветер в кронах
    '459981': ('wind-2', False),          # florianreichelt — порывистый ветер
    '559389': ('fog-1', False),           # szegvari — мистический гул леса
    '593785': ('fog-2', False),           # steaq — низкий тёмный гул
    '516566': ('crypt-1', False),         # Kinoton — тёмный гул, капель, сквозняк (катакомбы)
    '789913': ('crypt-2', False),         # newlocknew — подземный гул, петля (катакомбы)
    '636108': ('caves-1', False),         # fonografico — пещера: капель, камень (пещеры)
}
TARGET_RMS = 10 ** (-22 / 20)
PEAK = 10 ** (-1 / 20)
FADE = 2.0  # секунд на склейку петли


def seamless(data, rate):
    """Петля: последние FADE секунд плавно переходят в начало, хвост уходит — стык не слышен"""
    n = int(FADE * rate)
    if len(data) < n * 3: return data
    head, tail = data[:n], data[-n:]
    t = np.linspace(0, 1, n)[:, None] if data.ndim == 2 else np.linspace(0, 1, n)
    blend = tail * (1 - t) + head * t
    return np.concatenate([blend, data[n:-n]])


def main():
    os.makedirs(OUT, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(SRC, '*'))):
        sid = os.path.basename(path).split('__')[0]
        if sid not in SOUNDS: print('пропущен', os.path.basename(path)); continue
        name, loop = SOUNDS[sid]
        data, rate = sf.read(path, dtype='float32', always_2d=True)
        if data.shape[1] > 2: data = data[:, :2]
        if loop: data = seamless(data, rate)
        rms = float(np.sqrt(np.mean(data ** 2))) or 1
        data = data * (TARGET_RMS / rms)
        peak = float(np.max(np.abs(data))) or 1
        if peak > PEAK: data = data * (PEAK / peak)
        out = os.path.join(OUT, f'{name}.ogg')
        # Блоками: libsndfile падает молча, если отдать ему в OGG весь звук разом
        with sf.SoundFile(out, 'w', rate, data.shape[1], format='OGG', subtype='VORBIS', compression_level=0.6) as f:
            for i in range(0, len(data), 32768): f.write(data[i:i + 32768])
        print(f'{name}: {len(data) / rate:.0f} с, {os.path.getsize(out) / 1e6:.1f} МБ')


if __name__ == '__main__':
    main()
