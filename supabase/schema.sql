-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
--
-- Before using the site:
--   1. Authentication -> Users -> Add user: email ziggyzorb@devonmarlin.com (the site's login form turns the
--      username "ZiggyZorb" into this address), your password, and tick "Auto Confirm User".
--   2. Authentication -> Sign In / Providers -> turn OFF "Allow new users to sign up".
-- With sign-ups off, you are the only authenticated user, so "to authenticated" below means "only you".
-- Everyone else (the anon key in config.js) can read but never write.

create table if not exists public.projects (
  id         text primary key,
  title      text,
  notes      text,
  model_path text,                 -- uploaded model file in the "models" bucket (replaces the built-in one)
  model_meta jsonb,                -- measured parts of that model (size, volume, area)
  sort       int  default 0,       -- order of projects added from admin mode
  hidden     boolean default false,-- true = a built-in project the admin has removed
  updated_at timestamptz default now()
);
-- safe to re-run on a project created from an earlier version of this file
alter table public.projects add column if not exists model_path text;
alter table public.projects add column if not exists model_meta jsonb;
alter table public.projects add column if not exists sort int default 0;
alter table public.projects add column if not exists hidden boolean default false;

create table if not exists public.photos (
  id         uuid primary key default gen_random_uuid(),
  project_id text not null,
  path       text not null,
  caption    text default '',
  sort       int  default 0,
  created_at timestamptz default now()
);

alter table public.projects enable row level security;
alter table public.photos   enable row level security;

drop policy if exists "projects public read" on public.projects;
drop policy if exists "projects owner write" on public.projects;
create policy "projects public read" on public.projects for select using (true);
create policy "projects owner write" on public.projects for all to authenticated using (true) with check (true);

drop policy if exists "photos public read" on public.photos;
drop policy if exists "photos owner write" on public.photos;
create policy "photos public read" on public.photos for select using (true);
create policy "photos owner write" on public.photos for all to authenticated using (true) with check (true);

-- Part pages: one row per part per project; "blocks" holds the text, stats, charts, images and embeds you write.
create table if not exists public.parts (
  project_id text not null,
  key        text not null,
  title      text,
  blocks     jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now(),
  primary key (project_id, key)
);
alter table public.parts enable row level security;
drop policy if exists "parts public read" on public.parts;
drop policy if exists "parts owner write" on public.parts;
create policy "parts public read" on public.parts for select using (true);
create policy "parts owner write" on public.parts for all to authenticated using (true) with check (true);

-- Photo and model storage: public buckets, writes restricted to you.
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('models', 'models', true)
on conflict (id) do nothing;

drop policy if exists "photo files public read" on storage.objects;
drop policy if exists "photo files owner insert" on storage.objects;
drop policy if exists "photo files owner update" on storage.objects;
drop policy if exists "photo files owner delete" on storage.objects;
create policy "photo files public read"  on storage.objects for select using (bucket_id = 'photos');
create policy "photo files owner insert" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy "photo files owner update" on storage.objects for update to authenticated using (bucket_id = 'photos');
create policy "photo files owner delete" on storage.objects for delete to authenticated using (bucket_id = 'photos');

drop policy if exists "model files public read" on storage.objects;
drop policy if exists "model files owner insert" on storage.objects;
drop policy if exists "model files owner update" on storage.objects;
drop policy if exists "model files owner delete" on storage.objects;
create policy "model files public read"  on storage.objects for select using (bucket_id = 'models');
create policy "model files owner insert" on storage.objects for insert to authenticated with check (bucket_id = 'models');
create policy "model files owner update" on storage.objects for update to authenticated using (bucket_id = 'models');
create policy "model files owner delete" on storage.objects for delete to authenticated using (bucket_id = 'models');
