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
    # Motor de IA — modelos rembg: isnet-general-use (equilíbrio), u2net, u2netp (leve),
    # birefnet-general (máxima precisão em cabelo/bordas, mais pesado), birefnet-portrait...
    model_name: str = os.getenv("REMBG_MODEL", "isnet-general-use")
    preload_model: bool = _env_bool("PRELOAD_MODEL", True)

    # Limites de upload
    max_upload_mb: int = _env_int("MAX_UPLOAD_MB", 100)
    max_pixels: int = _env_int("MAX_PIXELS", 100_000_000)  # ~ 12000 x 8300
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
    cors_origins: list[str] = [
        o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()
    ]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


settings = Settings()
