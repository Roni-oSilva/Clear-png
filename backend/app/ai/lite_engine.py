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

Medido numa foto de 12 MP com u2netp: ~250 MB no pico, ~70 MB em repouso (cabe nos 512 MB).

Qualidade: previsão com TTA de espelho + limpeza por histerese/componentes + filtro guiado
(ver matting.py) — preserva partes finas ligadas ao objeto (cerdas, pontas, cabos).
"""
from __future__ import annotations

import logging
import os
import threading
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

from . import matting
from .pipeline import compose_output, load_working, release_memory, to_float_rgb

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


class LiteBackgroundRemover:
    def __init__(self, model_name: str, threads: int = 1, max_output_pixels: int = 0, tta: bool = True):
        self.model_name = model_name
        self.threads = threads
        self.max_output_pixels = max_output_pixels  # 0 = sem limite
        self.tta = tta  # previsão também na imagem espelhada (mais robusta; ~2x o tempo de inferência)
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

    def _run(self, small: Image.Image) -> np.ndarray:
        """Probabilidade [0,1] (s×s) para uma imagem RGB já reduzida a s×s."""
        x = np.asarray(small, dtype=np.float32)
        x /= max(float(x.max()), 1e-6)
        x -= np.array(self.mean, dtype=np.float32)
        x /= np.array(self.std, dtype=np.float32)
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        pred = self._get_session().run(None, {self._input: x})[0][0, 0].astype(np.float32)
        lo, hi = float(pred.min()), float(pred.max())
        return (pred - lo) / max(hi - lo, 1e-6)

    def predict_prob(self, work: Image.Image) -> np.ndarray:
        """Probabilidade na resolução do modelo, com TTA de espelho (média com a imagem invertida):
        reduz falhas pontuais em contornos complexos sem custo extra de RAM."""
        s = self.size
        small = work.resize((s, s), Image.Resampling.BILINEAR)
        p = self._run(small)
        if self.tta:
            p_flip = self._run(small.transpose(Image.Transpose.FLIP_LEFT_RIGHT))[:, ::-1]
            p = (p + p_flip) * 0.5
        return p

    def predict_alpha(self, work: Image.Image, snap: bool = True) -> np.ndarray:
        """Máscara final (float [0,1]) na resolução de trabalho de `work`."""
        p = matting.clean_prediction(self.predict_prob(work))
        mask = Image.fromarray((p * 255 + 0.5).astype(np.uint8), mode="L").resize(work.size, Image.Resampling.BICUBIC)
        alpha = np.asarray(mask, dtype=np.float32) / 255.0
        if snap:
            alpha = matting.snap_edges(alpha, to_float_rgb(work))
        return alpha

    def process(self, input_path: Path, output_path: Path, refine_edges: bool = True) -> tuple[int, int]:
        """Grava PNG RGBA. A IA e o pós-processamento correm em ≤1 MP; só a composição final
        usa a resolução original (até `max_output_pixels`) — por isso cabe em 512 MB.

        `refine_edges`: ativa o alinhamento das bordas aos contornos reais (filtro guiado).
        """
        try:
            work = load_working(input_path)
            alpha = self.predict_alpha(work, snap=refine_edges)
            work.close()
            return compose_output(input_path, alpha, output_path, self.max_output_pixels)
        finally:
            release_memory()

if __name__ == "__main__":  # usado no build: python -m app.ai.lite_engine
    logging.basicConfig(level=logging.INFO)
    print(ensure_model(os.getenv("REMBG_MODEL", "u2netp")))
