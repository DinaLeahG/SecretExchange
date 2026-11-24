-- =====================================================================
-- Secret Macabi — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it drops and recreates only the objects it owns.
--
-- Security model
--   * Admins log in with Supabase Auth (email + password).
--   * Every table has Row Level Security: an admin can only see/change
--     families they are listed as an admin of in family_admins.
--   * Family members (not logged in) reach the wishlist through a secret
--     per-family share link. They can only call the wishlist_* functions,
--     which never expose emails or draw results.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- clean re-run ----------
drop table if exists public.wishlist_items cascade;
drop table if exists public.assignments    cascade;
drop table if exists public.draws          cascade;
drop table if exists public.members        cascade;
drop table if exists public.family_admins  cascade;
drop table if exists public.families       cascade;

-- ---------- tables ----------
create table public.families (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (char_length(trim(name)) between 1 and 100),
  share_token        uuid not null unique default gen_random_uuid(),
  budget             text not null default ''               check (char_length(budget)   <= 50),
  occasion           text not null default ''               check (char_length(occasion) <= 100),
  signoff            text not null default ''               check (char_length(signoff)  <= 100),
  email_subject      text not null default ''
                                                            check (char_length(email_subject) <= 200),
  avoid_recent_draws int  not null default 1 check (avoid_recent_draws between 0 and 10),
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);

