-- Sync tables (§6.3).
--
-- One user, two devices, so last-write-wins on updated_at. The furthest-
-- position refinement for progress is applied on the client (mergeProgress in
-- src/core/progress.ts) because it needs to compare against local state that
-- may never have reached the server.

create table if not exists progress (
  user_id      uuid not null references auth.users(id) on delete cascade,
  book_id      text not null,
  locator      text,
  percent      real not null default 0,
  label        text,
  track_index  int,
  position_sec real,
  audio_percent real,
  device_id    text not null default '',
  updated_at   timestamptz not null default now(),
  primary key (user_id, book_id)
);

create table if not exists annotations (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  book_id     text not null,
  locator     text not null,
  kind        text not null check (kind in ('highlight','note','bookmark')),
  color       text not null default '#e0b83a',
  text        text,
  note        text,
  chapter     text,
  created_at  timestamptz not null default now(),
  -- Tombstoned rather than deleted, so the other device drops it too.
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists library_items (
  user_id       uuid not null references auth.users(id) on delete cascade,
  book_id       text not null,
  work_id       text,
  title         text not null,
  authors       text[] not null default '{}',
  language      text not null default 'en',
  subjects      text[] not null default '{}',
  description   text,
  -- The chosen edition/recording, denormalised so a new device can render the
  -- library and start a download without hitting the catalog first.
  edition       jsonb,
  recording     jsonb,
  audio_bitrate int,
  playback_rate real,
  finished_at   timestamptz,
  added_at      timestamptz not null default now(),
  deleted       boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (user_id, book_id)
);

-- Every pull is "rows changed since my last sync", so these are the indexes
-- that matter.
create index if not exists progress_sync_idx on progress (user_id, updated_at);
create index if not exists annotations_sync_idx on annotations (user_id, updated_at);
create index if not exists annotations_book_idx on annotations (user_id, book_id);
create index if not exists library_sync_idx on library_items (user_id, updated_at);

-- ---------------------------------------------------------------------------
-- Row level security: a user sees only their own rows.
-- ---------------------------------------------------------------------------

alter table progress enable row level security;
alter table annotations enable row level security;
alter table library_items enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['progress','annotations','library_items'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_own') then
      execute format(
        'create policy %I on %I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
        t || '_own', t
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Server-side updated_at, so a device with a wrong clock can't win every
-- conflict forever.
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  -- Trust the client's timestamp only when it is not in the future; otherwise
  -- stamp it here.
  if new.updated_at is null or new.updated_at > now() + interval '5 minutes' then
    new.updated_at := now();
  end if;
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['progress','annotations','library_items'] loop
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format(
      'create trigger %I before insert or update on %I for each row execute function touch_updated_at()',
      t || '_touch', t
    );
  end loop;
end $$;
