@rem Gradle startup script for Windows
@if "%DEBUG%"=="" @echo off

setlocal

set DIRNAME=%~dp0
if "%DIRNAME%"=="" set DIRNAME=.

set JAVA_HOME=%JAVA_HOME%
if defined JAVA_HOME if exist "%JAVA_HOME%" goto okJava
echo ERROR: JAVA_HOME is not set correctly.
exit /b 1

:okJava
set JAVA_EXE=%JAVA_HOME%/bin/java.exe

set CLASSPATH=%DIRNAME%gradle\wrapper\gradle-wrapper.jar

"%JAVA_EXE%" %JAVA_OPTS% -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*

endlocal
