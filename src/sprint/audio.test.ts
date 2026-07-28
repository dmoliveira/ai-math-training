import { afterEach, describe, expect, it, vi } from 'vitest'

import { SynthAudio } from './audio'

class FakeAudioContext {
  state: AudioContextState = 'suspended'
  currentTime = 1
  destination = {} as AudioDestinationNode
  resume = vi.fn(async () => { this.state = 'running' })
  suspend = vi.fn(async () => { this.state = 'suspended' })
  oscillator = {
    type: 'sine',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
  gain = {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  }
  createOscillator = vi.fn(() => this.oscillator)
  createGain = vi.fn(() => this.gain)
}

describe('SynthAudio', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('stays unavailable when the browser audio API is unsupported', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const audio = new SynthAudio()
    expect(await audio.unlockFromUserGesture()).toBe(false)
    expect(() => audio.play('correct')).not.toThrow()
  })

  it('constructs lazily, resumes, plays a short cue, and suspends', async () => {
    const context = new FakeAudioContext()
    const constructor = vi.fn(function AudioContextConstructor() { return context })
    vi.stubGlobal('AudioContext', constructor)
    const audio = new SynthAudio()
    expect(constructor).not.toHaveBeenCalled()
    expect(await audio.unlockFromUserGesture()).toBe(true)
    expect(constructor).toHaveBeenCalledOnce()
    audio.play('skip')
    expect(context.oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(310, 1)
    expect(context.oscillator.start).toHaveBeenCalledWith(1)
    expect(context.oscillator.stop).toHaveBeenCalledWith(1.1)
    audio.suspend()
    expect(context.suspend).toHaveBeenCalledOnce()
  })
})
