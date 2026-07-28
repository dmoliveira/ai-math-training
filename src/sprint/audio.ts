import type { AudioCue, AudioPort } from './contracts'

const FREQUENCIES: Record<AudioCue, number> = {
  type: 520,
  erase: 260,
  submit: 620,
  correct: 880,
  incorrect: 190,
  reveal: 390,
  skip: 310,
  complete: 1_050,
}

export class SynthAudio implements AudioPort {
  private context: AudioContext | null = null

  async unlockFromUserGesture(): Promise<boolean> {
    try {
      if (!this.context) {
        if (typeof AudioContext === 'undefined') return false
        this.context = new AudioContext()
      }
      if (this.context.state === 'suspended') await this.context.resume()
      return this.context.state === 'running'
    } catch {
      return false
    }
  }

  play(cue: AudioCue): void {
    const context = this.context
    if (!context || context.state !== 'running') return
    try {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const now = context.currentTime
      oscillator.type = cue === 'incorrect' ? 'sawtooth' : 'sine'
      oscillator.frequency.setValueAtTime(FREQUENCIES[cue], now)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(now)
      oscillator.stop(now + 0.1)
    } catch {
      // Sound is optional and must never interrupt practice.
    }
  }

  suspend(): void {
    try {
      if (this.context?.state === 'running') void this.context.suspend()
    } catch {
      // Sound is optional and must never interrupt practice.
    }
  }
}
