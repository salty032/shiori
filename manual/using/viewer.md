# Viewer and trimming

[日本語](viewer.ja.md) ・ **English**

Double-click an item in the list, or press `Enter`, to open it large in the viewer.
Close it with `Esc`, `Enter`, or the × in the top right.

`←` / `→` move to the previous or next image or clip. `Tab` shows or hides the details panel.

## Images

Double-click to toggle zoom. `+` / `-` zoom in and out, and `0` resets.

## Clips

`Space` plays and pauses, `M` mutes and unmutes, and `↑` / `↓` change the volume by 5%.

## Stepping through frames

`.` goes forward one frame and `,` goes back one frame.
The bottom left of the video shows which frame of the original video you are on, such as "Frame 128 / 719".

This frame number counts frames of the original video. Missing frames are counted too, so dividing the frame number by the fps gives the time in seconds, and the numbers match those in the timesheet.

If a mark appears next to the frame number, see [What "missed", "frames missing" and "unreliable" mean](../concepts/frame-markers.md).

## Frame-by-frame playback

Shiori can step through the original video automatically, showing each frame for a set time.
Choose the speed as how long each frame is shown, in the form "{sec}s / frame". **Normal** plays at the normal speed.

<!-- Screenshot: choosing the frame-by-frame playback speed -->

## Trimming

You can cut out just the part of a clip you need and save it as a new clip. **The original clip is kept.**

1. In the viewer, press **Trim**.
2. Step through with `,` / `.`, press `I` (**Set start**) where you want it to begin and `O` (**Set end**) where you want it to end.
3. Press **Trim and save**.

The trimmed clip keeps the title, playback position, tags you added yourself, and the frame table of the original video. Notes are not carried over.
You cannot trim to less than 0.1 seconds.

## Stepping through frames in the browser

On a video page of a supported site, you can also step through frames by pressing `,` / `.` over the player.
If you press too quickly, a message such as "Too fast — dropped 3" appears and the presses that could not keep up are skipped.