create table public.family_admins (
  family_id  uuid not null references public.families(id) on delete cascade,
  user_id    uuid not null references auth.users(id)      on delete cascade,
  role       text not null default 'admin' check (role in ('owner', 'admin')),
  created_at timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index on public.family_admins (user_id);

create table public.members (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  name         text not null check (char_length(trim(name)) between 1 and 100),
  email        text check (email is null or email = '' or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  group_name   text not null default 'Adults' check (group_name in ('Adults', 'Kids')),
  gender       text check (gender is null or gender in ('F', 'M')),
  exclusions   text not null default '' check (char_length(exclusions) <= 1000),
  past_matches text[] not null default '{}',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (id, family_id)              -- lets other tables pin a member to its family
);
create unique index members_family_name_uidx on public.members (family_id, lower(trim(name)));

create table public.draws (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, family_id)
);
create index on public.draws (family_id, created_at desc);

create table public.assignments (
  id          uuid primary key default gen_random_uuid(),
  draw_id     uuid not null,
  family_id   uuid not null,
  giver_id    uuid not null,
  receiver_id uuid not null,
  sent_at     timestamptz,
  constraint assignments_draw_fkey     foreign key (draw_id, family_id)     references public.draws(id, family_id)   on delete cascade,
  constraint assignments_giver_fkey    foreign key (giver_id, family_id)    references public.members(id, family_id) on delete cascade,
  constraint assignments_receiver_fkey foreign key (receiver_id, family_id) references public.members(id, family_id) on delete cascade,
  constraint assignments_not_self check (giver_id <> receiver_id),
  unique (draw_id, giver_id),
  unique (draw_id, receiver_id)
);

create table public.wishlist_items (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null,
  member_id  uuid not null,
  title      text not null check (char_length(trim(title)) between 1 and 200),
  link       text check (link is null or link = '' or (link ~* '^https?://' and char_length(link) <= 2000)),
  notes      text check (notes is null or char_length(notes) <= 1000),
  edit_key   uuid not null default gen_random_uuid(),   -- lets the person who added it delete it
  created_at timestamptz not null default now(),
  constraint wishlist_member_fkey foreign key (member_id, family_id) references public.members(id, family_id) on delete cascade
);
create index on public.wishlist_items (family_id, member_id);

-- ---------- helper checks (used by policies) ----------
create or replace function public.is_family_admin(fid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.family_admins where family_id = fid and user_id = auth.uid());
$$;

create or replace function public.is_family_owner(fid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.family_admins where family_id = fid and user_id = auth.uid() and role = 'owner');
$$;

-- ---------- row level security ----------
alter table public.families       enable row level security;
alter table public.family_admins  enable row level security;
alter table public.members        enable row level security;
alter table public.draws          enable row level security;
alter table public.assignments    enable row level security;
alter table public.wishlist_items enable row level security;

create policy "admins read family"    on public.families for select to authenticated using (public.is_family_admin(id));
create policy "admins update family"  on public.families for update to authenticated using (public.is_family_admin(id)) with check (public.is_family_admin(id));
create policy "owners delete family"  on public.families for delete to authenticated using (public.is_family_owner(id));

create policy "admins read admins"    on public.family_admins for select to authenticated using (public.is_family_admin(family_id));

create policy "admins manage members" on public.members for all to authenticated
  using (public.is_family_admin(family_id)) with check (public.is_family_admin(family_id));

create policy "admins read draws"     on public.draws for select to authenticated using (public.is_family_admin(family_id));
create policy "admins delete draws"   on public.draws for delete to authenticated using (public.is_family_admin(family_id));

create policy "admins read assignments"   on public.assignments for select to authenticated using (public.is_family_admin(family_id));
create policy "admins mark assignments"   on public.assignments for update to authenticated
  using (public.is_family_admin(family_id)) with check (public.is_family_admin(family_id));

create policy "admins manage wishlist" on public.wishlist_items for all to authenticated
  using (public.is_family_admin(family_id)) with check (public.is_family_admin(family_id));

-- Table privileges: nothing for anonymous visitors; column-limited updates for admins.
revoke all on public.families, public.family_admins, public.members, public.draws,
              public.assignments, public.wishlist_items from anon, authenticated;

grant select, delete on public.families to authenticated;
grant update (name, budget, occasion, signoff, email_subject, avoid_recent_draws) on public.families to authenticated;
grant select on public.family_admins to authenticated;
grant select, insert, delete on public.members to authenticated;
grant update (name, email, group_name, gender, exclusions, past_matches, active) on public.members to authenticated;
grant select, delete on public.draws to authenticated;
grant select on public.assignments to authenticated;
grant update (sent_at) on public.assignments to authenticated;
grant select, insert, delete on public.wishlist_items to authenticated;
grant update (title, link, notes) on public.wishlist_items to authenticated;

-- =====================================================================
-- Functions for logged-in admins
-- =====================================================================

-- Create a family; the caller becomes -- =====================================================================
-- Secret Macabi — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it drops and recreates only the objects it owns.
--
-- Security model
--   * Admins log in with Supabase Auth (email + password).
--   * Every table has Row Level Security: an admin can only see/change
--     families they are listed as an admin of in family_admins.
--   * Family members (not logged in) reach the wishlist through a secret
--     per-family share link. They can only call the wishlist_* functions,
--     which never expose emails or draw results.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- clean re-run ----------
drop table if exists public.wishlist_items cascade;
drop table if exists public.assignments    cascade;
drop table if exists public.draws          cascade;
drop table if exists public.members        cascade;
drop table if exists public.family_admins  cascade;
drop table if exists public.families       cascade;

-- ---------- tables ----------
create table public.families (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (char_length(trim(name)) between 1 and 100),
  share_token        uuid not null unique default gen_random_uuid(),
  budget             text not null default ''               check (char_length(budget)   <= 50),
  occasion           text not null default ''               check (char_length(occasion) <= 100),
  signoff            text not null default ''               check (char_length(signoff)  <= 100),
  email_subject      text not null default ''
                                                            check (char_length(email_subject) <= 200),
  avoid_recent_draws int  not null default 1 check (avoid_recent_draws between 0 and 10),
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);

create table public.family_admins (
  family_id  uuid not null references public.families(id) on delete cascade,
  user_id    uuid not null references auth.users(id)      on delete cascade,
  role       text not null default 'admin' check (role in ('owner', 'admin')),
  created_at timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index on public.family_admins (user_id);

create table public.members (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  name         text not null check (char_length(trim(name)) between 1 and 100),
  email        text check (email is null or email = '' or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  group_name   text not null default 'Adults' check (group_name in ('Adults', 'Kids')),
  gender       text check (gender is null or gender in ('F', 'M')),
  exclusions   text not null default '' check (char_length(exclusions) <= 1000),
  past_matches text[] not null default '{}',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (id, family_id)              -- lets other tables pin a member to its family
);
create unique index members_family_name_uidx on public.members (family_id, lower(trim(name)));

create table public.draws (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, family_id)
);
create index on public.draws (family_id, created_at desc);

create table public.assignments (
  id          uuid primary key default gen_random_uuid(),
  draw_id     uuid not null,
  family_id   uuid not null,
  giver_id    uuid not null,
  receiver_id uuid not null,
  sent_at     timestamptz,
  constraint assignments_draw_fkey     foreign key (draw_id, family_id)     references public.draws(id, family_id)   on delete cascade,
  constraint assignments_giver_fkey    foreign key (giver_id, family_id)    references public.members(id, family_id) on delete cascade,
  constraint assignments_receiver_fkey foreign key (receiver_id, family_id) references public.members(id, family_id) on delete cascade,
  constraint assignments_not_self check (giver_id <> receiver_id),
  unique (draw_id, giver_id),
  unique (draw_id, receiver_id)
);

create table public.wishlist_items (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null,
  member_id  uuid not null,
  title      text not null check (char_length(trim(title)) between 1 and 200),
  link       text check (link is null or link = '' or (link ~* '^https?://' and char_length(link) <= 2000)),
  notes      text check (notes is null or char_length(notes) <= 1000),
  edit_key   uuid not null default gen_random_uuid(),   -- lets the person who added it delete it
  created_at timestamptz not null default now(),
  constraint wishlist_member_fkey foreign key (member_id, family_id) references public.members(id, family_id) on delete cascade
);
create index on public.wishlist_items (family_id, member_id);

-- ---------- helper checks (used by policies) ----------
create or replace function public.is_family_admin(fid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.family_admins where family_id = fid and user_id = auth.uid());
$$;

create or replace function public.is_family_owner(fid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.family_admins where family_id = fid and user_id = auth.uid() and role = 'owner');
$$;

-- ---------- row level security ----------
alter table public.families       enable row level security;
alter table public.family_admins  enable row level security;
alter table public.members        enable row level security;
alter table public.draws          enable row level security;
alter table public.assignments    enable row level security;
alter table public.wishlist_items enable row level security;

create policy "admins read family"    on public.families for select to authenticated using (public.is_family_admin(id));
create policy "admins update family"  on public.families for update to authenticated using (public.is_family_admin(id)) with check (public.is_family_admin(id));
create policy "owners delete family"  on public.families for delete to authenticated using (public.is_family_owner(id));

create policy "admins read admins"    on public.family_admins for select to authenticated using (public.is_family_admin(family_id));

create policy "admins manage members" on public.members for all to authenticated
  using (public.is_family_admin(family_id)) with check (public.is_family_admin(family_id));

create policy "admins read draws"     on public.draws for select to authenticated using (public.is_family_admin(family_id));
create policy "admins delete draws"   on public.draws for delete to authenticated using (public.is_family_admin(family_id));

create policy "admins read assignments"   on public.assignments for select to authenticated using (public.is_family_admin(family_id));
create policy "admins mark assignments"   on public.assignments for update to authenticated
  using (public.is_family_admin(family_id)) with check (public.is_family_admin(family_id));

create policy "admins manage wishlist" on public.wishlist_items for all to authenticated
  using (public.is_family_admin(family_id)) with check (public.is_family_admin(family_id));

-- Table privileges: nothing for anonymous visitors; column-limited updates for admins.
revoke all on public.families, public.family_admins, public.members, public.draws,
              public.assignments, public.wishlist_items from anon, authenticated;

grant select, delete on public.families to authenticated;
grant update (name, budget, occasion, signoff, email_subject, avoid_recent_draws) on public.families to authenticated;
grant select on public.family_admins to authenticated;
grant select, insert, delete on public.members to authenticated;
grant update (name, email, group_name, gender, exclusions, past_matches, active) on public.members to authenticated;
grant select, delete on public.draws to authenticated;
grant select on public.assignments to authenticated;
grant update (sent_at) on public.assignments to authenticated;
grant select, insert, delete on public.wishlist_items to authenticated;
grant update (title, link, notes) on public.wishlist_items to authenticated;

-- =====================================================================
-- Functions for logged-in admins
-- =====================================================================

-- Create a family; the caller becomes its owner.
create or replace function public.create_family(p_name text)
returns public.families language plpgsql security definer set search_path = public as $$
declare f public.families;
begin
  if auth.uid() is null then raise exception 'Not logged in'; end if;
  if (select count(*) from public.family_admins where user_id = auth.uid() and role = 'owner') >= 10 then
    raise exception 'You already own 10 families';
  end if;
  insert into public.families (name, created_by) values (trim(p_name), auth.uid()) returning * into f;
  insert into public.family_admins (family_id, user_id, role) values (f.id, auth.uid(), 'owner');
  return f;
end $$;

-- Save a finished draw. p_pairs = [{"giver_id": "...", "receiver_id": "..."}, ...]
create or replace function public.save_draw(p_family uuid, p_pairs jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  if not public.is_family_admin(p_family) then raise exception 'Not an admin of this family'; end if;
  if jsonb_typeof(p_pairs) <> 'array' or jsonb_array_length(p_pairs) < 2 then raise exception 'A draw needs at least 2 pairs'; end if;
  insert into public.draws (family_id, created_by) values (p_family, auth.uid()) returning id into d;
  insert into public.assignments (draw_id, family_id, giver_id, receiver_id)
  select d, p_family, (p->>'giver_id')::uuid, (p->>'receiver_id')::uuid
  from jsonb_array_elements(p_pairs) p;
  return d;
end $$;

-- List a family's admins with their login emails.
create or replace function public.list_family_admins(p_family uuid)
returns table (user_id uuid, email text, role text) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_family_admin(p_family) then raise exception 'Not an admin of this family'; end if;
  return query
    select fa.user_id, u.email::text, fa.role
    from public.family_admins fa join auth.users u on u.id = fa.user_id
    where fa.family_id = p_family
    order by fa.role desc, u.email;
end $$;

-- Owners add another admin. The person must have created an account first.
create or replace function public.add_family_admin(p_family uuid, p_email text, p_role text default 'admin')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_family_owner(p_family) then raise exception 'Only an owner can add admins'; end if;
  if p_role not in ('owner', 'admin') then raise exception 'Role must be owner or admin'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'No account uses that email yet. Ask them to sign up on the site first.'; end if;
  insert into public.family_admins (family_id, user_id, role) values (p_family, uid, p_role)
  on conflict (family_id, user_id) do update set role = excluded.role;
end $$;

-- Owners remove an admin (anyone may remove themselves). The last owner can't be removed.
create or replace function public.remove_family_admin(p_family uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_family_owner(p_family) or (p_user = auth.uid() and public.is_family_admin(p_family))) then
    raise exception 'Only an owner can remove other admins';
  end if;
  if (select role from public.family_admins where family_id = p_family and user_id = p_user) = 'owner'
     and (select count(*) from public.family_admins where family_id = p_family and role = 'owner') <= 1 then
    raise exception 'A family needs at least one owner';
  end if;
  delete from public.family_admins where family_id = p_family and user_id = p_user;
end $$;

-- New share link (old wishlist links stop working).
create or replace function public.regenerate_share_token(p_family uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid := gen_random_uuid();
begin
  if not public.is_family_admin(p_family) then raise exception 'Not an admin of this family'; end if;
  update public.families set share_token = t where id = p_family;
  return t;
end $$;

-- =====================================================================
-- Functions for family members using the share link (no login)
-- =====================================================================

create or replace function public.wishlist_get(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f public.families;
begin
  select * into f from public.families where share_token = p_token;
  if f.id is null then return null; end if;
  return jsonb_build_object(
    'family',  jsonb_build_object('name', f.name, 'occasion', f.occasion, 'budget', f.budget),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'group', m.group_name) order by m.group_name, m.name)
                         from public.members m where m.family_id = f.id and m.active), '[]'::jsonb),
    'items',   coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'member_id', w.member_id, 'title', w.title,
                                                             'link', w.link, 'notes', w.notes, 'created_at', w.created_at) order by w.created_at)
                         from public.wishlist_items w where w.family_id = f.id), '[]'::jsonb)
  );
