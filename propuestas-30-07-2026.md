# Propuestas de mejora — conversación 30/07/2026

## Filosofía de la agencia (para dejar registrada)

- No se paga la API de WhatsApp Business de Meta ni se hace pauta paga masiva.
  El bot ya funciona con IA propia, sin depender de esas herramientas de pago.
- El objetivo del contenido orgánico no es vender adentro de Instagram/Facebook
  (hoy son plataformas de entretenimiento, no de "vidriera de compra"), sino
  atraer al usuario hacia el sitio web o el teléfono del cliente, que es donde
  ocurre la conversión real.
- El cliente final se comunica directo con el cliente de la agencia — la
  agencia no es intermediaria en la venta, su trabajo es crear, mantener y
  ganar clientes/ventas a través del contenido.
- Se prioriza contenido de calidad por sobre gasto en pauta. La pauta, si se
  usa alguna vez, sería puntual y sobre contenido que ya probó funcionar
  orgánicamente — no gasto a ciegas.

## Opinión (resumen de lo charlado)

- El diagnóstico de que Instagram/Facebook se volvieron plataformas de
  entretenimiento es correcto, y justifica no depender de vender adentro de
  la red.
- El matiz: el alcance orgánico de páginas de negocio viene cayendo hace
  años, contenido bueno resuelve *calidad* pero no necesariamente
  *distribución*. Conviene mirar el dato de `reach` que ya se guarda para
  Instagram y validar con eso, no a ciegas.
- Como el objetivo real es "que hagan clic al sitio o llamen", y hoy el
  sistema solo mide likes/comments/shares (señales de entretenimiento, no de
  intención de compra), el punto de mayor impacto es empezar a medir eso.

---

## Propuestas técnicas — en orden sugerido de prioridad

### 1. Medir clics reales al sitio web / llamadas al teléfono ✅ IMPLEMENTADO (30/07/2026)
Hoy no existe ninguna métrica de "esto generó un clic o una llamada", solo
likes/comments/shares. Es la métrica que más importa dado el objetivo real.
- UTM en los links que se comparten (bio, stories, caption) para poder ver en
  Google Analytics / Search Console cuánto tráfico viene de cada cliente y
  cada post.
- Si el sitio tiene botón de "llamar" o "WhatsApp personal del cliente",
  trackear el clic (evento simple de analytics, sin costo).
- Con esto se puede validar la filosofía con datos propios, en vez de
  suponerla.

**Cómo quedó:**
- Tabla `socialbot_link_clicks` (client_id, source, external_post_id,
  matched_keyword, user_agent, clicked_at) + Edge Function `track-click` que
  registra el clic y redirige (302) al link real del cliente.
- `meta-webhook` actualizado para mandar el link con tracking en los 4
  lugares donde el bot lo usa (comment/dm por keyword, comment/dm por IA
  Groq — este último era el canal con más volumen y no estaba medido).
- Panel visual en `agencia/index.html` y `cliente/cliente.html`: tarjeta con
  clics por canal (💬 Comentarios / ✉️ Mensajes directos / 🤖 Respuesta IA /
  🔤 Palabra clave), dentro de la misma ventana semanal/mensual que ya usan
  las otras métricas. Ya no hace falta entrar a Supabase directo para verlo.

### 1.5. Reformular la IA de texto según `biblia-marketing-confianza.md` ✅ IMPLEMENTADO (30/07/2026)
Tanto la generación de texto de `crear.zip` (ai.js) como los prompts de
`content_planner.py` y `generate_caption()` (post_scheduler.py) deben
actualizarse para que la IA escriba siguiendo los 5 principios y los 6
pilares de contenido del documento nuevo `biblia-marketing-confianza.md`
(específico > genérico, mostrar proceso real, nombrar el miedo del mercado,
reversión de riesgo, aporte comunitario, etc.), en vez de textos de venta
genéricos. Esto afecta directamente el `system_prompt`/`knowledge_base` de
cada cliente en `socialbot_ai_settings`, y probablemente conviene rotar
entre los 6 pilares como parte de la lógica del plan semanal (que no caiga
siempre en el mismo tipo de post).

