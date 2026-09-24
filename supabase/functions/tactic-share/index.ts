const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const bucket = 'tactic-shares';
const maxBytes = 128 * 1024 * 1024;
const tokenPattern = /^[a-f0-9]{64}$/i;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, apikey, content-type, x-tactic-action, x-tactic-id' };
const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', ...headers } });
const adminHeaders = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' };

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...adminHeaders, ...init.headers } });
  if (!response.ok) throw new Error(`Supabase database request failed (${response.status}).`);
  return response;
}
async function hash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes: number) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map(item => item.toString(16).padStart(2, '0')).join('');
}
async function storage(path: string, init: RequestInit = {}) {
  const response = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, { ...init, headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, ...init.headers } });
  if (!response.ok) throw new Error(`Supabase storage request failed (${response.status}).`);
  return response;
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    const endpoint = new URL(request.url), action = request.headers.get('x-tactic-action') ?? '';
    if (request.method === 'GET') {
      const token = endpoint.pathname.match(/\/t\/([a-f0-9]{64})\/?$/i)?.[1];
      if (!token || !tokenPattern.test(token)) return respond({ error: 'Invalid share link.' }, 400);
      const query = `tactic_shares?select=share_token,object_path,expires_at&share_token=eq.${token}&limit=1`;
      const rows = await (await rest(query)).json() as Array<{ share_token: string; object_path: string; expires_at: string | null }>;
      const row = rows[0];
      if (!row || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return respond({ error: 'This share link has expired or was revoked.' }, 404);
      const file = await storage(row.object_path);
      return new Response(file.body, { headers: { ...cors, 'content-type': 'application/vnd.tacticlab.cstactic', 'content-disposition': 'attachment; filename="shared-tactic.cstactic"', 'cache-control': 'private, no-store' } });
    }
    if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);

    if (action === 'create') {
      const contentType = request.headers.get('content-type') ?? '';
      const length = Number(request.headers.get('content-length') ?? 0);
      if (!contentType.startsWith('application/vnd.tacticlab.cstactic') || length > maxBytes) return respond({ error: 'Unsupported file type or size.' }, 413);
      const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
      const ipHash = await hash(`${Deno.env.get('SHARE_RATE_SALT') ?? serviceKey}:${ip}`);
      const quota = await rest('rpc/consume_tactic_share_quota', { method: 'POST', body: JSON.stringify({ p_ip_hash: ipHash }) });
      if (!await quota.json()) return respond({ error: 'Share upload limit reached. Try again in an hour.' }, 429);
      const data = new Uint8Array(await request.arrayBuffer());
      if (data.length < 4 || data.length > maxBytes || data[0] !== 0x50 || data[1] !== 0x4b) return respond({ error: 'Invalid .cstactic archive.' }, 400);
      const shareToken = randomHex(32), ownerToken = randomHex(32), objectPath = `${shareToken}.cstactic`;
      await storage(objectPath, { method: 'POST', headers: { 'content-type': 'application/vnd.tacticlab.cstactic', 'x-upsert': 'false' }, body: data });
      try {
        await rest('tactic_shares', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ share_token: shareToken, owner_token_hash: await hash(ownerToken), visibility: 'unlisted', object_path: objectPath }) });
      } catch (error) { await storage(objectPath, { method: 'DELETE' }).catch(() => undefined); throw error; }
      const viewer = Deno.env.get('SHARE_VIEWER_URL')?.replace(/\/$/, '');
      const shareUrl = viewer ? `${viewer}/t/${shareToken}` : `${endpoint.origin}/functions/v1/tactic-share/t/${shareToken}`;
      return respond({ shareToken, ownerToken, shareUrl, expiresAt: null }, 201);
    }

    const payload = await request.json() as { shareToken?: string; ownerToken?: string; expiresAt?: string | null };
    if (!payload.shareToken || !tokenPattern.test(payload.shareToken) || !payload.ownerToken || !tokenPattern.test(payload.ownerToken)) return respond({ error: 'Invalid share owner credentials.' }, 400);
    const rows = await (await rest(`tactic_shares?select=id,share_token,owner_token_hash,object_path&share_token=eq.${payload.shareToken}&limit=1`)).json() as Array<{ id: string; share_token: string; owner_token_hash: string; object_path: string }>;
    const row = rows[0];
    if (!row || row.owner_token_hash !== await hash(payload.ownerToken)) return respond({ error: 'Share owner token did not match.' }, 403);
    if (action === 'revoke') {
      await storage(row.object_path, { method: 'DELETE' });
      await rest(`tactic_shares?id=eq.${row.id}`, { method: 'DELETE' });
      return respond({ revoked: true });
    }
    if (action === 'update') {
      const expiry = payload.expiresAt ? new Date(payload.expiresAt) : null;
      if (expiry && (!Number.isFinite(expiry.valueOf()) || expiry.valueOf() <= Date.now())) return respond({ error: 'Expiry must be in the future.' }, 400);
      await rest(`tactic_shares?id=eq.${row.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ expires_at: expiry?.toISOString() ?? null }) });
      return respond({ expiresAt: expiry?.toISOString() ?? null });
    }
    return respond({ error: 'Unknown action.' }, 400);
  } catch (error) {
    console.error('tactic-share failed', error);
    return respond({ error: error instanceof Error ? error.message : 'Share request failed.' }, 500);
  }
});
