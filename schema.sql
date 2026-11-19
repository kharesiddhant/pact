-- Pact database schema.
-- Paste this whole file into the Supabase SQL editor and run it once.

-- ============ Tables ============

create table challenges (
  id uuid primary key default gen_random_uuid(),   -- also the invite code
  stake text not null default '' check (length(stake) <= 200),
  duration_days int not null check (duration_days between 1 and 365),
  started_at timestamptz,                          -- null during the setup window
  created_at timestamptz not null default now()
);

create table members (
  challenge_id uuid not null references challenges on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  display_name text not null check (length(display_name) between 1 and 40),
  goal text not null default '' check (length(goal) <= 200),
  ready boolean not null default false,
  primary key (challenge_id, user_id)
);

create table milestones (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null,
  user_id uuid not null default auth.uid(),
  name text not null check (length(name) between 1 and 80),
  due date,
  created_at timestamptz not null default now(),
  foreign key (challenge_id, user_id) references members on delete cascade
);

create table updates (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null,
  user_id uuid not null default auth.uid(),
  day date not null,                               -- the author's local calendar date
  title text not null check (length(title) between 1 and 120),
  body text not null default '' check (length(body) <= 5000),
  images text[] not null default '{}' check (cardinality(images) <= 10), -- paths in the "updates" storage bucket
  created_at timestamptz not null default now(),
  foreign key (challenge_id, user_id) references members on delete cascade
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references milestones on delete cascade,
  title text not null check (length(title) between 1 and 200),
  update_id uuid references updates on delete set null,       -- done when set: the daily update that completed it
  suggested_by uuid references auth.users on delete cascade,  -- set while a friend's suggestion is pending
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references challenges on delete cascade,
  user_id uuid default auth.uid() references auth.users on delete set null,
  kind text not null default 'text' check (kind in ('text', 'nudge', 'system')),
  body text not null default '' check (length(body) <= 2000),
  reply_to uuid references messages on delete set null,
  update_id uuid references updates on delete set null,       -- set when the message is a comment on an update
  created_at timestamptz not null default now()
);

create table reactions (
  message_id uuid not null references messages on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  emoji text not null check (length(emoji) <= 16),
  primary key (message_id, user_id, emoji)
);

-- ============ Functions ============

-- Security definer so policies on "members" can ask about membership without recursing into themselves.
create function is_member(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where challenge_id = c and user_id = auth.uid())
$$;

-- True until the countdown ends (and during setup). After that, plans and updates are frozen,
-- so nobody can change the result by editing their tasks once time is up.
create function bet_open(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select started_at is null or now() < started_at + duration_days * interval '1 day' from challenges where id = c),
    false)
$$;

-- A bet has no shared name: each member has their own goal. "goal" is the creator's.
create function create_challenge(goal text, stake text, duration_days int, name text) returns uuid
language sql security definer set search_path = public as $$
  with c as (
    insert into challenges (stake, duration_days) values ($2, $3) returning id
  )
  insert into members (challenge_id, user_id, display_name, goal)
  select id, auth.uid(), $4, $1 from c
  returning challenge_id
$$;

