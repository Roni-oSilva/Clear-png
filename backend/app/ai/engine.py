"""Motor de IA: wrapper modular sobre o rembg (segmentação local via ONNX Runtime)."""
from __future__ import annotations

import logging
import threading
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

logger = logging.getLogger("clearcut.ai")


class BackgroundRemover:
    """Carrega o modelo uma única vez (lazy + thread-safe) e reutiliza a sessão ONNX."""

    def __init__(self, model_name: str):
        self.model_name = model_name
        self._session = None
        self._lock = threading.Lock()

    @property
    def is_ready(self) -> bool:
        return self._session is not None

    def _get_session(self):
        if self._session is None:
            with self._lock:
                if self._session is None:
                    from rembg import new_session  # import tardio: arranque do servidor mais rápido

                    logger.info("A carregar o modelo '%s' (primeira execução faz download)...", self.model_name)
                    self._session = new_session(self.model_name)
                    logger.info("Modelo '%s' pronto.", self.model_name)
        return self._session

    def warmup(self) -> None:
        self._get_session()

    def process(self, input_path: Path, output_path: Path, refine_edges: bool = False) -> tuple[int, int]:
        """Remove o fundo de `input_path` e grava PNG RGBA em resolução original em `output_path`."""
        from rembg import remove

        session = self._get_session()

        with Image.open(input_path) as src:
            # Respeita a orientação EXIF (fotos de telemóvel) e normaliza para RGB
            image = ImageOps.exif_transpose(src).convert("RGB")

        kwargs = dict(session=session, post_process_mask=True)
        if refine_edges:
            # Alpha matting: melhora cabelo, pelo e bordas semi-transparentes (mais lento)
            kwargs.update(
                alpha_matting=True,
                alpha_matting_foreground_threshold=240,
                alpha_matting_background_threshold=10,
                alpha_matting_erode_size=10,
            )

        try:
            result = remove(image, **kwargs)
        except Exception:
            if not refine_edges:
                raise
            # O alpha matting pode falhar em casos extremos: recorre ao recorte padrão
            logger.warning("Alpha matting falhou; a usar recorte padrão.", exc_info=True)
            kwargs = dict(session=session, post_process_mask=True)
            result = remove(image, **kwargs)

        if result.mode != "RGBA":
            result = result.convert("RGBA")
        result.save(output_path, format="PNG", compress_level=6)
        return result.size
