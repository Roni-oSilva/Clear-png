"""Motor de IA "lite": ONNX Runtime + NumPy + Pillow, sem rembg.

Pensado para servidores com pouca RAM (ex.: Render gratuito, 512 MB):
  - não importa OpenCV / SciPy / scikit-image / numba / pymatting (o rembg sozinho ocupa ~220 MB)
  - a rede neuronal trabalha só na resolução do modelo (320 px ou 1024 px); o recorte final
    é aplicado na resolução original com Pillow
  - sessão ONNX com 1 thread e sem "memory arena" (a RAM volta ao sistema após cada pedido)
  - malloc_trim() após cada imagem para o processo não "inchar"

Modelos compatíveis (mesmos ficheiros .onnx do rembg, licença MIT/Apache):
  u2netp   (4.7 MB)  — o mais leve, bom para objetos/pessoas simples
  silueta  (43 MB)   — qualidade próxima do u2net; pico ~480 MB (precisa de ~1 GB)
  isnet-general-use (176 MB) — melhor qualidade; pico ~900 MB (precisa de ~1.5 GB)

Medido numa foto de 12 MP com u2netp: ~250 MB no pico, ~70 MB em repouso → cabe nos 512 MB.
"""
from __future__ import annotations

import ctypes
import gc
import math
import logging
import os
import threading
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

logger = logging.getLogger("clearcut.ai.lite")

