-- Upgrade for a database created from an older schema.sql.
-- 1. Once the countdown ends, milestones, tasks and updates can no longer be added, changed or
--    deleted, so nobody can change the result afterwards.
-- 2. A task can be ticked only by an update from the same bet.
-- Paste this whole file into the Supabase SQL editor and run it. Running it again later is harmless.
-- A fresh install does not need it: schema.sql already contains all of this.

-- True until the countdown ends (and during setup). After that, plans and updates are frozen,
-- so nobody can change the result by editing their tasks once time is up.
create or replace function bet_open(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select started_at is null or now() < started_at + duration_days * interval '1 day' from challenges where id = c),
    false)
$$;

drop policy if exists "owner writes" on milestones;
drop policy if exists "owner writes until the end" on milestones;
create policy "owner writes until the end" on milestones for all to authenticated
  using (user_id = auth.uid() and bet_open(challenge_id));

drop policy if exists "owner adds, friend suggests" on tasks;
-- The owner adds real tasks; the friend can only add pending suggestions. Nothing is added after the end.
create policy "owner adds, friend suggests" on tasks for insert to authenticated
  with check (
    (suggested_by is null or suggested_by = auth.uid())
    and exists (
      select 1 from milestones m
      where m.id = milestone_id
        and is_member(m.challenge_id)
        and bet_open(m.challenge_id)
        and (m.user_id = auth.uid()) = (suggested_by is null)
    )
  );

drop policy if exists "owner edits" on tasks;
drop policy if exists "owner edits until the end" on tasks;
-- A task is ticked by pointing it at one of the owner's own updates in the same bet, while the bet runs.
create policy "owner edits until the end" on tasks for update to authenticated
  using (exists (
    select 1 from milestones m where m.id = milestone_id and m.user_id = auth.uid() and bet_open(m.challenge_id)
  ))
  with check (
    suggested_by is null
    and (update_id is null or exists (
      select 1 from updates u join challenges c on c.id = u.challenge_id
      where u.id = update_id
        and u.user_id = auth.uid()
        and u.challenge_id = (select m.challenge_id from milestones m where m.id = milestone_id)
        and now() < c.started_at + c.duration_days * interval '1 day'
    ))
  );

drop policy if exists "owner deletes" on tasks;
drop policy if exists "owner deletes until the end" on tasks;
create policy "owner deletes until the end" on tasks for delete to authenticated
  using (exists (
    select 1 from milestones m where m.id = milestone_id and m.user_id = auth.uid() and bet_open(m.challenge_id)
  ));

drop policy if exists "delete own" on updates;
drop policy if exists "delete own until the end" on updates;
create policy "delete own until the end" on updates for delete to authenticated
  using (user_id = auth.uid() and bet_open(challenge_id));