end $$;

create or replace function public.wishlist_add(p_token uuid, p_member uuid, p_title text, p_link text, p_notes text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f uuid; w public.wishlist_items;
begin
  select id into f from public.families where share_token = p_token;
  if f is null then raise exception 'This wishlist link is no longer valid'; end if;
  if not exists (select 1 from public.members where id = p_member and family_id = f and active) then
    raise exception 'Unknown person';
  end if;
  if (select count(*) from public.wishlist_items where member_id = p_member) >= 50 then
    raise exception 'That list already has 50 items';
  end if;
  insert into public.wishlist_items (family_id, member_id, title, link, notes)
  values (f, p_member, trim(p_title), nullif(trim(coalesce(p_link, '')), ''), nullif(trim(coalesce(p_notes, '')), ''))
  returning * into w;
  return jsonb_build_object('id', w.id, 'edit_key', w.edit_key);
end $$;

create or replace function public.wishlist_delete(p_token uuid, p_item uuid, p_edit_key uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.wishlist_items w
  using public.families f
  where w.id = p_item and w.edit_key = p_edit_key and w.family_id = f.id and f.share_token = p_token;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ---------- function privileges ----------
revoke execute on function
  public.is_family_admin(uuid), public.is_family_owner(uuid),
  public.create_family(text), public.save_draw(uuid, jsonb),
  public.list_family_admins(uuid), public.add_family_admin(uuid, text, text),
  public.remove_family_admin(uuid, uuid), public.regenerate_share_token(uuid),
  public.wishlist_get(uuid), public.wishlist_add(uuid, uuid, text, text, text),
  public.wishlist_delete(uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.is_family_admin(uuid), public.is_family_owner(uuid),
  public.create_family(text), public.save_draw(uuid, jsonb),
  public.list_family_admins(uuid), public.add_family_admin(uuid, text, text),
  public.remove_family_admin(uuid, uuid), public.regenerate_share_token(uuid)
to authenticated;

grant execute on function
  public.wishlist_get(uuid), public.wishlist_add(uuid, uuid, text, text, text),
  public.wishlist_delete(uuid, uuid, uuid)
to anon, authenticated;

create or replace function public.create_family(p_name text)
returns public.families language plpgsql security definer set search_path = public as $$
declare f public.families;
begin
  if auth.uid() is null then raise exception 'Not logged in'; end if;
  if (select count(*) from public.family_admins where user_id = auth.uid() and role = 'owner') >= 10 then
    raise exception 'You already own 10 families';
  end if;
  insert into public.families (name, created_by) values (trim(p_name), auth.uid()) returning * into f;
  insert into public.family_admins (family_id, user_id, role) values (f.id, auth.uid(), 'owner');
  return f;
end $$;

-- Save a finished draw. p_pairs = [{"giver_id": "...", "receiver_id": "..."}, ...]
create or replace function public.save_draw(p_family uuid, p_pairs jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  if not public.is_family_admin(p_family) then raise exception 'Not an admin of this family'; end if;
  if jsonb_typeof(p_pairs) <> 'array' or jsonb_array_length(p_pairs) < 2 then raise exception 'A draw needs at least 2 pairs'; end if;
  insert into public.draws (family_id, created_by) values (p_family, auth.uid()) returning id into d;
  insert into public.assignments (draw_id, family_id, giver_id, receiver_id)
  select d, p_family, (p->>'giver_id')::uuid, (p->>'receiver_id')::uuid
  from jsonb_array_elements(p_pairs) p;
  return d;
end $$;

-- List a family's admins with their login emails.
create or replace function public.list_family_admins(p_family uuid)
returns table (user_id uuid, email text, role text) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_family_admin(p_family) then raise exception 'Not an admin of this family'; end if;
  return query
    select fa.user_id, u.email::text, fa.role
    from public.family_admins fa join auth.users u on u.id = fa.user_id
    where fa.family_id = p_family
    order by fa.role desc, u.email;
end $$;

-- Owners add another admin. The person must have created an account first.
create or replace function public.add_family_admin(p_family uuid, p_email text, p_role text default 'admin')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_family_owner(p_family) then raise exception 'Only an owner can add admins'; end if;
  if p_role not in ('owner', 'admin') then raise exception 'Role must be owner or admin'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'No account uses that email yet. Ask them to sign up on the site first.'; end if;
  insert into public.family_admins (family_id, user_id, role) values (p_family, uid, p_role)
  on conflict (family_id, user_id) do update set role = excluded.role;
end $$;

-- Owners remove an admin (anyone may remove themselves). The last owner can't be removed.
create or replace function public.remove_family_admin(p_family uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_family_owner(p_family) or (p_user = auth.uid() and public.is_family_admin(p_family))) then
    raise exception 'Only an owner can remove other admins';
  end if;
  if (select role from public.family_admins where family_id = p_family and user_id = p_user) = 'owner'
     and (select count(*) from public.family_admins where family_id = p_family and role = 'owner') <= 1 then
    raise exception 'A family needs at least one owner';
  end if;
  delete from public.family_admins where family_id = p_family and user_id = p_user;
end $$;

-- New share link (old wishlist links stop working).
create or replace function public.regenerate_share_token(p_family uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid := gen_random_uuid();
begin
  if not public.is_family_admin(p_family) then raise exception 'Not an admin of this family'; end if;
  update public.families set share_token = t where id = p_family;
  return t;
end $$;

-- =====================================================================
-- Functions for family members using the share link (no login)
-- =====================================================================

create or replace function public.wishlist_get(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f public.families;
begin
  select * into f from public.families where share_token = p_token;
  if f.id is null then return null; end if;
  return jsonb_build_object(
    'family',  jsonb_build_object('name', f.name, 'occasion', f.occasion, 'budget', f.budget),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'group', m.group_name) order by m.group_name, m.name)
                         from public.members m where m.family_id = f.id and m.active), '[]'::jsonb),
    'items',   coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'member_id', w.member_id, 'title', w.title,
                                                             'link', w.link, 'notes', w.notes, 'created_at', w.created_at) order by w.created_at)
                         from public.wishlist_items w where w.family_id = f.id), '[]'::jsonb)
  );
