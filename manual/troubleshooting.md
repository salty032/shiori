# Troubleshooting

[日本語](troubleshooting.ja.md) ・ **English**

## Captures or recordings are black

Hardware acceleration is on in your browser.
Turn it off and restart the browser ([Turn off hardware acceleration in your browser](getting-started/hardware-acceleration.md)).
When a capture comes out black, Shiori also tells you: "The captured frame came out black."

## "Nothing to capture" appears

The extension is not connected. Check that a video page on a supported site is open and that the extension is enabled.
If Settings → General → Browser extension shows **Connected**, it is connected.

In Firefox, the extension is removed when you quit Firefox. Load it again ([Installation](getting-started/installation.md)).

## "Reload needed" appears

Shiori has updated, and so has the extension. Reload the Shiori extension on your browser's extensions page.
Until you do, the old extension keeps running.

## "Shiori cannot connect to the browser extension" or "No port available" appears

The port the extension and the app use to talk is taken by another app or reserved by Windows.
Restarting your PC may fix it. Reinstalling the extension or reloading the page will not.

## Nothing happens when I press `Alt+S` / `Alt+D`

A recording or overlay app such as the NVIDIA App may be using the same key.
Change the key in Settings → Capture. If Shiori could not register a key, it also tells you: "Could not register the … hotkey."

## The title is not picked up, or player controls show up in captures

The site may have changed how its pages are built. Please let us know through [Reporting bugs](about/feedback.md).

## "Shiori cannot reach the folder it saves to" appears

The save location is on an external drive or similar that is not connected right now. Connect the drive, or choose another folder in Settings → Data → Storage location.

## Some items have no thumbnail in the list

Press **Repair thumbnails…** under Settings → Data. The images themselves are not gone.

## "Your database is damaged" appears

If there is a backup, you can restore from it. Images and videos are separate files, so they are not lost whichever you choose.
Restoring loses tags, notes and timesheets added after the backup.
The damaged file is not deleted; it is kept in the backups folder.
