# Scriptorium for Android

A tiny app that opens https://shalone86.github.io/quickstart/ full-screen (same idea as Daily's wrapper), plus:
microphone access for voice notes, a file picker for images and imports, downloads saved to
`Downloads/Scriptorium`, the Android share sheet, Back-button handling, and **Share → Save to Scriptorium**
from any app (links become saved articles; text becomes a note).

Everything else lives on the website, so you only rebuild when this folder changes:

```
ANDROID_HOME=/path/to/android-sdk ./build-apk.sh     # → ../app/scriptorium.apk
```

`build-apk.sh` only needs the SDK (`platforms;android-34`, `build-tools;37.0.0`) and a JDK. No Gradle downloads.
`gradle assembleRelease` also works if you prefer. Bump `versionCode` in `app/build.gradle` when you rebuild.
The APK is signed with `scriptorium.keystore`, kept in the repo so each rebuild installs as an update.
It's a personal signing key for a sideloaded app, not a Play Store identity.
