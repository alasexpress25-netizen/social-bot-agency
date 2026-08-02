// js/clients.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { CLIENT_PORTAL_URL, clientsCache, currentAgencyId, persistSelectedClientId, sb, setSelectedClientId } from "./state.js";
import { normalizeUrl } from "./utils.js";
import { loadClients } from "./app.js";

function openNewClientModal(){
  document.getElementById('newClientModal').classList.add('open');
}
// Item 1.5 de propuestas-30-07-2026.md (biblia-marketing-confianza.md):
// plantilla de guion de 30-45seg para que el comerciante que no sabe qué
// decir frente a la cámara tenga una estructura lista, solo llenando los
// espacios entre corchetes con su realidad (nombre, garantía, rubro).
function buildCameraScriptTemplate(clientName){
  return `Guion para ${clientName} — 30 a 45 segundos, hablando a cámara\n\n`
    + `1) GANCHO (5 seg) — Nombrá el problema o miedo típico de tu rubro:\n`
    + `"¿Cansado/a de [problema típico que le pasa a tu cliente]?"\n\n`
    + `2) QUIÉN SOS (5 seg) — Tu nombre, qué hacés, desde cuándo. Cara visible, todavía sin vender:\n`
    + `"Soy [tu nombre], hago [lo que hacés] desde hace [tiempo]."\n\n`
    + `3) LA PRUEBA (15-20 seg) — Mostrá el trabajo real pasando, no lo describas. Si tenés un antes/después, este es el momento:\n`
    + `[Acá se filma el trabajo en proceso o el antes/después real — no hace falta decir nada más, dejá que se vea.]\n\n`
    + `4) LA GARANTÍA EN CRIOLLO (5 seg) — Qué pasa si algo sale mal, dicho simple:\n`
    + `"Si [algo no sale como esperás], [lo que hacés vos para solucionarlo], sin vueltas."\n\n`
    + `5) EL PASO CHICO (5 seg) — No "comprá ahora": pedí algo de bajo riesgo, con el número a la vista en pantalla:\n`
    + `"Mandame una foto de [lo que necesitás resolver] y te digo en el momento si tiene solución. [tu WhatsApp/número]"\n\n`
    + `Tip: no hace falta actuar ni memorizar. Es una estructura para ordenar lo que ya sabés decir.`;
}
function openCameraScriptModal(clientId, clientName){
  document.getElementById('cameraScriptClientName').textContent = clientName;
  document.getElementById('cameraScriptText').value = buildCameraScriptTemplate(clientName);
  document.getElementById('cameraScriptModal').classList.add('open');
}
function closeCameraScriptModal(){
  document.getElementById('cameraScriptModal').classList.remove('open');
}
async function copyCameraScript(btn){
  const text = document.getElementById('cameraScriptText').value;
  try{
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = 'Copiado ✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }catch(e){
    prompt('Copiá el guion manualmente:', text);
  }
}
function closeNewClientModal(){
  document.getElementById('newClientModal').classList.remove('open');
  document.getElementById('newClientName').value = '';
  document.getElementById('newClientLink').value = '';
  document.getElementById('newClientPlatform').value = 'facebook';
  document.getElementById('newClientPageName').value = '';
  document.getElementById('newClientPageId').value = '';
  document.getElementById('newClientIgId').value = '';
  document.getElementById('newClientPageToken').value = '';
}
function openEditClientModal(clientId){
  if(!clientId || clientId === 'all'){ alert('Elegí primero un cliente puntual en el selector de arriba para poder editarlo.'); return; }
  const entry = clientsCache[clientId];
  if(!entry){ alert('No se encontró el cliente. Probá recargar la página.'); return; }
  const { client, accounts } = entry;
  const account = (accounts && accounts[0]) || null;

  document.getElementById('editClientId').value = client.id;
  document.getElementById('editClientName').value = client.name || '';
  document.getElementById('editClientLink').value = client.sales_link || '';
  document.getElementById('editClientLogoUrl').value = client.logo_url || '';
  const logoPreview = document.getElementById('editClientLogoPreview');
  logoPreview.src = client.logo_url ? normalizeUrl(client.logo_url) : '';
  logoPreview.style.display = client.logo_url ? 'block' : 'none';
  document.getElementById('editClientGooglePlaceId').value = client.google_place_id || '';
  document.getElementById('editClientWhatsapp').value = client.referral_whatsapp || '';
  document.getElementById('editClientPlatform').value = account ? account.platform : 'facebook';
  fillEditAccountFields(account);

  document.getElementById('editClientModal').classList.add('open');
}
// Cuando el usuario cambia la plataforma dentro del modal, buscamos si el
// cliente ya tiene una cuenta conectada con esa plataforma (en clientsCache)
// y la usamos para editar en vez de la que estaba antes. Así evitamos el
// error de "duplicate key" que pasaba al intentar convertir, por ejemplo,
// la cuenta de Facebook en una de Instagram cuando esa ya existía aparte.
function onEditClientPlatformChange(){
  const clientId = document.getElementById('editClientId').value;
  const entry = clientsCache[clientId];
  const platform = document.getElementById('editClientPlatform').value;
  const accounts = (entry && entry.accounts) || [];
  const match = accounts.find(a => a.platform === platform) || null;
  fillEditAccountFields(match);
}
function fillEditAccountFields(account){
  document.getElementById('editClientAccountId').value = account ? account.id : '';
  document.getElementById('editClientPageName').value = account ? (account.page_name || '') : '';
  document.getElementById('editClientPageId').value = account ? (account.page_id || '') : '';
  document.getElementById('editClientIgId').value = account ? (account.ig_business_id || '') : '';
  document.getElementById('editClientPageToken').value = account ? (account.page_access_token || '') : '';
}
function closeEditClientModal(){
  document.getElementById('editClientModal').classList.remove('open');
}
document.getElementById('editClientLogoUrl').addEventListener('input', (e) => {
  const preview = document.getElementById('editClientLogoPreview');
  preview.src = e.target.value ? normalizeUrl(e.target.value) : '';
  if(!e.target.value) preview.style.display = 'none';
});
async function saveClientEdit(e){
  e.preventDefault();
  const clientId = document.getElementById('editClientId').value;
  const accountId = document.getElementById('editClientAccountId').value;
  const name = document.getElementById('editClientName').value;
  const sales_link = document.getElementById('editClientLink').value;
  const logo_url = normalizeUrl(document.getElementById('editClientLogoUrl').value);
  const google_place_id = document.getElementById('editClientGooglePlaceId').value || null;
  const referral_whatsapp = document.getElementById('editClientWhatsapp').value || null;

  const { error } = await sb.from('socialbot_clients').update({ name, sales_link, logo_url, google_place_id, referral_whatsapp }).eq('id', clientId);
  if(error){ alert(error.message); return; }

  // Igual que en createClient: page_id y page_access_token son NOT NULL en
  // la base, así que sólo tocamos la cuenta si ambos están cargados.
  const pageId = document.getElementById('editClientPageId').value;
  const pageToken = document.getElementById('editClientPageToken').value;
  if(pageId && pageToken){
    const accountPatch = {
      platform: document.getElementById('editClientPlatform').value,
      page_id: pageId,
      ig_business_id: document.getElementById('editClientIgId').value || null,
      page_name: document.getElementById('editClientPageName').value,
      page_access_token: pageToken,
    };
    const { error: accError } = accountId
      ? await sb.from('socialbot_social_accounts').update(accountPatch).eq('id', accountId)
      : await sb.from('socialbot_social_accounts').insert({ ...accountPatch, client_id: clientId });
    if(accError){ alert(`El cliente se guardó, pero la cuenta de FB/IG no se pudo guardar: ${accError.message}`); }
  }

  closeEditClientModal();
  loadClients();
}
function onClientSelectorChange(){
  setSelectedClientId(document.getElementById('clientSelector').value);
  persistSelectedClientId();
  loadClients();
}
async function createClient(e){
  e.preventDefault();
  const name = document.getElementById('newClientName').value;
  const sales_link = document.getElementById('newClientLink').value;
  const { data: created, error } = await sb.from('socialbot_clients').insert({ agency_id: currentAgencyId, name, sales_link }).select();
  if(error){ alert(error.message); return; }

  // La cuenta de FB/IG es opcional en este modal: page_id y page_access_token
  // son NOT NULL en la base, así que solo la creamos si se cargaron los dos.
  // Si se dejaron vacíos, el cliente queda creado igual y la cuenta se puede
  // agregar más tarde desde su tarjeta ("Conectar cuenta nueva").
  const pageId = document.getElementById('newClientPageId').value;
  const pageToken = document.getElementById('newClientPageToken').value;
  if(created && created[0] && pageId && pageToken){
    const { error: accError } = await sb.from('socialbot_social_accounts').insert({
      client_id: created[0].id,
      platform: document.getElementById('newClientPlatform').value,
      page_id: pageId,
      ig_business_id: document.getElementById('newClientIgId').value || null,
      page_name: document.getElementById('newClientPageName').value,
      page_access_token: pageToken,
    });
    if(accError){ alert(`El cliente se creó, pero la cuenta de FB/IG no se pudo guardar: ${accError.message}`); }
  }

  closeNewClientModal();
  // Seleccionamos automáticamente el cliente recién creado
  if(created && created[0]) setSelectedClientId(created[0].id);
  persistSelectedClientId();
  loadClients();
}
async function toggleActive(clientId, current, clientName){
  const name = clientName || 'este cliente';
  const msg = current
    ? `¿Pausar a ${name}?\n\nMientras esté pausado:\n• No se van a generar ni publicar posts nuevos (ni los ya aprobados en espera).\n• La IA va a dejar de contestar comentarios y mensajes directos en Facebook/Instagram.\n• No se va a gastar cuota de IA ni recursos para este cliente.\n\nSe reactiva todo apretando "Reactivar" en cualquier momento.`
    : `¿Reactivar a ${name}?\n\nVuelve a publicar posts según su horario y la IA vuelve a contestar comentarios y mensajes automáticamente.`;

  if(!confirm(msg)) return;

  await sb.from('socialbot_clients').update({ active: !current }).eq('id', clientId);
  loadClients();
}
// ---------------------------------------------------------------------------
// Eliminar cliente — requiere reingresar la contraseña del usuario logueado
// (no solo un confirm()). Se valida re-autenticando contra Supabase Auth con
// signInWithPassword usando el email de la sesión actual: si la contraseña
// es incorrecta, Supabase devuelve error y no se borra nada. No hace falta
// guardar la contraseña en ningún lado del código ni conocerla de antemano.
// ---------------------------------------------------------------------------
function openDeleteClientModal(clientId, clientName){
  document.getElementById('deleteClientId').value = clientId;
  document.getElementById('deleteClientName').textContent = clientName;
  document.getElementById('deleteClientUsername').value = document.getElementById('userTag').innerText || '';
  document.getElementById('deleteClientPassword').value = '';
  document.getElementById('deleteClientError').style.display = 'none';
  document.getElementById('deleteClientModal').classList.add('open');
}
function closeDeleteClientModal(){
  document.getElementById('deleteClientModal').classList.remove('open');
}
async function confirmDeleteClient(e){
  e.preventDefault();
  const clientId = document.getElementById('deleteClientId').value;
  const password = document.getElementById('deleteClientPassword').value;
  const errBox = document.getElementById('deleteClientError');
  errBox.style.display = 'none';

  const btn = e.target.querySelector('button[type="submit"]');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Verificando...';

  try {
    const { data: { user } } = await sb.auth.getUser();
    if(!user || !user.email){
      throw new Error('No se pudo identificar tu sesión. Volvé a iniciar sesión.');
    }

    // Re-autentica al usuario actual con la contraseña ingresada. Esto NO
    // crea una sesión nueva de otro usuario: es el mismo usuario logueado
    // confirmando que conoce su propia contraseña antes de un borrado
    // irreversible.
    const { error: authError } = await sb.auth.signInWithPassword({
      email: user.email,
      password,
    });
    if(authError){
      throw new Error('Contraseña incorrecta.');
    }

    const { error: deleteError } = await sb.from('socialbot_clients').delete().eq('id', clientId);
    if(deleteError) throw deleteError;

    closeDeleteClientModal();
    loadClients();
  } catch(err){
    errBox.textContent = err.message || 'No se pudo eliminar el cliente.';
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
async function saveClientPortalAccess(e, clientId){
  e.preventDefault();
  const f = new FormData(e.target);
  const clientEmail = f.get('client_email');
  
  // Guardar email y require_approval en la BD
  const { data: client, error } = await sb.from('socialbot_clients').update({
    client_email: clientEmail || null,
    require_approval: f.get('require_approval') === 'on',
  }).eq('id', clientId).select().single();
  
  if(error){
    alert('Error al guardar: ' + error.message);
    return;
  }

  // Si hay email, enviar magic link automático (mismo método que usa
  // cliente.html para el login del cliente: sb.auth.signInWithOtp).
  // Ya no depende de la Edge Function send-client-magic-link.
  if(clientEmail && clientEmail.trim()){
    const { error: otpError } = await sb.auth.signInWithOtp({
      email: clientEmail.trim(),
      options: { emailRedirectTo: CLIENT_PORTAL_URL }
    });
    if(otpError){
      alert(`Acceso guardado, pero no se pudo enviar el link: ${otpError.message}`);
    } else {
      alert(`Acceso guardado. Magic link enviado a ${clientEmail}`);
    }
  } else {
    alert('Acceso guardado (sin email de cliente).');
  }
  
  loadClients();
}
// Edita una cuenta ya conectada (UPDATE por id). Crear cuentas nuevas se
// hace únicamente desde el modal "Nuevo cliente" (createClient), para que
// cada sección tenga un solo trabajo: esta solo edita lo que ya existe.
async function saveAccount(e, accountId){
  e.preventDefault();
  const f = new FormData(e.target);
  const patch = {
    platform: f.get('platform'),
    page_id: f.get('page_id'),
    ig_business_id: f.get('ig_business_id') || null,
    page_name: f.get('page_name'),
    page_access_token: f.get('page_access_token'),
  };

  const { error } = await sb.from('socialbot_social_accounts').update(patch).eq('id', accountId);
  if (error){ alert(error.message); return; }
  alert('Cuenta actualizada.');
  loadClients();
}

export { buildCameraScriptTemplate, closeCameraScriptModal, closeDeleteClientModal, closeEditClientModal, closeNewClientModal, confirmDeleteClient, copyCameraScript, createClient, fillEditAccountFields, onClientSelectorChange, onEditClientPlatformChange, openCameraScriptModal, openDeleteClientModal, openEditClientModal, openNewClientModal, saveAccount, saveClientEdit, saveClientPortalAccess, toggleActive };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.closeCameraScriptModal = closeCameraScriptModal;
window.closeDeleteClientModal = closeDeleteClientModal;
window.closeEditClientModal = closeEditClientModal;
window.closeNewClientModal = closeNewClientModal;
window.confirmDeleteClient = confirmDeleteClient;
window.copyCameraScript = copyCameraScript;
window.createClient = createClient;
window.onClientSelectorChange = onClientSelectorChange;
window.onEditClientPlatformChange = onEditClientPlatformChange;
window.openCameraScriptModal = openCameraScriptModal;
window.openDeleteClientModal = openDeleteClientModal;
window.openEditClientModal = openEditClientModal;
window.openNewClientModal = openNewClientModal;
window.saveClientEdit = saveClientEdit;
window.saveClientPortalAccess = saveClientPortalAccess;
window.toggleActive = toggleActive;
