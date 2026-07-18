-- Item "menores" de PROPUESTAS-AGENCIA.md: métrica de tiempo de respuesta
-- promedio. created_at ya marca cuándo llegó el comentario/DM
-- (claimInteraction lo reserva apenas llega, antes de generar la
-- respuesta); replied_at marca cuándo el bot terminó de contestarlo
-- (finishInteraction, meta-webhook/index.ts). La diferencia entre ambos,
-- promediada, es el "tiempo de respuesta" real que se le puede mostrar al
-- cliente como prueba de velocidad.

alter table socialbot_interactions_log
  add column if not exists replied_at timestamptz;

create index if not exists idx_interactions_log_client_replied
  on socialbot_interactions_log(client_id, replied_at);
