@echo off
title Fotat HR System - Online Cloud Link
chcp 65001 >nul
cls
echo ============================================================
echo   مصنع فتات للمخبوزات - تشغيل النظام أونلاين عبر الإنترنت
echo   تصميم وتطوير: مستر محمد الجندي — مدير تشغيل إقليمي
echo ============================================================
echo.
echo جاري تشغيل السيرفر المحلي...
start /b "" "C:\Program Files\nodejs\node.exe" server\server.js
timeout /t 2 /nobreak >nul
echo.
echo جاري إنشاء رابط إنترنت مشفر وآمن (HTTPS)...
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000
pause
