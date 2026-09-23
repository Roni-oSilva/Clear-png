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

from .ai import matting
from .ai.engine import BackgroundRemover
from .ai.pipeline import refine_with_strokes
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
        settings.model_name,
        threads=settings.lite_threads,
        max_output_pixels=settings.max_output_pixels,
        tta=settings.lite_tta,
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
    expose_headers=[
        "X-Processing-Time",
        "X-Image-Width",
        "X-Image-Height",
        "X-Refine-Applied",
        "X-Output-Downscaled",
        "X-Strokes-Applied",
    ],
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
        "features": {"refine_brush": True, "max_strokes": matting.MAX_STROKES},
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
            # lite: o alinhamento de bordas (filtro guiado) é barato → sempre ligado
            width, height = await run_in_threadpool(
                remover.process, input_path, output_path, True if settings.engine == "lite" else refine
            )
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


MAX_MASK_BYTES = 8 * 1024 * 1024
MAX_MASK_PIXELS = 4_200_000  # a máscara base vem do navegador já reduzida (lado maior ≤ 1024–2048 px)


@app.post("/api/refine-background")
async def refine_background(
    file: UploadFile = File(..., description="Imagem ORIGINAL (a mesma enviada para remover o fundo)"),
    strokes: str = Form(..., description='JSON: {"strokes":[{"mode":"erase|restore","r":0.01,"pts":[x,y,…]}]}'),
    mask: UploadFile | None = File(None, description="Opcional: máscara base (PNG em tons de cinza) da 1.ª passagem"),
    snap_edges: bool = Form(True, description="Alinha as bordas editadas aos contornos reais da imagem"),
):
    """Refinamento cirúrgico por pincel.

    - `erase`: remove as áreas pintadas; se o traço cobrir a maior parte de uma mancha solta, remove-a toda.
    - `restore`: protege/recupera as áreas pintadas e as partes finas ligadas a elas.
    - Com `mask`, a IA não volta a correr (só pós-processamento a ~1 MP) — ideal para 512 MB de RAM.
    """
    try:
        stroke_list = matting.parse_strokes(strokes)
    except matting.StrokeError as exc:
        raise ImageValidationError(str(exc), status_code=400, code="invalid_strokes")
    if not stroke_list:
        raise ImageValidationError("Pinte pelo menos uma área antes de aplicar.", status_code=400, code="no_strokes")

    job_dir = storage.new_job_dir()
    input_path = job_dir / "input.bin"
    mask_path = job_dir / "mask.bin" if mask is not None else None
    output_path = job_dir / "output.png"

    try:
        await save_upload_limited(file, input_path, settings.max_upload_bytes)
        if mask is not None:
            await save_upload_limited(mask, mask_path, MAX_MASK_BYTES)
    except BaseException:
        storage.remove(job_dir)
        raise

    async with job_semaphore:
        try:
            info = await run_in_threadpool(
                validate_image_file,
                input_path,
                settings.max_pixels,
                settings.max_decode_pixels,
                settings.max_webp_pixels,
            )
            if mask_path is not None:
                mask_info = await run_in_threadpool(validate_image_file, mask_path, MAX_MASK_PIXELS)
                if mask_info.format != "PNG":
                    raise ImageValidationError("A máscara base tem de ser PNG.", status_code=415, code="invalid_mask")
        except BaseException:
            storage.remove(job_dir)
            raise

        try:
            started = time.perf_counter()
            width, height = await run_in_threadpool(
                refine_with_strokes,
                remover,
                input_path,
                output_path,
                stroke_list,
                mask_path,
                snap_edges,
                settings.max_output_pixels if settings.engine == "lite" else 0,
            )
            elapsed = time.perf_counter() - started
            input_path.unlink(missing_ok=True)
        except Exception as exc:
            storage.remove(job_dir)
            logger.exception("Falha no refinamento")
            raise ImageValidationError(
                "Não foi possível aplicar o refinamento. Tente novamente com menos traços.",
                status_code=422,
                code="refine_failed",
            ) from exc

    logger.info("Refinado %dx%d com %d traços em %.2fs", width, height, len(stroke_list), elapsed)
    downscaled = width * height < info.width * info.height
    return FileResponse(
        output_path,
        media_type="image/png",
        filename=f"{_safe_stem(file.filename)}-sem-fundo.png",
        headers={
            "Cache-Control": "no-store",
            "X-Processing-Time": f"{elapsed:.2f}",
            "X-Image-Width": str(width),
            "X-Image-Height": str(height),
            "X-Output-Downscaled": "true" if downscaled else "false",
            "X-Strokes-Applied": str(len(stroke_list)),
        },
        background=BackgroundTask(storage.remove, job_dir),
    )


# ---------------------------------------------------------------- Frontend estático (montado por último)
if settings.frontend_dir.exists():
    app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="frontend")
