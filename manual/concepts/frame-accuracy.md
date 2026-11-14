# About frame accuracy

[日本語](frame-accuracy.ja.md) ・ **English**

In the viewer, `,` / `.` steps through a recorded clip **one frame at a time** of the original video.
One frame here is one frame of the video as streamed, not one frame of the recording file.

## Guaranteed up to 24fps / 29.97fps / 30fps

**Frame accuracy is guaranteed for 24fps / 29.97fps / 30fps video.**
Shiori takes in the screen about every 20ms (measured on a 60Hz screen: about 50 pictures per second).
That is shorter than the gap between frames of the original video (41.7ms at 24fps, 33.3ms at 30fps), so every frame can be captured.
In measurements, no frames were missed.

Almost all streamed anime is 24fps (23.976fps to be exact).

## Not guaranteed for 60fps

**Frame accuracy is not guaranteed for 59.94fps / 60fps video.**
The gap between frames of the original video (16.7ms) is shorter than the capture interval, so some frames inevitably cannot be taken in.
You can still record, but frames that could not be taken in show the picture of the frame before.

Raising your screen's refresh rate does not help: capture tops out at about 50 pictures per second (measured on a 200Hz screen).
Frame accuracy for 60fps video is not guaranteed on any screen.

## How the fps is decided

The fps of the original video is measured from the video for each recording (**Auto-detect** under Settings → Capture → Frame step).
If you turn auto-detect off, a fixed fps is used: about 24 for anime, about 30 for live action.

## When accuracy cannot be guaranteed, the screen says so

Frames that could not be captured, and places where Shiori cannot confirm which original frame is shown, are marked on screen rather than hidden.
What appears and what each mark means is in [What "missed", "frames missing" and "unreliable" mean](frame-markers.md).
