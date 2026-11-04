@echo off
setlocal
set "JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.21.21-hotspot"
set "ANDROID_HOME=C:\Users\Administrator\android-sdk"
set "ANDROID_SDK_ROOT=C:\Users\Administrator\android-sdk"
cd /d C:\Users\Administrator\disaster-app\android
"%JAVA_HOME%\bin\java.exe" -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
endlocal
