// Light Studio's — back-end para Netlify (Function v2 + Netlify Blobs)
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};
const MAX_UPLOAD = 4 * 1024 * 1024; // 4 MB (Functions aceitam ~6 MB por requisição)
const PLATFORMS = ['windows'];
const SESSION_MS = 7 * 24 * 3600 * 1000;

const DEFAULT_DB = {
  site: { title: "Light Studio's,", tagline: 'imaginação sem fim.', banner: null },
  games: [
    { id: 'toy-factory', name: 'Toy Factory', description: '', cover: null, files: { windows: null } },
    { id: 'welcome-to-the-neighborhood', name: 'Welcome to the Neighborhood', description: '', cover: null, files: { windows: null } },
  ],
};

// consistência "strong" = depois de salvar, a leitura seguinte já vê a mudança
const dataStore = () => getStore({ name: 'light-studio-data', consistency: 'strong' });
const fileStore = () => getStore({ name: 'light-studio-files', consistency: 'strong' });

async function loadDb() {
  const db = await dataStore().get('db', { type: 'json' });
  return db || structuredClone(DEFAULT_DB);
}
const saveDb = (db) => dataStore().setJSON('db', db);

// ---------- helpers ----------
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
const clean = (v, max) => String(v ?? '').replace(/\u0000/g, '').slice(0, max);

function sanitizeFilename(name) {
  let base = String(name || 'arquivo').split(/[\\/]/).pop().replace(/[^\w.\-() À-ɏ]/g, '_').trim();
  if (!base || base === '.' || base === '..') base = 'arquivo';
  return base.slice(0, 120);
}
const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
};

