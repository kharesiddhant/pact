import { useEffect, useState, type SubmitEvent } from 'react'
import { supabase, type Challenge, type Member } from './supabase'

type Row = Challenge & { members: Member[] }

function status(c: Challenge) {
  if (!c.started_at) return 'Setup'
  return Date.now() < Date.parse(c.started_at) + c.duration_days * 864e5 ? 'Running' : 'Finished'
}

export default function Home({ me, name }: { me: string; name: string }) {
  const [list, setList] = useState<Row[] | null>(null)

  useEffect(() => {
    supabase
      .from('challenges')
      .select('*, members(*)')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) alert(error.message)
        setList(data ?? [])
      })
  }, [])

  async function create(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const { data, error } = await supabase.rpc('create_challenge', {
      goal: String(form.get('goal')).trim(),
      stake: form.get('stake'),
      duration_days: Number(form.get('days')),
      name,
    })
    if (error) alert(error.message)
    else location.hash = `#/c/${data}`
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8 px-4 py-8 md:py-12">
      <header className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Pact</h1>
        <button className="link" onClick={() => supabase.auth.signOut()}>
          Sign out ({name})
        </button>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="label px-1">Your bets</h2>
        {list?.length === 0 && <p className="card p-4 text-sm text-muted">No bets yet. Start one below.</p>}
        {list && list.length > 0 && (
          <div className="card divide-y divide-line/70">
            {list.map((c) => {
              const friend = c.members.find((m) => m.user_id !== me)
              return (
                <a
                  key={c.id}
                  href={`#/c/${c.id}`}
                  className="flex items-center gap-3 px-4 py-3 first:rounded-t-2xl last:rounded-b-2xl hover:bg-page/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {friend ? `You and ${friend.display_name}` : 'Waiting for a friend to join'}
                    </span>
                    <span className="block truncate text-sm text-muted">
                      {c.members.find((m) => m.user_id === me)?.goal || 'No goal yet'}
                    </span>
                  </span>
                  <span className="text-sm text-muted">{status(c)}</span>
                  <span aria-hidden className="text-muted">
                    ›
                  </span>
                </a>
              )
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="label px-1">Start a new bet</h2>
        <form onSubmit={create} className="card flex flex-col gap-3 p-4">
          <input name="goal" required maxLength={200} className="field" placeholder="Your goal, for example: ship my MVP" aria-label="Your goal" />
          <input name="stake" maxLength={200} className="field" placeholder="Stake, for example: loser buys dinner" aria-label="Stake" />
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-muted">
              Days
              <input name="days" type="number" required min={1} max={365} defaultValue={14} className="field w-20" />
            </label>
            <button className="btn btn-primary">Create and invite a friend</button>
          </div>
          <p className="label">You each have your own goal. Your friend adds theirs after joining.</p>
        </form>
      </section>
    </div>
  )
}
