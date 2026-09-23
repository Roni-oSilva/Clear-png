"""Armazenamento temporário isolado por pedido + rotina de limpeza automática."""
from __future__ import annotations

import asyncio
import logging
import shutil
import time
import uuid
from pathlib import Path

logger = logging.getLogger("clearcut.storage")


class TempStorage:
    """Cada pedido recebe uma pasta própria (UUID) apagada após a resposta ou por TTL."""

    def __init__(self, root: Path, ttl_seconds: int):
        self.root = root
        self.ttl_seconds = ttl_seconds
        self.root.mkdir(parents=True, exist_ok=True)

    def new_job_dir(self) -> Path:
        job_dir = self.root / uuid.uuid4().hex
        job_dir.mkdir(mode=0o700)
        return job_dir

    def remove(self, path: Path) -> None:
        shutil.rmtree(path, ignore_errors=True)
        logger.debug("Removido: %s", path.name)

    def purge_expired(self) -> int:
        """Apaga pastas mais antigas que o TTL (rede de segurança para falhas/timeouts)."""
        now = time.time()
        removed = 0
        for entry in self.root.iterdir():
            try:
                if now - entry.stat().st_mtime > self.ttl_seconds:
                    if entry.is_dir():
                        shutil.rmtree(entry, ignore_errors=True)
                    else:
                        entry.unlink(missing_ok=True)
                    removed += 1
            except FileNotFoundError:
                continue
        if removed:
            logger.info("Limpeza automática: %d item(ns) expirado(s) removido(s).", removed)
        return removed

    def purge_all(self) -> None:
        for entry in self.root.iterdir():
            if entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)


async def cleanup_loop(storage: TempStorage, interval_seconds: int) -> None:
    """Tarefa de fundo que corre durante toda a vida do servidor."""
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            await asyncio.to_thread(storage.purge_expired)
        except Exception:  # nunca deixar a rotina morrer
            logger.exception("Falha na rotina de limpeza automática")
