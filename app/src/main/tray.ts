import { app, Tray, Menu, nativeImage } from 'electron'
import { sendToRenderer, showMainWindow } from './windows'
import { CH } from '../shared/api'

let tray: Tray | null = null

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: '開く', click: () => showMainWindow() },
    {
      label: '設定',
      click: () => {
        showMainWindow()
        sendToRenderer(CH.openSettings)
      }
    },
    { label: '終了', click: () => app.quit() }
  ])
}

export function createTray(): void {
  const TRAY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACE0lEQVR4AXyPb0gTYRzHvzd3ittcTQlL3+qbQbqcU7GoGVsghEJFr6aQ9GZBUtAb613kC9/ki0LopfWiXoiU9KY/QlbknyaBrpGwGRVuzZNtbre7427buUc9uXPnHu57v+f35/t5nseAMmvOZnvCtLZeVkZkgPoC2KBaZQEURa0IkuRU5tebmycEi+WikpNYFiAJwjIBBJxOesvheBRLpUwcy74nRkVHAurrYZYrKv4UzGZLI0XdXY/Hz/EMM9wPZBQziboAey3svr6ridd9rul5ZqM6kk66X8ZivV5gm5jU0gUYqgzekYdjlY8nnp733LvVJQ1f6z05MhDtbrKMqs1krwvoONvjqauzgq4yodF/A+6bfgwO9h+XcmKOmNTSA9Atba4L4KOAmAZyPCDnEVhcQDYrflCbyb4EYD+BznZXew3k4mEFsQjIIp+N48f35UyIwSIxqVUCqDlm9bY5HeoZCFwSv9b+zRWLUlGarwTQ7b7kqabzmqH/0b9YWQ1/1BT3Ew2gqRZW++kzHciz++29sPBtCQUJJe8nXQ2gkkZPZ5fLKMsF0tuVJHIIBtc2QgmEdguHfhrAnaErnoZTJiS3N5FmE+AFFlxmC8Gfv2cP+Q5SDeDt7Pzk6IP7q9NTM3IkHAHHZ5BKJfF86o3u9QlFA5hZigXGX3xuGR971uC77h8Y8t2e/PQ1/Io2Gt+RYT3tAAAA///r8xy5AAAABklEQVQDAAXuvGuw0D+SAAAAAElFTkSuQmCC'
  const trayIcon = nativeImage.createFromDataURL(TRAY_PNG)
  tray = new Tray(trayIcon)
  tray.setToolTip('Shiori')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', () => showMainWindow())
}
