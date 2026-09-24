-- Profile pictures. Purely additive: a public "avatars" bucket, so an image is
-- readable by its URL without any policy, and writes locked to the account's
-- own folder (<user id>/<file>). The URL itself lives in the account's
-- user_metadata.avatar_url (see auth.js uploadAvatar) — no table involved; the
-- server only relays URLs that point into this bucket (server.js safeAvatarUrl).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars insert own folder" on storage.objects;
create policy "avatars insert own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Delete (and the select it needs) so replacing a picture can drop the old file.
drop policy if exists "avatars select own folder" on storage.objects;
create policy "avatars select own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars delete own folder" on storage.objects;
create policy "avatars delete own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
