# Settings

[日本語](settings.ja.md) ・ **English**

Open Settings by right-clicking the tray icon and choosing **Settings**.
It is split into the tabs General, Capture, Tags, Data and About.

## General

**Appearance**: choose the theme (System / Dark / Light) and the language.

**Startup**: turn on **Start on login** to start Shiori when you sign in to Windows.

**Memory**: turn on **Free memory when the window is closed** to use less memory while the window is closed.
In exchange, opening the window or starting a recording may take a moment.

**Browser extension**: shows **Open the extension folder** and whether the extension is connected (**Connected** / **Not connected**).
When an app update also brought a new extension, it shows **Reload needed**; reload the extension on your browser's extensions page.

## Capture

**Hotkeys**: change the key to capture (default `Alt+S`) and the key to record (default `Alt+D`).
If pressing one does nothing, another app may be using the same key.

**Frame step (, / .)**: choose whether the fps of the original video is measured for each recording (**Auto-detect**) or fixed ([About frame accuracy](../concepts/frame-accuracy.md)).

**Notifications**: choose whether Windows notifications appear when a capture or recording finishes.

## Tags

**Auto tagging (WD Tagger)** and **Sidebar** settings ([Tags and auto tagging](tags.md)).

## Data

**Storage location**: change where images and clips are saved.
Changing it also moves everything you already have. Before moving, Shiori shows how many files and how much space, and you can stop partway.
Stopping or failing changes nothing. While moving, the destination temporarily needs twice the free space.
A drive root cannot be chosen.

**Disk usage**: shows how many images and videos you have and how much space each uses.

**Saved resolution**: the maximum size of captured images. It does not apply to recordings.
**Auto** (the default) matches the resolution of the stream and does not save upscaled pixels.
**1080p** and **720p** lower the quality when the stream is higher than that. **No limit** saves at the size shown on screen.

**Video export**: the format clips are exported in ([Export formats](../reference/export.md)).

**Export / Import**: export your whole library to a folder, or read an exported folder back in ([Export formats](../reference/export.md)).

**Repair thumbnails**: use this if some images have no thumbnail in the list.

## About

Shows the version and credits for the libraries Shiori uses.
