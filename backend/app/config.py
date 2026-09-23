"""Configuração central da aplicação (lida de variáveis de ambiente)."""
from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    # Motor de IA:
    #   "rembg" — qualidade máxima (isnet/birefnet), precisa de 1,5 GB+ de RAM → PC local / servidor pago
    #   "lite"  — ONNX Runtime puro, cabe em 512 MB (Render gratuito) com o modelo u2netp
    engine: str = os.getenv("ENGINE", "rembg").strip().lower()
    # Modelos: rembg → isnet-general-use, u2net, birefnet-general, birefnet-portrait…
    #          lite  → u2netp (512 MB), silueta, u2net, isnet-general-use (precisam de mais RAM)
    model_name: str = os.getenv("REMBG_MODEL") or ("u2netp" if engine == "lite" else "isnet-general-use")
    lite_threads: int = _env_int("LITE_THREADS", 1)
    preload_model: bool = _env_bool("PRELOAD_MODEL", True)

    # Limites de upload
    max_upload_mb: int = _env_int("MAX_UPLOAD_MB", 100)
    max_pixels: int = _env_int("MAX_PIXELS", 100_000_000)  # ~ 12000 x 8300
    # PNG/WebP têm de ser descodificados por inteiro: limite próprio (JPEG é reduzido na descodificação)
    max_decode_pixels: int = _env_int("MAX_DECODE_PIXELS", 0) or max_pixels
    # WebP gasta ~15 bytes/píxel a descodificar (PNG ~4–8, JPEG reduzido quase nada) → limite próprio
    max_webp_pixels: int = _env_int("MAX_WEBP_PIXELS", 0) or max_decode_pixels
    # Motor lite: resolução máxima do PNG final (0 = original). Fotos maiores são reduzidas, não recusadas.
    max_output_pixels: int = _env_int("MAX_OUTPUT_PIXELS", 0)
    # Acima disto o alpha matting (refinar bordas) é ignorado: seria lento demais e usaria muita RAM
    max_refine_pixels: int = _env_int("MAX_REFINE_PIXELS", 25_000_000)
    # Quantas imagens o frontend envia num lote
    max_batch_files: int = _env_int("MAX_BATCH_FILES", 5)

    # Armazenamento temporário e limpeza automática
    temp_dir: Path = Path(os.getenv("TEMP_DIR", str(BACKEND_DIR / "tmp")))
    file_ttl_seconds: int = _env_int("FILE_TTL_SECONDS", 300)          # 5 minutos
    cleanup_interval_seconds: int = _env_int("CLEANUP_INTERVAL_SECONDS", 60)

    # Desempenho
    max_concurrent_jobs: int = _env_int("MAX_CONCURRENT_JOBS", 2)

    # Frontend / CORS
    frontend_dir: Path = PROJECT_ROOT / "frontend"
    # Vírgulas separam vários domínios; barras finais são ignoradas; vazio = qualquer origem
    cors_origins: list[str] = [
        o.strip().rstrip("/") for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()
    ] or ["*"]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


settings = Settings()
