import { useEffect, useRef, useState, type SubmitEvent } from 'react'
import Modal from './Modal'
import { formatTime as time, supabase, type Data, type Message, type Save } from './supabase'

// ponytail: a hand-picked set, most used first. Swap in a searchable picker library if this feels small.
// Any emoji typed from the keyboard works in a message already.
const EMOJI = (
  '👍 ❤️ 🔥 💪 😂 🎉 👏 🙌 🙏 💯 ✅ 👀 ' +
  '😀 😄 😁 😅 🤣 😊 😇 🙂 😉 😍 🥰 😘 😎 🤩 🥳 🤔 🤨 😐 😴 😮 😱 😢 😭 😤 😡 🥺 😬 🙄 😏 🤯 🥱 🤗 🫡 🤝 ' +
  '👎 👌 ✌️ 🤞 🤙 👋 🫶 ✍️ 💅 🧠 ' +
  '💙 💚 💛 💜 🖤 💔 ✨ ⭐ 🌟 ⚡ 💥 💫 ❗ ❓ ❌ ⏰ ⏳ 📌 ' +
  '💻 📚 📝 📈 📊 🎯 🏆 🥇 🚀 💡 🔧 🐛 ☕ 🧘 🏃 ' +
  '🍕 🍔 🍰 🍫 🍻 🥂 🎂 🎁 🎶 🌈 ☀️ 🌙 🐢 🐌 🦥 💤'
).split(' ')

