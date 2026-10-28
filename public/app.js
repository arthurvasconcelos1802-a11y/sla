// Código compartilhado entre as páginas
const $ = (s, r = document) => r.querySelector(s);
const State = { site: { title: '', tagline: '', banner: null }, games: [], isAdmin: false, platforms: ['windows'] };

// cria elementos sem innerHTML (evita XSS)
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (!Array.isArray(children)) children = [children];
  for (const c of children) n.append(c);
  return n;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro inesperado');
  return data;
}

// upload com barra de progresso (o corpo é o próprio arquivo)
function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch {}
      x.status < 300 ? resolve(d) : reject(new Error(d.error || 'Falha no upload'));
    };
    x.onerror = () => reject(new Error('Falha de rede no upload'));
    x.send(file);
  });
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const i = el('input', { type: 'file' });
    if (accept) i.accept = accept;
    i.onchange = () => resolve(i.files[0] || null);
    i.addEventListener('cancel', () => resolve(null));
    i.click();
  });
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b >= 100 ? 0 : 1) + ' ' + u[i];
}

function applyBanner(node, banner) {
  node.style.backgroundImage = banner ? `url(/uploads/${encodeURIComponent(banner)})` : '';
}

// ---------- modal genérico ----------
// fields: [{name,label,type:'text'|'textarea'|'password',value}]
function modal({ title, fields = [], body = [], onSave, saveLabel = 'Salvar', noSave = false }) {
  const overlay = el('div', { class: 'overlay' });
  const box = el('div', { class: 'modal', role: 'dialog' });
  box.append(el('h3', {}, title));
  const inputs = {};
  for (const f of fields) {
    const input = f.type === 'textarea' ? el('textarea') : el('input', { type: f.type || 'text' });
    input.value = f.value || '';
    inputs[f.name] = input;
    box.append(el('label', {}, f.label), input);
  }
  const err = el('div', { class: 'err' });
  const cancel = el('button', { class: 'btn' }, noSave ? 'Fechar' : 'Cancelar');
  const save = el('button', { class: 'btn primary' }, saveLabel);
  const actions = el('div', { class: 'actions' }, noSave ? [cancel] : [cancel, save]);
  box.append(err, actions);
  overlay.append(box);
  document.body.append(overlay);

  const close = () => overlay.remove();
  cancel.onclick = close;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  const submit = async () => {
    save.disabled = true; err.textContent = '';
    try {
      const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
      await onSave(values);
      close();
    } catch (e) { err.textContent = e.message; save.disabled = false; }
  };
  save.onclick = submit;
  const first = Object.values(inputs)[0];
  if (first) {
    first.focus();
    if (first.tagName === 'INPUT') first.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  }
  return { close, box, actions };
}

// ---------- ações de admin ----------
function editSite(rerender) {
  modal({
    title: 'Editar título do site',
    fields: [
      { name: 'title', label: 'Título (linha 1)', value: State.site.title },
      { name: 'tagline', label: 'Frase (linha 2, em destaque)', value: State.site.tagline },
    ],
    onSave: async (v) => { await api('PUT', '/api/site', v); await load(); rerender(); },
  });
}
function editGame(g, rerender) {
  modal({
    title: 'Editar jogo',
    fields: [
      { name: 'name', label: 'Nome do jogo', value: g.name },
      { name: 'description', label: 'Descrição', type: 'textarea', value: g.description },
    ],
    onSave: async (v) => { await api('PUT', '/api/games/' + encodeURIComponent(g.id), v); await load(); rerender(); },
  });
}
const MAX_DIRECT = 4 * 1024 * 1024; // limite de upload direto no Netlify
function tooBig(f) {
  if (f.size > MAX_DIRECT) {
    alert(`"${f.name}" tem ${fmtSize(f.size)}. O upload direto aceita até 4 MB.\n` +
      'Para arquivos grandes, hospede em outro lugar (ex: GitHub Releases, Google Drive, Mega) e use "Colar link de download".');
    return true;
  }
  return false;
}
async function changeBanner(rerender) {
  const f = await pickFile('image/*');
  if (!f || tooBig(f)) return;
  try { await upload('/api/upload/banner', f); await load(); rerender(); } catch (e) { alert(e.message); }
}

function openLogin(rerender) {
  modal({
    title: 'Entrar como admin',
    fields: [{ name: 'password', label: 'Senha', type: 'password' }],
    saveLabel: 'Entrar',
    onSave: async (v) => { await api('POST', '/api/login', { password: v.password }); await load(); rerender(); },
  });
}

// ---------- carregar dados / iniciar ----------
async function load() {
  const d = await api('GET', '/api/site');
  Object.assign(State, d);
  document.body.classList.toggle('is-admin', State.isAdmin);
  const link = $('#adminLink');
  if (link) link.hidden = State.isAdmin;
}

async function boot(render) {
  try { await load(); } catch (e) { console.error(e); }
  render();
  const link = $('#adminLink');
  if (link) link.onclick = () => openLogin(render);
  const out = $('#logoutBtn');
  if (out) out.onclick = async () => { await api('POST', '/api/logout'); await load(); render(); };
}
