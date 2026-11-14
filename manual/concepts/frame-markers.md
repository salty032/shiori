# What "missed", "frames missing" and "unreliable" mean

[日本語](frame-markers.ja.md) ・ **English**

While you step through frames, a mark sometimes appears next to "Frame 128 / 719" at the bottom left of the viewer.
Each one means you cannot be sure that frame was captured exactly as it is in the original video.
Click the frame number to see a list of where each problem is in that recording.

## missed

**The picture for this frame was not captured, so the picture of the frame before is shown.**

The frame number is still correct. Stepping through, you do stop on this frame.
But the picture shown belongs to the previous frame, so **if a new drawing starts on this frame, you cannot see it on screen.**
If you are using "the picture does not change" to judge timing, do not judge on a missed frame.

Missed frames always appear in 60fps video ([About frame accuracy](frame-accuracy.md)).

## frames missing ("8 frames missing" and so on)

**The frames of the original video themselves never reached the recording.**
Unlike a missed frame, you cannot stop on these frames. Pressing `.` jumps over the missing ones.
The mark appears on the frame just before the gap.

"~8 frames missing" means the number of missing frames was estimated from the times before and after the gap.
If it is off by one, every frame number after it is off by one too, and nothing on screen tells you so.
"gap - frame count unknown" is a place where even the number of missing frames is unknown.

## unreliable (frame number in red)

**Stepping through frames cannot be trusted for this recording as a whole.** The frame number itself turns red.
It appears when too many frames are missing, or when the pictures have fallen out of step with the frames of the original video.
Once out of step, it stays out of step from that point to the end. Because you cannot tell which frame the picture belongs to, this is more serious than "missed".

## Where the marks appear

Besides next to the frame number at the bottom left of the viewer, "{count} frames missed" or "unreliable" also appears in the details panel.
The notice right after recording shows it too, such as "Recording saved (…, missed frames: none)" or "missed frames: 3".
Right after recording it says "missed frames: checking", and changes to a number once checking is done.

The notice right after recording may add "possible gap at the start".
That means Shiori could not wait long enough for the picture to settle when the recording started.
"the preparation message may appear at the start" means the **Getting ready to record** message may have been captured at the very beginning of the recording.

## How this affects the timesheet

Missed frames and missing frames have no picture, so they are grayed out in the timesheet and you cannot enter anything there ([Timesheet](../using/timesheet.md)).
The timesheet cannot be opened for an unreliable recording.
