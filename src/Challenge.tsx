import { useCallback, useEffect, useRef, useState, type SubmitEvent } from 'react'
import Bell from './Bell'
import Chat from './Chat'
import { chime, friendActivity, soundOn, unlockSound } from './notify'
import Tasks from './Tasks'
import UpdateForm from './UpdateForm'
import {
  formatDay,
  formatTime,
  imageUrl,
  run,
  signImages,
  supabase,
  today,
  type Data,
  type Member,
  type Save,
  type Update,
} from './supabase'

const DAY = 864e5

function countdown(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h ${minutes % 60}m`
}

export default function Challenge({ id, me }: { id: string; me: string }) {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'update' | 'chat' | { tasksOf: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const newestLoad = useRef(0)

  // ponytail: reloads the whole challenge on every change. Fine for two people over a few weeks;
  // page the chat if it ever grows to thousands of messages.
  const load = useCallback(async () => {
    const n = ++newestLoad.current
    const [c, milestones, updates, messages] = await Promise.all([
      supabase.from('challenges').select('*, members(*)').eq('id', id).maybeSingle(),
      supabase
        .from('milestones')
        .select('*, tasks(*)')
        .eq('challenge_id', id)
        .order('due')
        .order('created_at')
        .order('created_at', { referencedTable: 'tasks' }),
      supabase.from('updates').select().eq('challenge_id', id).order('created_at', { ascending: false }),
      supabase.from('messages').select('*, reactions(*)').eq('challenge_id', id).order('created_at'),
    ])
    const failed = c.error ?? milestones.error ?? updates.error ?? messages.error
    if (failed) return setError(failed.message)
    if (!c.data) return setError('This bet does not exist, or you are not part of it.')
    await signImages((updates.data ?? []).flatMap((u: Update) => u.images))
    if (n !== newestLoad.current) return // a newer load is on its way
    const { members, ...challenge } = c.data
    setData({
      challenge,
      members,
      milestones: milestones.data ?? [],
      updates: updates.data ?? [],
      messages: messages.data ?? [],
    })
  }, [id])

  const save: Save = useCallback(
    async (query) => {
      const ok = await run(query)
      await load() // realtime also triggers a reload; this covers a project where realtime is off
      return ok
    },
    [load],
  )

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- first fetch; state is set after the await
    void load()
    // Row level security limits these events to rows this user may read.
    const channel = supabase
      .channel(`challenge:${id}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public' }, () => void load())
      .subscribe()
    const clock = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      void supabase.removeChannel(channel)
      clearInterval(clock)
    }
  }, [id, load])

  // While the chat is open, everything in it counts as seen.
  const seenKey = `seen:${id}`
  const seenUpdatesKey = `seen-updates:${id}`
  const lastMessage = data?.messages.at(-1)?.created_at
  useEffect(() => {
    if (modal === 'chat' && lastMessage) localStorage.setItem(seenKey, lastMessage)
  }, [modal, lastMessage, seenKey])

  // Notifications: the friend's new updates and messages (bell, chime, tab title).
  const [, rerender] = useState(0)
  const activity = data ? friendActivity(data, me) : []
  const seenChat = localStorage.getItem(seenKey) ?? ''
  const seenUpdates = localStorage.getItem(seenUpdatesKey) ?? ''
  const isUnread = (a: { at: string; inChat: boolean }) => a.at > (a.inChat ? seenChat : seenUpdates)
  const unreadCount = activity.filter(isUnread).length
  const newest = activity[0]?.at ?? ''
  const heard = useRef<string | null>(null)
  useEffect(() => {
    if (!data) return
    if (heard.current !== null && newest > heard.current && soundOn()) chime()
    heard.current = newest
  }, [data, newest])
  useEffect(() => {
    addEventListener('pointerdown', unlockSound, { once: true })
    addEventListener('keydown', unlockSound, { once: true })
    return () => {
      removeEventListener('pointerdown', unlockSound)
      removeEventListener('keydown', unlockSound)
    }
  }, [])
  useEffect(() => {
    document.title = unreadCount ? `(${unreadCount}) Pact` : 'Pact'
    return () => {
      document.title = 'Pact'
    }
  }, [unreadCount])

  if (!data) {
    return (
      <p className="p-8 text-muted">
        {error || 'Loading…'}{' '}
        {error && (
          <a className="link" href="#/">
            Back
          </a>
        )}
      </p>
    )
  }

  const { challenge, members } = data
  const mine = members.find((m) => m.user_id === me)!
  const friend = members.find((m) => m.user_id !== me)
  const start = challenge.started_at ? Date.parse(challenge.started_at) : null
  const end = start === null ? null : start + challenge.duration_days * DAY
  const running = end !== null && now < end
  const over = end !== null && now >= end
  // History entries ('system') are shown on this page, not in the chat, so they are not "unread".
  const unread = data.messages.filter((m) => m.kind !== 'system' && m.user_id !== me && m.created_at > seenChat)

  const finished = (userId: string) => {
    const tasks = data.milestones
      .filter((m) => m.user_id === userId)
      .flatMap((m) => m.tasks)
      .filter((t) => !t.suggested_by)
    return tasks.length > 0 && tasks.every((t) => t.update_id)
  }
  const stake = challenge.stake || 'No stake set'
  let verdict = ''
  if (over && friend) {
    const [iWon, theyWon] = [finished(me), finished(friend.user_id)]
    if (iWon && theyWon) verdict = 'You both finished every task. Nobody owes anything.'
    else if (iWon) verdict = `You won. ${friend.display_name} owes the stake.`
    else if (theyWon) verdict = `${friend.display_name} won. You owe the stake.`
    else verdict = 'Neither of you finished. You both owe the stake.'
  }

  const close = () => setModal(null)
  const column = { data, me, start, running, save }

  return (
    // On wide screens the page fills the window and the lists scroll inside their cards.
    <div className="mx-auto flex max-w-6xl flex-col px-4 py-6 lg:h-dvh lg:min-h-[40rem] lg:py-8">
      <header className="mb-6 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <a href="#/" className="link justify-self-start">
          ‹ All bets
        </a>
        <h1 className="text-xl font-semibold tracking-tight">
          {friend ? `You and ${friend.display_name}` : 'New bet'}
        </h1>
        <Bell
          items={activity}
          isUnread={isUnread}
          name={friend?.display_name ?? 'Your friend'}
          onOpen={() => {
            if (lastMessage) localStorage.setItem(seenKey, lastMessage)
            if (data.updates[0]) localStorage.setItem(seenUpdatesKey, data.updates[0].created_at)
            rerender((n) => n + 1)
          }}
          onOpenChat={() => setModal('chat')}
        />
      </header>

      <main className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[1fr_18rem_1fr] lg:grid-rows-[minmax(0,1fr)]">
        {friend ? (
          <Column {...column} member={friend} nudged={false} onAdd={close} />
        ) : (
          <p className="card order-last flex items-center justify-center p-8 text-center text-muted lg:order-none">
            Waiting for your friend to join. Send them the invite link.
          </p>
        )}

        {/* Centre column. On narrow screens its two cards join the page flow: timer first, history last. */}
        <div className="contents lg:flex lg:min-h-0 lg:flex-col lg:gap-4">
          <div className="card order-first flex flex-col gap-4 p-5 lg:order-none lg:min-h-0 lg:overflow-y-auto">
            {start === null ? (
              <Setup data={data} mine={mine} friend={friend} save={save} />
            ) : (
              <>
                <div className="text-center">
                  <div className="label">Time to end</div>
                  <div className="text-[26px] leading-tight font-semibold tracking-tight tabular-nums">
                    {over ? 'Finished' : countdown(end! - now)}
                  </div>
                </div>
                <div className="border-t border-line/70 pt-4 text-center">
                  <div className="label">Stake</div>
                  <div className="font-medium break-words">{stake}</div>
                </div>
                {verdict && <p className="rounded-xl bg-page p-3 text-center text-[15px] font-semibold">{verdict}</p>}
              </>
            )}
          </div>
          <History data={data} />
        </div>

        <Column
          {...column}
          member={mine}
          nudged={running && unread.some((m) => m.kind === 'nudge')}
          onAdd={() => setModal('update')}
        />
      </main>

      <footer className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <button
          className="btn bg-surface shadow-card lg:justify-self-start"
          disabled={!friend}
          onClick={() => friend && setModal({ tasksOf: friend.user_id })}
        >
          View their tasks
        </button>
        <button
          className="btn order-first col-span-2 bg-surface shadow-card lg:order-none lg:col-span-1 lg:justify-self-center"
          onClick={() => setModal('chat')}
        >
          Discussion space
          {unread.length > 0 && (
            <span className="ml-2 rounded-full bg-bad-ink px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-white">
              {unread.length} new
            </span>
          )}
        </button>
        <button className="btn bg-surface shadow-card lg:justify-self-end" onClick={() => setModal({ tasksOf: me })}>
          View your tasks
        </button>
      </footer>

      {modal === 'update' && <UpdateForm data={data} me={me} load={load} onClose={close} />}
      {modal === 'chat' && <Chat data={data} me={me} save={save} onClose={close} />}
      {modal && typeof modal === 'object' && (
        <Tasks
          data={data}
          owner={members.find((m) => m.user_id === modal.tasksOf)!}
          me={me}
          frozen={over}
          save={save}
          onClose={close}
        />
      )}
    </div>
  )
}

