-- Upgrade for a database created from an older schema.sql.
-- Photos are now saved as WebP (JPEG from Safari), and the photo bucket refuses files over 1 MB
-- (it allowed 5 MB). Photos already uploaded stay as they are.
-- Paste this whole file into the Supabase SQL editor and run it. Running it again later is harmless.
-- A fresh install does not need it: schema.sql already contains all of this.

update storage.buckets
set file_size_limit = 1048576, allowed_mime_types = '{image/webp,image/jpeg}'
where id = 'updates';
