import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const configured = Boolean(url && key)
export const supabase = createClient(url || 'http://localhost', key || 'missing')

export type Challenge = {
  id: string
  stake: string
  duration_days: number
  started_at: string | null
}
export type Member = {
  challenge_id: string
  user_id: string
  display_name: string
  goal: string
  ready: boolean
}
export type Task = {
  id: string
  milestone_id: string
  title: string
  update_id: string | null // done when set
  suggested_by: string | null // pending suggestion when set
}
export type Milestone = {
  id: string
  challenge_id: string
  user_id: string
  name: string
  due: string | null
  tasks: Task[]
}
export type Update = {
  id: string
  user_id: string
  day: string
  title: string
  body: string
  images: string[]
  created_at: string
}
export type Reaction = { message_id: string; user_id: string; emoji: string }
export type Message = {
  id: string
  user_id: string | null
  kind: 'text' | 'nudge' | 'system'
  body: string
  reply_to: string | null
  update_id: string | null
  created_at: string
  reactions: Reaction[]
}
export type Data = {
  challenge: Challenge
  members: Member[]
  milestones: Milestone[]
  updates: Update[]
  messages: Message[]
}

type Result = { error: { message: string } | null }

/** Awaits a Supabase query, shows any error, and reports whether it worked. */
export async function run(query: PromiseLike<Result>) {
  const { error } = await query
  if (error) alert(error.message)
  return !error
}

/** `run`, followed by a reload of the challenge. */
export type Save = (query: PromiseLike<Result>) => Promise<boolean>

/** Today's date in the viewer's own timezone, as YYYY-MM-DD. */
export const today = () => new Date().toLocaleDateString('en-CA')

export const formatDay = (day: string) =>
  new Date(`${day}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

// ponytail: signed image URLs last 24 hours and are cached for the life of the tab.
// A tab left open longer than that shows broken images until it is reloaded.
const imageUrls = new Map<string, string>()
export const imageUrl = (path: string) => imageUrls.get(path)
export async function signImages(paths: string[]) {
  const missing = paths.filter((path) => !imageUrls.has(path))
  if (!missing.length) return
  const { data } = await supabase.storage.from('updates').createSignedUrls(missing, 86400)
  for (const item of data ?? []) if (item.path && item.signedUrl) imageUrls.set(item.path, item.signedUrl)
}
