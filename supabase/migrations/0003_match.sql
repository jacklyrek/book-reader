-- Text ↔ audio matching (§6.2).
--
-- This runs in Postgres rather than in the ingest process: matching 75k texts
-- against 20k recordings means a similarity join, which is exactly what
-- pg_trgm's GIN indexes exist for. Pulling both sides into Node would be
-- minutes of work and a lot of memory for something the database does in
-- seconds.
--
-- Expect this to be wrong about 10% of the time. That is what match_confidence
-- and the overrides table are for.

-- Recordings carry their own normalised forms so the join has something
-- indexed on both sides.
alter table recordings add column if not exists norm_title text not null default '';
alter table recordings add column if not exists norm_author text not null default '';

create index if not exists recordings_norm_title_trgm
  on recordings using gin (norm_title gin_trgm_ops);

create or replace function rebuild_edition_links(
  p_threshold real default 0.72,
  p_title_weight real default 0.7
)
returns table (links_created int, overrides_applied int)
language plpgsql
as $$
declare
  v_links int;
  v_overrides int;
begin
  -- pg_trgm's `%` operator uses this; keep it a little below the final
  -- threshold so the weighted score has candidates to work with.
  perform set_config('pg_trgm.similarity_threshold', '0.5', true);

  delete from edition_links;

  with candidates as (
    select
      w.work_id,
      r.recording_id,
      similarity(w.norm_title, r.norm_title) as title_sim,
      -- LibriVox author fields are volunteer-entered and often wrong, so a
      -- missing author agreement must not veto an otherwise perfect title.
      coalesce(nullif(similarity(w.norm_author, r.norm_author), 0), 0) as author_sim
    from works w
    join recordings r
      on r.norm_title % w.norm_title
     and (r.norm_title <> '' and w.norm_title <> '')
  ),
  scored as (
    select
      work_id,
      recording_id,
      (title_sim * p_title_weight + author_sim * (1 - p_title_weight)) as score
    from candidates
  ),
  -- One recording belongs to one work: take each recording's best match.
  best as (
    select distinct on (recording_id) work_id, recording_id, score
    from scored
    where score >= p_threshold
    order by recording_id, score desc
  )
  insert into edition_links (work_id, recording_id, match_confidence, matched_by)
  select work_id, recording_id, score, 'trigram' from best
  on conflict do nothing;

  get diagnostics v_links = row_count;

  -- Manual corrections win over anything the matcher decided.
  delete from edition_links l
  using overrides o
  where o.work_id = l.work_id
    and o.recording_id = l.recording_id
    and o.linked = false;

  insert into edition_links (work_id, recording_id, match_confidence, matched_by)
  select o.work_id, o.recording_id, 1.0, 'manual'
  from overrides o
  where o.linked = true
    and exists (select 1 from works w where w.work_id = o.work_id)
    and exists (select 1 from recordings r where r.recording_id = o.recording_id)
  on conflict (work_id, recording_id)
    do update set match_confidence = 1.0, matched_by = 'manual';

  get diagnostics v_overrides = row_count;

  return query select v_links, v_overrides;
end $$;

-- Ingest calls this with the service role only.
revoke execute on function rebuild_edition_links(real, real) from anon, authenticated;