**Cómo quedó:**
- `content_planner.py`: `system_prompt` reescrito con el diagnóstico de
  desconfianza + los 5 principios; los 6 pilares metidos en el prompt con
  instrucción de rotar (no repetir pilar en la misma tanda semanal); el
  campo `angle` del JSON ahora identifica qué pilar se usó, para poder
  auditar la rotación después. Se suma también una consulta nueva a
  `socialbot_reviews` (rating ≥4) para darle a la IA material real de
  testimonios (pilar 3) — antes ese pilar no tenía datos para trabajar.
- `post_scheduler.py` (`generate_caption()`, fallback diario): los 5
  principios sumados como bloque aparte del `user_prompt`, sin tocar el
  `system_prompt` propio de cada cliente (ese es configurable desde el
  panel y no correspondía pisarlo).
- `crear/js/ai.js` (generador de carruseles): mismo criterio adaptado al
  formato de slides.
- Guion de cámara (30-45seg) de la biblia: agregado como plantilla
  copiable en `agencia/index.html`, botón "🎬 Guion para cámara" en cada
  tarjeta de cliente (modal con los 5 pasos, editable, con copiar).

### 2. Cerrar el hueco de `generate_caption()` sin historial ✅ IMPLEMENTADO (30/07/2026)
La función de respaldo en `post_scheduler.py` (se usa cuando no hay un item
del plan semanal aprobado para ese día) genera texto sin ver captions
anteriores ni métricas de qué funcionó — a diferencia de `content_planner.py`,
que sí lo hace. Extenderla para que reciba el mismo contexto (últimos
captions + top/bottom posts por métricas) que ya arma `build_context()`.
Sin migración nueva, reutiliza tablas existentes.

### 3. Validar reach real antes de asumir "el contenido alcanza solo" ✅ REVISADO (30/07/2026)
Mirar el `reach` ya guardado en `socialbot_post_metrics` (Instagram) por
cliente a lo largo del tiempo. Si el reach orgánico es bajo pese a buen
contenido, considerar una prueba chica y puntual de pauta sobre un post que
ya probó funcionar — coherente con la filosofía de no gastar a ciegas.

**Lo que se encontró (consulta directa a `socialbot_post_metrics`):**
- El `reach` guardado es muy bajo en los 3 clientes: 20 (La Visual Marketing),
  39 (Impacto 3D), 63 (Alas Tecno) de promedio por post, con likes casi
  nulos (0.1-0.6 promedio). Pero las cuentas recién empezaron a publicar a
  mediados de julio, así que hay solo 2-4 semanas de datos — muy poco para
  hablar de una tendencia real. No se puede separar todavía "contenido que
  no engancha" de "cuenta nueva sin audiencia".
- **Bug encontrado y corregido:** el `reach` nunca se estaba guardando para
  Facebook (0 de 59 posts de FB entre los 3 clientes tenían el dato,
  mientras que Instagram sí lo traía siempre). La causa: Meta deprecó
  `post_impressions`/`post_impressions_unique` el 15/06/2026, y
  `_fetch_facebook_post_insights()` en `post_scheduler.py` seguía pidiendo
  esas dos métricas viejas — la API devolvía error de "invalid metric", el
  `except` lo tragaba en silencio, y quedaba en `null` sin ningún aviso.
  Corregido: ahora pide `post_total_media_view_unique` (el reemplazo oficial
  de Meta para alcance único de post). No hay reemplazo directo para
  "impressions" totales, esa columna queda sin dato por ahora.

**Conclusión:** todavía es prematuro decidir si conviene una prueba de
pauta puntual. Con el bug de Facebook corregido y unas semanas más de
datos acumulados (ideal: 6-8 semanas), se puede volver a este punto con
una muestra que realmente sirva para decidir.

### 4. Banco de "ganchos ganadores" categorizados ✅ IMPLEMENTADO (30/07/2026)
En vez de solo mirar el texto crudo de los últimos posts, categorizar qué
*tipo* de gancho tuvo cada post top (pregunta, oferta, testimonio, urgencia,
dato curioso) y priorizar ese patrón en los próximos, no solo evitar repetir
frases.