create function join_challenge(c uuid, name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if is_member(c) then return; end if;
  perform 1 from challenges where id = c and started_at is null for update;
  if not found then raise exception 'Challenge not found or already started'; end if;
  -- ponytail: 1v1 only. For groups, change the 2 here and in set_ready.
  if (select count(*) from members where challenge_id = c) >= 2 then
    raise exception 'Challenge is full';
  end if;
  insert into members (challenge_id, user_id, display_name) values (c, auth.uid(), name);
end $$;

-- Marks the caller ready (or not). The countdown starts the moment both members are ready.
create function set_ready(c uuid, r boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from challenges where id = c and started_at is null for update;
  if not found then raise exception 'Challenge not found or already started'; end if;
  if r and not exists (
    select 1
    from members m
    join milestones ms on ms.challenge_id = m.challenge_id and ms.user_id = m.user_id
    join tasks t on t.milestone_id = ms.id and t.suggested_by is null
    where m.challenge_id = c and m.user_id = auth.uid() and m.goal <> ''
  ) then
    raise exception 'Set your goal and add at least one task first';
  end if;
  update members set ready = r where challenge_id = c and user_id = auth.uid();
  update challenges set started_at = now()
  where id = c
    and (select count(*) = 2 and bool_and(ready) from members where challenge_id = c);
end $$;

-- Called by the triggers below whenever a goal, the stake, a milestone, a task or an update changes.
-- It writes one history entry (a 'system' message: who, what, when) that clients cannot forge.
-- During the setup window it also makes both members press Ready again.
create function touch_plan(cid uuid, note text) returns void
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

create function challenges_changed() returns trigger
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
create trigger challenges_changed after update of stake, duration_days on challenges
  for each row execute function challenges_changed();

create function members_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform touch_plan(new.challenge_id, case
    when new.goal <> old.goal then 'set their goal to "' || new.goal || '"'
  end);
  return null;
end $$;
create trigger members_changed after update of goal on members
  for each row execute function members_changed();

create function milestones_changed() returns trigger
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
create trigger milestones_changed after insert or delete or update of name, due on milestones
  for each row execute function milestones_changed();

create function tasks_changed() returns trigger
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
create trigger tasks_changed after insert or delete or update of title, suggested_by, update_id on tasks
  for each row execute function tasks_changed();

create function updates_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform touch_plan(old.challenge_id, 'deleted update "' || old.title || '"');
  else
    perform touch_plan(new.challenge_id, 'posted update "' || new.title || '"');
  end if;
  return null;
end $$;
create trigger updates_changed after insert or delete on updates
  for each row execute function updates_changed();

-- ============ Privileges ============
-- Only the columns a client may write are granted. Everything else goes through the functions above.

revoke all on challenges, members, milestones, tasks, updates, messages, reactions from anon, authenticated;
grant select on challenges, members, milestones, tasks, updates, messages, reactions to authenticated;
grant update (stake, duration_days) on challenges to authenticated;
grant update (goal) on members to authenticated;
grant insert (challenge_id, name, due), update (name, due), delete on milestones to authenticated;
grant insert (milestone_id, title, suggested_by), update (title, suggested_by, update_id), delete on tasks to authenticated;
grant insert (challenge_id, day, title, body, images), delete on updates to authenticated;
grant insert (challenge_id, kind, body, reply_to, update_id) on messages to authenticated;
grant insert (message_id, emoji), delete on reactions to authenticated;

-- ============ Row level security ============

alter table challenges enable row level security;
alter table members enable row level security;
alter table milestones enable row level security;
alter table tasks enable row level security;
alter table updates enable row level security;
alter table messages enable row level security;
alter table reactions enable row level security;

create policy "members read" on challenges for select to authenticated
  using (is_member(id));
create policy "members edit during setup" on challenges for update to authenticated
  using (is_member(id) and started_at is null);

create policy "members read" on members for select to authenticated
  using (is_member(challenge_id));
create policy "own goal during setup" on members for update to authenticated
  using (user_id = auth.uid()
    and exists (select 1 from challenges c where c.id = challenge_id and c.started_at is null));

create policy "members read" on milestones for select to authenticated
  using (is_member(challenge_id));
create policy "owner writes until the end" on milestones for all to authenticated
  using (user_id = auth.uid() and bet_open(challenge_id));

create policy "members read" on tasks for select to authenticated
  using (exists (select 1 from milestones m where m.id = milestone_id and is_member(m.challenge_id)));
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
create policy "owner deletes until the end" on tasks for delete to authenticated
  using (exists (
    select 1 from milestones m where m.id = milestone_id and m.user_id = auth.uid() and bet_open(m.challenge_id)
  ));

create policy "members read" on updates for select to authenticated
  using (is_member(challenge_id));
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
create policy "delete own until the end" on updates for delete to authenticated
  using (user_id = auth.uid() and bet_open(challenge_id));

create policy "members read" on messages for select to authenticated
  using (is_member(challenge_id));
create policy "members post" on messages for insert to authenticated
  with check (is_member(challenge_id) and user_id = auth.uid() and kind <> 'system');

create policy "members read" on reactions for select to authenticated
  using (exists (select 1 from messages m where m.id = message_id and is_member(m.challenge_id)));
create policy "members react" on reactions for insert to authenticated
  with check (user_id = auth.uid()
    and exists (select 1 from messages m where m.id = message_id and is_member(m.challenge_id)));
create policy "remove own" on reactions for delete to authenticated
  using (user_id = auth.uid());

-- ============ Image storage ============
-- Private bucket. Object path: <challenge_id>/<user_id>/<file>.webp (or .jpg from Safari).
-- The app shrinks photos to well under 1 MB before upload; the bucket refuses anything bigger or of another type.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('updates', 'updates', false, 1048576, '{image/webp,image/jpeg}')
on conflict (id) do nothing;

create policy "pact members view images" on storage.objects for select to authenticated
  using (bucket_id = 'updates' and exists (
    select 1 from public.members m
    where m.challenge_id::text = (storage.foldername(name))[1] and m.user_id = auth.uid()
  ));
create policy "pact members upload images" on storage.objects for insert to authenticated
  with check (bucket_id = 'updates' and (storage.foldername(name))[2] = auth.uid()::text and exists (
    select 1 from public.members m
    where m.challenge_id::text = (storage.foldername(name))[1] and m.user_id = auth.uid()
      and public.bet_open(m.challenge_id)
  ));
-- A photo that an update still shows cannot be deleted (or deleted and re-uploaded with other content).
create policy "pact owners delete unused images" on storage.objects for delete to authenticated
  using (bucket_id = 'updates' and (storage.foldername(name))[2] = auth.uid()::text and exists (
    select 1 from public.members m
    where m.challenge_id::text = (storage.foldername(name))[1] and m.user_id = auth.uid()
      and public.bet_open(m.challenge_id)
  ) and not exists (select 1 from public.updates u where objects.name = any(u.images)));

-- ============ Realtime ============

alter publication supabase_realtime
  add table challenges, members, milestones, tasks, updates, messages, reactions;
