import { useState, type SubmitEvent } from 'react'
import Modal from './Modal'
import { formatDay, supabase, type Data, type Member, type Save } from './supabase'

/** Milestone cards for one person. The owner edits; the friend can only suggest. */
export default function Tasks(props: {
  data: Data
  owner: Member
  me: string
  frozen: boolean // true once the bet is over
  save: Save
  onClose: () => void
}) {
  const { data, owner, me, save } = props
  const isOwner = owner.user_id === me
  const canChange = !props.frozen
  const [editing, setEditing] = useState<string | null>(null)
  const milestones = data.milestones.filter((m) => m.user_id === owner.user_id)
  const name = (userId: string) => data.members.find((m) => m.user_id === userId)?.display_name ?? 'someone'

  // Builds a submit handler for a small "add" form: saves the row, then clears the form.
  const adds = (row: (form: FormData) => Parameters<Save>[0]) => async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    if (await save(row(new FormData(form)))) form.reset()
  }

  return (
    <Modal
      title={`${isOwner ? 'Your' : `${owner.display_name}'s`} tasks for the goal: ${owner.goal || '(no goal yet)'}`}
      onClose={props.onClose}
    >
      <div className="flex gap-3 overflow-x-auto rounded-2xl bg-page p-3">
        {milestones.map((m) => (
          <div key={m.id} className="flex w-64 shrink-0 flex-col gap-3 rounded-xl bg-surface p-4 shadow-card">
            {editing === m.id ? (
              <>
                <input
                  key={m.due}
                  type="date"
                  className="field"
                  defaultValue={m.due ?? ''}
                  aria-label="Milestone date"
                  onBlur={(e) =>
                    (e.target.value || null) !== m.due &&
                    save(supabase.from('milestones').update({ due: e.target.value || null }).eq('id', m.id))
                  }
                />
                <input
                  key={m.name}
                  className="field font-semibold"
                  defaultValue={m.name}
                  maxLength={80}
                  aria-label="Milestone name"
                  onBlur={(e) => {
                    const value = e.target.value.trim()
                    if (value && value !== m.name) save(supabase.from('milestones').update({ name: value }).eq('id', m.id))
                  }}
                />
                {m.tasks
                  .filter((t) => !t.suggested_by)
                  .map((t) => (
                    <div key={t.id} className="flex items-center gap-2">
                      <input
                        key={t.title}
                        className="field"
                        defaultValue={t.title}
                        maxLength={200}
                        aria-label="Task"
                        onBlur={(e) => {
                          const value = e.target.value.trim()
                          if (value && value !== t.title) save(supabase.from('tasks').update({ title: value }).eq('id', t.id))
                        }}
                      />
                      <button
                        className="grid size-7 shrink-0 place-items-center rounded-full text-xs text-muted transition-colors hover:bg-fill"
                        aria-label={`Delete task ${t.title}`}
                        onClick={() => save(supabase.from('tasks').delete().eq('id', t.id))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                <div className="mt-auto flex items-center justify-between pt-1">
                  <button
                    className="text-sm text-bad-ink hover:underline"
                    onClick={() =>
                      confirm(`Delete "${m.name}" and all its tasks?`) &&
                      save(supabase.from('milestones').delete().eq('id', m.id))
                    }
                  >
                    Delete milestone
                  </button>
                  <button className="link font-semibold" onClick={() => setEditing(null)}>
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="label">{m.due ? formatDay(m.due) : 'No date'}</div>
                    <div className="font-semibold tracking-tight break-words">{m.name}</div>
                  </div>
                  {isOwner && canChange && (
                    <button className="link" onClick={() => setEditing(m.id)}>
                      Edit
                    </button>
                  )}
                </div>
                <ul className="flex flex-col gap-2 text-[15px]">
                  {m.tasks.map((t) =>
                    t.suggested_by ? (
                      <li key={t.id} className="rounded-lg bg-page px-2.5 py-2">
                        <div className="break-words">{t.title}</div>
                        <div className="mt-0.5 text-[13px] text-muted">Suggested by {name(t.suggested_by)}</div>
                        {isOwner && canChange && (
                          <div className="mt-1 flex gap-4 text-[13px]">
                            <button
                              className="font-medium text-accent hover:underline"
                              onClick={() => save(supabase.from('tasks').update({ suggested_by: null }).eq('id', t.id))}
                            >
                              Accept
                            </button>
                            <button className="text-muted hover:underline" onClick={() => save(supabase.from('tasks').delete().eq('id', t.id))}>
                              Decline
                            </button>
                          </div>
                        )}
                      </li>
                    ) : (
                      <li key={t.id}>
                        <label className="flex items-start justify-between gap-3">
                          <span className="min-w-0 break-words">{t.title}</span>
                          {/* Read-only: tasks are ticked from the daily update form. */}
                          <input
                            type="checkbox"
                            checked={Boolean(t.update_id)}
                            readOnly
                            aria-disabled
                            tabIndex={-1}
                            className="pointer-events-none mt-1 size-4 shrink-0 accent-accent"
                          />
                        </label>
                      </li>
                    ),
                  )}
                </ul>
                {isOwner && canChange && (
                  <form
                    className="mt-auto flex gap-2 pt-1"
                    onSubmit={adds((form) =>
                      supabase.from('tasks').insert({ milestone_id: m.id, title: String(form.get('title')).trim() }),
                    )}
                  >
                    <input name="title" required maxLength={200} className="field" placeholder="New task" aria-label="New task" />
                    <button className="btn size-10 shrink-0 p-0 text-lg" aria-label="Add task">
                      +
                    </button>
                  </form>
                )}
              </>
            )}
          </div>
        ))}

        {isOwner && canChange && (
          <form
            className="flex w-64 shrink-0 flex-col gap-2 rounded-xl border border-dashed border-line p-4"
            onSubmit={adds((form) =>
              supabase.from('milestones').insert({
                challenge_id: owner.challenge_id,
                name: String(form.get('name')).trim(),
                due: form.get('due') || null,
              }),
            )}
          >
            <input name="due" type="date" className="field" aria-label="Milestone date" />
            <input name="name" required maxLength={80} className="field" placeholder="New milestone" aria-label="New milestone" />
            <button className="btn">Add milestone</button>
          </form>
        )}
        {!isOwner && milestones.length === 0 && (
          <p className="p-4 text-sm text-muted">{owner.display_name} has not added any tasks yet.</p>
        )}
      </div>

      {!isOwner && canChange && milestones.length > 0 && (
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={adds((form) =>
            supabase.from('tasks').insert({
              milestone_id: form.get('milestone_id'),
              title: String(form.get('title')).trim(),
              suggested_by: me,
            }),
          )}
        >
          <select name="milestone_id" className="field w-auto" aria-label="Milestone">
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <input name="title" required maxLength={200} className="field w-auto min-w-40 flex-1" placeholder="Suggest a task" aria-label="Suggest a task" />
          <button className="btn btn-primary">Suggest</button>
        </form>
      )}
      <p className="label mt-3">
        Tasks are ticked from the daily update form. Every change to this list is recorded in the history.
      </p>
    </Modal>
  )
}