**Cómo quedó:** `content_planner.py` clasifica cada post publicado de los
últimos 30 días por tipo de gancho (heurística local por palabras clave,
sin costo extra de IA), arma un ranking por enganche promedio con al menos
2 posts por categoría, y se lo pasa al prompt para que priorice el TIPO de
gancho ganador de cada cliente en al menos una idea de la semana — no solo
el texto puntual, el patrón que probadamente funciona con esa audiencia.

### 5. Mejor horario sugerido por engagement real ✅ IMPLEMENTADO (30/07/2026)
Cruzar `published_at` con métricas para que `content_planner.py` sugiera
horario y día de la semana, en vez de usar siempre los slots fijos de
`socialbot_schedule_slots`. (Ya estaba anotado como pendiente en el roadmap
propio, punto 13 de `PROPUESTAS-AGENCIA.md`.)

**Cómo quedó:** el cálculo (`best_times_from_scored()`) ya existía y
alimentaba el prompt de la IA, pero no era visible en ningún lado del
panel. Se agregó:
- Tabla nueva `socialbot_suggested_schedule` (client_id, day_of_week, hour,
  avg_score, sample_size) — se borra y reinserta en cada corrida de
  `content_planner.py`, sin historial, solo el ranking vigente.
- `agencia/index.html`, pestaña "Horarios": tarjeta dorada arriba de la
  lista de horarios activos con la sugerencia por cliente y botón "Usar
  este horario" que la agrega directo como horario activo (sin tocar los
  existentes, la agencia decide si la usa o no).
- No cambia el comportamiento real de publicación (sigue usando los slots
  activos de siempre) — es solo la parte visual que faltaba del dato que
  ya se calculaba.

### 6. Reciclado de contenido ganador ✅ IMPLEMENTADO (30/07/2026)
Un post que funcionó muy bien hace 3-4 meses, reformulado con ángulo nuevo,
suele volver a funcionar. Hoy nada hace esto automáticamente.

**Cómo quedó:** `content_planner.py` agrega `get_recycle_candidate()`, que
busca el post con mejor score de enganche publicado entre 90 y 200 días
atrás y lo pasa al prompt semanal como candidato a reciclar (una idea de
la semana lo reformula con ángulo nuevo, marcada con `"angle": "reciclado"`
para poder auditarla después, igual que el banco de ganchos del punto 4).
Tabla nueva `socialbot_recycle_suggestions` para no repetir la misma
sugerencia antes de 45 días — si el mejor candidato ya se sugirió hace
poco, se prueba con el siguiente en el ranking; si no hay ninguno
disponible (cuenta muy nueva, o ya se recicló todo lo que había), esa
parte del prompt simplemente se omite esa semana.

### 7. Escalamiento de comentarios negativos/quejas ✅ IMPLEMENTADO (30/07/2026)
Ya identificado en el roadmap propio (punto 10) y sin implementar todavía:
detectar sentimiento negativo en el mismo llamado de IA que ya se hace, y en
vez de autoresponder genérico, guardar en cola de "requiere atención humana"
+ notificación a la agencia.

**Cómo quedó:** al revisar, esto ya estaba implementado para comentarios
desde el punto 10 de `PROPUESTAS-AGENCIA.md` (18/07/2026) — `meta-webhook`
detecta `sentiment: "negativo"`, guarda en `socialbot_flagged_comments` en
vez de autoresponder, y el trigger `trg_notify_agency_flagged_comment`
dispara `notify-flagged-comment` que avisa por mail a la agencia. El hueco
real encontrado: `handleDm` (mensajes directos) nunca hacía este chequeo —
una queja por DM se autorespondía igual que cualquier otra cosa. Corregido:
`handleDm` ahora escala quejas exactamente igual que `handleComment`, sin
tocar la tabla, el trigger ni el mail (ya cubren cualquier plataforma).

### 8. Motor de referidos (Fase 7.6 del roadmap propio)
Cuando un lead pasa a `convertido`, disparar un mensaje sugerido (no
automático, requiere aprobación) invitando a dejar reseña o referir un
contacto — es el momento de mayor satisfacción del cliente final.

