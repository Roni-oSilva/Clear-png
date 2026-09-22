"""Validação robusta de uploads: tamanho, formato real (magic bytes) e integridade."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile
from PIL import Image, UnidentifiedImageError

# Formato detetado pelo Pillow (conteúdo real, não a extensão) -> extensão
ALLOWED_FORMATS = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}


class ImageValidationError(Exception):
    """Erro de validação com mensagem amigável para o utilizador."""

    def __init__(self, message: str, status_code: int = 400, code: str = "invalid_image"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


@dataclass(frozen=True)
class ImageInfo:
    format: str
    extension: str
    width: int
    height: int


async def save_upload_limited(upload: UploadFile, dest: Path, max_bytes: int) -> int:
    """Grava o upload em disco em blocos de 1 MB (memória constante, mesmo com 100 MB),
    abortando assim que o limite é ultrapassado."""
    size = 0
    with open(dest, "wb") as out:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise ImageValidationError(
                    f"O ficheiro excede o tamanho máximo de {max_bytes // (1024 * 1024)} MB.",
                    status_code=413,
                    code="file_too_large",
                )
            out.write(chunk)
    if size == 0:
        raise ImageValidationError("O ficheiro enviado está vazio.", code="empty_file")
    return size


def validate_image_file(path: Path, max_pixels: int) -> ImageInfo:
    """Garante que o ficheiro é uma imagem PNG/JPG/WebP íntegra e de dimensões aceitáveis."""
    try:
        # 1) Identificação do formato + verificação estrutural
        with Image.open(path) as img:
            fmt = img.format
            width, height = img.size
            if fmt in ALLOWED_FORMATS and width * height > max_pixels:
                raise ImageValidationError(
                    f"A imagem é demasiado grande ({width}×{height}). Reduza a resolução e tente novamente.",
                    status_code=413,
                    code="too_many_pixels",
                )
            img.verify()
        # 2) verify() invalida o objeto; reabrimos e descodificamos tudo para apanhar ficheiros truncados
        with Image.open(path) as img:
            img.load()
    except ImageValidationError:
        raise
    except Image.DecompressionBombError:
        raise ImageValidationError(
            "A imagem tem dimensões excessivas e foi rejeitada por segurança.",
            status_code=413,
            code="decompression_bomb",
        )
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise ImageValidationError(
            "Não foi possível ler a imagem. O ficheiro pode estar corrompido ou não é uma imagem válida.",
            code="corrupted_image",
        )

    if fmt not in ALLOWED_FORMATS:
        raise ImageValidationError(
            "Formato não suportado. Envie uma imagem PNG, JPG ou WebP.",
            status_code=415,
            code="unsupported_format",
        )

    return ImageInfo(format=fmt, extension=ALLOWED_FORMATS[fmt], width=width, height=height)