/** Centre panel before the start: agree on the stake and length, invite, and press Ready. */
function Setup({ data, mine, friend, save }: { data: Data; mine: Member; friend?: Member; save: Save }) {
  const c = data.challenge
  const [copied, setCopied] = useState(false)
  const link = `${location.origin}${location.pathname}#/join/${c.id}`
  const edit = (change: object) => save(supabase.from('challenges').update(change).eq('id', c.id))
  const readiness = (ready: boolean) => (
    <span className={ready ? 'font-medium text-good-ink' : 'text-muted'}>{ready ? 'Ready ✓' : 'Not ready'}</span>
  )

  return (
    <div className="flex w-full flex-col gap-3 text-sm">
      <h2 className="text-center text-base font-semibold tracking-tight">Setup</h2>
      <label className="label">
        Stake
        <input
          key={c.stake}
          className="field mt-1"
          defaultValue={c.stake}
          maxLength={200}
          placeholder="Loser buys dinner"
          onBlur={(e) => e.target.value.trim() !== c.stake && edit({ stake: e.target.value.trim() })}
        />
      </label>
      <label className="label">
        Days
        <input
          key={c.duration_days}
          className="field mt-1"
          type="number"
          min={1}
          max={365}
          defaultValue={c.duration_days}
          onBlur={(e) => Number(e.target.value) !== c.duration_days && edit({ duration_days: Number(e.target.value) })}
        />
      </label>
      {!friend && (
        <>
          <label className="label">
            Invite link
            <input className="field mt-1" readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
          <button className="btn" onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true))}>
            {copied ? 'Copied' : 'Copy invite link'}
          </button>
        </>
      )}
      <ul className="flex flex-col gap-1 border-t border-line/70 pt-3">
        <li className="flex justify-between gap-2">
          <span>You</span>
          {readiness(mine.ready)}
        </li>
        {friend && (
          <li className="flex justify-between gap-2">
            <span className="min-w-0 truncate">{friend.display_name}</span>
            {readiness(friend.ready)}
          </li>
        )}
      </ul>
      <button
        className={`btn ${mine.ready ? '' : 'btn-primary'}`}
        onClick={() => save(supabase.rpc('set_ready', { c: c.id, r: !mine.ready }))}
      >
        {mine.ready ? 'Wait, not ready' : 'I am ready'}
      </button>
      <p className="label">
        The countdown starts when you both press Ready. Any change to a goal, a task or the stake resets Ready for
        both of you.
      </p>
    </div>
  )
}

