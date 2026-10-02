import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('recorder start order', () => {
  const source = readFileSync(join(__dirname, 'recorder.ts'), 'utf8')

  it('creates the recording canvas stream only after the clean frame boundary', () => {
    const waitForCleanFrame = source.indexOf('await captureBoundary.wait')
    const createCanvasStream = source.indexOf('canvas.captureStream(0)')
    const createRecorder = source.indexOf('new MediaRecorder(recordStream')

    expect(waitForCleanFrame).toBeGreaterThan(-1)
    expect(createCanvasStream).toBeGreaterThan(waitForCleanFrame)
    expect(createRecorder).toBeGreaterThan(createCanvasStream)
    expect(source.slice(createCanvasStream, createRecorder)).not.toContain('csTrack.requestFrame()')
  })

  it('does not use sound as recording feedback', () => {
    const recordingSource = readFileSync(join(__dirname, '../main/video/recording.ts'), 'utf8')
    expect(recordingSource).not.toContain('shell.beep')
  })
})