_BASE_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0"
MODELS = {
    #  nome            tamanho de entrada, média,                 desvio-padrão
    "u2netp":            (320,  (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
    "silueta":           (320,  (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
    "u2net":             (320,  (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
    "u2net_human_seg":   (320,  (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
    "isnet-general-use": (1024, (0.5, 0.5, 0.5),       (1.0, 1.0, 1.0)),
}


def models_dir() -> Path:
    return Path(os.getenv("MODELS_DIR", Path(__file__).resolve().parents[2] / "models"))


def ensure_model(name: str) -> Path:
    """Garante que o .onnx existe localmente (descarrega na 1.ª vez / durante o build)."""
    if name not in MODELS:
        raise ValueError(f"Modelo '{name}' não suportado no motor lite. Use: {', '.join(MODELS)}")
    path = models_dir() / f"{name}.onnx"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        logger.info("A descarregar o modelo %s…", name)
        urllib.request.urlretrieve(f"{_BASE_URL}/{name}.onnx", tmp)
        tmp.rename(path)
    return path


def _release_memory() -> None:
    gc.collect()
    try:  # devolve ao sistema a memória livre do heap (glibc / Linux)
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


class LiteBackgroundRemover:
    def __init__(self, model_name: str, threads: int = 1, max_output_pixels: int = 0):
        self.model_name = model_name
        self.threads = threads
        self.max_output_pixels = max_output_pixels  # 0 = sem limite
        self._session = None
        self._lock = threading.Lock()
        self.size, self.mean, self.std = MODELS.get(model_name, MODELS["silueta"])

    @property
    def is_ready(self) -> bool:
        return self._session is not None

    def _get_session(self):
        if self._session is None:
            with self._lock:
                if self._session is None:
                    import onnxruntime as ort

                    opts = ort.SessionOptions()
                    opts.intra_op_num_threads = self.threads
                    opts.inter_op_num_threads = 1
                    # Combinação medida como a de menor pico de RAM (u2netp: ~270 MB no pico, ~85 MB em repouso)
                    opts.enable_cpu_mem_arena = False   # não retém buffers entre pedidos
                    opts.enable_mem_pattern = True
                    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
                    path = ensure_model(self.model_name)
                    self._session = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
                    self._input = self._session.get_inputs()[0].name
                    logger.info("Modelo lite '%s' pronto (%d thread).", self.model_name, self.threads)
        return self._session

    def warmup(self) -> None:
        self._get_session()

    def _predict_mask(self, small: Image.Image) -> Image.Image:
        """Máscara (modo L, s×s) a partir de uma imagem RGB já reduzida a s×s."""
        x = np.asarray(small, dtype=np.float32)
        x /= max(float(x.max()), 1e-6)
        x -= np.array(self.mean, dtype=np.float32)
        x /= np.array(self.std, dtype=np.float32)
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])

        pred = self._get_session().run(None, {self._input: x})[0][0, 0]
        lo, hi = float(pred.min()), float(pred.max())
        pred = (pred - lo) / max(hi - lo, 1e-6)
        # "Níveis": limpa o ruído perto de 0/1 mas mantém bordas suaves (cabelo)
        pred = np.clip((pred - 0.08) / 0.84, 0.0, 1.0)
        mask = Image.fromarray((pred * 255).astype(np.uint8), mode="L")
        # Abertura morfológica leve: remove pontinhos soltos no fundo
        return mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))

    @staticmethod
    def _open_oriented(path: Path, max_pixels: int = 0) -> Image.Image:
        """Abre em RGB, reduzindo logo na descodificação se passar de `max_pixels`
        (JPEG usa "draft": descodifica já a 1/2, 1/4 ou 1/8 — quase sem custo de RAM)."""
        src = Image.open(path)
        orientation = src.getexif().get(0x0112, 1)
        w, h = src.size
        if max_pixels and w * h > max_pixels:
            if src.format == "JPEG":
                # Redução nativa do JPEG (1/2, 1/4, 1/8): a imagem nunca existe em tamanho real na RAM.
                r = 1
                while r < 8 and (w / r) * (h / r) > max_pixels * 1.6:
                    r *= 2
                src.draft("RGB", (-(-w // r), -(-h // r)))
                w, h = src.size
                if w * h > max_pixels:
                    k = (max_pixels / (w * h)) ** 0.5
                    src.thumbnail((max(1, int(w * k)), max(1, int(h * k))), Image.Resampling.LANCZOS)
            else:
                # PNG/WebP: redução inteira (box). Ao contrário do resize LANCZOS, não cria
                # buffers intermédios gigantes — só aloca a imagem final.
                if src.mode not in ("RGB", "RGBA", "L", "LA"):
                    src = src.convert("RGBA")
                src = src.reduce(math.ceil(math.sqrt(w * h / max_pixels)))
        img = src if src.mode == "RGB" else src.convert("RGB")
        img.load()
        if orientation != 1:
            img = ImageOps.exif_transpose(img)
        return img

    def process(self, input_path: Path, output_path: Path, refine_edges: bool = False) -> tuple[int, int]:
        """Grava PNG RGBA na resolução original. `refine_edges` suaviza ligeiramente a borda.

        Em duas fases para que a imagem grande e a inferência nunca estejam na RAM ao mesmo tempo:
          1) imagem reduzida -> máscara pequena   (liberta a imagem antes de correr o modelo)
          2) imagem original -> aplica a máscara ampliada -> PNG
        """
        s = self.size
        try:
            # Fase 1 — máscara
            img = self._open_oriented(input_path, max_pixels=(s * 2) ** 2)
            small = img.resize((s, s), Image.Resampling.BILINEAR)
            img.close()
            del img
            _release_memory()
            mask = self._predict_mask(small)
            del small
            if refine_edges:
                mask = mask.filter(ImageFilter.GaussianBlur(0.8))
            _release_memory()

            # Fase 2 — recorte na resolução original
            image = self._open_oriented(input_path, max_pixels=self.max_output_pixels)
            mask = mask.resize(image.size, Image.Resampling.BICUBIC)
            image.putalpha(mask)  # RGB -> RGBA
            del mask
            image.save(output_path, format="PNG", compress_level=6)
            size = image.size
            image.close()
            del image
            return size
        finally:
            _release_memory()


if __name__ == "__main__":  # usado no build: python -m app.ai.lite_engine
    logging.basicConfig(level=logging.INFO)
    print(ensure_model(os.getenv("REMBG_MODEL", "u2netp")))
