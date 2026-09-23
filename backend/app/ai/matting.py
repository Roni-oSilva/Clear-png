"""Visão computacional leve para máscaras de recorte — só NumPy + Pillow (sem OpenCV/SciPy).

Tudo aqui trabalha em resoluções pequenas (resolução do modelo, ≤ 1024 px de lado), por isso
o custo de RAM é de poucas dezenas de MB mesmo para fotos enormes.

Técnicas usadas:
  * Limiar com histerese + reconstrução geodésica — mantém partes finas e pouco confiantes
    (cerdas de pincel, pontas de ferramentas, cabos finos) quando estão LIGADAS ao objeto
    principal, e descarta ruído solto do fundo.
  * Remoção de "ilhas" por componentes conexos — tira manchas pequenas isoladas, mas preserva
    objetos separados de tamanho relevante (ex.: vários pincéis lado a lado).
  * Filtro guiado a cores (He et al., 2010) numa faixa estreita à volta da borda — a máscara
    "cola" aos contornos reais da imagem (bordas nítidas em ferramentas, detalhe em cerdas).
  * Traços de pincel do utilizador (remover / restaurar) aplicados com lógica inteligente:
      - remover que cobre a maior parte de uma ilha → remove a ilha inteira;
      - restaurar recupera também as partes fracas ligadas ao traço (dentro de uma faixa).
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

# --------------------------------------------------------------------------- básicos


def box_mean(x: np.ndarray, r: int) -> np.ndarray:
    """Média numa janela (2r+1)² por imagem integral — custo O(n), independente de r."""
    if r <= 0:
        return x.astype(np.float32, copy=True)
    h, w = x.shape
    ii = np.zeros((h + 1, w + 1), np.float64)
    ii[1:, 1:] = x.cumsum(0, dtype=np.float64).cumsum(1)
    y0 = np.clip(np.arange(h) - r, 0, h)
    y1 = np.clip(np.arange(h) + r + 1, 0, h)
    x0 = np.clip(np.arange(w) - r, 0, w)
    x1 = np.clip(np.arange(w) + r + 1, 0, w)
    s = ii[y1][:, x1] - ii[y0][:, x1] - ii[y1][:, x0] + ii[y0][:, x0]
    n = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    return (s / n).astype(np.float32)


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    """Dilatação binária quadrada de raio r (via média em janela)."""
    if r <= 0:
        return mask.copy()
    return box_mean(mask.astype(np.float32), r) > 1e-6


def erode(mask: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return mask.copy()
    return box_mean(mask.astype(np.float32), r) > 1 - 1e-6


def _grow8(cur: np.ndarray) -> np.ndarray:
    """Um passo de dilatação 8-conexa (deslocamentos, muito rápido)."""
    out = cur.copy()
    out[1:, :] |= cur[:-1, :]
    out[:-1, :] |= cur[1:, :]
    out[:, 1:] |= cur[:, :-1]
    out[:, :-1] |= cur[:, 1:]
    out[1:, 1:] |= cur[:-1, :-1]
    out[1:, :-1] |= cur[:-1, 1:]
    out[:-1, 1:] |= cur[1:, :-1]
    out[:-1, :-1] |= cur[1:, 1:]
    return out


def reconstruct(seed: np.ndarray, allowed: np.ndarray, max_iter: int = 4000) -> np.ndarray:
    """Reconstrução geodésica: tudo em `allowed` que está ligado (8-conexo) a `seed`."""
    cur = seed & allowed
    for _ in range(max_iter):
        nxt = _grow8(cur) & allowed
        if np.array_equal(nxt, cur):
            break
        cur = nxt
    return cur


def label_components(mask: np.ndarray, max_iter: int = 4000) -> np.ndarray:
    """Rótulos de componentes 8-conexos (0 = fundo). Propagação do mínimo com saltos de ponteiro."""
    h, w = mask.shape
    big = np.int32(h * w + 1)
    lab = np.where(mask, np.arange(1, h * w + 1, dtype=np.int32).reshape(h, w), big)
    for _ in range(max_iter):
        m = lab.copy()
        np.minimum(m[1:, :], lab[:-1, :], out=m[1:, :])
        np.minimum(m[:-1, :], lab[1:, :], out=m[:-1, :])
        np.minimum(m[:, 1:], lab[:, :-1], out=m[:, 1:])
        np.minimum(m[:, :-1], lab[:, 1:], out=m[:, :-1])
        np.minimum(m[1:, 1:], lab[:-1, :-1], out=m[1:, 1:])
        np.minimum(m[1:, :-1], lab[:-1, 1:], out=m[1:, :-1])
        np.minimum(m[:-1, 1:], lab[1:, :-1], out=m[:-1, 1:])
        np.minimum(m[:-1, :-1], lab[1:, 1:], out=m[:-1, :-1])
        m = np.where(mask, m, big)
        # salto de ponteiro: cada rótulo aponta para o rótulo do seu "representante"
        flat = m.ravel()
        idx = np.where(flat < big, flat - 1, 0)
        m = np.where(mask, np.minimum(m, m.ravel()[idx].reshape(h, w)), big)
        if np.array_equal(m, lab):
            break
        lab = m
    lab = np.where(mask, lab, 0)
    # renumera 1..N
    uniq, inv = np.unique(lab, return_inverse=True)
    return inv.reshape(h, w).astype(np.int32) if uniq[0] == 0 else (inv.reshape(h, w) + 1).astype(np.int32)


# --------------------------------------------------------------------------- filtro guiado


def guided_filter_color(img: np.ndarray, p: np.ndarray, r: int, eps: float) -> np.ndarray:
    """Filtro guiado a cores (He et al.). img: HxWx3 float32 [0,1]; p: HxW float32."""
    ch = [img[..., c] for c in range(3)]
    mi = [box_mean(c, r) for c in ch]
    mp = box_mean(p, r)
    cov = [box_mean(ch[c] * p, r) - mi[c] * mp for c in range(3)]

    def var(i, j):
        return box_mean(ch[i] * ch[j], r) - mi[i] * mi[j]

    rr, rg, rb = var(0, 0) + eps, var(0, 1), var(0, 2)
    gg, gb, bb = var(1, 1) + eps, var(1, 2), var(2, 2) + eps
    i_rr = gg * bb - gb * gb
    i_rg = gb * rb - rg * bb
    i_rb = rg * gb - gg * rb
    i_gg = rr * bb - rb * rb
    i_gb = rb * rg - rr * gb
    i_bb = rr * gg - rg * rg
    det = rr * i_rr + rg * i_rg + rb * i_rb
    a_r = (i_rr * cov[0] + i_rg * cov[1] + i_rb * cov[2]) / det
    a_g = (i_rg * cov[0] + i_gg * cov[1] + i_gb * cov[2]) / det
    a_b = (i_rb * cov[0] + i_gb * cov[1] + i_bb * cov[2]) / det
    b = mp - a_r * mi[0] - a_g * mi[1] - a_b * mi[2]
    return box_mean(a_r, r) * ch[0] + box_mean(a_g, r) * ch[1] + box_mean(a_b, r) * ch[2] + box_mean(b, r)


def snap_edges(alpha: np.ndarray, rgb: np.ndarray, contrast: float = 1.8) -> np.ndarray:
    """Alinha a borda da máscara aos contornos reais da imagem, só numa faixa estreita
    à volta da transição (o interior confiante do objeto e do fundo não é tocado).

    Parâmetros medidos numa cena sintética com pincel/ferramentas e verdade conhecida:
    r≈lado/300, eps=1e-3 e contraste 1.8 na faixa → IoU 0.760→0.797 e -14% de erro na borda.
    """
    h, w = alpha.shape
    long_side = max(h, w)
    r = max(2, round(long_side / 300))                       # raio do filtro guiado
    band_r = max(3, round(long_side / 120))                  # largura da faixa de incerteza
    hard = (alpha > 0.5).astype(np.float32)
    m = box_mean(hard, band_r)
    band = (m > 0.001) & (m < 0.999)
    band |= (alpha > 0.03) & (alpha < 0.97)
    if not band.any():
        return alpha
    q = guided_filter_color(rgb, alpha, r, eps=1e-3)
    out = alpha.copy()
    out[band] = (q[band] - 0.5) * contrast + 0.5  # recupera a nitidez que a ampliação da máscara tira
    return np.clip(out, 0.0, 1.0)


# --------------------------------------------------------------------------- limpeza da previsão da IA


def clean_prediction(
    p: np.ndarray,
    strong: float = 0.5,
    weak: float = 0.10,
    min_rel_area: float = 0.03,
    min_abs_area: float = 0.0008,
    faint_gamma: float = 0.35,
) -> np.ndarray:
    """p: probabilidade [0,1] na resolução do modelo. Devolve máscara suave limpa.

    1) Histerese: pixels fracos (≥ `weak`) só ficam se estiverem ligados a pixels fortes
       (≥ `strong`) — é isto que preserva cerdas, pontas e cabos finos do objeto.
    2) Componentes pequenos demais em relação ao maior são removidos (manchas soltas).
    3) As partes finas mantidas ganham opacidade (gama), para não ficarem "fantasma".
    """
    strong_m = p >= strong
    if not strong_m.any():
        return np.clip((p - 0.05) / 0.9, 0.0, 1.0)
    keep = reconstruct(strong_m, p >= weak)

    lab = label_components(keep)
    areas = np.bincount(lab.ravel())
    if areas.size > 2:
        biggest = areas[1:].max()
        min_area = max(min_rel_area * biggest, min_abs_area * p.size)
        small = np.flatnonzero(areas < min_area)
        small = small[small > 0]
        if small.size:
            keep &= ~np.isin(lab, small)

    out = np.where(keep, p, 0.0).astype(np.float32)
    faint = keep & ~strong_m
    out[faint] = out[faint] ** faint_gamma  # γ=0.35: 0.10→0.45, 0.25→0.62 — partes ligadas ficam sólidas
    return np.clip((out - 0.04) / 0.92, 0.0, 1.0)


# --------------------------------------------------------------------------- traços do utilizador


@dataclass
class Stroke:
    mode: str               # "erase" | "restore"
    r: float                # raio, em fração do lado maior da imagem
    pts: list[float]        # x0, y0, x1, y1, …  normalizados em [0, 1]


MAX_STROKES = 600
MAX_COORDS = 60_000


class StrokeError(ValueError):
    pass


def parse_strokes(raw: str) -> list[Stroke]:
    """JSON: {"strokes": [{"mode": "erase"|"restore", "r": 0.01, "pts": [x, y, x, y, …]}]}"""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise StrokeError("Os traços do pincel não estão num formato válido.")
    items = data.get("strokes") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise StrokeError("Os traços do pincel não estão num formato válido.")
    if len(items) > MAX_STROKES:
        raise StrokeError(f"Demasiados traços ({len(items)}). O máximo é {MAX_STROKES}.")
    out: list[Stroke] = []
    total = 0
    for it in items:
        if not isinstance(it, dict):
            raise StrokeError("Traço inválido.")
        mode = it.get("mode")
        if mode not in ("erase", "restore"):
            raise StrokeError("Cada traço tem de ser 'erase' (remover) ou 'restore' (restaurar).")
        try:
            r = float(it.get("r", 0))
            pts = [float(v) for v in it.get("pts", [])]
        except (TypeError, ValueError):
            raise StrokeError("Coordenadas do pincel inválidas.")
        if not (0.0005 <= r <= 0.25) or len(pts) < 2 or len(pts) % 2:
            raise StrokeError("Tamanho do pincel ou coordenadas fora dos limites.")
        total += len(pts)
        if total > MAX_COORDS:
            raise StrokeError("Os traços têm pontos a mais. Desenhe menos ou aplique por partes.")
        pts = [min(1.0, max(0.0, v)) for v in pts]
        out.append(Stroke(mode, r, pts))
    return out


def rasterize_strokes(strokes: list[Stroke], w: int, h: int) -> np.ndarray:
    """Mapa de edição na ordem dos traços: 0 = remover, 255 = restaurar, 128 = sem edição."""
    canvas = Image.new("L", (w, h), 128)
    draw = ImageDraw.Draw(canvas)
    long_side = max(w, h)
    for st in strokes:
        value = 0 if st.mode == "erase" else 255
        rad = max(0.75, st.r * long_side)
        xy = [(st.pts[i] * w, st.pts[i + 1] * h) for i in range(0, len(st.pts), 2)]
        if len(xy) > 1:
            draw.line(xy, fill=value, width=max(1, round(rad * 2)), joint="curve")
        for x, y in xy:  # pontas e junções arredondadas
            draw.ellipse((x - rad, y - rad, x + rad, y + rad), fill=value)
    return np.asarray(canvas)


def _resize_bool(mask: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    return np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize(size, Image.Resampling.NEAREST)) > 127


def apply_strokes(alpha: np.ndarray, rgb: np.ndarray, strokes: list[Stroke], snap: bool = True) -> np.ndarray:
    """Aplica os traços do utilizador sobre a máscara base, de forma "cirúrgica".

    alpha: HxW float32 [0,1] (máscara da IA), rgb: HxWx3 float32 [0,1] (guia para as bordas).
    """
    h, w = alpha.shape
    edit = rasterize_strokes(strokes, w, h)
    erase = edit == 0
    restore = edit == 255
    out = alpha.astype(np.float32, copy=True)

    # ---- análise em baixa resolução (rápida) para as decisões "inteligentes"
    scale = min(1.0, 320 / max(w, h))
    lw, lh = max(1, round(w * scale)), max(1, round(h * scale))
    a_low = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).resize((lw, lh), Image.Resampling.BILINEAR)) / 255.0
    e_low = _resize_bool(erase, (lw, lh))
    r_low = _resize_bool(restore, (lw, lh))

    # Remover inteligente: se um traço de remover cobre ≥ 35% de uma "ilha", remove a ilha toda.
    if e_low.any():
        fg = a_low > 0.5
        lab = label_components(fg)
        areas = np.bincount(lab.ravel())
        covered = np.bincount(lab[e_low].ravel(), minlength=areas.size)
        drop = np.flatnonzero((covered >= 0.35 * np.maximum(areas, 1)) & (np.arange(areas.size) > 0))
        if drop.size:
            island = _resize_bool(np.isin(lab, drop), (w, h))
            out[island & ~restore] = 0.0

    # Restaurar inteligente: recupera também as partes fracas LIGADAS ao traço, numa faixa limitada.
    if r_low.any():
        weak = a_low > 0.06
        rad_low = max(2, round(max((s.r for s in strokes if s.mode == "restore"), default=0.01) * max(lw, lh) * 2))
        grown = reconstruct(r_low, (weak | r_low) & dilate(r_low, rad_low))
        grown_full = _resize_bool(grown, (w, h)) & (alpha > 0.06)
        out[grown_full] = np.maximum(out[grown_full], np.sqrt(alpha[grown_full]))

    # ---- restrições duras dos traços
    out[restore] = 1.0
    out[erase] = 0.0

    # ---- bordas coladas aos contornos reais da imagem
    if snap:
        out = snap_edges(out, rgb)
        # o interior dos traços é sempre respeitado (o filtro só mexe nas bordas)
        out[erode(restore, 2)] = 1.0
        out[erode(erase, 2)] = 0.0
    return np.clip(out, 0.0, 1.0)
