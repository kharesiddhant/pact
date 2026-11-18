import { useEffect, useRef, type ReactNode } from 'react'

export default function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      onClose={props.onClose}
      // A click that lands on the dialog itself is a click on the backdrop.
      onClick={(e) => e.target === ref.current && props.onClose()}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(56rem,calc(100vw-2rem))] overflow-y-auto rounded-3xl bg-surface text-ink shadow-2xl backdrop:bg-black/30 backdrop:backdrop-blur-sm"
    >
      <div className="p-5 md:p-6">
        <header className="mb-4 flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-[17px] font-semibold tracking-tight break-words">{props.title}</h2>
          <button
            onClick={props.onClose}
            aria-label="Close"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-fill text-xs transition-colors hover:bg-fill-hover"
          >
            ✕
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  )
}
