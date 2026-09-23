FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 U2NET_HOME=/models
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
# Descarrega o modelo na build (arranque instantâneo)
RUN python -c "from rembg import new_session; new_session('isnet-general-use')"
COPY backend backend
COPY frontend frontend
WORKDIR /app/backend
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
