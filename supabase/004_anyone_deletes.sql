-- Update for an existing database: anyone with the family's wishlist link can
-- delete any item. Safe to run on live data (also appended to schema.sql).

create or replace function public.wishlist_delete_any(p_token uuid, p_item uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.wishlist_items w
  using public.families f
  where w.id = p_item and w.family_id = f.id and f.share_token = p_token;
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke execute on function public.wishlist_delete_any(uuid, uuid) from public, anon, authenticated;
grant execute on function public.wishlist_delete_any(uuid, uuid) to anon, authenticated;
