-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
--
-- Before using the site:
--   1. Authentication -> Users -> Add user: create your own email + password.
--   2. Authentication -> Sign In / Providers -> turn OFF "Allow new users to sign up".
-- With sign-ups off, you are the only authenticated user, so "to authenticated" below means "only you".
-- Everyone else (the anon key in config.js) can read but never write.

create table if not exists public.projects (
  id         text primary key,
  title      text,
  notes      text,
  updated_at timestamptz default now()
);

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

-- Photo storage: public bucket, writes restricted to you.
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
on conflict (id) do nothing;

drop policy if exists "photo files public read" on storage.objects;
drop policy if exists "photo files owner insert" on storage.objects;
drop policy if exists "photo files owner update" on storage.objects;
drop policy if exists "photo files owner delete" on storage.objects;
create policy "photo files public read"  on storage.objects for select using (bucket_id = 'photos');
create policy "photo files owner insert" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy "photo files owner update" on storage.objects for update to authenticated using (bucket_id = 'photos');
create policy "photo files owner delete" on storage.objects for delete to authenticated using (bucket_id = 'photos');
