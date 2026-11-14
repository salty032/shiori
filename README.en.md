# Shiori

[日本語](README.md) ・ **English**

A Windows desktop app that lets you keep a moment from the anime you are streaming as an image or a video clip with a single key,
and look back at it later frame by frame, one frame of the original video at a time.

**Core idea: "the moment you catch the frame you wanted, it's already filed away."**

The title, playback position and URL are recorded the moment you capture, so there is nothing to sort out afterwards.

<!-- Screenshot: the library, and stepping through frames in the viewer -->

## Getting started

Shiori works as two parts: a desktop app and a browser extension.

1. Download the latest installer (`Shiori-Setup-x.x.x.exe`) from [GitHub Releases](https://github.com/salty032/shiori/releases) and run it.
2. Load the browser extension that comes with the app into your browser (Chromium-based browsers and Firefox 142 or later).
3. Turn off hardware acceleration in your browser. If it stays on, your captures come out black.

When you open the app, **Set up Shiori** walks you through steps 2 and 3.
Detailed steps are in [Installation](manual/getting-started/installation.md).

## What it does

- **Capture and record with one key**: `Alt+S` keeps an image, `Alt+D` records a clip of up to 30 seconds. The player's controls are hidden at the moment of capture, so only the picture is kept.
- **Step through the original video one frame at a time**: `,` / `.` step through a recorded clip one frame of the original video at a time. Frame accuracy is guaranteed for 24fps / 30fps video, and missed frames are marked on screen.
- **Timesheet**: enter drawing numbers while stepping through frames, and copy the result in a form you can paste into Toei Digital Timesheet.
- **Find and organize**: filter by title, notes, tags, date and site, and save filters as smart folders. AI auto tagging (WD Tagger) is available too.
- **Everything stays on your PC**: what you capture and its records are stored only on your PC and never sent anywhere.

## Manual

- [Shiori Manual](manual/index.md)
- [Tutorial: capture one image, record one clip, step through it](manual/getting-started/tutorial.md)
- [Troubleshooting](manual/troubleshooting.md)

---

## Disclaimer

Shiori is a tool for organizing and looking back at video you are entitled to watch, on your own PC.
It has no feature that sends what you capture anywhere. Check the terms of each streaming service and the applicable laws, and use it within the scope of private use.
The author accepts no liability for any damages arising from its use.

---

## License

This software is provided under a personal-use (proprietary) license.
Only personal, non-commercial use is permitted; redistribution, distributing modified
versions, and commercial use are prohibited. See [LICENSE](LICENSE) for details. Third-party licenses are listed in [NOTICE.md](NOTICE.md).

## Development

See [Development setup](manual/development/setup.md) for setting up a development environment.
