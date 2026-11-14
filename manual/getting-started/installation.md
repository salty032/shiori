# Installation

[日本語](installation.ja.md) ・ **English**

Shiori works as two parts: a **desktop app** and a **browser extension**.
The app captures the screen and saves it; the extension tells the app what you are watching and where you are in it (title, playback position, URL).
You cannot capture with only one of them, so install both.

The extension works in Chromium-based browsers such as Chrome, Edge, Vivaldi, Brave and Opera, and in Firefox 142 or later.

## Install the app

Download the latest installer (`Shiori-Setup-x.x.x.exe`) from [GitHub Releases](https://github.com/salty032/shiori/releases) and run it.

The app is not code-signed, so Windows SmartScreen may show a warning the first time.
Choose "More info" → "Run anyway" to continue.

When you open Shiori after installing, the empty library shows **Start setup**.
Press it to open **Set up Shiori**, which walks you through three steps, from preparing the browser to your first capture.
This page and the next one describe those steps in detail.
If you close it partway, you can resume from Setup in the sidebar.

<!-- Screenshot: the "Set up Shiori" window -->

## Load the extension (Chromium-based browsers)

The extension is not on any browser store. You load the extension folder that comes with the app into your browser.

1. In **Set up Shiori**, or in Settings → General → Browser extension, press **Open the extension folder**.
   The extension folder opens (`%APPDATA%\Shiori\extension`).
2. Open your browser's extensions page:
   `chrome://extensions` in Chrome, `edge://extensions` in Edge, `vivaldi://extensions` in Vivaldi, `brave://extensions` in Brave.
3. Turn on **Developer mode**.
4. Press **Load unpacked** and choose the folder you opened in step 1.

Once it is loaded, open a video page on a supported site.
When the extension connects to the app, the second step of **Set up Shiori** shows **Receiving from the video page**.

The extension folder is refreshed whenever the app updates. You do not need to load it again.

## Load the extension (Firefox)

1. In Shiori, go to Settings → General → Browser extension and press **Open the extension folder**.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Press **Load Temporary Add-on…** and choose `manifest.json` inside the folder you opened in step 1.

> **In Firefox, the extension is removed when you quit Firefox.**
> Firefox does not allow unsigned extensions to stay installed,
> so you need to repeat steps 2–3 every time you start Firefox.
> If you would rather not reload it every time, use a Chromium-based browser.

## Updates

When a new version is released, Shiori downloads it in the background.
When the download finishes, a banner appears in the app; press **Restart and update** to switch to the new version right away.
If you quit without pressing it, the update is applied as the app quits, and the new version starts next time.
You never need to download the installer again yourself.

## Next

Go on to [Turn off hardware acceleration in your browser](hardware-acceleration.md).
If you skip it, your captures and recordings will come out black.
