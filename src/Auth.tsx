import { useState, type SubmitEvent } from 'react'
import { supabase } from './supabase'

export default function Auth() {
  const [isSignUp, setIsSignUp] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const email = String(form.get('email'))
    const password = String(form.get('password'))
    const { data, error } = isSignUp
      ? await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: String(form.get('name')).trim() } },
        })
      : await supabase.auth.signInWithPassword({ email, password })
    if (error) setMessage(error.message)
    else if (!data.session) setMessage('Check your email to confirm your account, then sign in.')
  }

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-3 px-4 pt-[16vh]">
      <h1 className="text-center text-4xl font-semibold tracking-tight">Pact</h1>
      <p className="mb-4 text-center text-muted">Bet with a friend that you will both finish your goals.</p>
      {isSignUp && (
        <input name="name" required maxLength={40} className="field" placeholder="Your name" aria-label="Your name" />
      )}
      <input name="email" type="email" required className="field" placeholder="Email" aria-label="Email" />
      <input
        name="password"
        type="password"
        required
        minLength={6}
        className="field"
        placeholder="Password"
        aria-label="Password"
      />
      <button className="btn btn-primary mt-1 min-h-11 text-base">{isSignUp ? 'Create account' : 'Sign in'}</button>
      <button type="button" className="link self-center" onClick={() => setIsSignUp(!isSignUp)}>
        {isSignUp ? 'I already have an account' : 'Create an account'}
      </button>
      {message && (
        <p role="alert" className="text-center text-sm text-bad-ink">
          {message}
        </p>
      )}
    </form>
  )
}
