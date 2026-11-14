# Tags and auto tagging

[日本語](tags.ja.md) ・ **English**

You can tag images and clips and filter by those tags later.
There are two kinds of tags: **manual tags** you add yourself, and **AI tags** added by AI.

## Adding tags yourself

Type one in from **+ Tag** in the details panel, or select items in the list and press `T`.
In the box that `T` opens, `Enter` adds the tag, `Shift+Enter` adds it and keeps the box open for another, and `Esc` closes it.

With several items selected, **Tags (bulk edit)** in the details panel adds tags to all of them.
Clicking a tag that only some of them have adds it to all of them.

Right-click a tag to remove it.
Right-click a tag in the sidebar to delete that tag from every image. This cannot be undone.

## Auto tagging (WD Tagger)

Go to Settings → Tags → **Auto tagging (WD Tagger)** and press **Download model**, and AI will tag everything you capture.
The first time only, a model of about 600 MB has to be downloaded.

The model is downloaded from HuggingFace and stored on your PC.
Tagging happens entirely on your PC, and images are never sent anywhere.

To tag images you captured earlier, press **Tag existing images…**. Only images without AI tags yet are processed.

Pressing **Delete model** deletes the model and, with it, every AI tag added so far across your whole library. Manual tags are kept. This cannot be undone.

## Tags shown in the sidebar

By default, the sidebar shows only manual tags.
Turn on Settings → Tags → **Show AI tags in the sidebar too** to list AI tags as well. Manual tags are shown above AI tags.
