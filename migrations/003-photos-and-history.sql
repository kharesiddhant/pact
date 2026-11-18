-- Upgrade for a database created from an older schema.sql.
-- 1. Photos: an update can only use photos its author already uploaded into that bet's folder (at most 10),
--    a photo that an update uses cannot be deleted or replaced, and no photos change after the end.
-- 2. The date of an update is checked against today's date in UTC, whatever time zone a request asks for.
-- 3. The history records every change when one request changes several things at once.
-- 4. Comments on an update stay in the chat if the update is deleted.
-- Paste this whole file into the Supabase SQL editor and run it. Running it again later is harmless.
-- A fresh install does not need it: schema.sql already contains all of this.

alter table updates drop constraint if exists updates_images_check;
alter table updates add constraint updates_images_check check (cardinality(images) <= 10);

alter table messages drop constraint if exists messages_update_id_fkey;
alter table messages add constraint messages_update_id_fkey
  foreign key (update_id) references updates on delete set null;

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

drop policy if exists "log while the challenge runs" on updates;
-- "day" is the author's local date, so it may differ from today's UTC date by one day at most.
-- Photos must already be uploaded, by the author, into this bet's folder.
create policy "log while the challenge runs" on updates for insert to authenticated
  with check (
    user_id = auth.uid()
    and day between (now() at time zone 'utc')::date - 1 and (now() at time zone 'utc')::date + 1
    and not exists (
      select 1 from unnest(images) as i(path)
      where i.path not like challenge_id::text || '/' || auth.uid()::text || '/%'
        or not exists (select 1 from storage.objects o where o.bucket_id = 'updates' and o.name = i.path)
    )
    and exists (
      select 1 from challenges c
      where c.id = challenge_id
        and now() between c.started_at and c.started_at + c.duration_days * interval '1 day'
    )
  );

drop policy if exists "pact members upload images" on storage.objects;
create policy "pact members upload images" on storage.objects for insert to authenticated
  with check (bucket_id = 'updates' and (storage.foldername(name))[2] = auth.uid()::text and exists (
    select 1 from public.members m
    where m.challenge_id::text = (storage.foldername(name))[1] and m.user_id = auth.uid()
      and public.bet_open(m.challenge_id)
  ));

drop policy if exists "pact owners delete images" on storage.objects;
drop policy if exists "pact owners delete unused images" on storage.objects;
-- A photo that an update still shows cannot be deleted (or deleted and re-uploaded with other content).
create policy "pact owners delete unused images" on storage.objects for delete to authenticated
  using (bucket_id = 'updates' and (storage.foldername(name))[2] = auth.uid()::text and exists (
    select 1 from public.members m
    where m.challenge_id::text = (storage.foldername(name))[1] and m.user_id = auth.uid()
      and public.bet_open(m.challenge_id)
  ) and not exists (select 1 from public.updates u where objects.name = any(u.images)));
