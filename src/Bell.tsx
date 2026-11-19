import { useEffect, useRef, useState } from 'react'
import { chime, setSound as saveSound, soundOn, unlockSound, type Activity } from './notify'
import { formatTime } from './supabase'

export default function Bell(props: {
  items: Activity[]
  isUnread: (item: Activity) => boolean
  name: string
  onOpen: () => void // marks everything as seen
  onOpenChat: () => void
}) {
  const [open, setOpen] = useState(false)
  const [sound, setSound] = useState(soundOn)
  const [shown, setShown] = useState<string[]>([]) // ids that were new when the panel opened
  const ref = useRef<HTMLDivElement>(null)
  const unread = props.items.filter(props.isUnread).length

  // Close on a click outside or on Escape.
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => ref.current?.contains(e.target as Node) || setOpen(false)
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  function toggle() {
    // Read the unread dots first, then mark everything seen; the dots stay visible while the panel is open.
    if (!open) setShown(props.items.filter(props.isUnread).map((i) => i.id))
    setOpen(!open)
    if (!open) props.onOpen()
  }

  function toggleSound() {
    const next = !sound
    saveSound(next)
    setSound(next)
    if (next) {
      unlockSound()
      chime() // a preview, so you know what it sounds like
    }
  }

  return (
    <div ref={ref} className="relative justify-self-end">
      <button
        onClick={toggle}
        aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        aria-expanded={open}
        className="relative grid size-9 place-items-center rounded-full text-ink transition-colors hover:bg-fill"
      >
        <svg viewBox="0 0 24 24" className="size-[22px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9a6 6 0 1 1 12 0c0 4.5 1.5 6.5 2.5 7.5h-17C4.5 15.5 6 13.5 6 9Z" />
          <path d="M10 20a2.2 2.2 0 0 0 4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-bad-ink px-1 text-[11px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="card absolute top-full right-0 z-20 mt-2 flex max-h-[min(28rem,70dvh)] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-3">
            <h2 className="font-semibold tracking-tight">Activity</h2>
            <button className="link" onClick={toggleSound} aria-pressed={sound}>
              {sound ? 'Sound on' : 'Sound off'}
            </button>
          </div>
          <ul className="overflow-y-auto">
            {props.items.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-muted">Nothing yet. {props.name}'s updates and messages show up here.</li>
            )}
            {props.items.slice(0, 30).map((item) => (
              <li key={item.id} className="border-t border-line/70 first:border-t-0">
                <button
                  className="flex w-full gap-3 px-4 py-2.5 text-left hover:bg-page/70"
                  onClick={() => {
                    setOpen(false)
                    if (item.inChat) props.onOpenChat()
                  }}
                >
                  <span
                    aria-label={shown.includes(item.id) ? 'New' : undefined}
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${shown.includes(item.id) ? 'bg-accent' : 'bg-transparent'}`}
                  />
                  <span className="min-w-0">
                    <span className="line-clamp-2 text-sm break-words">
                      <span className="font-semibold">{props.name}</span> {item.text}
                    </span>
                    <span className="block text-xs text-muted">{formatTime(item.at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