end $$;

create or replace function public.wishlist_add(p_token uuid, p_member uuid, p_title text, p_link text, p_notes text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f uuid; w public.wishlist_items;
begin
  select id into f from public.families where share_token = p_token;
  if f is null then raise exception 'This wishlist link is no longer valid'; end if;
  if not exists (select 1 from public.members where id = p_member and family_id = f and active) then
    raise exception 'Unknown person';
  end if;
  if (select count(*) from public.wishlist_items where member_id = p_member) >= 50 then
    raise exception 'That list already has 50 items';
  end if;
  insert into public.wishlist_items (family_id, member_id, title, link, notes)
  values (f, p_member, trim(p_title), nullif(trim(coalesce(p_link, '')), ''), nullif(trim(coalesce(p_notes, '')), ''))
  returning * into w;
  return jsonb_build_object('id', w.id, 'edit_key', w.edit_key);
end $$;

create or replace function public.wishlist_delete(p_token uuid, p_item uuid, p_edit_key uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.wishlist_items w
  using public.families f
  where w.id = p_item and w.edit_key = p_edit_key and w.family_id = f.id and f.share_token = p_token;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ---------- function privileges ----------
revoke execute on function
  public.is_family_admin(uuid), public.is_family_owner(uuid),
  public.create_family(text), public.save_draw(uuid, jsonb),
  public.list_family_admins(uuid), public.add_family_admin(uuid, text, text),
  public.remove_family_admin(uuid, uuid), public.regenerate_share_token(uuid),
  public.wishlist_get(uuid), public.wishlist_add(uuid, uuid, text, text, text),
  public.wishlist_delete(uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.is_family_admin(uuid), public.is_family_owner(uuid),
  public.create_family(text), public.save_draw(uuid, jsonb),
  public.list_family_admins(uuid), public.add_family_admin(uuid, text, text),
  public.remove_family_admin(uuid, uuid), public.regenerate_share_token(uuid)
to authenticated;

grant execute on function
  public.wishlist_get(uuid), public.wishlist_add(uuid, uuid, text, text, text),
  public.wishlist_delete(uuid, uuid, uuid)
to anon, authenticated;
