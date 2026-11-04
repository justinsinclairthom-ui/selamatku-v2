@echo off
set ANDROID_HOME=C:\Users\Administrator\android-sdk
set JAVA_HOME=C:\Program Files\Java\jdk-26.0.1
cd /d C:\Users\Administrator\disaster-app\android
call gradlew.bat assembleDebug 2>&1
