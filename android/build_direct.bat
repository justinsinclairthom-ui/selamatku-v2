@echo off
set ANDROID_HOME=C:\Users\Administrator\android-sdk
set "JAVA_HOME=C:\Users\Administrator\jdk17\jdk-17.0.20.1+1"
cd /d "C:\Users\Administrator\disaster-app\android"
"%JAVA_HOME%\bin\java.exe" -classpath "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain assembleDebug
