-- Lets any server member delete a channel (same membership-only permission
-- model as create_channel/set_channel_type — no owner-only restriction).
create or replace function public.delete_channel(target_channel_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  is_member boolean;
begin
  select exists (select 1 from channels join room_members on room_members.room_id = channels.room_id where channels.id = target_channel_id and room_members.user_id = auth.uid()) into is_member;

  if not is_member then
    raise exception 'not a member of this server';
  end if;

  delete from channels where id = target_channel_id;
end;
$function$;

grant execute on function public.delete_channel(text) to authenticated;
