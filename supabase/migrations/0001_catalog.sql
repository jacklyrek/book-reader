-- Catalog index (§6.2).
--
-- The point of this schema is that a search is one query against rows we
-- already own, rather than a fan-out to three third-party APIs from a phone on
-- a train. 75k rows is nothing for Postgres; search will feel instant.

create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- ---------------------------------------------------------------------------
-- Core tables
-- ---------------------------------------------------------------------------

create table if not exists works (
  work_id       text primary key,
  title         text not null,
  authors       text[] not null default '{}',
  -- Normalised forms, written by the ingest job. Matching and search both use
  -- these rather than the display strings.
  norm_title    text not null,
  norm_author   text not null default '',
  language      text not null default 'en',
  subjects      text[] not null default '{}',
  cover_url     text,
  year          int,
  description   text,
  updated_at    timestamptz not null default now()
);

create table if not exists editions (
  edition_id    text primary key,
  work_id       text not null references works(work_id) on delete cascade,
  source        text not null check (source in ('standard-ebooks','gutenberg','archive')),
  epub_url      text not null,
  bytes         bigint,
  language      text not null default 'en',
  page_url      text,
  translator    text,
  updated_at    timestamptz not null default now()
);

create table if not exists recordings (
  recording_id  text primary key,
  work_id       text not null references works(work_id) on delete cascade,
  source        text not null default 'librivox',
  page_url      text,
  total_seconds int not null default 0,
  readers       text[] not null default '{}',
  track_count   int not null default 0,
  bitrates      int[] not null default '{64,128}',
  -- Track lists are large (a 128-section book) and only needed once the user
  -- commits to a book, so they live in jsonb and are never selected by search.
  tracks        jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now()
);

-- Text ↔ audio links, produced by the fuzzy matcher. Kept separate from the
-- rows themselves so a re-run can rebuild them without touching the catalog.
create table if not exists edition_links (
  work_id          text not null references works(work_id) on delete cascade,
  recording_id     text not null references recordings(recording_id) on delete cascade,
  match_confidence real not null,
  matched_by       text not null default 'trigram',
  created_at       timestamptz not null default now(),
  primary key (work_id, recording_id)
);

-- Manual corrections. The matcher is wrong maybe 10% of the time (§6.2) and
-- this is how you fix an individual case without retuning the thresholds.
create table if not exists overrides (
  work_id      text not null,
  recording_id text not null,
  -- true = force this pairing, false = forbid it
  linked       boolean not null,
  note         text,
  created_at   timestamptz not null default now(),
  primary key (work_id, recording_id)
);

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------

alter table works
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(authors, ' '), '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(subjects, ' '), '')), 'D')
  ) stored;

create index if not exists works_search_idx on works using gin (search_vector);
create index if not exists works_norm_title_trgm on works using gin (norm_title gin_trgm_ops);
create index if not exists works_norm_author_trgm on works using gin (norm_author gin_trgm_ops);
create index if not exists works_language_idx on works (language);
create index if not exists editions_work_idx on editions (work_id);
create index if not exists recordings_work_idx on recordings (work_id);
create index if not exists edition_links_recording_idx on edition_links (recording_id);

-- ---------------------------------------------------------------------------
-- Shaping. These return rows the client can use as CatalogWork directly.
-- ---------------------------------------------------------------------------

create or replace function editions_json(p_work_id text)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'editionId', e.edition_id,
      'source', e.source,
      'epubUrl', e.epub_url,
      'bytes', e.bytes,
      'language', e.language,
      'pageUrl', e.page_url,
      'translator', e.translator
    )
    -- Standard Ebooks first: it is the best reading experience by a wide
    -- margin, so it is the default whenever an edition exists (§6.2).
    order by case e.source
      when 'standard-ebooks' then 0
      when 'gutenberg' then 1
      else 2
    end
  ), '[]'::jsonb)
  from editions e where e.work_id = p_work_id;
$$;

