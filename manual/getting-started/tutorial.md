# Tutorial: capture one image, record one clip, step through it

[日本語](tutorial.ja.md) ・ **English**

This starts from the point where the app and the extension are installed and hardware acceleration is off.
Have a video ready on a supported site.

## Capture one image

1. Start Shiori. It keeps running in the tray even when you close the window.
2. Play a video on a supported site in your browser.
3. At the moment you want to keep, press `Alt+S`.

A new image appears in the library, already titled.
At the moment of capture the player's controls are hidden, so only the picture is captured.

Click the image to see its title, playback position and URL in the details panel on the right.
Double-click it to open it large in the viewer. Press `Esc` to close.

<!-- Screenshot: the library and details panel after the first capture -->

> After your first capture, Shiori asks "Your first capture is ready. Want to try the library interface?"
> Press **Try it** to try selecting, the viewer, notes and search on the real screen, one after another.

## Record one clip

1. In the same video, go back a little before the part you want and play it.
2. Press `Alt+D` where you want to start.
   **Getting ready to record** appears in the middle of the video. **Recording starts when that message disappears** (up to about 2 seconds).
3. Press `Alt+D` again where you want to stop. If you do not, it stops at 30 seconds.

A new clip appears in the library, with a notice such as "Recording saved (…, missed frames: none)".
Missed frames are explained shortly.

> If nothing happens when you press `Alt+D`, a recording or overlay app such as the NVIDIA App may be using the same key.
> Change the key in Settings.

## Step through it

1. Double-click the clip to open it in the viewer.
2. Press `Space` to pause.
3. Press `.` to go forward one frame and `,` to go back one frame.

The bottom left of the video shows which frame you are on, such as "Frame 128 / 719".
One frame here means one frame of the original video, not one screen refresh.

<!-- Screenshot: stepping through frames in the viewer (frame number visible at the bottom left) -->

Sometimes "missed" or "8 frames missing" appears next to the frame number, or the frame number turns red with "unreliable".
These mean you cannot be sure that frame was captured exactly as it is in the original video.
Click the frame number to read what each one means.
Why this happens is explained in [About frame accuracy](../concepts/frame-accuracy.md).

## Next

That covers the basics of Shiori.
How to find, filter and organize what you have captured is in [Library](../using/library.md), and how to make a timesheet while stepping through frames is in [Timesheet](../using/timesheet.md).