/** Discussion space: messages, replies, reactions and nudges. History entries live on the main page. */
export default function Chat(props: { data: Data; me: string; save: Save; onClose: () => void }) {
  const { data, me, save } = props
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  // The emoji panel is open for one message (its id), for the message being typed, or closed.
  const [picker, setPicker] = useState<string | 'compose' | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const name = (userId: string | null) => data.members.find((m) => m.user_id === userId)?.display_name ?? 'Someone'

  const messages = data.messages.filter((m) => m.kind !== 'system')
  const target = messages.find((m) => m.id === picker)
  const count = messages.length
  // Show the newest messages. (scrollIntoView would also scroll the dialog and the page behind it.)
  const composing = picker === 'compose' // the panel shrinks the list, so jump back to the newest message
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight
  }, [count, composing])

  async function send(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const body = String(new FormData(form).get('body')).trim()
    if (!body) return
    const sent = await save(
      supabase.from('messages').insert({ challenge_id: data.challenge.id, body, reply_to: replyTo?.id ?? null }),
    )
    if (sent) {
      form.reset()
      setReplyTo(null)
      setPicker(null)
    }
  }

  function react(m: Message, emoji: string) {
    const reacted = m.reactions.some((r) => r.user_id === me && r.emoji === emoji)
    return save(
      reacted
        ? supabase.from('reactions').delete().match({ message_id: m.id, user_id: me, emoji })
        : supabase.from('reactions').insert({ message_id: m.id, emoji }),
    )
  }

  function pick(emoji: string) {
    if (target) {
      void react(target, emoji)
      setPicker(null)
      return
    }
    // Typing: put the emoji where the cursor was and keep the panel open for more.
    const field = input.current!
    field.setRangeText(emoji, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, 'end')
    // Refocus only with a mouse; on a phone that would pop the keyboard over the panel.
    if (matchMedia('(pointer: fine)').matches) field.focus()
  }

  return (
    <Modal title="Discussion space" onClose={props.onClose} fill>
      {/* Only this list scrolls. "relative" keeps the hidden screen-reader labels inside it, so they cannot
          stretch the dialog; overscroll-contain stops scrolling from carrying on to the page behind. */}
      <div ref={list} className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-1">
        {count === 0 && <p className="m-auto text-sm text-muted">No messages yet. Say something encouraging.</p>}
        {messages.map((m) => {
          if (m.kind === 'nudge') {
            return (
              <p key={m.id} className="self-center px-4 text-center text-xs text-muted">
                {name(m.user_id)} sent a nudge · {time(m.created_at)}
              </p>
            )
          }
          const mine = m.user_id === me
          const quoted = data.messages.find((x) => x.id === m.reply_to)
          const update = data.updates.find((u) => u.id === m.update_id)
          const inset = `mb-1.5 rounded-lg border-l-2 px-2 py-1 text-xs ${
            mine ? 'border-white/70 bg-white/15' : 'border-muted/50 bg-black/5'
          }`
          const reacted = [...new Set(m.reactions.map((r) => r.emoji))].sort()
          return (
            <div key={m.id} className={`flex max-w-[85%] flex-col gap-1 ${mine ? 'items-end self-end' : 'items-start self-start'}`}>
              <div className={`flex items-center gap-1.5 ${mine ? 'flex-row-reverse' : ''}`}>
                <div
                  className={`min-w-0 rounded-[18px] px-3.5 py-2 ${mine ? 'bg-accent text-white' : 'bg-fill'} ${
                    picker === m.id ? 'ring-2 ring-accent/40 ring-offset-2' : ''
                  }`}
                >
                  <span className="sr-only">{name(m.user_id)}: </span>
                  {quoted && (
                    <div className={`${inset} line-clamp-2`}>
                      {name(quoted.user_id)}: {quoted.body}
                    </div>
                  )}
                  {update && <div className={inset}>On the update “{update.title}”</div>}
                  <p className="break-words whitespace-pre-wrap">{m.body}</p>
                </div>
                <button
                  className="grid size-6 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-fill"
                  aria-label="Reply or react"
                  aria-expanded={picker === m.id}
                  onClick={() => setPicker(picker === m.id ? null : m.id)}
                >
                  +
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted">
                {reacted.map((emoji) => {
                  const who = m.reactions.filter((r) => r.emoji === emoji)
                  const byMe = who.some((r) => r.user_id === me)
                  return (
                    <button
                      key={emoji}
                      onClick={() => react(m, emoji)}
                      title={who.map((r) => name(r.user_id)).join(', ')}
                      aria-pressed={byMe}
                      className={`rounded-full px-1.5 py-0.5 text-xs text-ink ${
                        byMe ? 'bg-accent/15 ring-1 ring-accent/40' : 'bg-fill'
                      }`}
                    >
                      {emoji} {who.length}
                    </button>
                  )
                })}
                <span>{time(m.created_at)}</span>
              </div>
            </div>
          )
        })}
      </div>

      {picker && (
        <div className="mt-3 shrink-0 rounded-2xl bg-page p-2">
          {target && (
            <div className="mb-1 flex items-center gap-3 px-2 py-1 text-sm text-muted">
              <span className="min-w-0 flex-1 truncate">
                {name(target.user_id)}: {target.body}
              </span>
              <button
                className="link"
                onClick={() => {
                  setReplyTo(target)
                  setPicker(null)
                  input.current?.focus()
                }}
              >
                Reply
              </button>
              <button onClick={() => setPicker(null)} aria-label="Close emoji panel">
                ✕
              </button>
            </div>
          )}
          <div className="grid max-h-40 grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] overflow-y-auto">
            {EMOJI.map((emoji) => (
              <button
                key={emoji}
                className="grid h-10 place-items-center rounded-lg text-xl transition-colors hover:bg-fill"
                aria-label={target ? `React with ${emoji}` : `Insert ${emoji}`}
                onClick={() => pick(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {replyTo && (
        <div className="mt-3 flex shrink-0 items-center gap-2 rounded-xl bg-page px-3 py-2 text-sm text-muted">
          <span className="min-w-0 flex-1 truncate">
            Replying to {name(replyTo.user_id)}: {replyTo.body}
          </span>
          <button onClick={() => setReplyTo(null)} aria-label="Cancel reply">
            ✕
          </button>
        </div>
      )}
      <form onSubmit={send} className="mt-3 flex shrink-0 items-center gap-2">
        <input
          ref={input}
          name="body"
          className="field rounded-full px-4"
          maxLength={2000}
          placeholder="Message"
          aria-label="Message"
          autoComplete="off"
        />
        <button
          type="button"
          className={`grid size-10 shrink-0 place-items-center rounded-full transition-colors hover:bg-fill ${
            picker === 'compose' ? 'bg-fill text-accent' : 'text-muted'
          }`}
          aria-label="Emoji"
          aria-expanded={picker === 'compose'}
          onClick={() => setPicker(picker === 'compose' ? null : 'compose')}
        >
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
            <path d="M9 9.5v.5M15 9.5v.5" />
          </svg>
        </button>
        <button
          className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-lg text-white transition-colors hover:bg-accent-hover"
          aria-label="Send"
        >
          ↑
        </button>
      </form>
    </Modal>
  )
}
