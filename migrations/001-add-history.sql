-- Upgrade for a database created from an older schema.sql, before the History panel existed.
-- Adds the history: every change to goals, the stake, milestones, tasks and updates is recorded.
-- Paste this whole file into the Supabase SQL editor and run it. Running it again later is harmless.
-- A fresh install does not need it: schema.sql already contains all of this.

-- Fill the history with what happened before this upgrade. This runs only on a database that has
-- never had the history (no updates_changed trigger yet), so running the file again adds nothing.
do $backfill$
begin
  if to_regprocedure('public.updates_changed()') is not null then return; end if;
  with backfill (challenge_id, user_id, body, created_at) as (
    select challenge_id, user_id, 'added milestone "' || name || '"', created_at from milestones
    union all
    select m.challenge_id, coalesce(t.suggested_by, m.user_id),
           case when t.suggested_by is null then 'added task "' else 'suggested task "' end || t.title || '"',
           t.created_at
    from tasks t join milestones m on m.id = t.milestone_id
    union all
    select challenge_id, user_id, 'posted update "' || title || '"', created_at from updates
    union all
    select u.challenge_id, u.user_id, 'completed task "' || t.title || '"', u.created_at + interval '1 millisecond'
    from tasks t join updates u on u.id = t.update_id
  )
  insert into messages (challenge_id, user_id, kind, body, created_at)
  select b.challenge_id, b.user_id, 'system', b.body, b.created_at
  from backfill b
  where not exists (
    select 1 from messages m
    where m.challenge_id = b.challenge_id and m.kind = 'system' and m.body = b.body
  );
end
$backfill$;

-- Called by the triggers below whenever a goal, the stake, a milestone, a task or an update changes.
-- It writes one history entry (a 'system' message: who, what, when) that clients cannot forge.
-- During the setup window it also makes both members press Ready again.
create or replace function touch_plan(cid uuid, note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  c challenges;
begin
  select * into c from challenges where id = cid;
  if not found then return; end if; -- the whole bet is being deleted
  if c.started_at is null then
    update members set ready = false where challenge_id = cid and ready;
  end if;
  if note is not null then
    -- clock_timestamp() keeps entries written in one transaction in the order they happened.
    insert into messages (challenge_id, user_id, kind, body, created_at)
    values (cid, auth.uid(), 'system', note, clock_timestamp());
  end if;
end $$;
revoke execute on function touch_plan from public, anon, authenticated;

create or replace function challenges_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stake <> old.stake then
    perform touch_plan(new.id, 'changed the stake to "' || new.stake || '"');
  end if;
  if new.duration_days <> old.duration_days then
    perform touch_plan(new.id, 'changed the length to ' || new.duration_days || ' days');
  end if;
  if new.stake = old.stake and new.duration_days = old.duration_days then
    perform touch_plan(new.id, null);
  end if;
  return null;
end $$;
drop trigger if exists challenges_changed on challenges;
create trigger challenges_changed after update of stake, duration_days on challenges
  for each row execute function challenges_changed();

create or replace function members_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform touch_plan(new.challenge_id, case
    when new.goal <> old.goal then 'set their goal to "' || new.goal || '"'
  end);
  return null;
end $$;
drop trigger if exists members_changed on members;
create trigger members_changed after update of goal on members
  for each row execute function members_changed();

create or replace function milestones_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform touch_plan(old.challenge_id, 'removed milestone "' || old.name || '" and its tasks');
  elsif tg_op = 'INSERT' then
    perform touch_plan(new.challenge_id, 'added milestone "' || new.name || '"');
  else
    if new.name <> old.name then
      perform touch_plan(new.challenge_id, 'renamed milestone "' || old.name || '" to "' || new.name || '"');
    end if;
    if new.due is distinct from old.due then
      perform touch_plan(new.challenge_id,
        'changed the date of milestone "' || new.name || '" to ' || coalesce(to_char(new.due, 'FMDD Mon'), 'no date'));
    end if;
    if new.name = old.name and new.due is not distinct from old.due then
      perform touch_plan(new.challenge_id, null);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists milestones_changed on milestones;
create trigger milestones_changed after insert or delete or update of name, due on milestones
  for each row execute function milestones_changed();

create or replace function tasks_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cid uuid;
  notes text[] := '{}';
  note text;
begin
  if tg_op = 'DELETE' then
    select challenge_id into cid from milestones where id = old.milestone_id;
    notes := array['removed task "' || old.title || '"'];
  elsif tg_op = 'INSERT' then
    select challenge_id into cid from milestones where id = new.milestone_id;
    notes := array[case when new.suggested_by is null then 'added' else 'suggested' end || ' task "' || new.title || '"'];
  else
    -- One entry per change, so a single request that changes several things cannot hide any of them.
    select challenge_id into cid from milestones where id = new.milestone_id;
    if old.suggested_by is not null and new.suggested_by is null then
      notes := notes || ('accepted suggested task "' || old.title || '"');
    end if;
    if old.title <> new.title then
      notes := notes || ('renamed task "' || old.title || '" to "' || new.title || '"');
    end if;
    if new.update_id is distinct from old.update_id then
      notes := notes || (case
        when old.update_id is null then 'completed task "'
        when new.update_id is null then 'reopened task "' -- its update was deleted
        else 'moved the completion of task "'
      end || new.title || '"');
    end if;
  end if;
  -- No milestone means it was deleted together with its tasks; the milestone trigger reports that.
  if cid is null then return null; end if;
  if cardinality(notes) = 0 then perform touch_plan(cid, null); end if;
  foreach note in array notes loop
    perform touch_plan(cid, note);
  end loop;
  return null;
end $$;
drop trigger if exists tasks_changed on tasks;
create trigger tasks_changed after insert or delete or update of title, suggested_by, update_id on tasks
  for each row execute function tasks_changed();

create or replace function updates_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform touch_plan(old.challenge_id, 'deleted update "' || old.title || '"');
  else
    perform touch_plan(new.challenge_id, 'posted update "' || new.title || '"');
  end if;
  return null;
end $$;
drop trigger if exists updates_changed on updates;
create trigger updates_changed after insert or delete on updates
  for each row execute function updates_changed();
