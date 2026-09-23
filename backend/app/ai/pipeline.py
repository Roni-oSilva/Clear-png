"""Etapas partilhadas pelos motores: abrir imagens com pouca RAM, resolução de trabalho,
composição final e o fluxo de refinamento por pincel."""
from __future__ import annotations

import ctypes
import gc
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from . import matting

WORK_LONG_SIDE = 1024  # resolução onde vivem a máscara e o filtro guiado (≈1 MP no máximo)


def release_memory() -> None:
    gc.collect()
    try:  # devolve ao sistema a memória livre do heap (glibc / Linux)
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


def open_oriented(path: Path, max_pixels: int = 0) -> Image.Image:
    """Abre em RGB, reduzindo logo na descodificação se passar de `max_pixels`
    (JPEG usa "draft": descodifica já a 1/2, 1/4 ou 1/8 — quase sem custo de RAM)."""
    src = Image.open(path)
    orientation = src.getexif().get(0x0112, 1)
    w, h = src.size
    if max_pixels and w * h > max_pixels:
        if src.format == "JPEG":
            r = 1
            while r < 8 and (w / r) * (h / r) > max_pixels * 1.6:
                r *= 2
            src.draft("RGB", (-(-w // r), -(-h // r)))
            w, h = src.size
            if w * h > max_pixels:
                k = (max_pixels / (w * h)) ** 0.5
                src.thumbnail((max(1, int(w * k)), max(1, int(h * k))), Image.Resampling.LANCZOS)
        else:
            # PNG/WebP: redução inteira (box) — não cria buffers intermédios gigantes.
            if src.mode not in ("RGB", "RGBA", "L", "LA"):
                src = src.convert("RGBA")
            src = src.reduce(math.ceil(math.sqrt(w * h / max_pixels)))
    img = src if src.mode == "RGB" else src.convert("RGB")
    img.load()
    if orientation != 1:
        img = ImageOps.exif_transpose(img)
    return img


def load_working(path: Path, long_side: int = WORK_LONG_SIDE) -> Image.Image:
    """Imagem RGB com o lado maior ≤ `long_side` (barato mesmo para fotos de 100 MP)."""
    img = open_oriented(path, max_pixels=(long_side * 2) ** 2)
    if max(img.size) > long_side:
        k = long_side / max(img.size)
        img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.Resampling.LANCZOS)
    return img


def to_float_rgb(img: Image.Image) -> np.ndarray:
    return np.asarray(img, dtype=np.float32) / 255.0


def compose_output(input_path: Path, alpha: np.ndarray, output_path: Path, max_output_pixels: int = 0) -> tuple[int, int]:
    """Aplica a máscara (resolução de trabalho) à imagem original e grava PNG RGBA."""
    mask = Image.fromarray((np.clip(alpha, 0, 1) * 255 + 0.5).astype(np.uint8), mode="L")
    del alpha
    release_memory()
    image = open_oriented(input_path, max_pixels=max_output_pixels)
    mask = mask.resize(image.size, Image.Resampling.BICUBIC)
    image.putalpha(mask)  # RGB -> RGBA
    del mask
    image.save(output_path, format="PNG", compress_level=6)
    size = image.size
    image.close()
    return size


def refine_with_strokes(
    remover,
    input_path: Path,
    output_path: Path,
    strokes: list[matting.Stroke],
    base_mask_path: Path | None = None,
    snap: bool = True,
    max_output_pixels: int = 0,
) -> tuple[int, int]:
    """Refinamento por pincel.

    Se o cliente enviar a máscara base (a da primeira passagem da IA), a IA NÃO volta a correr:
    é só pós-processamento em ~1 MP — rápido e leve. Sem máscara, a IA recalcula a base.
    """
    try:
        work = load_working(input_path)
        rgb = to_float_rgb(work)
        if base_mask_path is not None:
            with Image.open(base_mask_path) as m:
                base = m.convert("L").resize(work.size, Image.Resampling.BILINEAR)
            alpha = np.asarray(base, dtype=np.float32) / 255.0
        else:
            alpha = remover.predict_alpha(work)
        work.close()
        alpha = matting.apply_strokes(alpha, rgb, strokes, snap=snap)
        del rgb
        return compose_output(input_path, alpha, output_path, max_output_pixels)
    finally:
        release_memory()