### 9. Automatizar `success_story_generator.py`
Hoy es manual. Correrlo mensual (cron) para siempre tener 1-2 casos de éxito
frescos listos para prospectos nuevos de la agencia.

### 10. wa.me como CTA adicional gratuito (opcional, sin costo de API)
No es la API de WhatsApp Business de Meta (que se descartó por costo/filosofía)
— es un link `wa.me/<numero>` gratuito de click-to-chat. Podría sumarse como
opción de contacto adicional en el sitio del cliente sin ningún costo ni
dependencia de Meta, si tiene sentido para algún cliente puntual.

---

## Huecos visuales encontrados (conversación 30/07/2026, sesión 2)

Al revisar todo el esquema real de Supabase contra lo que hoy se ve en
`frontend/agencia/index.html` y `frontend/cliente/cliente.html`, aparecieron
varias cosas que el backend ya calcula o guarda pero que no tienen ninguna
pantalla — quedan "enterradas" y solo se pueden ver entrando a Supabase
directo. Se marca para cada una si conviene en **Agencia**, en **Cliente**,
o en ambos — el cliente final no es alguien técnico, así que lo suyo tiene
que quedar simple y sin jerga de marketing/analítica.

### 11. Alcance real (`reach`) vs Me gusta ✅ IMPLEMENTADO (30/07/2026)
`socialbot_post_metrics.reach` existe (y se acaba de corregir el bug de
Facebook que lo dejaba en null) pero no aparece en ningún lado del panel —
hoy solo se muestra "Me gusta". Es el dato clave para validar con datos
propios la filosofía de la biblia de marketing.
- **Agencia:** sí — gráfico de tendencia reach vs likes en la pestaña
  Métricas, por cliente. Acá sirve mostrarlo con el nombre técnico
  ("alcance") y comparado contra likes.
- **Cliente:** sí, pero simplificado — un solo KPI tipo "Personas que vieron
  tus publicaciones" (el numero de reach nomás, sin el término "alcance" ni
  la comparación con likes) es fácil de entender y motivador para un
  cliente no técnico. Sin gráfico de tendencia, solo el total del período.

**Cómo quedó:**
- `agencia/index.html` (pestaña Métricas): KPI nuevo "👁️ Alcance real" al
  lado de Me gusta, más un gráfico de tendencia "Alcance real (reach)"
  debajo del de Me gusta, mismos helpers (`fillBuckets`/`renderBarChart`)
  que ya existían. Si algún post todavía no tiene el dato (Meta puede
  tardar unos días), se muestra "—" o una nota aclaratoria en vez de un
  0 engañoso.
- `cliente/cliente.html` (pestaña Métricas): un solo KPI "👀 Te vieron"
  (es) / "👀 Te viram" (pt), sin gráfico ni la palabra técnica "alcance",
  con la misma nota aclaratoria si falta el dato en algún post reciente.

### 12. Cola de quejas escaladas (`socialbot_flagged_comments`) ✅ IMPLEMENTADO (30/07/2026)
El punto 7 (escalamiento de negativos) funciona 100% en el backend —
trigger, guardado, mail — pero la tabla no tiene ninguna pantalla. Hoy la
única forma de verla es entrando a Supabase directo o esperando el mail; si
se archiva el mail sin querer, la queja queda invisible.
- **Agencia:** sí — pestaña "Quejas" con lista (texto, plataforma, fecha) +
  botón "marcar resuelto" (la tabla ya tiene `status: pendiente/resuelto`,
  solo falta la vista).
- **Cliente:** no. Requiere criterio de la agencia para decidir cómo
  responder — mostrárselo al cliente sin acompañamiento podría preocuparlo
  de más por un comentario puntual que ya se está manejando.

**Cómo quedó:** pestaña nueva "Quejas" en `agencia/index.html`, con badge
de pendientes en el sidebar (mismo patrón que Referidos/Plan), lista por
cliente (plataforma, fecha, motivo, texto) y botón "Marcar resuelto" que
solo actualiza `status`/`resolved_at` — no dispara ningún mensaje ni
trigger, es puramente el registro de que la agencia ya lo atendió por
fuera del bot.

