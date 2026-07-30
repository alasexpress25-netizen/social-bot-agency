-- Punto 9 de propuestas-30-07-2026.md: automatizar success_story_generator.py.
-- Bucket privado + tabla de registro para que el panel pueda mostrar el
-- ultimo caso de exito generado por cliente (via signed URL, RLS igual
-- que el resto de las tablas socialbot_*).
--
-- NOTA: igual que 0030, esta migracion documenta lo que ya esta aplicado
-- en produccion (proyecto redaqqxoeciycqgjhpbv) -- aplicada el 30/07/2026.

insert into storage.buckets (id, name, public)
values ('success-stories', 'success-stories', false)
on conflict (id) do nothing;

create table if not exists socialbot_success_stories (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade unique not null,
  storage_path text not null,
  days int not null default 90,
  generated_at timestamptz default now()
);

alter table socialbot_success_stories enable row level security;

drop policy if exists "owner sees own success stories" on socialbot_success_stories;
create policy "owner sees own success stories" on socialbot_success_stories
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

-- Politica de storage: solo el dueno de la agencia puede leer los archivos
-- de sus propios clientes. Convencion de path: {client_id}/archivo.html
drop policy if exists "owner reads own success story files" on storage.objects;
create policy "owner reads own success story files" on storage.objects
  for select using (
    bucket_id = 'success-stories'
    and (storage.foldername(name))[1] in (
      select c.id::text from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
    )
  );
