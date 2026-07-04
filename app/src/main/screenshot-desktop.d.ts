declare module 'screenshot-desktop' {
  interface Display {
    id: number
    name?: string
    left?: number
    top?: number
    width: number
    height: number
  }

  interface Options {
    screen?: number
    format?: 'png' | 'jpg'
  }

  function screenshot(options?: Options): Promise<Buffer>
  namespace screenshot {
    function listDisplays(): Promise<Display[]>
  }

  export = screenshot
}
