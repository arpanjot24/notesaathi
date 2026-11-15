#!/usr/bin/env bash
# Installs the freshly built APK on the CI emulator, opens it, and fails if it crashes.
set -e
adb install -r NoteSaathi.apk
adb logcat -c
adb shell am start -W -n app.notesaathi/.MainActivity
sleep 15
adb exec-out screencap -p > screen-home.png
adb logcat -d > logcat.txt || true
if grep -q "FATAL EXCEPTION" logcat.txt; then
  grep -A 40 "FATAL EXCEPTION" logcat.txt
  exit 1
fi
adb shell pidof app.notesaathi
grep -i "chromium.*console\|Uncaught" logcat.txt || true
