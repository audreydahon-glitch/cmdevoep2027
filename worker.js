// Tableau des Commandes VO · Plaque EP — serveur Cloudflare (fichier unique, autonome)
// Sert le site (index.html) et les 2 fonctions /api/config et /api/admin.

// Donne au navigateur l'adresse Supabase et la clé publique (anon).
// La clé anon est publique par conception : la sécurité repose sur les règles de la base (tableau-commandes.sql).
async function configGet({ env }) {
  const url = env.SUPABASE_URL || '';
  const anon = env.SUPABASE_ANON_KEY || '';
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (!url || !anon) {
    return new Response(JSON.stringify({ error: 'Variables SUPABASE_URL / SUPABASE_ANON_KEY manquantes dans Cloudflare' }), { status: 500, headers: h });
  }
  return new Response(JSON.stringify({ url, anon }), { headers: h });
}

// Création de comptes et nouveaux mots de passe — réservé aux administrateurs de l'outil.
// Variables Cloudflare : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY (secrète, jamais envoyée au navigateur).
// Les comptes sont ceux de Prospection Atelier : même identifiant, même mot de passe.

const DOMAIN = 'vo.plaque-ep.fr';            // identifiant prenom.nom → prenom.nom@vo.plaque-ep.fr
const ROLES = ['admin', 'directeur', 'chef', 'assistante', 'lecture', 'aucun'];

function fail(msg, status) { return Object.assign(new Error(msg), { status }); }

function client(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw fail('Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes dans Cloudflare', 500);
  async function sb(path, opts = {}) {
    const res = await fetch(url + path, {
      ...opts,
      headers: {
        apikey: key, ...(key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {}),
        'Content-Type': 'application/json', ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) throw fail((body && (body.msg || body.message || body.error_description || body.error)) || ('Erreur ' + res.status), res.status);
    return body;
  }
  return { url, sb };
}

// Vérifie que l'appelant est administrateur du Tableau des Commandes
async function checkAdmin(request, c) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw fail('Non connecté', 401);
  const res = await fetch(c.url + '/auth/v1/user', { headers: { apikey: c.anonOrService || '', Authorization: 'Bearer ' + token } });
  if (!res.ok) throw fail('Session expirée, reconnectez-vous', 401);
  const user = await res.json();
  const acc = await c.sb('/rest/v1/tc_acces?select=role&user_id=eq.' + user.id);
  let role = acc && acc[0] && acc[0].role;
  if (!role) {
    const p = await c.sb('/rest/v1/profiles?select=role&id=eq.' + user.id);
    role = p && p[0] && p[0].role === 'admin' ? 'admin' : 'aucun';
  }
  if (role !== 'admin') throw fail('Réservé aux administrateurs', 403);
  return user;
}

function slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

function password() {
  const a = 'abcdefghjkmnpqrstuvwxyz', d = '23456789';
  const r = n => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % n; };
  let p = '';
  for (let i = 0; i < 6; i++) p += a[r(a.length)];
  for (let i = 0; i < 3; i++) p += d[r(d.length)];
  return p.charAt(0).toUpperCase() + p.slice(1);
}

async function createOne(c, b) {
  const nom = String(b.nom || '').trim();
  const role = String(b.role || '');
  const sites = String(b.sites || '').trim();
  if (!nom) throw fail('Nom manquant', 400);
  if (!ROLES.includes(role) || role === 'aucun') throw fail('Rôle invalide', 400);
  if (role !== 'admin' && !sites) throw fail('Choisissez au moins un parc', 400);
  const id8 = slug(b.identifiant || nom);
  if (!id8) throw fail('Identifiant invalide', 400);
  const exist = await c.sb('/rest/v1/profiles?select=id&identifiant=eq.' + encodeURIComponent(id8));
  if (exist && exist.length) throw fail('L\'identifiant « ' + id8 + ' » existe déjà (compte Prospection Atelier). Utilisez « Modifier » dans la liste pour lui donner accès.', 409);
  const pwd = password();
  const user = await c.sb('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: id8 + '@' + DOMAIN, password: pwd, email_confirm: true, user_metadata: { nom } }),
  });
  // Profil commun avec Prospection Atelier : ce nouveau compte n'y voit aucun site.
  await c.sb('/rest/v1/profiles', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: user.id, identifiant: id8, nom, role: 'vendeur', site: '' }),
  });
  await c.sb('/rest/v1/tc_acces', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ user_id: user.id, role, sites }),
  });
  return { id: user.id, identifiant: id8, password: pwd, nom, role, sites };
}

async function adminPost({ request, env }) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  try {
    const c = client(env);
    c.anonOrService = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
    const me = await checkAdmin(request, c);
    const b = await request.json().catch(() => ({}));
    let out;
    if (b.action === 'create') {
      out = await createOne(c, b);
    } else if (b.action === 'reset') {
      if (!b.id) throw fail('Compte manquant', 400);
      const pwd = password();
      await c.sb('/auth/v1/admin/users/' + encodeURIComponent(b.id), { method: 'PUT', body: JSON.stringify({ password: pwd }) });
      out = { password: pwd };
    } else if (b.action === 'delete') {
      if (!b.id) throw fail('Compte manquant', 400);
      if (b.id === me.id) throw fail('Vous ne pouvez pas supprimer votre propre compte', 400);
      await c.sb('/auth/v1/admin/users/' + encodeURIComponent(b.id), { method: 'DELETE' });
      out = { ok: true };
    } else {
      throw fail('Action inconnue', 400);
    }
    return new Response(JSON.stringify(out), { headers: h });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Erreur' }), { status: e.status || 500, headers: h });
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/config' && request.method === 'GET') return configGet({ request, env });
    if (path === '/api/admin' && request.method === 'POST') return adminPost({ request, env });
    if (path.startsWith('/api/')) return new Response('{"error":"Introuvable"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return env.ASSETS.fetch(request);
  },
};