### 13. Uso de IA / cuota diaria por cliente
`socialbot_ai_usage_log` + `socialbot_ai_settings.daily_ai_reply_limit` no
tienen ninguna pantalla. Si un cliente pasa su límite diario, el bot cae a
plantilla fija sin avisar a nadie.
- **Agencia:** sí — barra simple "18/30 respuestas IA hoy" por cliente,
  para anticipar cuándo hace falta subir la cuota de alguno.
- **Cliente:** no. Es un detalle operativo/técnico de cómo funciona el bot
  por dentro, no aporta nada a un cliente no técnico y puede generar
  preguntas innecesarias ("¿qué es una cuota de IA?").

### 14. Reseñas (Google/Facebook) en el portal del cliente
`reviews_monitor.py` ya junta las reseñas (`socialbot_reviews`) y se
muestran en el panel de agencia, pero el cliente no las ve en su propio
portal.
- **Agencia:** ya implementado (pestaña Reseñas).
- **Cliente:** sí — es simple, motivador, y refuerza el pilar 3 de la
  biblia de marketing (testimonio real) sin trabajo nuevo de backend. Alcanza
  con mostrar estrellas/recomendación + texto, sin botones de gestión (esos
  quedan solo del lado agencia).

### 15. Ranking histórico de "gancho ganador" (banco de ganchos, punto 4)
Hoy `angle` se muestra por post individual en el plan semanal, pero no hay
ninguna vista agregada tipo "para este cliente, pregunta > oferta > urgencia
en engagement". La lógica de ranking ya existe en `content_planner.py`,
solo falta que quede visible en algún lado más allá del prompt de la IA.
- **Agencia:** sí — tabla o mini-ranking en la pestaña Plan/Métricas.
- **Cliente:** no (o como mucho, muy simplificado a futuro). Es un
  concepto de estrategia de contenido con vocabulario de marketing
  ("gancho", "engagement") que no le aporta nada de forma directa a un
  cliente no técnico — es una herramienta de trabajo de la agencia, no
  algo que el cliente necesite decidir o entender.

---

## Estado

- ✅ Punto 1 (medir clics/llamadas) — implementado, con panel visual en
  agencia y cliente.
- ✅ Punto 2 (`generate_caption()` sin historial) — implementado.
- ✅ Punto 1.5 (reformular la IA según la biblia de marketing) — implementado.
- ✅ Punto 3 (validar reach real) — revisado; bug de reach de Facebook
  corregido; conclusión sobre pauta pendiente de más semanas de datos.
- ✅ Punto 4 (banco de ganchos ganadores) — implementado.
- ✅ Punto 5 (horario sugerido por engagement) — implementado, con parte
  visual en el panel de agencia.
- ✅ Punto 6 (reciclado de contenido ganador) — implementado.
- ✅ Punto 7 (escalamiento de quejas) — ya estaba implementado para
  comentarios; se cerró el hueco que faltaba en DMs.
- ✅ Punto 8 (motor de referidos) — implementado: migración, triggers,
  Edge Functions y pestaña "Referidos" en el panel de agencia con
  aprobar/descartar/reintentar.
- ✅ Punto 9 (automatizar `success_story_generator.py`) — implementado:
  modo `--all` mensual vía GitHub Actions, sube a Storage privado, registra
  en `socialbot_success_stories`, manda mail consolidado, y el panel de
  agencia (pestaña Referidos) muestra un botón para ver/descargar la
  última versión con signed URL.
- Pendiente: 10 (wa.me, opcional).
- ✅ Punto 11 (alcance real vs me gusta) — implementado, agencia con
  gráfico completo y cliente con KPI simple sin vocabulario técnico.
- ✅ Punto 12 (cola de quejas escaladas) — implementado, pestaña nueva
  "Quejas" en el panel de agencia con badge y botón de resolución.
- Pendientes (huecos visuales, sesión 2): 13 a 15 — ver detalle arriba.

