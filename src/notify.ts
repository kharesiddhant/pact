// Notifications for the friend's activity: what counts as activity, and the chime.
import type { Data } from './supabase'

let audio: AudioContext | undefined

/** Browsers allow sound only after the person has clicked or typed on the page once. */
export function unlockSound() {
  audio ??= new AudioContext()
  void audio.resume()
}

/** A soft two-note chime, made in the browser so there is no sound file to ship. */
export function chime() {
  if (audio?.state !== 'running') return
  const start = audio.currentTime
  for (const [i, frequency] of [880, 1318.5].entries()) {
    const t = start + i * 0.12
    const tone = new OscillatorNode(audio, { type: 'sine', frequency })
    const volume = new GainNode(audio, { gain: 0.0001 })
    volume.gain.setValueAtTime(0.0001, t)
    volume.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
    volume.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
    tone.connect(volume).connect(audio.destination)
    tone.start(t)
    tone.stop(t + 0.65)
  }
}

const SOUND_KEY = 'pact:sound'
export const soundOn = () => localStorage.getItem(SOUND_KEY) !== 'off'
export const setSound = (on: boolean) => localStorage.setItem(SOUND_KEY, on ? 'on' : 'off')

export type Activity = { id: string; at: string; text: string; inChat: boolean }

/** The friend's updates and chat messages, newest first. Your own actions never notify you. */
export function friendActivity(data: Data, me: string): Activity[] {
  const updateTitle = (id: string | null) => data.updates.find((u) => u.id === id)?.title ?? 'an update'
  return [
    ...data.updates
      .filter((u) => u.user_id !== me)
      .map((u) => ({ id: u.id, at: u.created_at, text: `posted an update: “${u.title}”`, inChat: false })),
    ...data.messages
      .filter((m) => m.user_id !== me && m.kind !== 'system')
      .map((m) => ({
        id: m.id,
        at: m.created_at,
        inChat: true,
        text:
          m.kind === 'nudge'
            ? 'sent you a nudge'
            : m.update_id
              ? `commented on “${updateTitle(m.update_id)}”: ${m.body}`
              : m.body,
      })),
  ].sort((a, b) => b.at.localeCompare(a.at))
}
