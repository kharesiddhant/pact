import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import Auth from './Auth'
import Challenge from './Challenge'
import Home from './Home'
import { configured, supabase } from './supabase'

export default function App() {
  // undefined = still checking, null = signed out
  const [session, setSession] = useState<Session | null>()
  const [hash, setHash] = useState(location.hash)

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setSession(session))
    const onHash = () => setHash(location.hash)
    addEventListener('hashchange', onHash)
    return () => {
      data.subscription.unsubscribe()
      removeEventListener('hashchange', onHash)
    }
  }, [])

  if (!configured) {
    return (
      <p className="p-8">
        Missing <code>VITE_SUPABASE_URL</code> or <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>. See the README.
      </p>
    )
  }
  if (session === undefined) return null
  if (!session) return <Auth />

  const me = session.user.id
  const name = String(session.user.user_metadata.display_name || session.user.email?.split('@')[0] || 'Me').slice(0, 40)
  // Routes: "#/c/<challenge id>", "#/join/<challenge id>", anything else is the list.
  const [, route, id] = hash.split('/')
  if (route === 'join' && id) return <Join id={id} name={name} />
  if (route === 'c' && id) return <Challenge key={id} id={id} me={me} />
  return <Home me={me} name={name} />
}

function Join({ id, name }: { id: string; name: string }) {
  const [error, setError] = useState('')
  useEffect(() => {
    supabase.rpc('join_challenge', { c: id, name }).then(({ error }) => {
      if (error) setError(error.message)
      else location.hash = `#/c/${id}`
    })
  }, [id, name])
  return (
    <p className="p-8">
      {error || 'Joining…'}{' '}
      {error && (
        <a className="underline" href="#/">
          Back
        </a>
      )}
    </p>
  )
}
