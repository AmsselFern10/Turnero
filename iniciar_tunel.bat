@echo off
title Turnero 2026 - Tunel Cloudflare
color 0b
echo ========================================================
echo       TURNERO 2026 - INICIANDO TUNEL PUBLICO HTTPS
echo ========================================================
echo.
echo Conectando con Cloudflare Tunnel...
echo Espera unos segundos mientras se genera tu enlace publico.
echo.
echo Presiona Ctrl + C en esta ventana cuando quieras apagar el tunel.
echo ========================================================
echo.

"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000

pause
