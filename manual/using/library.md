# Library

[日本語](library.ja.md) ・ **English**

Every image and clip you capture goes into the library.
The sidebar is on the left, the list in the middle, and the details panel on the right.

<!-- Screenshot: the whole library (sidebar, list, details panel) -->

## Layout

At the bottom of the sidebar you can switch between **Grid** and **Timeline**.
Grid lays out thumbnails in the order you captured them. Timeline groups items by title in chronological order, which suits following a single sequence.

Sort order can be Newest first, Oldest first or Random. Thumbnail size can be S, M or L in the sidebar.

## Selecting

Click to select one item, and hold `Shift` / `Ctrl` while clicking to select several.
Drag from an empty spot to select everything inside the rectangle.
Arrow keys move the selection, and `Ctrl+A` selects everything. `Escape` clears the selection.

With one item selected, the details panel shows its title, Position, Duration, FPS, Resolution, Site, Captured time, tags and Notes.
With several selected, the details panel switches to bulk tag editing.

Edit the title by double-clicking it in the details panel or pressing `F2`. Notes are saved as you type.

## Opening

Double-click or press `Enter` to open the viewer ([Viewer and trimming](viewer.md)).

## Searching and filtering

Typing in the search field at the top (press `/` to jump there) searches titles and notes.
You can narrow results with these:

| Type | Meaning |
|---|---|
| `tag:name` | Items with that tag |
| `site:name` | Items captured on that site |
| `type:` | Images or videos |
| `from:` / `to:` | A range of capture dates (`2026-01-01` / `2026-01` / `2026`) |

You can also click a tag in the sidebar to filter. Click it again to remove the filter.
To remove every condition, press **Clear filters** in the list.

## Smart folders

Save the current filter with a name using **Save smart folder** in the sidebar.
From then on, one click in the sidebar brings back the same filter.
Deleting a smart folder only deletes the filter; the images stay.

## Passing items to other apps

`Ctrl+C` copies the selected image to the clipboard (videos cannot be copied).
You can also drag items from the list into File Explorer or other apps.
**Export** in the details panel copies the selected items into a folder as files ([Export formats](../reference/export.md)).
