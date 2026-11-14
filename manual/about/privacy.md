# Privacy

[日本語](privacy.ja.md) ・ **English**

Captured images, clips, records such as titles, and tags are all stored on your PC.
Shiori has no feature that sends them to an outside server.

Shiori connects to the outside only in these cases:

**When downloading the AI model**: it connects to HuggingFace.

**When checking for and downloading app updates**: it connects to GitHub Releases.

**When you press "Report a bug or idea"**: it opens the Tally report form in your default browser and passes the Shiori version, OS type and Electron version to the form.
It does not pass titles, URLs, images or anything like that. Nothing is sent from the app itself.

On video pages of supported sites, the browser extension reads the title, playback position, browser window position and URL, and sends them only to Shiori on the same PC ([What gets recorded when you capture](../concepts/what-gets-recorded.md)).
