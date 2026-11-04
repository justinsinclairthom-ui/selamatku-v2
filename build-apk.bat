@echo off
setlocal EnableExtensions

echo.
echo ============================================
echo   SelamatKu APK Builder
echo ============================================
echo.

REM --- Configuration ---
set "JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.21.21-hotspot"
set "ANDROID_HOME=C:\Users\Administrator\android-sdk"
set "PROJECT_DIR=%~dp0"
set "ANDROID_DIR=%PROJECT_DIR%android"
set "ASSETS_DIR=%ANDROID_DIR%\app\src\main\assets"
set "OUTPUT_APK=%PROJECT_DIR%SelamatKu-v1.0-debug.apk"

REM --- Check prerequisites ---
if not exist "%JAVA_HOME%\bin\java.exe" (
    echo [ERROR] Java JDK 17 not found at: %JAVA_HOME%
    echo         Please install OpenJDK 17 and update JAVA_HOME in this script.
    pause
    exit /b 1
)

if not exist "%ANDROID_HOME%\platforms\android-34" (
    echo [ERROR] Android SDK Platform 34 not found.
    echo         Run sdkmanager to install: platforms;android-34
    pause
    exit /b 1
)

echo [1/4] Syncing web assets to Android project...
copy /Y "%PROJECT_DIR%index.html"          "%ASSETS_DIR%\" >nul
copy /Y "%PROJECT_DIR%style.css"           "%ASSETS_DIR%\" >nul
copy /Y "%PROJECT_DIR%app.js"              "%ASSETS_DIR%\" >nul
copy /Y "%PROJECT_DIR%service-worker.js"   "%ASSETS_DIR%\" >nul
copy /Y "%PROJECT_DIR%manifest.json"       "%ASSETS_DIR%\" >nul
if exist "%PROJECT_DIR%icons" (
    xcopy /Y /S /Q "%PROJECT_DIR%icons" "%ASSETS_DIR%\icons\" >nul
)
echo       Assets synced.

echo.
echo [2/4] Building APK (debug)...
cd /d "%ANDROID_DIR%"
"%JAVA_HOME%\bin\java.exe" -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain assembleDebug --no-daemon

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Build failed!
    pause
    exit /b 1
)

echo.
echo [3/4] Copying APK to output...
copy /Y "%ANDROID_DIR%\app\build\outputs\apk\debug\app-debug.apk" "%OUTPUT_APK%" >nul

echo.
echo [4/4] Done!
echo.
echo ============================================
echo   BUILD SUCCESSFUL
echo ============================================
echo.
echo   APK Location: %OUTPUT_APK%
echo   Size:         for %%F in ("%OUTPUT_APK%") do @echo          %%~zF bytes
echo.
echo   To install on your phone:
echo     1. Transfer the APK file to your phone
echo     2. Open the file on your phone
echo     3. Allow "Install unknown apps" when prompted
echo     4. Tap Install
echo.
pause
endlocal
