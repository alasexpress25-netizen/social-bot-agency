-- =========================================================
-- FASE 6 (parte 2): plan semanal de contenido generado por IA.
--
-- Una vez por semana, un job nuevo (scheduler/content_planner.py) mira,
-- por cliente:
--   - los ultimos captions publicados (para no repetir angulo),
--   - el interes de los leads recientes (que le pregunta la gente),
--   - la performance de los ultimos posts via socialbot_post_metrics
--     (que engancho mas: likes/comments/shares/reach),
--   - cuantos slots de horario tiene esa semana (cuantas ideas hacen falta),
-- y le pide a la IA un lote de posts YA REDACTADOS (no solo temas sueltos)
-- para la semana, uno por cada fecha sugerida. La agencia los revisa,
-- edita si quiere, y aprueba o rechaza cada uno desde el panel.
--
-- Un item aprobado queda "reservado" para su target_date: cuando el
-- scheduler (post_scheduler.py) va a generar el post de ese cliente ese
-- dia, si encuentra un item de plan aprobado para hoy, usa ese caption tal
-- cual (en vez de llamar a la IA en el momento como hace siempre) y lo
-- marca 'used'. Si nadie lo aprueba antes de esa fecha, no pasa nada: el
-- scheduler sigue con su logica de siempre (caption_override del media, o
-- generacion en el momento).
-- =========================================================

create table if not exists socialbot_content_plan_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  week_start date not null, -- lunes ISO de la semana que este item propone cubrir
  target_date date not null, -- fecha sugerida para publicar (debe caer dentro de esa semana)
  angle text, -- "pilar" o angulo del post en pocas palabras (ej: "objecion de precio", "testimonio")
  based_on text, -- justificacion corta y legible de por que se sugiere esto (leads, metricas, vacio de contenido)
  caption text not null, -- texto YA REDACTADO por la IA, listo para usar tal cual si se aprueba
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'used')),
  used_post_id uuid references socialbot_posts(id) on delete set null, -- se completa cuando el scheduler efectivamente lo usa
  created_at timestamptz default now(),
  reviewed_at timestamptz
);

create index if not exists idx_content_plan_items_client_date
  on socialbot_content_plan_items (client_id, target_date);

alter table socialbot_content_plan_items enable row level security;

-- Mismo patron que "owner sees own posts" (0001_init.sql): la agencia tiene
-- control total (ver, editar el texto, aprobar/rechazar) sobre el plan de
-- sus propios clientes.
create policy "owner sees own content_plan_items" on socialbot_content_plan_items
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

-- El cliente puede ver su propio plan (solo lectura por ahora -- si mas
-- adelante se quiere que el cliente tambien apruebe/edite desde su portal,
-- se agrega siguiendo el mismo patron de RPC SECURITY DEFINER que ya usa
-- el resto de las acciones de cliente, ver 0006_client_portal.sql).
create policy "client sees own content_plan_items" on socialbot_content_plan_items
  for select using (client_id in (select id from socialbot_clients where client_user_id = auth.uid()));
