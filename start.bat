@echo off
cd /d "%~dp0"

if not exist .env (
    copy .env.example .env
    echo .env created from template.
    echo Edit .env and set your server and Ollama settings.
    pause
    exit /b 0
)

npm install
npm start
