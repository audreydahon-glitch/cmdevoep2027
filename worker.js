import * as config from './functions/api/config.js';
import * as admin from './functions/api/admin.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/config' && request.method === 'GET') return config.onRequestGet({ request, env });
    if (path === '/api/admin' && request.method === 'POST') return admin.onRequestPost({ request, env });
    if (path.startsWith('/api/')) return new Response('{"error":"Introuvable"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return env.ASSETS.fetch(request);
  },
};
