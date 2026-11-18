// Runs schema.sql in an in-memory Postgres and checks the rules that keep a bet honest.
// Run with: npm test
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const db = new PGlite()

// Minimal stand-ins for what a Supabase project provides.
await db.exec(`
  create role anon;
  create role authenticated;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (bucket_id text, name text, unique (bucket_id, name));
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
  grant usage on schema storage to authenticated;
  grant all on storage.objects to authenticated;
  create publication supabase_realtime;
`)
await db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))

const [A, B, C] = ['a', 'b', 'c'].map((x) => `${x.repeat(8)}-0000-4000-8000-000000000000`)
await db.exec(`insert into auth.users values ('${A}'), ('${B}'), ('${C}')`)

const as = (uid) =>
  db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated`)
const rows = async (sql, params) => (await db.query(sql, params)).rows
const affected = async (sql, params) => (await db.query(sql, params)).affectedRows
const denied = (sql, params) => assert.rejects(db.query(sql, params), undefined, sql)
// Blocked = refused with an error, or silently matched no rows. Either way nothing changed.
const blocked = async (sql, params) => {
  try {
    assert.equal(await affected(sql, params), 0, sql)
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e
  }
}

// History entries written since the last call, as "who: what", oldest first.
let historyRead = 0
async function newHistory() {
  await db.exec('reset role')
  const all = await rows(`select user_id, body from messages where kind = 'system' and challenge_id = $1 order by created_at`, [ch])
  const fresh = all.slice(historyRead).map((r) => `${{ [A]: 'A', [B]: 'B' }[r.user_id]}: ${r.body}`)
  historyRead = all.length
  return fresh
}

// --- Create and join ---
await as(A)
const [{ id: ch }] = await rows(`select create_challenge('Ship something', 'Loser buys dinner', 14, 'Asha') as id`)
assert.deepEqual(await rows('select goal from members'), [{ goal: 'Ship something' }], "creator's goal is stored")
await as(C)
assert.equal((await rows('select * from challenges')).length, 0, 'outsider sees no challenge')
await as(B)
await rows(`select join_challenge($1, 'Ben')`, [ch])
await rows(`select join_challenge($1, 'Ben')`, [ch]) // joining twice is harmless
assert.equal((await rows('select * from members')).length, 2)
await as(C)
await denied(`select join_challenge($1, 'Cy')`, [ch]) // full

// --- Setup window ---
await as(A)
const [{ id: msA }] = await rows(`insert into milestones (challenge_id, name) values ($1, 'Week 1') returning id`, [ch])
const [{ id: taskA }] = await rows(`insert into tasks (milestone_id, title) values ($1, 'Build login') returning id`, [msA])
await rows(`update challenges set stake = 'Loser cooks', duration_days = 30`)

await as(B)
await denied(`insert into tasks (milestone_id, title) values ($1, 'sneaky')`, [msA]) // friend can only suggest
const [{ id: suggestion }] = await rows(
  `insert into tasks (milestone_id, title, suggested_by) values ($1, 'Add tests', $2) returning id`,
  [msA, B],
)
assert.equal(await affected(`delete from tasks where id = $1`, [taskA]), 0, "friend cannot delete owner's task")
await denied(`update members set ready = true`) // ready only through set_ready()
await denied(`update challenges set started_at = now()`) // start only through set_ready()
await denied(`select touch_plan($1, 'fake')`, [ch])
await denied(`insert into messages (challenge_id, kind, body) values ($1, 'system', 'fake')`, [ch]) // history cannot be forged
await denied(`select set_ready($1, true)`, [ch]) // no goal, no tasks yet

await rows(`update members set goal = 'Finish the course' where user_id = $1`, [B])
const [{ id: msB }] = await rows(`insert into milestones (challenge_id, name) values ($1, 'Module 1') returning id`, [ch])
const [{ id: taskB }] = await rows(`insert into tasks (milestone_id, title) values ($1, 'Watch lectures') returning id`, [msB])
await rows(`select set_ready($1, true)`, [ch])

await as(A)
await rows(`update members set goal = 'Ship the MVP' where user_id = $1`, [A])
assert.deepEqual(
  await rows(`select ready from members where user_id = $1`, [B]),
  [{ ready: false }],
  'a plan change un-readies the friend',
)
await rows(`select set_ready($1, true)`, [ch])
assert.equal((await rows('select started_at from challenges'))[0].started_at, null, 'one Ready does not start it')
await denied(`insert into updates (challenge_id, day, title) values ($1, current_date, 'too early')`, [ch])
assert.deepEqual(await newHistory(), [
  'A: added milestone "Week 1"',
  'A: added task "Build login"',
  'A: changed the stake to "Loser cooks"',
  'A: changed the length to 30 days',
  'B: suggested task "Add tests"',
  'B: set their goal to "Finish the course"',
  'B: added milestone "Module 1"',
  'B: added task "Watch lectures"',
  'A: set their goal to "Ship the MVP"',
])

await as(B)
await rows(`select set_ready($1, true)`, [ch])
assert.ok((await rows('select started_at from challenges'))[0].started_at, 'both Ready starts the countdown')

// --- Challenge running ---
await as(A)
assert.equal(await affected(`update members set goal = 'Something easier' where user_id = $1`, [A]), 0, 'goal is locked')
assert.equal(await affected(`update challenges set stake = 'nothing'`), 0, 'stake is locked')
await denied(`insert into updates (challenge_id, day, title) values ($1, current_date - 5, 'backfill')`, [ch])
const [{ id: updA }] = await rows(
  `insert into updates (challenge_id, day, title) values ($1, current_date, 'Day 1') returning id`,
  [ch],
)
assert.equal(await affected(`update tasks set update_id = $1 where id = $2`, [updA, taskA]), 1)

await as(B)
assert.equal(await affected(`update tasks set update_id = null where id = $1`, [taskA]), 0, "cannot untick friend's task")
await denied(`update tasks set update_id = $1 where id = $2`, [updA, taskB]) // cannot tick with someone else's update
await rows(`insert into messages (challenge_id, body) values ($1, 'nice work')`, [ch])

await as(A)
await rows(`update tasks set suggested_by = null where id = $1`, [suggestion])
await rows(`update tasks set title = 'Add e2e tests' where id = $1`, [suggestion])
await rows(`delete from tasks where id = $1`, [suggestion])
await rows(`update milestones set name = 'Week one' where id = $1`, [msA])
await rows(`update milestones set due = '2030-01-05' where id = $1`, [msA])
const [{ id: lateTask }] = await rows(`insert into tasks (milestone_id, title) values ($1, 'Polish') returning id`, [msA])
assert.deepEqual(await newHistory(), [
  'A: posted update "Day 1"',
  'A: completed task "Build login"',
  'A: accepted suggested task "Add tests"',
  'A: renamed task "Add tests" to "Add e2e tests"',
  'A: removed task "Add e2e tests"',
  'A: renamed milestone "Week 1" to "Week one"',
  'A: changed the date of milestone "Week one" to 5 Jan',
  'A: added task "Polish"',
])

// --- Storage paths ---
await as(A)
await rows(`insert into storage.objects values ('updates', $1)`, [`${ch}/${A}/x.jpg`])
await denied(`insert into storage.objects values ('updates', $1)`, [`${ch}/${B}/x.jpg`]) // not my folder
await as(C)
await denied(`insert into storage.objects values ('updates', $1)`, [`${ch}/${C}/x.jpg`]) // not a member
assert.equal((await rows('select * from storage.objects')).length, 0, 'outsider sees no images')
assert.equal((await rows('select * from messages')).length, 0, 'outsider sees no chat or history')

// --- Photos on updates ---
await as(B)
await rows(`insert into storage.objects values ('updates', $1)`, [`${ch}/${B}/b.jpg`])
await as(A)
const post = (images) =>
  db.query(`insert into updates (challenge_id, day, title, images) values ($1, current_date, 'Photos', $2) returning id`, [
    ch,
    images,
  ])
await assert.rejects(post([`${ch}/${A}/not-uploaded.jpg`]), undefined, 'photo must be uploaded first')
await assert.rejects(post([`${ch}/${B}/b.jpg`]), undefined, "cannot use the friend's photo")
await assert.rejects(post(Array.from({ length: 11 }, () => `${ch}/${A}/x.jpg`)), undefined, 'at most 10 photos')
const [{ id: updPhoto }] = (await post([`${ch}/${A}/x.jpg`])).rows
assert.equal(await affected(`delete from storage.objects where name = $1`, [`${ch}/${A}/x.jpg`]), 0, 'a photo in use cannot be deleted')
await denied(`insert into storage.objects values ('updates', $1)`, [`${ch}/${A}/x.jpg`]) // nor replaced
// The update's date is checked in UTC, whatever time zone the request asks for.
await db.exec(`set timezone = 'Etc/GMT-14'`)
await denied(`insert into updates (challenge_id, day, title) values ($1, (now() at time zone 'utc')::date + 2, 'future')`, [ch])
await db.exec(`set timezone = 'Etc/GMT+12'`)
await denied(`insert into updates (challenge_id, day, title) values ($1, (now() at time zone 'utc')::date - 2, 'past')`, [ch])
await db.exec(`reset timezone`)

// --- One request that changes several things records each change ---
await rows(`update tasks set title = 'Polish UI', update_id = $1 where id = $2`, [updPhoto, lateTask])
await rows(`update tasks set update_id = $1 where id = $2`, [updA, lateTask])
assert.deepEqual(await newHistory(), [
  'A: posted update "Photos"',
  'A: renamed task "Polish" to "Polish UI"',
  'A: completed task "Polish UI"',
  'A: moved the completion of task "Polish UI"',
])

// --- A second bet between the same two people ---
await as(A)
const [{ id: ch2 }] = await rows(`select create_challenge('Run 5k', 'Coffee', 7, 'Asha') as id`)
const [{ id: ms2 }] = await rows(`insert into milestones (challenge_id, name) values ($1, 'Week') returning id`, [ch2])
await rows(`insert into tasks (milestone_id, title) values ($1, 'Run')`, [ms2])
await as(B)
await rows(`select join_challenge($1, 'Ben')`, [ch2])
await rows(`update members set goal = 'Swim' where challenge_id = $1 and user_id = $2`, [ch2, B])
const [{ id: ms2b }] = await rows(`insert into milestones (challenge_id, name) values ($1, 'Pool') returning id`, [ch2])
await rows(`insert into tasks (milestone_id, title) values ($1, 'Swim 1k')`, [ms2b])
await rows(`select set_ready($1, true)`, [ch2])
await as(A)
await rows(`select set_ready($1, true)`, [ch2])
const [{ id: upd2 }] = await rows(
  `insert into updates (challenge_id, day, title) values ($1, current_date, 'Ran 2k') returning id`,
  [ch2],
)
await denied(`update tasks set update_id = $1 where id = $2`, [upd2, lateTask]) // an update from another bet cannot tick this one

// --- Deleting an update reopens its tasks and keeps comments; deleting a milestone is recorded once ---
await as(B)
const [{ id: comment }] = await rows(`insert into messages (challenge_id, body, update_id) values ($1, 'Is that photo new?', $2) returning id`, [ch, updA])
await as(A)
await rows(`delete from updates where id = $1`, [updA])
assert.deepEqual(await rows(`select update_id from messages where id = $1`, [comment]), [{ update_id: null }], 'comment stays')
assert.deepEqual(await rows(`select update_id from tasks where id = $1`, [taskA]), [{ update_id: null }])
await as(A)
await rows(`delete from milestones where id = $1`, [msA])
assert.deepEqual(await newHistory(), [
  'A: deleted update "Day 1"',
  'A: reopened task "Build login"',
  'A: reopened task "Polish UI"',
  'A: removed milestone "Week one" and its tasks',
])

// --- After the end date: plans and updates are frozen, so nobody can change the result ---
await as(A)
const [{ id: msEnd }] = await rows(`insert into milestones (challenge_id, name) values ($1, 'Week 2') returning id`, [ch])
const [{ id: taskEnd }] = await rows(`insert into tasks (milestone_id, title) values ($1, 'Ship') returning id`, [msEnd])
const [{ id: updEnd }] = await rows(
  `insert into updates (challenge_id, day, title) values ($1, current_date, 'Day 2') returning id`,
  [ch],
)
await db.exec('reset role')
await rows(`insert into storage.objects values ('updates', $1)`, [`${ch}/${A}/spare.jpg`])
await db.query(`update challenges set started_at = now() - interval '31 days' where id = $1`, [ch])
await as(A)
await denied(`insert into updates (challenge_id, day, title) values ($1, current_date, 'too late')`, [ch])
await blocked(`update tasks set update_id = $1 where id = $2`, [updEnd, taskEnd]) // no ticking after the end
assert.equal(await affected(`update tasks set title = 'Easier' where id = $1`, [taskEnd]), 0, 'no renaming after the end')
assert.equal(await affected(`delete from tasks where id = $1`, [taskEnd]), 0, 'no deleting tasks after the end')
assert.equal(await affected(`delete from milestones where id = $1`, [msEnd]), 0, 'no deleting milestones after the end')
assert.equal(await affected(`delete from updates where id = $1`, [updEnd]), 0, 'no deleting updates after the end')
assert.equal(await affected(`delete from storage.objects where name = $1`, [`${ch}/${A}/spare.jpg`]), 0, 'photos frozen too')
await denied(`insert into storage.objects values ('updates', $1)`, [`${ch}/${A}/late.jpg`])
await denied(`insert into tasks (milestone_id, title) values ($1, 'late')`, [msEnd])
await denied(`insert into milestones (challenge_id, name) values ($1, 'late')`, [ch])
await as(B)
await denied(`insert into tasks (milestone_id, title, suggested_by) values ($1, 'late', $2)`, [msEnd, B])
await rows(`insert into messages (challenge_id, body) values ($1, 'good game')`, [ch]) // chatting still works
assert.deepEqual(
  await newHistory(),
  ['A: added milestone "Week 2"', 'A: added task "Ship"', 'A: posted update "Day 2"'],
  'nothing changed after the end',
)

// --- Deleting a whole bet does not trip over the history triggers ---
await db.exec(`reset role; delete from challenges`)
assert.equal((await rows('select * from messages')).length, 0)

console.log('schema.sql: all checks passed')