/** Who changed what, and when. Entries are written by database triggers; newest first. */
function History({ data }: { data: Data }) {
  const entries = data.messages.filter((m) => m.kind === 'system').reverse()
  const name = (userId: string | null) => data.members.find((m) => m.user_id === userId)?.display_name ?? 'Someone'
  return (
    <section className="card order-last flex flex-col p-5 lg:order-none lg:min-h-32 lg:flex-1">
      <h2 className="mb-1 font-semibold tracking-tight">History</h2>
      {entries.length === 0 && (
        <p className="py-4 text-center text-sm text-muted">Changes to goals, tasks and updates are recorded here.</p>
      )}
      <ol tabIndex={0} aria-label="History" className="flex max-h-80 flex-col overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1">
        {entries.map((m) => (
          <li key={m.id} className="border-t border-line/70 py-2 first:border-t-0">
            <p className="text-sm break-words">
              <span className="font-semibold">{name(m.user_id)}</span> {m.body}
            </p>
            <p className="text-xs text-muted">{formatTime(m.created_at)}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** One person's side: goal, progress, daily dots and the list of daily updates. */
function Column(props: {
  data: Data
  member: Member
  me: string
  start: number | null
  running: boolean
  nudged: boolean
  save: Save
  onAdd: () => void
}) {
  const { data, member, me, start, running, save } = props
  const isMe = member.user_id === me
  const whose = isMe ? 'Your' : `${member.display_name}'s`
  const [nudgeSent, setNudgeSent] = useState(false)

  const tasks = data.milestones
    .filter((m) => m.user_id === member.user_id)
    .flatMap((m) => m.tasks)
    .filter((t) => !t.suggested_by)
  const done = tasks.filter((t) => t.update_id).length
  const updates = data.updates.filter((u) => u.user_id === member.user_id)
  const todayStr = today()
  const days =
    start === null
      ? []
      : Array.from({ length: data.challenge.duration_days }, (_, i) => {
          const d = new Date(start)
          d.setDate(d.getDate() + i)
          return d.toLocaleDateString('en-CA')
        })
  const isLogged = (day: string) => updates.some((u) => u.day === day)
  const elapsed = days.filter((day) => day <= todayStr)

  return (
    <section
      className={`card flex min-w-0 flex-col gap-4 p-5 lg:min-h-0 lg:overflow-y-auto ${isMe ? '' : 'order-last lg:order-none'}`}
    >
      <div>
        <p className="label">{whose} goal</p>
        {isMe && start === null ? (
          <input
            key={member.goal}
            className="field mt-1 font-semibold"
            defaultValue={member.goal}
            maxLength={200}
            placeholder="Type your goal"
            aria-label="Your goal"
            onBlur={(e) => {
              const goal = e.target.value.trim()
              if (goal !== member.goal)
                save(supabase.from('members').update({ goal }).match({ challenge_id: member.challenge_id, user_id: me }))
            }}
          />
        ) : (
          <p className="text-lg leading-snug font-semibold tracking-tight break-words">
            {member.goal || 'No goal yet'}
          </p>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="label">Progress</span>
          <span className="text-[13px] tabular-nums">
            {done} of {tasks.length} tasks
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={`${whose} progress`}
          aria-valuemin={0}
          aria-valuemax={tasks.length}
          aria-valuenow={done}
          className="h-1.5 overflow-hidden rounded-full bg-fill"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }}
          />
        </div>
      </div>

      {days.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="label">Daily log</span>
            <span className="text-[13px] tabular-nums">
              {elapsed.filter(isLogged).length} of {elapsed.length} days
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {days.map((day) => {
              const state = isLogged(day) ? 'logged' : day < todayStr ? 'missed' : 'not yet'
              return (
                <span
                  key={day}
                  title={`${formatDay(day)}: ${state}`}
                  className={`size-2.5 rounded-full ${
                    state === 'logged' ? 'bg-good' : state === 'missed' ? 'bg-bad' : 'bg-line'
                  }`}
                />
              )
            })}
          </div>
        </div>
      )}

      <div className="flex min-h-40 flex-col border-t border-line/70 pt-4 lg:flex-1">
        <div className="mb-1 flex min-h-9 items-center gap-2">
          <h2 className="flex-1 font-semibold tracking-tight">Daily updates</h2>
          {running && isMe && (
            <button className="btn btn-primary" onClick={props.onAdd}>
              Add update
            </button>
          )}
          {running && !isMe && (
            <button
              className="btn"
              disabled={nudgeSent}
              onClick={async () => {
                if (await save(supabase.from('messages').insert({ challenge_id: member.challenge_id, kind: 'nudge' })))
                  setNudgeSent(true)
              }}
            >
              {nudgeSent ? 'Nudged' : 'Nudge'}
            </button>
          )}
        </div>
        {props.nudged && (
          <p className="my-1 rounded-xl bg-accent/10 px-3 py-2 text-sm">You got a nudge. Time to log your day.</p>
        )}
        {start === null && <p className="py-6 text-center text-sm text-muted">Updates start once the countdown begins.</p>}
        {running && !isLogged(todayStr) && <p className="py-3 text-center text-sm text-muted">No updates today</p>}
        {/* Scrolls inside the card on wide screens; on phones the page itself scrolls. */}
        <div className="flex flex-col lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {updates.map((u) => (
            <UpdateCard key={u.id} update={u} data={data} canDelete={isMe && running} save={save} />
          ))}
        </div>
      </div>
    </section>
  )
}

/** A daily update. Click to open the text, the images and the comments. */
function UpdateCard(props: { update: Update; data: Data; canDelete: boolean; save: Save }) {
  const { update: u, data, save } = props
  const completed = data.milestones.flatMap((m) => m.tasks).filter((t) => t.update_id === u.id)
  const comments = data.messages.filter((m) => m.update_id === u.id)
  const name = (userId: string | null) => data.members.find((m) => m.user_id === userId)?.display_name ?? 'Someone'

  async function comment(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const body = String(new FormData(form).get('body')).trim()
    if (!body) return
    if (await save(supabase.from('messages').insert({ challenge_id: data.challenge.id, body, update_id: u.id })))
      form.reset()
  }

  async function remove() {
    if (!confirm('Delete this update? The tasks it completed become open again.')) return
    // Photos can only be removed once no update uses them, so delete the update first.
    if ((await save(supabase.from('updates').delete().eq('id', u.id))) && u.images.length)
      await supabase.storage.from('updates').remove(u.images)
  }

  return (
    <details className="group border-t border-line/70 first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium">{u.title}</div>
          <div className="truncate text-[13px] text-muted">
            {formatDay(u.day)} · {completed.length ? `Completed: ${completed.map((t) => t.title).join(', ')}` : 'No tasks completed'}
            {comments.length > 0 && ` · ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`}
          </div>
        </div>
        {u.images.slice(0, 2).map((path) => (
          <img key={path} src={imageUrl(path)} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
        ))}
        <span aria-hidden className="text-muted transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="flex flex-col gap-3 pb-4 text-[15px]">
        {u.body && <p className="break-words whitespace-pre-wrap">{u.body}</p>}
        {u.images.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {u.images.map((path) => (
              <a key={path} href={imageUrl(path)} target="_blank" rel="noreferrer">
                <img src={imageUrl(path)} alt="Attached to this update" className="w-full rounded-xl" />
              </a>
            ))}
          </div>
        )}
        {comments.length > 0 && (
          <div className="flex flex-col gap-1 text-sm">
            {comments.map((c) => (
              <p key={c.id} className="break-words">
                <span className="font-semibold">{name(c.user_id)}</span> {c.body}
              </p>
            ))}
          </div>
        )}
        <form onSubmit={comment} className="flex gap-2">
          <input name="body" className="field rounded-full px-4" maxLength={2000} placeholder="Comment" aria-label="Comment" autoComplete="off" />
          <button className="btn">Send</button>
        </form>
        {props.canDelete && (
          <button className="self-start text-[13px] text-bad-ink hover:underline" onClick={remove}>
            Delete update
          </button>
        )}
      </div>
    </details>
  )
}
