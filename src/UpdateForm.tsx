import { useState, type SubmitEvent } from 'react'
import Modal from './Modal'
import { supabase, today, type Data } from './supabase'

/** Scales a photo down to 1600px and re-encodes it as JPEG, so the free storage tier lasts. */
async function shrink(file: File) {
  const image = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(image.width * scale)
  canvas.height = Math.round(image.height * scale)
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read that image'))), 'image/jpeg', 0.8),
  )
}

/** "Update for the day": the only place where tasks get ticked. */
export default function UpdateForm(props: { data: Data; me: string; load: () => Promise<void>; onClose: () => void }) {
  const { data, me } = props
  const [busy, setBusy] = useState(false)
  const open = data.milestones
    .filter((m) => m.user_id === me)
    .map((m) => ({ ...m, tasks: m.tasks.filter((t) => !t.update_id && !t.suggested_by) }))
    .filter((m) => m.tasks.length > 0)

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    try {
      const files = (form.getAll('images') as File[]).filter((file) => file.size > 0)
      if (files.length > 10) throw new Error('You can attach up to 10 photos to one update.')
      const images = await Promise.all(
        files.map(async (file) => {
          const path = `${data.challenge.id}/${me}/${crypto.randomUUID()}.jpg`
          const { error } = await supabase.storage
            .from('updates')
            .upload(path, await shrink(file), { contentType: 'image/jpeg' })
          if (error) throw error
          return path
        }),
      )
      const { data: update, error } = await supabase
        .from('updates')
        .insert({
          challenge_id: data.challenge.id,
          day: today(),
          title: String(form.get('title')).trim(),
          body: String(form.get('body')).trim(),
          images,
        })
        .select('id')
        .single()
      if (error) throw error
      const finished = form.getAll('tasks')
      if (finished.length) {
        const { error } = await supabase.from('tasks').update({ update_id: update.id }).in('id', finished)
        if (error) throw error
      }
      await props.load()
      props.onClose()
    } catch (err) {
      alert((err as Error).message)
      await props.load()
      setBusy(false)
    }
  }

  return (
    <Modal title="Update for the day" onClose={props.onClose}>
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <input name="title" required maxLength={120} className="field md:col-span-2" placeholder="Update name" aria-label="Update name" />
        <div role="group" aria-labelledby="finished-tasks" className="rounded-xl bg-page p-3">
          <div id="finished-tasks" className="label mb-2">
            Tasks you finished
          </div>
          {open.map((m) => (
            <div key={m.id} className="mb-3 last:mb-0">
              <div className="mb-1 text-[13px] font-semibold">{m.name}</div>
              {m.tasks.map((t) => (
                <label key={t.id} className="flex items-start gap-2.5 py-0.5 text-[15px]">
                  <input type="checkbox" name="tasks" value={t.id} className="mt-1 size-4 shrink-0 accent-accent" />
                  <span className="min-w-0 break-words">{t.title}</span>
                </label>
              ))}
            </div>
          ))}
          {open.length === 0 && <p className="text-sm text-muted">No open tasks.</p>}
        </div>
        <textarea name="body" maxLength={5000} rows={6} className="field" placeholder="What did you do today?" aria-label="What you did today" />
        <label className="rounded-xl bg-page p-3">
          <span className="label">Photos</span>
          <input
            name="images"
            type="file"
            accept="image/*"
            multiple
            className="mt-2 block w-full text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-fill file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
          />
        </label>
        <button className="btn btn-primary self-end justify-self-end" disabled={busy}>
          {busy ? 'Saving…' : 'Post update'}
        </button>
      </form>
    </Modal>
  )
}