// ---------- sessão sem estado (cookie assinado) ----------
const secret = () => {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  return crypto.createHmac('sha256', pw).update('light-studio-session-v1' + (process.env.SESSION_SECRET || '')).digest();
};
function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}
function makeToken() {
  const payload = String(Date.now() + SESSION_MS);
  return payload + '.' + sign(payload);
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function isAdmin(req) {
  if (!secret()) return false;
  const t = parseCookies(req).ls_session;
  if (!t) return false;
  const [payload, sig] = t.split('.');
  if (!payload || !sig) return false;
  const good = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// limite de tentativas de login (guardado no Blobs, por IP)
async function checkRate(ip, failed) {
  const key = 'rl-' + crypto.createHash('sha256').update(String(ip || 'x')).digest('hex').slice(0, 24);
  const st = dataStore();
  let a = await st.get(key, { type: 'json' });
  if (!a || a.reset < Date.now()) a = { n: 0, reset: Date.now() + 15 * 60 * 1000 };
  if (failed === 'reset') { await st.delete(key); return true; }
  if (failed) { a.n++; await st.setJSON(key, a); return true; }
  return a.n < 10;
}

// ---------- uploads (corpo da requisição = arquivo) ----------
async function readUpload(req, { imageOnly }) {
  let original;
  try { original = sanitizeFilename(decodeURIComponent(req.headers.get('x-filename') || '')); }
  catch { return { error: json({ error: 'Nome de arquivo inválido' }, 400) }; }
  const ext = extOf(original);
  if (imageOnly && !IMAGE_TYPES[ext]) return { error: json({ error: 'Envie uma imagem (png, jpg, webp, gif ou avif)' }, 400) };
  if (!imageOnly && !/^\.[a-z0-9]{1,10}$/.test(ext)) return { error: json({ error: 'O arquivo precisa ter extensão (ex: .zip, .exe)' }, 400) };
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_UPLOAD) return { error: json({ error: 'Arquivo grande demais para upload direto (máx 4 MB). Para arquivos grandes use "Colar link de download".' }, 413) };
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return { error: json({ error: 'Arquivo vazio' }, 400) };
  if (buf.byteLength > MAX_UPLOAD) return { error: json({ error: 'Arquivo grande demais para upload direto (máx 4 MB). Para arquivos grandes use "Colar link de download".' }, 413) };
  const key = crypto.randomBytes(12).toString('hex') + ext;
  return { buf, key, original, size: buf.byteLength };
}
async function removeBlob(key) {
  if (!key) return;
  try { await fileStore().delete(key); } catch {}
}
// apaga o arquivo antigo só se ele foi enviado (e não é um link)
const removeStoredFile = (f) => (f && f.type === 'upload' ? removeBlob(f.key) : undefined);

const validGameId = (id) => /^[\w-]{1,60}$/.test(id || '');

// ---------- handler ----------
export default async (req, context) => {
  const url = new URL(req.url);
  const p = decodeURIComponent(url.pathname);
  const m = req.method;

  try {
    // dados públicos
    if (m === 'GET' && p === '/api/site') {
      const db = await loadDb();
      return json({ site: db.site, games: db.games, isAdmin: isAdmin(req), platforms: PLATFORMS });
    }

    // login / logout
    if (m === 'POST' && p === '/api/login') {
      if (!secret()) return json({ error: 'Defina a variável ADMIN_PASSWORD no Netlify (Site settings → Environment variables).' }, 500);
      const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'x';
      if (!(await checkRate(ip))) return json({ error: 'Muitas tentativas. Tente de novo em alguns minutos.' }, 429);
      const body = await req.json().catch(() => ({}));
      if (!safeEqual(body.password || '', process.env.ADMIN_PASSWORD)) {
        await checkRate(ip, true);
        return json({ error: 'Senha incorreta' }, 401);
      }
      await checkRate(ip, 'reset');
      return json({ ok: true }, 200, {
        'Set-Cookie': `ls_session=${makeToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
      });
    }
    if (m === 'POST' && p === '/api/logout') {
      return json({ ok: true }, 200, { 'Set-Cookie': 'ls_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
    }

    // imagens (banner / capas) — públicas
    let mm = p.match(/^\/uploads\/([\w.-]+)$/);
    if (m === 'GET' && mm) {
      const type = IMAGE_TYPES[extOf(mm[1])];
      if (!type) return new Response('Não encontrado', { status: 404 });
      const data = await fileStore().get(mm[1], { type: 'stream' });
      if (!data) return new Response('Não encontrado', { status: 404 });
      return new Response(data, {
        headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' },
      });
    }

    // download (público)
    mm = p.match(/^\/download\/([\w-]+)\/(\w+)$/);
    if (m === 'GET' && mm) {
      const db = await loadDb();
      const g = db.games.find((x) => x.id === mm[1]);
      const f = g && PLATFORMS.includes(mm[2]) ? g.files[mm[2]] : null;
      if (!f) return new Response('Arquivo não encontrado', { status: 404 });
      if (f.type === 'link') return Response.redirect(f.url, 302);
      const data = await fileStore().get(f.key, { type: 'stream' });
      if (!data) return new Response('Arquivo não encontrado', { status: 404 });
      return new Response(data, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${f.name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    // ---------- só admin ----------
    if (p.startsWith('/api/')) {
      if (!isAdmin(req)) return json({ error: 'Faça login como admin' }, 401);
      const db = await loadDb();

      // título e frase
      if (m === 'PUT' && p === '/api/site') {
        const b = await req.json().catch(() => ({}));
        db.site.title = clean(b.title, 120);
        db.site.tagline = clean(b.tagline, 200);
        await saveDb(db);
        return json({ site: db.site });
      }

      // banner global
      if (m === 'PUT' && p === '/api/upload/banner') {
        const up = await readUpload(req, { imageOnly: true });
        if (up.error) return up.error;
        await fileStore().set(up.key, up.buf);
        await removeBlob(db.site.banner);
        db.site.banner = up.key;
        await saveDb(db);
        return json({ site: db.site });
      }
      if (m === 'DELETE' && p === '/api/banner') {
        await removeBlob(db.site.banner);
        db.site.banner = null;
        await saveDb(db);
        return json({ site: db.site });
      }

      // nome e descrição do jogo
      mm = p.match(/^\/api\/games\/([\w-]+)$/);
      if (m === 'PUT' && mm) {
        const g = db.games.find((x) => x.id === mm[1]);
        if (!g) return json({ error: 'Jogo não encontrado' }, 404);
        const b = await req.json().catch(() => ({}));
        g.name = clean(b.name, 120) || g.name;
        g.description = clean(b.description, 4000);
        await saveDb(db);
        return json({ game: g });
      }

      // capa do jogo
      mm = p.match(/^\/api\/upload\/games\/([\w-]+)\/cover$/);
      if (m === 'PUT' && mm) {
        const g = db.games.find((x) => x.id === mm[1]);
        if (!g) return json({ error: 'Jogo não encontrado' }, 404);
        const up = await readUpload(req, { imageOnly: true });
        if (up.error) return up.error;
        await fileStore().set(up.key, up.buf);
        await removeBlob(g.cover);
        g.cover = up.key;
        await saveDb(db);
        return json({ game: g });
      }

      // arquivo do jogo — upload direto (até 4 MB)
      mm = p.match(/^\/api\/upload\/games\/([\w-]+)\/file\/(\w+)$/);
      if (m === 'PUT' && mm) {
        const g = db.games.find((x) => x.id === mm[1]);
        if (!g || !PLATFORMS.includes(mm[2])) return json({ error: 'Jogo ou plataforma inválida' }, 404);
        const up = await readUpload(req, { imageOnly: false });
        if (up.error) return up.error;
        await fileStore().set(up.key, up.buf);
        await removeStoredFile(g.files[mm[2]]);
        g.files[mm[2]] = { type: 'upload', key: up.key, name: up.original, size: up.size };
        await saveDb(db);
        return json({ game: g });
      }

      // arquivo do jogo — link externo (qualquer tamanho)
      mm = p.match(/^\/api\/games\/([\w-]+)\/link\/(\w+)$/);
      if (m === 'PUT' && mm) {
        const g = db.games.find((x) => x.id === mm[1]);
        if (!g || !PLATFORMS.includes(mm[2])) return json({ error: 'Jogo ou plataforma inválida' }, 404);
        const b = await req.json().catch(() => ({}));
        let u;
        try { u = new URL(String(b.url || '').trim()); } catch { return json({ error: 'Link inválido' }, 400); }
        if (u.protocol !== 'https:') return json({ error: 'O link precisa começar com https://' }, 400);
        const name = clean(b.name, 120).trim() || sanitizeFilename(decodeURIComponent(u.pathname.split('/').pop() || '')) || 'download';
        await removeStoredFile(g.files[mm[2]]);
        g.files[mm[2]] = { type: 'link', url: u.toString(), name, size: 0 };
        await saveDb(db);
        return json({ game: g });
      }

      // apagar arquivo/link
      mm = p.match(/^\/api\/games\/([\w-]+)\/file\/(\w+)$/);
      if (m === 'DELETE' && mm) {
        const g = db.games.find((x) => x.id === mm[1]);
        if (!g || !PLATFORMS.includes(mm[2])) return json({ error: 'Jogo ou plataforma inválida' }, 404);
        await removeStoredFile(g.files[mm[2]]);
        g.files[mm[2]] = null;
        await saveDb(db);
        return json({ game: g });
      }

      return json({ error: 'Rota não encontrada' }, 404);
    }

    return new Response('Não encontrado', { status: 404 });
  } catch (e) {
    console.error(e);
    return json({ error: 'Erro no servidor: ' + (e.message || 'desconhecido') }, 500);
  }
};

export const config = {
  path: ['/api/*', '/uploads/*', '/download/*'],
};
