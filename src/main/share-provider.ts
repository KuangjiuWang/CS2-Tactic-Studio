import type { ShareResult, ShareStatus } from '../types';

export interface ShareRecord { shareToken: string; ownerToken?: string; expiresAt: string | null }
export interface ShareProvider {
  status(): ShareStatus;
  uploadTactic(archive: Uint8Array, tacticId: string): Promise<{ result: ShareResult; record: ShareRecord }>;
  getTactic(linkOrToken: string): Promise<Uint8Array>;
  deleteShare(record: ShareRecord): Promise<void>;
  updateShare(record: ShareRecord, expiresAt: string | null): Promise<ShareRecord>;
}

const tokenPattern = /^[a-f0-9]{64}$/i;

export class SupabaseShareProvider implements ShareProvider {
  private readonly endpoint: string | null;
  private readonly anonKey: string;
  private readonly viewerBase: string | null;

  constructor(url = process.env.VITE_SUPABASE_URL ?? '', anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? '', viewerUrl = process.env.VITE_SHARE_VIEWER_URL ?? '') {
    this.anonKey = anonKey.trim();
    this.viewerBase = this.normalizeBase(viewerUrl);
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error('HTTPS is required for the sharing service.');
      this.endpoint = `${parsed.origin}/functions/v1/tactic-share`;
    } catch { this.endpoint = null; }
  }

  private normalizeBase(value: string): string | null {
    if (!value.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
      return url.origin + url.pathname.replace(/\/$/, '');
    } catch { return null; }
  }

  status(): ShareStatus {
    const configured = !!this.endpoint && this.anonKey.length > 0;
    return { configured, state: configured ? 'configured' : 'not-configured', message: configured ? 'Configured. The service is checked when a share operation runs.' : 'Not configured' };
  }

  private requireEndpoint() {
    if (!this.endpoint || !this.anonKey) throw new Error('Online sharing is not configured. Export a .cstactic file instead.');
    return this.endpoint;
  }

  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.anonKey, Authorization: `Bearer ${this.anonKey}`, ...extra };
  }

  private async request(url: string, init: RequestInit) {
    let response: Response;
    try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(5 * 60_000) }); }
    catch (error) { throw new Error(`Sharing server unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    if (!response.ok) {
      const message = (await response.text()).slice(0, 500);
      throw new Error(`Sharing server returned ${response.status}: ${message || response.statusText}`);
    }
    return response;
  }

  async uploadTactic(archive: Uint8Array, tacticId: string) {
    const endpoint = this.requireEndpoint();
    if (!/^[a-f0-9-]{20,80}$/i.test(tacticId)) throw new Error('Invalid tactic identifier.');
    const body = archive.slice().buffer as ArrayBuffer;
    const response = await this.request(endpoint, { method: 'POST', headers: this.headers({ 'content-type': 'application/vnd.tacticlab.cstactic', 'x-tactic-action': 'create', 'x-tactic-id': tacticId }), body });
    const payload = await response.json() as { shareToken?: string; ownerToken?: string; expiresAt?: string | null; shareUrl?: string };
    if (!payload.shareToken || !tokenPattern.test(payload.shareToken) || !payload.ownerToken || payload.ownerToken.length < 40) throw new Error('Sharing service returned an invalid share token.');
    const fallback = `${endpoint}/t/${payload.shareToken}`;
    const shareUrl = payload.shareUrl || (this.viewerBase ? `${this.viewerBase}/t/${payload.shareToken}` : fallback);
    let parsed: URL;
    try { parsed = new URL(shareUrl); } catch { throw new Error('Sharing service returned an invalid share link.'); }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error('Sharing service returned an insecure HTTP link.');
    const expiresAt = payload.expiresAt ?? null;
    return { result: { shareToken: payload.shareToken, shareUrl, expiresAt }, record: { shareToken: payload.shareToken, ownerToken: payload.ownerToken, expiresAt } };
  }

  private tokenFrom(value: string) {
    const trimmed = value.trim();
    if (tokenPattern.test(trimmed)) return trimmed;
    let url: URL;
    try { url = new URL(trimmed); } catch { throw new Error('Enter a valid tactic share URL.'); }
    const token = url.pathname.match(/(?:^|\/)([a-f0-9]{64})\/?$/i)?.[1];
    if (!token) throw new Error('Share URL does not contain a valid token.');
    return token;
  }

  async getTactic(linkOrToken: string) {
    const endpoint = this.requireEndpoint(), token = this.tokenFrom(linkOrToken);
    const response = await this.request(`${endpoint}/t/${token}`, { method: 'GET', headers: this.headers({ accept: 'application/vnd.tacticlab.cstactic' }) });
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > 128 * 1024 * 1024) throw new Error('Shared tactic exceeds the 128 MiB download limit.');
    if (data.byteLength < 4 || data[0] !== 0x50 || data[1] !== 0x4b) throw new Error('Sharing service returned an invalid tactic archive.');
    return data;
  }

  async deleteShare(record: ShareRecord) {
    const endpoint = this.requireEndpoint();
    if (!record.ownerToken) throw new Error('This share link cannot be revoked from this installation.');
    await this.request(endpoint, { method: 'POST', headers: this.headers({ 'content-type': 'application/json', 'x-tactic-action': 'revoke' }), body: JSON.stringify({ shareToken: record.shareToken, ownerToken: record.ownerToken }) });
  }

  async updateShare(record: ShareRecord, expiresAt: string | null): Promise<ShareRecord> {
    const endpoint = this.requireEndpoint();
    if (!record.ownerToken) throw new Error('This share link cannot be updated from this installation.');
    const response = await this.request(endpoint, { method: 'POST', headers: this.headers({ 'content-type': 'application/json', 'x-tactic-action': 'update' }), body: JSON.stringify({ shareToken: record.shareToken, ownerToken: record.ownerToken, expiresAt }) });
    const data = await response.json() as { expiresAt?: string | null };
    return { ...record, expiresAt: data.expiresAt ?? null };
  }
}
