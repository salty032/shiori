# Shiori

[日本語](README.md) ・ **English**

A desktop app (Windows) for organizing the frames you capture while watching anime.

**Core idea: "the moment you catch the frame you wanted, it's already filed away."**

Press a global hotkey to grab the streaming player's screen, and Shiori records the
title, playback timecode, and URL automatically. It also supports automatic tagging with
WD Tagger and filtering by tag or date.

---

## Features

- **One-key capture**: press `Alt+S` to capture the playing player (the player UI is hidden automatically)
- **Video clip recording**: press `Alt+D` to record a short clip of the playing player (capped at **30 seconds** so you can't make long copies — this can't be raised, even in settings). You can trim and play clips inside the app afterwards.
- **Automatic metadata**: the title, playback timecode, and watch URL are recorded for you
- **Automatic tagging**: WD Tagger (a local AI) tags the contents of each capture
- **Search and filter**: search titles and notes, and filter by tag (AND/OR), date, or service
- **Grid and timeline views**: organize in bulk with drag-rectangle selection, Shift/Ctrl-click, and arrow keys
- **Frame stepping**: `,` / `.` over the player (same keys in the app's viewer and trimmer)
- **Local import**: paste a clipboard image with `Ctrl+V`, or drop a folder of images and videos (`.webm` / `.mp4`, up to 30 seconds) to import them in bulk
- **Delete**: press `Delete`. The toast that appears has an "Undo" you can use for a few seconds
  (after the grace period the files are gone for good, and **they are not sent to the Windows Recycle Bin**)
- **Export**: copy the selected images out as plain files
- **Library export/import**: write out or read back your whole library (captures) with its metadata

---

## Installation

> ⚠️ Shiori runs as two parts: a **desktop app** and a **browser extension**. You need to set up both.
> The extension works with Chromium-based browsers (Chrome, Edge, Vivaldi, Brave, Opera, and so on) and Firefox 142 or later.

### 1. The app

Download the latest installer (`Shiori-Setup-x.x.x.exe`) from
[GitHub Releases](https://github.com/salty032/shiori/releases) and run it.

> The build is unsigned, so Windows SmartScreen may warn you on first launch.
> Choose "More info" → "Run anyway" to continue.

### 2. Sideload the browser extension (Chromium)

1. Launch Shiori and click "Open the extension folder" — on the welcome screen (shown when your library is empty), or under Settings → General → Browser extension.
   (This folder is kept in sync automatically when the app updates. To find it by hand, it's at `%APPDATA%\Shiori\extension`.)
2. Open your browser's extensions page (Chrome: `chrome://extensions`, Edge: `edge://extensions`,
   Vivaldi: `vivaldi://extensions`, Brave: `brave://extensions` — the steps are the same on any Chromium browser)
3. Turn on "Developer mode" in the top right
4. Click "Load unpacked" and choose the folder from step 1

Once the extension connects to the app, player info is sent automatically each time you capture.

### 3. Sideload the browser extension (Firefox)

1. In Shiori, click "Open the extension folder" under Settings → General → Browser extension
2. In Firefox, open `about:debugging#/runtime/this-firefox`
3. Choose "Load Temporary Add-on" and select `manifest.json` inside the folder from step 1

> A temporary add-on is removed when Firefox closes. For ongoing use, install the signed
> Firefox extension package instead.

### 4. Updates

After the first install, new versions download in the background automatically.
When a download finishes, a banner appears in the app — press "Restart and update" to apply
it on the spot (no manual downloading or running needed).

### 5. Turn off your browser's hardware acceleration

> ⚠️ **Important**: if your browser's hardware acceleration stays on, your captures and
> clips come out black (the video area goes completely dark). Be sure to turn it off.

Disable it in each browser's settings (restart the browser after changing this):

- Chrome: Settings → System → turn off "Use hardware acceleration when available"
  (`chrome://settings/system`)
- Edge: Settings → System and performance → turn off "Use hardware acceleration when available"
  (`edge://settings/system`)
- Vivaldi / Brave / Opera and other Chromium browsers have the same option under system settings
- Firefox: Settings → General → Performance → turn off "Use recommended performance settings",
  then turn off "Use hardware acceleration when available"

---

## How to use

### Capture a still

1. Play anime on a video page where the browser extension is active
2. Press `Alt+S` on the frame you want
3. The thumbnail, title, and tags appear in your Shiori gallery automatically

### Record a video clip

1. Play a video on a supported site
2. Press `Alt+D` at the start of the scene you want (press again to stop; it stops automatically at **30 seconds**)
3. The clip is added to your gallery; open it to play and trim it inside the app

> While recording, the tray icon shows the status (there's no on-screen indicator over the
> recording area, since it would end up in the recording itself).
> If `Alt+D` doesn't work, another app (an overlay or capture tool such as the NVIDIA App)
> may be using the same key. Change it to a different key in settings.

#### About frame accuracy

In the viewer, `,` / `.` step a recorded clip **one source frame at a time**. The current
position appears at the bottom left of the video as "Frame 128 / 719".

**Frame accuracy is guaranteed for 24fps / 29.97fps / 30fps sources.**
Screen capture delivers about 50 frames per second at most, which is shorter than the gap
between source frames (41.7ms at 24fps, 33.3ms at 30fps), so every source frame gets its own
picture (measured: zero missed frames).

**Frame accuracy is not guaranteed for 59.94fps / 60fps sources.** Their frames are 16.7ms
apart, shorter than the ~20ms capture interval, so some frames inevitably have no picture of
their own. Recording still works, but those frames show the previous frame's picture.

**Nothing unreliable is passed off silently.** Stepping onto such a frame changes the readout
to "reused" or "needs review", and the detail panel shows the counts as "{n} frames need
review" / "{n} frames never reported". **You can tell on the spot whether the picture staying
the same is evidence of the animation's frame timing.**

### Import your own images and videos

- Paste a clipboard image with `Ctrl+V`
- Drop image and video files (`.webm` / `.mp4`, up to 30 seconds), or folders containing them, onto the window to import in bulk

You can change each hotkey (capture / recording) in settings. The app lives in the tray and
keeps running even when you close the window.

---

## What it works with

Automatic title and timecode capture, temporary hiding of the player UI, and `,` / `.`
frame stepping work **only on the services the browser extension explicitly declares support
for**. On any other site the extension is not loaded and does nothing.

The supported services are listed in the extension's `manifest.json`. Title capture and UI
hiding are tuned per site to match its page structure, so adding an arbitrary site to that
list is not enough to make it work.

> Even on a supported service, a change to the site's page structure may temporarily break capture.
> Use Shiori within the terms of service of each site (see "Disclaimer").

---

## Automatic tagging (optional)

Download the model from Settings → the "Tags" tab → "Auto tagging (WD Tagger)" to turn on
AI tagging of your captures.

> The model is downloaded from [HuggingFace](https://huggingface.co/SmilingWolf/wd-vit-tagger-v3)
> and stored locally. All inference happens on your device — your images are never sent anywhere.

---

## Privacy

- Your captures, clips, metadata, and tags are all stored **locally**
- There is no feature that uploads your captures, clips, or metadata to any external server
- Shiori connects to HuggingFace when downloading the model, and to GitHub Releases when checking for and downloading updates
- On video pages where it is active, the browser extension reads the title, playback position, window position, and URL, and sends them only to the local Shiori app (`ws://127.0.0.1:39821`)

---

## Disclaimer

This software is meant for **organizing and helping you enjoy, in your own local environment,**
content you are entitled to watch.

Even where copying for private use is permitted under copyright law, do not use it in ways such as:

- Posting, sharing, distributing, selling, or building a public library out of the images you capture
- Capturing or saving content you know was uploaded illegally
- Taking screenshots, recording, or saving in ways that break a streaming service's terms of service
- Circumventing DRM or other technical protection measures

Some services — Netflix, Amazon Prime Video, ABEMA, and others — prohibit screenshots and
recording in their terms of service. Check the terms of each service and the laws that apply
to you, and keep anything you capture within the scope of private use.

The 30-second clip cap is a design constraint this software imposes; there is no legal rule
that "under 30 seconds is lawful." Even within that cap, whether your use stays within private
copying is something you must judge for yourself. The author accepts no liability for any
damages arising from your use of this software.

---

## Development

See [SETUP.md](SETUP.md) (Japanese) / [SETUP.en.md](SETUP.en.md) for setting up a development environment.
Third-party licenses are listed in [NOTICE.md](NOTICE.md).

---

## License

This software is provided under a personal-use (proprietary) license.
Only personal, non-commercial use is permitted; redistribution, distributing modified
versions, and commercial use are prohibited. See [LICENSE](LICENSE) for details.
