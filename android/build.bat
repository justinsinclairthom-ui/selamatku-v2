@echo off
setlocal

set "JAVA_HOME=C:\Program Files\Microsoft\jdk-26.0.1"
set "ANDROID_HOME=C:\Users\Administrator\android-sdk"
set "ANDROID_SDK_ROOT=C:\Users\Administrator\android-sdk"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%"

cd /d "%~dp0"

echo === Building SelamatKu APK ===
echo Java: %JAVA_HOME%
echo Android SDK: %ANDROID_HOME%
echo.

call gradlew.bat %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo BUILD FAILED
    exit /b 1
)

echo.
echo === BUILD SUCCESSFUL ===
echo APK location: app\build\outputs\apk\debug\app-debug.apk
endlocal
