// js/auth.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { sb } from "./state.js";
import { boot } from "./app.js";

async function login(event){
  if(event) event.preventDefault(); // ahora se llama desde <form onsubmit>, no un boton suelto
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if(error){ alert(error.message); return; }
  boot();
}
async function signup(){
  const email = prompt("Email:");
  const password = prompt("Contraseña (mínimo 6 caracteres):");
  if(!email || !password) return;
  const { data, error } = await sb.auth.signUp({ email, password });
  if(error){ alert(error.message); return; }
  alert("Cuenta creada. Si tu proyecto pide confirmación por email, revisá tu bandeja de entrada.");
}
async function logout(){
  await sb.auth.signOut();
  location.reload();
}

export { login, logout, signup };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.login = login;
window.logout = logout;
window.signup = signup;