-- Update for an existing database: store imported past draws as their own list,
-- so every pasted line is kept even if that person isn't on the People list yet.
-- Safe to run on live data. Your people, draws, and wish lists are untouched.

create table if not exists public.past_pairs (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  giver      text not null check (char_length(trim(giver))    between 1 and 100),
  receiver   text not null check (char_length(trim(receiver)) between 1 and 100),
  created_at timestamptz not null default now()
);
create unique index if not exists past_pairs_unique_idx
  on public.past_pairs (family_id, lower(trim(giver)), lower(trim(receiver)));

alter table public.past_pairs enable row level security;

drop policy if exists "admins manage past pairs" on public.past_pairs;
create policy "admins manage past pairs" on public.past_pairs for all to authenticated
  using (public.is_family_admin(family_id)) with check (public.is_family_admin(family_id));

revoke all on public.past_pairs from anon, authenticated;
grant select, insert, delete on public.past_pairs to authenticated;
