# What gets recorded when you capture

[日本語](what-gets-recorded.ja.md) ・ **English**

Along with what you capture, Shiori keeps a record of what you were watching, where, and at which point.
Collecting that is the browser extension's job.

## What the extension tells the app

While a video page on a supported site is open, the extension tells Shiori on the same PC:

the **title** (read from the page), the **playback position**, the **URL**, and the **position of the browser window** (so Shiori knows which part of the screen to capture).

It sends this only to Shiori on the same PC (`ws://127.0.0.1`, port 39821; if that is taken, it moves on to 41821 / 43821 / 45821 in that order).
Nothing is sent to the internet.

You can check whether the extension is connected in Settings → General → Browser extension.
It shows **Connected** when data is arriving from a video page on a supported site, and **Not connected** when it is not.

## What a capture keeps

When you press `Alt+S`, Shiori captures only the video area of the browser and saves it as an image.
At that moment the extension hides the player's controls, so only the picture is captured.

The title, playback position, URL, site and capture time are recorded with the image and shown in the details panel.
If auto tagging is set up, tags are added a moment later ([Tags and auto tagging](../using/tags.md)).

By default, images are saved at no more than the resolution of the stream.
If you watch a 1080p stream on a 4K screen, Shiori does not save the upscaled pixels and make the file bigger for nothing.
You can change this in Settings → Data → Saved resolution ([Settings](../using/settings.md)).

## What a recording keeps

When you record with `Alt+D`, picture and sound are saved as a video clip, up to 30 seconds long.

On top of the same information as an image, a clip keeps **a table of which frame of the original video appears where in the clip**.
That table is what lets `,` / `.` in the viewer step through the clip one original frame at a time.
How accurately frames are captured is covered in [About frame accuracy](frame-accuracy.md).

## What imported items keep

Images and videos you import by pasting or dropping have no title, playback position or URL.
In an imported video, one frame of the file is one frame of the original, so `,` / `.` steps through the file one frame at a time.

If a recorded clip ends up without its frame table for some reason, the bottom left of the viewer shows "File frame 128 / 719" in a different color instead of "Frame".
In that case `,` / `.` steps through the frames of the recording file, which do not match the frames of the original video.