-- `p_with_tracks` is false for search results: a 128-track list per row would
-- dominate the payload.
create or replace function recordings_json(p_work_id text, p_with_tracks boolean default false)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'recordingId', r.recording_id,
      'source', r.source,
      'pageUrl', r.page_url,
      'totalSeconds', r.total_seconds,
      'readers', r.readers,
      'trackCount', r.track_count,
      'bitrates', r.bitrates,
      'tracks', case when p_with_tracks then r.tracks else '[]'::jsonb end
    )
    order by r.total_seconds desc
  ), '[]'::jsonb)
  from recordings r
  join edition_links l on l.recording_id = r.recording_id
  where l.work_id = p_work_id
    and not exists (
      select 1 from overrides o
      where o.work_id = l.work_id and o.recording_id = l.recording_id and o.linked = false
    );
$$;

create or replace function work_row(w works, p_with_tracks boolean default false)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'workId', w.work_id,
    'title', w.title,
    'authors', w.authors,
    'language', w.language,
    'subjects', w.subjects,
    'coverUrl', w.cover_url,
    'year', w.year,
    'description', w.description,
    'editions', editions_json(w.work_id),
    'recordings', recordings_json(w.work_id, p_with_tracks),
    'matchConfidence', (
      select max(l.match_confidence) from edition_links l where l.work_id = w.work_id
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- RPCs consumed by src/catalog/supabase.ts
-- ---------------------------------------------------------------------------

create or replace function search_catalog(
  q text,
  lang text default null,
  kind text default 'all',
  lim int default 40
)
returns setof jsonb
language sql stable
as $$
  with scored as (
    select
      w,
      -- Full-text rank for real queries, trigram similarity as the safety net
      -- for typos and half-remembered titles.
      ts_rank(w.search_vector, websearch_to_tsquery('simple', q)) as text_rank,
      greatest(
        similarity(w.norm_title, lower(unaccent(q))),
        similarity(w.norm_author, lower(unaccent(q)))
      ) as fuzzy_rank,
      exists (select 1 from editions e where e.work_id = w.work_id) as has_text,
      exists (select 1 from edition_links l where l.work_id = w.work_id) as has_audio,
      exists (
        select 1 from editions e
        where e.work_id = w.work_id and e.source = 'standard-ebooks'
      ) as is_standard_ebooks
    from works w
    where
      (lang is null or w.language = lang)
      and (
        w.search_vector @@ websearch_to_tsquery('simple', q)
        or w.norm_title % lower(unaccent(q))
        or w.norm_author % lower(unaccent(q))
      )
  )
  select work_row(s.w, false)
  from scored s
  where
    case kind
      when 'text' then s.has_text
      when 'audio' then s.has_audio
      else true
    end
  order by
    -- Ranking we control, which is the whole payoff of owning the index.
    (s.text_rank * 4)
    + (s.fuzzy_rank * 2)
    + (case when s.is_standard_ebooks then 0.6 else 0 end)
    + (case when s.has_text and s.has_audio then 0.3 else 0 end)
    desc
  limit lim;
$$;

create or replace function get_work(work_id text)
returns setof jsonb
language sql stable
as $$
  select work_row(w, true) from works w where w.work_id = get_work.work_id;
$$;

create or replace function featured_works(lim int default 24)
returns setof jsonb
language sql stable
as $$
  select work_row(w, false)
  from works w
  join editions e on e.work_id = w.work_id and e.source = 'standard-ebooks'
  order by w.updated_at desc
  limit lim;
$$;

-- ---------------------------------------------------------------------------
-- Access. The catalog is public-domain metadata: readable by anyone with the
-- anon key, writable only by the ingest job's service role.
-- ---------------------------------------------------------------------------

alter table works enable row level security;
alter table editions enable row level security;
alter table recordings enable row level security;
alter table edition_links enable row level security;
alter table overrides enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'works' and policyname = 'works_read') then
    create policy works_read on works for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'editions' and policyname = 'editions_read') then
    create policy editions_read on editions for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'recordings' and policyname = 'recordings_read') then
    create policy recordings_read on recordings for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'edition_links' and policyname = 'links_read') then
    create policy links_read on edition_links for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'overrides' and policyname = 'overrides_read') then
    create policy overrides_read on overrides for select using (true);
  end if;
end $$;

grant execute on function search_catalog(text, text, text, int) to anon, authenticated;
grant execute on function get_work(text) to anon, authenticated;
grant execute on function featured_works(int) to anon, authenticated;
