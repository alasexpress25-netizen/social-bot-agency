-- =========================================================
-- FASE 6.1: cierra 2 huecos que dejaba la Fase 6 en uso real (pedido
-- agencia 15/07/2026):
--
-- 1) La IA invitaba a "comentar la palabra clave" en el texto del post,
--    pero esa palabra clave nunca quedaba en un campo estructurado -- solo
--    vivia disuelta adentro del caption. Resultado: al aprobar el post, la
--    agencia igual tenia que ir a mano a "Reglas de auto-respuesta" a
--    crear la regla con esa misma palabra y su respuesta. Ahora
--    content_planner.py le pide a la IA la palabra clave (y su respuesta
--    automatica) como campos propios de cada idea, y al aprobar el item
--    desde el panel (frontend/index.html) se crea/actualiza sola la regla
--    en socialbot_auto_reply_rules -- cero pasos manuales.
--
-- 2) El plan semanal no generaba hashtags (a diferencia del
--    caption_override manual de un media, que si podia llevarlos escritos
--    a mano). Se agrega:
--      - socialbot_ai_settings.default_hashtags: hashtags de marca/base
--        que la agencia (o el cliente, via RPC) cargan una vez y quedan
--        como contexto fijo.
--      - socialbot_content_plan_items.hashtags: los hashtags puntuales de
--        cada idea (base + tema del dia), generados por la IA junto con
--        el caption, editables antes de aprobar. post_scheduler.py los
--        suma al caption al publicar el post ya aprobado.
--
-- Ya aplicada en producción (redaqqxoeciycqgjhpbv), 15/07/2026. Este
-- archivo es solo para que el repo quede fiel a lo que ya está corriendo.
-- =========================================================

-- ---------------------------------------------------------------------------
-- 1) Campos nuevos en socialbot_content_plan_items: la palabra clave y la
--    respuesta automatica que le corresponden a esa idea (estructurados,
--    no solo mencionados adentro del caption), mas los hashtags puntuales.
-- ---------------------------------------------------------------------------
alter table socialbot_content_plan_items
  add column if not exists keyword text;
alter table socialbot_content_plan_items
  add column if not exists reply_template text;
alter table socialbot_content_plan_items
  add column if not exists hashtags text;

comment on column socialbot_content_plan_items.keyword is
  'Palabra clave que el caption invita a comentar. La IA la propone junto con el texto; al aprobar el item, el panel de agencia crea/actualiza sola una fila en socialbot_auto_reply_rules con esta misma palabra.';
comment on column socialbot_content_plan_items.reply_template is
  'Respuesta automatica sugerida para esa palabra clave (mismo formato que socialbot_auto_reply_rules.reply_template, admite {{sales_link}}). Se copia a la regla al aprobar.';
comment on column socialbot_content_plan_items.hashtags is
  'Hashtags sugeridos para este post puntual (base de socialbot_ai_settings.default_hashtags + algo del tema del dia). Se suman al caption cuando post_scheduler.py publica el item aprobado.';

-- ---------------------------------------------------------------------------
-- 2) Hashtags de base del cliente (marca), para que la IA no los invente
--    de cero cada semana y para que la agencia/cliente los puedan fijar.
-- ---------------------------------------------------------------------------
alter table socialbot_ai_settings
  add column if not exists default_hashtags text;

comment on column socialbot_ai_settings.default_hashtags is
  'Hashtags de marca fijos (ej: #ImpactoTecno #SantaCatarina), editables por la agencia (frontend/index.html) o el cliente (RPC client_update_hashtags). content_planner.py los usa como base para los hashtags de cada idea de la semana.';

-- ---------------------------------------------------------------------------
-- 3) Evita reglas de auto-respuesta duplicadas para la misma palabra
--    clave del mismo cliente -- necesario para poder hacer upsert desde
--    el panel al aprobar un item del plan (si la palabra ya tiene regla,
--    se actualiza la respuesta en vez de crear una segunda).
--
--    Se normaliza primero lo que ya hubiera cargado a mano (trim +
--    minuscula) para no romper el índice si dos reglas viejas coinciden
--    salvo mayusculas/espacios -- se queda con la mas reciente de cada
--    grupo y borra el resto.
--
--    Nota: el indice es sobre la columna literal "keyword" (no
--    lower(keyword)) porque el upsert que hace el panel via PostgREST
--    necesita on_conflict sobre columnas reales, no una expresion. Tanto
--    content_planner.py (auto) como el panel (al aprobar) ya normalizan la
--    palabra a minuscula/trim antes de escribirla, asi que alcanza.
-- ---------------------------------------------------------------------------
update socialbot_auto_reply_rules set keyword = trim(lower(keyword));

delete from socialbot_auto_reply_rules a using socialbot_auto_reply_rules b
  where a.client_id = b.client_id and a.keyword = b.keyword and a.id < b.id;

create unique index if not exists idx_auto_reply_rules_client_keyword_unique
  on socialbot_auto_reply_rules (client_id, keyword);

-- ---------------------------------------------------------------------------
-- 4) RPC para que el cliente edite sus hashtags de base desde su portal,
--    mismo patron que client_update_ai_prefs (0006_client_portal.sql).
-- ---------------------------------------------------------------------------
create or replace function public.client_update_hashtags(p_hashtags text)
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
    set default_hashtags = p_hashtags
    where client_id = v_client_id
    returning * into v_row;

  if v_row.id is null then
    raise exception 'configuracion de ia no encontrada para este cliente';
  end if;

  return v_row;
end;
$$;

revoke all on function public.client_update_hashtags(text) from public;
grant execute on function public.client_update_hashtags(text) to authenticated;

-- No hace falta ninguna policy nueva para aprobar el plan + crear la regla
-- de auto-respuesta: "owner sees own content_plan_items" (0013) y "owner
-- sees own auto_reply_rules" (0001) ya le dan a la agencia control total
-- sobre ambas tablas de sus propios clientes -- el panel hace las 2
-- escrituras (aprobar item + upsert de regla) directo con supabase-js,
-- mismo patron que ya usa para aprobar/editar todo lo demas.
