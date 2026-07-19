-- Rediseño del portal cliente (18/07/2026): cada cliente va a tener su
-- propio logo en su portal (frontend/cliente/cliente.html), en vez de un
-- logo genérico de la agencia. La agencia carga la URL desde su panel
-- (frontend/agencia/index.html, modal "Editar cliente"), el cliente
-- solo la lee.
alter table socialbot_clients
  add column if not exists logo_url text;

comment on column socialbot_clients.logo_url is
  'URL pública del logo del cliente (subido por la agencia a Hostinger/Cloudinary/etc, no se sube el archivo directo a Supabase). Se muestra en el header del portal cliente.';
