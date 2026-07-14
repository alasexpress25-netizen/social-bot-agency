-- =========================================================
-- FASE 3: portal de cliente (login propio, ve y gestiona sus datos)
-- Ya aplicada en produccion (redaqqxoeciycqgjhpbv) directo via MCP de
-- Supabase. Este archivo es solo para que el repo quede fiel a lo que ya
-- esta corriendo -- usa "if not exists" / DROP+ADD idempotente, no cambia
-- nada en la base real.
-- =========================================================

-- Vincula cada cliente con su usuario de Supabase Auth. El cliente entra con
-- magic link (sin contrasena) usando client_email; al loguearse por primera
-- vez, el frontend "reclama" el client_user_id si coincide el email y todavia
-- esta sin reclamar (evita que cualquiera se adjudique un cliente ajeno).
alter table socialbot_clients
  add column if not exists client_email text unique;
alter table socialbot_clients
  add column if not exists client_user_id uuid references auth.users(id);
comment on column socialbot_clients.client_user_id is
  'Se completa solo, la primera vez que el cliente entra con magic link a su client_email.';

-- Permite a la agencia activar aprobacion manual de posts para un cliente
-- puntual (adelanto de Fase 5, pedido para el portal de cliente).
alter table socialbot_clients
  add column if not exists require_approval boolean not null default false;
comment on column socialbot_clients.require_approval is
  'Si es true, el scheduler genera el post pero NO publica hasta que el cliente lo apruebe desde su portal.';

-- Estado de aprobacion, independiente del status de publicacion (que sigue
-- siendo pending/publishing/published/failed). Default 'approved' para no
-- romper a los clientes existentes que no usan aprobacion manual.
alter table socialbot_posts
  add column if not exists approval_status text not null default 'approved'
    check (approval_status in ('pending','approved','rejected'));
comment on column socialbot_posts.approval_status is
  'pending = esperando que el cliente apruebe/rechace. approved = ok para publicar (o ya publicado). rejected = el cliente lo descarto.';

-- El status ahora tambien puede quedar en 'pending' (post generado pero
-- todavia no publicado porque espera aprobacion), ademas de los valores que
-- ya existian.
alter table socialbot_posts
  drop constraint if exists socialbot_posts_status_check;
alter table socialbot_posts
  add constraint socialbot_posts_status_check
    check (status in ('pending','publishing','published','failed'));

-- ---------------------------------------------------------
-- RLS: el cliente ve y gestiona SOLO su propia fila, via client_user_id.
-- Son policies ADICIONALES a las de "owner sees own X" de la agencia
-- (Postgres las combina con OR: agencia sigue viendo todo lo suyo).
-- Nota: estas policies filtran por FILA (que cliente es), no por columna;
-- igual que en el resto del esquema, se confia en que el frontend solo
-- mande los campos que corresponden (ej: el portal de cliente solo ofrece
-- botones para approval_status y status de lead, no para editar caption).
-- ---------------------------------------------------------

create policy "client sees own client row" on socialbot_clients
  for select using (client_user_id = auth.uid());

-- Permite el "self-claim" inicial: el cliente completa client_user_id la
-- primera vez que entra, pero SOLO si esa fila todavia no tiene dueno
-- (client_user_id is null) y el email de auth coincide con client_email.
create policy "client claims own row once" on socialbot_clients
  for update using (
    client_user_id is null
    and client_email = (select email from auth.users where id = auth.uid())
  )
  with check (client_user_id = auth.uid());

create policy "client sees own posts" on socialbot_posts
  for select using (client_id in (select id from socialbot_clients where client_user_id = auth.uid()));

create policy "client updates approval of own posts" on socialbot_posts
  for update using (client_id in (select id from socialbot_clients where client_user_id = auth.uid()))
  with check (client_id in (select id from socialbot_clients where client_user_id = auth.uid()));

create policy "client sees own leads" on socialbot_leads
  for select using (client_id in (select id from socialbot_clients where client_user_id = auth.uid()));

create policy "client updates status of own leads" on socialbot_leads
  for update using (client_id in (select id from socialbot_clients where client_user_id = auth.uid()))
  with check (client_id in (select id from socialbot_clients where client_user_id = auth.uid()));

create policy "client sees own ai_settings" on socialbot_ai_settings
  for select using (client_id in (select id from socialbot_clients where client_user_id = auth.uid()));

create policy "client updates tone/topics of own ai_settings" on socialbot_ai_settings
  for update using (client_id in (select id from socialbot_clients where client_user_id = auth.uid()))
  with check (client_id in (select id from socialbot_clients where client_user_id = auth.uid()));


