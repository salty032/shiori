# Timesheet

[日本語](timesheet.ja.md) ・ **English**

While stepping through a recorded clip, you can enter drawing numbers and build a timesheet.
The result can be copied in a form you can paste into Toei Digital Timesheet.

## Opening it

Open a clip in the viewer and press the timesheet button.
The sheet appears in the same place as the details panel, replacing it. It has the columns Sec, Frame, Cell and Note.

<!-- Screenshot: the timesheet open in the viewer -->

It can only be opened for recordings made from 24fps video (23.976fps when streamed) whose frame numbers match the original video.
A timesheet counts 24 frames per second, so in 30fps or 60fps video the frames of the original video do not correspond to the animation's frames.
It also cannot be opened for an "unreliable" recording ([What "missed", "frames missing" and "unreliable" mean](../concepts/frame-markers.md)) or for videos you imported yourself.

## Entering

While the sheet is open, the keys follow Toei Digital Timesheet.

| Key | Action |
|---|---|
| `0`–`9` | Enter a drawing number |
| `Enter` | Confirm and move to the next frame |
| `Backspace` | Delete |
| `↑` / `↓` | Step frames |
| `←` / `→` | Move between cell columns (you can enter into any column from A to G) |
| `F1` / `F2` / `F3` | ○ (in-between) / ● (reverse sheet) / × (empty). The numeric keypad `/` `-` `*` also work |

While the sheet is open, `←` / `→` do not move to the previous or next clip.

## Grayed-out rows

Missed frames and missing frames are grayed out, and you cannot enter anything there. They have no picture, so anything you entered would be guessed from the frames around them.
"{frames} frames missed" in the sheet's header is the number of missed frames.

Rows for missing frames are inserted based on an estimate of how many frames are missing. If the estimate is off by one, everything you enter below it points to the frame next to the one you meant.

## Copying

Press **Copy** to put the sheet on the clipboard in a form you can paste into Toei Digital Timesheet.
Hover over the button to see how many seconds and frames it covers. Choose the column and position to paste into yourself.

There is no export to `.xdts` files.
