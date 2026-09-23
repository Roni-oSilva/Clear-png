"""ClearCut — API FastAPI para remoção de fundo com IA (rembg)."""
from __future__ import annotations

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from PIL import Image
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .ai.engine import BackgroundRemover
from .config import settings
from .services.storage import TempStorage, cleanup_loop
from .services.validation import ImageValidationError, save_upload_limited, validate_image_file

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s")
logger = logging.getLogger("clearcut")

# O nosso limite é verificado explicitamente; alinhamos o do Pillow para evitar avisos
Image.MAX_IMAGE_PIXELS = max(settings.max_pixels, Image.MAX_IMAGE_PIXELS or 0)

storage = TempStorage(settings.temp_dir, settings.file_ttl_seconds)
if settings.engine == "lite":
    from .ai.lite_engine import LiteBackgroundRemover

    remover = LiteBackgroundRemover(
        settings.model_name, threads=settings.lite_threads, max_output_pixels=settings.max_output_pixels
    )
else:
    remover = BackgroundRemover(settings.model_name)
job_semaphore = asyncio.Semaphore(settings.max_concurrent_jobs)


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.purge_all()  # nada sobrevive a um reinício
    if settings.preload_model:
        await asyncio.to_thread(remover.warmup)  # evita latência no 1.º pedido
    cleaner = asyncio.create_task(cleanup_loop(storage, settings.cleanup_interval_seconds))
    yield
    cleaner.cancel()
    storage.purge_all()


app = FastAPI(title="ClearCut API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["X-Processing-Time", "X-Image-Width", "X-Image-Height", "X-Refine-Applied", "X-Output-Downscaled"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


# ---------------------------------------------------------------- Erros amigáveis
def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


@app.exception_handler(ImageValidationError)
async def handle_validation(_: Request, exc: ImageValidationError):
    return _error(exc.status_code, exc.code, exc.message)


@app.exception_handler(RequestValidationError)
async def handle_request_validation(_: Request, __: RequestValidationError):
    return _error(422, "missing_file", "Nenhuma imagem foi recebida. Selecione um ficheiro e tente novamente.")


@app.exception_handler(Exception)
async def handle_unexpected(_: Request, exc: Exception):
    logger.exception("Erro inesperado", exc_info=exc)
    return _error(500, "internal_error", "Ocorreu um erro inesperado. Tente novamente dentro de instantes.")


# ---------------------------------------------------------------- Endpoints
@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "engine": settings.engine,
        "model": settings.model_name,
        "max_concurrent_jobs": settings.max_concurrent_jobs,
        "max_output_megapixels": settings.max_output_pixels // 1_000_000,
        "max_png_megapixels": settings.max_decode_pixels // 1_000_000,
        "max_webp_megapixels": settings.max_webp_pixels // 1_000_000,
        "model_ready": remover.is_ready,
        "max_upload_mb": settings.max_upload_mb,
        "max_batch_files": settings.max_batch_files,
        "max_refine_megapixels": settings.max_refine_pixels // 1_000_000,
        "accepted_formats": ["image/png", "image/jpeg", "image/webp"],
        "file_ttl_seconds": settings.file_ttl_seconds,
    }


def _safe_stem(filename: str | None) -> str:
    stem = Path(filename or "imagem").stem
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.")[:60]
    return stem or "imagem"


@app.post("/api/remove-background")
async def remove_background(
    file: UploadFile = File(..., description="Imagem PNG, JPG ou WebP"),
    refine_edges: bool = Form(False, description="Alpha matting para cabelo/bordas finas"),
):
    job_dir = storage.new_job_dir()
    input_path = job_dir / "input.bin"
    output_path = job_dir / "output.png"

    # 1) Receção em streaming para disco (barato em RAM — pode correr em paralelo)
    try:
        await save_upload_limited(file, input_path, settings.max_upload_bytes)
    except BaseException:
        storage.remove(job_dir)
        raise

    # 2) Validação + inferência dentro da mesma fila: os passos que usam muita RAM
    #    (descodificar a imagem e correr o modelo) nunca se sobrepõem entre pedidos.
    async with job_semaphore:
        try:
            info = await run_in_threadpool(
                validate_image_file,
                input_path,
                settings.max_pixels,
                settings.max_decode_pixels,
                settings.max_webp_pixels,
            )
        except BaseException:
            storage.remove(job_dir)
            raise

        # No motor lite o "refinar" é só um desfoque leve da máscara (barato) → sempre permitido
        refine = refine_edges and (
            settings.engine == "lite" or info.width * info.height <= settings.max_refine_pixels
        )
        try:
            started = time.perf_counter()  # mede só a inferência, não a espera na fila
            width, height = await run_in_threadpool(remover.process, input_path, output_path, refine)
            elapsed = time.perf_counter() - started
            input_path.unlink(missing_ok=True)  # o original deixa de ser necessário
        except Exception as exc:
            storage.remove(job_dir)
            logger.exception("Falha no processamento")
            raise ImageValidationError(
                "A IA não conseguiu processar esta imagem. Experimente outra imagem ou um formato diferente.",
                status_code=422,
                code="processing_failed",
            ) from exc

    logger.info("Processado %dx%d em %.2fs (refine=%s)", width, height, elapsed, refine)

    return FileResponse(
        output_path,
        media_type="image/png",
        filename=f"{_safe_stem(file.filename)}-sem-fundo.png",
        headers={
            "Cache-Control": "no-store",
            "X-Processing-Time": f"{elapsed:.2f}",
            "X-Image-Width": str(width),
            "X-Image-Height": str(height),
            "X-Refine-Applied": "true" if refine else "false",
            "X-Output-Downscaled": "true" if (width, height) != (info.width, info.height) and width * height < info.width * info.height else "false",
        },
        # Apaga a pasta do pedido assim que a resposta termina de ser enviada
        background=BackgroundTask(storage.remove, job_dir),
    )


# ---------------------------------------------------------------- Frontend estático (montado por último)
if settings.frontend_dir.exists():
    app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="frontend")