-- =========================================================
-- ENDURECIMIENTO: se sacan las policies de UPDATE de arriba (filtran por
-- fila pero no por columna) y se reemplazan por funciones RPC con
-- SECURITY DEFINER, que validan del lado del servidor quien es el dueno de
-- la fila, que campo se toca, y que valores estan permitidos. El cliente ya
-- no tiene NINGUN camino de UPDATE directo por tabla; todo pasa por estas
-- funciones. Tambien aplicado directo en produccion via MCP de Supabase.
-- =========================================================

drop policy if exists "client claims own row once" on socialbot_clients;
drop policy if exists "client updates approval of own posts" on socialbot_posts;
drop policy if exists "client updates status of own leads" on socialbot_leads;
drop policy if exists "client updates tone/topics of own ai_settings" on socialbot_ai_settings;

-- 1) Reclamar la cuenta la primera vez que el cliente entra con magic link.
-- No recibe el email como parametro (evita que alguien reclame la fila de
-- otro pasando un email ajeno): lo toma de su propia sesion.
create or replace function public.client_claim_account()
returns socialbot_clients
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_row socialbot_clients;
begin
  select email into v_email from auth.users where id = auth.uid();
  if v_email is null then
    raise exception 'no autenticado';
  end if;

  update socialbot_clients
    set client_user_id = auth.uid()
    where client_email = v_email and client_user_id is null
    returning * into v_row;

  if v_row.id is null then
    select * into v_row from socialbot_clients where client_user_id = auth.uid();
  end if;

  return v_row;
end;
$$;

revoke all on function public.client_claim_account() from public;
grant execute on function public.client_claim_account() to authenticated;

-- 2) Aprobar/rechazar un post propio. Solo toca approval_status, y solo si
-- el post todavia esta 'pending' (no se puede revertir una decision ya tomada).
create or replace function public.client_review_post(p_post_id uuid, p_decision text)
returns socialbot_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_row socialbot_posts;
begin
  if p_decision not in ('approved','rejected') then
    raise exception 'decision invalida: %', p_decision;
  end if;

  select id into v_client_id from socialbot_clients where client_user_id = auth.uid();
  if v_client_id is null then
    raise exception 'no autorizado';
  end if;

  update socialbot_posts
    set approval_status = p_decision
    where id = p_post_id and client_id = v_client_id and approval_status = 'pending'
    returning * into v_row;

  if v_row.id is null then
    raise exception 'post no encontrado, no es tuyo, o ya fue revisado';
  end if;

  return v_row;
end;
$$;

revoke all on function public.client_review_post(uuid, text) from public;
grant execute on function public.client_review_post(uuid, text) to authenticated;

-- 3) Actualizar el status de un lead propio. Solo toca status/updated_at.
create or replace function public.client_update_lead_status(p_lead_id uuid, p_status text)
returns socialbot_leads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_row socialbot_leads;
begin
  if p_status not in ('nuevo','contactado','convertido','descartado') then
    raise exception 'status invalido: %', p_status;
  end if;

  select id into v_client_id from socialbot_clients where client_user_id = auth.uid();
  if v_client_id is null then
    raise exception 'no autorizado';
  end if;

  update socialbot_leads
    set status = p_status, updated_at = now()
    where id = p_lead_id and client_id = v_client_id
    returning * into v_row;

  if v_row.id is null then
    raise exception 'lead no encontrado o no es tuyo';
  end if;

  return v_row;
end;
$$;

revoke all on function public.client_update_lead_status(uuid, text) from public;
grant execute on function public.client_update_lead_status(uuid, text) to authenticated;

-- 4) Actualizar SOLO tone/topics de la config de IA propia (nunca provider,
-- system_prompt ni daily_ai_reply_limit, que quedan reservados a la agencia).
create or replace function public.client_update_ai_prefs(p_tone text, p_topics text)
returns socialbot_ai_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_row socialbot_ai_settings;
begin
  select id into v_client_id from socialbot_clients where client_user_id = auth.uid();
  if v_client_id is null then
    raise exception 'no autorizado';
  end if;

  update socialbot_ai_settings
    set tone = p_tone, topics = p_topics
    where client_id = v_client_id
    returning * into v_row;

  if v_row.id is null then
    raise exception 'configuracion de ia no encontrada para este cliente';
  end if;

  return v_row;
end;
$$;

revoke all on function public.client_update_ai_prefs(text, text) from public;
grant execute on function public.client_update_ai_prefs(text, text) to authenticated;
