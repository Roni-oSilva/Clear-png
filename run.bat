@echo off
cd /d "%~dp0backend"
if not exist .venv python -m venv .venv
call .venv\Scripts\activate
pip install -q -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
