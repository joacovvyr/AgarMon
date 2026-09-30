const $ = selector => document.querySelector(selector);
const currency = cents => new Intl.NumberFormat('es-UY', { style: 'currency', currency: 'USD' }).format(cents / 100);
let state = null, filter = 'all', authMode = 'login', loading = false, refreshVersion = 0;
const messages = {
  insufficient_funds:'No tenés suficiente saldo de prueba.', email_exists:'Ese correo ya tiene una cuenta.',
  invalid_credentials:'Correo o contraseña incorrectos.', invalid_credentials_format:'Usá un correo válido y una contraseña de 12 a 128 caracteres.',
  invalid_name:'El nombre debe tener entre 2 y 40 caracteres.', authentication_required:'Ingresá para continuar.',
  demo_funding_limit:'Llegaste al límite de USD 500 de fondos de prueba por cuenta.',
  too_many_attempts:'Demasiados intentos. Esperá antes de volver a probar.', csrf_denied:'Tu sesión cambió. Recargá la página.',
  cannot_join:'Ya estás en esa sala o no admite entradas.', cannot_leave:'La reserva ya no está disponible para devolver.',
  invalid_cents:'Ingresá un monto válido en dólares.', idempotency_conflict:'La operación ya existe con otros datos.'
};
async function api(path, body) {
  const options = body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':state?.csrf ?? ''}, body:JSON.stringify(body) };
  const response = await fetch(path, { ...options, credentials:'same-origin' });
  const data = await response.json();
  if (!response.ok) throw Error(messages[data.error] ?? 'No se pudo completar la operación. Probá nuevamente.');
  return data;
}
let toastTimer;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function el(tag, text, classes) { const node=document.createElement(tag); if(text!==undefined)node.textContent=text; if(classes)node.className=classes; return node; }
function authOpen() { $('#auth-error').textContent=''; $('#auth-dialog').showModal(); }
async function perform(button, action) {
  if(loading)return; loading=true; button.disabled=true;
  try { await action(); await refresh(); } catch(error) { toast(error.message); }
  finally { loading=false; button.disabled=false; }
}
function render() {
  $('#account-name').textContent=state.user?.name ?? '';
  $('#account-button').replaceChildren(document.createTextNode(state.user ? 'Salir' : 'Ingresar'), el('span','↗'));
  $('#balance').textContent=currency(state.balanceCents);
  $('#reserved').textContent=currency(state.reservedCents);
  $('#pending-total').textContent=currency(state.withdrawals.reduce((n,p)=>n+p.amountCents,0));
  $('#wallet-hint').textContent=state.user ? 'Fondos ficticios para probar el flujo completo.' : 'Ingresá para probar entradas y movimientos.';
  const grid=$('#room-grid');grid.replaceChildren();
  for(const room of state.rooms.filter(r=>filter==='all'||r.mode===filter)) {
    const card=el('article',undefined,'room-card'+(room.joined?' joined':''));
    const top=el('div',undefined,'card-top');top.append(el('span',room.mode==='hard'?'HARD · SUPERVIVENCIA':'NORMAL · EXTRACCIÓN','mode-label'+(room.mode==='hard'?' hard':'')),el('span',room.mode==='hard'?'⌁':'◎','card-icon'));
    const price=el('div',undefined,'room-price');price.append(el('strong',String(room.entryCents/100)),el('span','USD de prueba'));
    const meta=el('div',undefined,'room-meta');meta.append(el('span','◷ '+Math.round(room.durationMs/60000)+' minutos'),el('span',room.players+' en la sala'));
    const button=el('button',undefined,'button '+(room.joined?'button-primary':'button-outline'));
    button.append(document.createTextNode(room.joined?'Devolver mi reserva':'Reservar entrada'),el('span',room.joined?'↩':'↗'));
    button.addEventListener('click',()=>{if(!state.user)return authOpen(); perform(button,async()=>{
      await api(`/api/rooms/${room.id}/${room.joined?'leave':'join'}`,{requestId:crypto.randomUUID()});
      toast(room.joined?'Entrada devuelta a tu billetera de prueba.':'Entrada reservada. Podés devolverla antes de empezar.');
    });});
    card.append(top,price,el('p',room.mode==='hard'?'Cobrás al sobrevivir hasta el final.':'Extraete entre el minuto 1 y el 2.'),meta,button);grid.append(card);
  }
  const pending=$('#pending-withdrawals');pending.replaceChildren();
  for(const payout of state.withdrawals) {
    const row=el('div',undefined,'pending-row');row.append(el('span',currency(payout.amountCents)+' reservados · Retiro simulado pendiente'));
    const controls=el('div',undefined,'pending-controls');
    for(const [outcome,label] of [['paid','Confirmar prueba'],['failed','Devolver saldo']]) {
      const button=el('button',label,'button button-outline');button.addEventListener('click',()=>perform(button,async()=>{
        await api(`/api/demo/withdrawals/${payout.id}/resolve`,{outcome});
        toast(outcome==='paid'?'Retiro marcado como pagado en la simulación. No se envió dinero.':'Saldo devuelto a la billetera de prueba.');
      }));controls.append(button);
    }row.append(controls);pending.append(row);
  }
  const reasons={deposit:'Fondos de prueba agregados',reserve_entry:'Entrada reservada',entry_refund:'Entrada devuelta',leave_lobby_refund:'Reserva devuelta',match_extraction:'Extracción de partida',survivor_settlement:'Liquidación de partida',reserve_withdrawal:'Retiro reservado',withdrawal_failed:'Retiro fallido · devolución'};
  const history=$('#history');history.replaceChildren();
  if(!state.history.length)history.append(el('p','Tu historial empieza con el primer movimiento.','empty'));
  for(const item of state.history) {
    const row=el('div',undefined,'history-row'),label=el('div',reasons[item.reason] ?? 'Movimiento de billetera');
    label.append(el('small','Movimiento #'+item.sequence));row.append(label,el('strong',(item.amountCents>0?'+ ':'− ')+currency(Math.abs(item.amountCents)),item.amountCents>0?'positive':'negative'));history.append(row);
  }
}
async function refresh() { const version=++refreshVersion,next=await api('/api/state');if(version===refreshVersion){state=next;render();} }
$('#account-button').addEventListener('click',event=>{if(!state?.user)return authOpen();perform(event.currentTarget,async()=>{await api('/api/logout',{});toast('Sesión cerrada.');});});
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>document.getElementById(button.dataset.close).close());
for(const button of document.querySelectorAll('[data-mode]'))button.addEventListener('click',()=>{
  filter=button.dataset.mode;for(const b of document.querySelectorAll('[data-mode]')){b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));}render();
});
for(const button of document.querySelectorAll('[data-auth]'))button.addEventListener('click',()=>{
  authMode=button.dataset.auth;for(const b of document.querySelectorAll('[data-auth]'))b.classList.toggle('selected',b===button);
  $('#name-label').hidden=authMode!=='register';$('#name-input').required=authMode==='register';
  $('#auth-title').textContent=authMode==='register'?'Tu primera partida empieza acá.':'Volvé a la partida.';
  $('#auth-submit').textContent=authMode==='register'?'Crear cuenta de prueba':'Ingresar';
  $('#password-input').autocomplete=authMode==='register'?'new-password':'current-password';$('#auth-error').textContent='';
});
$('#auth-form').addEventListener('submit',async event=>{
  event.preventDefault();const formElement=event.currentTarget,button=$('#auth-submit');button.disabled=true;$('#auth-error').textContent='';
  try {
    const form=new FormData(formElement),body={email:form.get('email'),password:form.get('password')};
    if(authMode==='register')body.name=form.get('name');
    await api('/api/'+authMode,body);formElement.reset();await refresh();$('#auth-dialog').close();toast('Tu billetera de prueba está lista.');
  }catch(error){$('#auth-error').textContent=error.message;}finally{button.disabled=false;}
});
$('#funds-button').addEventListener('click',event=>{if(!state?.user)return authOpen();perform(event.currentTarget,async()=>{
  await api('/api/demo/funds',{amountCents:10000,requestId:crypto.randomUUID()});toast('Agregaste USD 100 ficticios.');
});});
$('#withdraw-button').addEventListener('click',()=>{if(!state?.user)return authOpen();$('#withdraw-error').textContent='';$('#withdraw-dialog').showModal();});
$('#withdraw-form').addEventListener('submit',async event=>{
  event.preventDefault();const formElement=event.currentTarget,button=formElement.querySelector('[type=submit]');button.disabled=true;$('#withdraw-error').textContent='';
  try {
    const text=new FormData(formElement).get('amount').trim().replace(',','.');
    if(!/^\d{1,7}(?:\.\d{1,2})?$/.test(text))throw Error('Usá un monto con hasta dos decimales.');
    const [whole,fraction='']=text.split('.');const amountCents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
    if(amountCents<1)throw Error('El monto debe ser mayor que cero.');
    await api('/api/demo/withdrawals',{amountCents,requestId:crypto.randomUUID()});formElement.reset();await refresh();$('#withdraw-dialog').close();
    toast('Retiro reservado. Elegí confirmar la prueba o devolver el saldo.');
  }catch(error){$('#withdraw-error').textContent=error.message;}finally{button.disabled=false;}
});
refresh().catch(error=>toast(error.message));
setInterval(()=>{if(!loading&&!document.hidden)refresh().catch(()=>{});},5000);
