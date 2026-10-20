import { DurableObject } from 'cloudflare:workers';
import { allowedStudentRequest, MAX_REMOTE_BYTES } from './policy.js';
const PROTOCOL = 'classroom-relay-v1';
const token = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const json = (value, status = 200) => Response.json(value, { status, headers });
const fail = (message, status) => json({ ok: false, message }, status);
const cookie = (request, name) => (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
function same(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
function encode(bytes) { let result = ''; for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(result); }
async function readBody(request, limit) {
  if (Number(request.headers.get('content-length') || 0) > limit) throw new Error('too large');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks = []; let length = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) { await reader.cancel(); throw new Error('too large'); } chunks.push(value); }
  const body = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; } return body;
}
export default {
  async fetch(request, env) {
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(env.PAIRING_KEY || '')) return fail('請先設定至少 32 位英數字的 PAIRING_KEY。', 503);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/control/')) {
      if (!same(request.headers.get('authorization') || '', `Bearer ${env.PAIRING_KEY}`)) return fail('配對金鑰不正確。', 401);
      if (request.method !== 'POST') return fail('不支援的操作。', 405);
      if (url.pathname === '/control/test') return json({ ok: true, protocol: PROTOCOL, maxImageBytes: MAX_REMOTE_BYTES });
    }
    return env.CLASSROOM.get(env.CLASSROOM.idFromName('classroom')).fetch(request);
  }
};
export class ClassroomRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.pending = new Map(); this.rate = new Map(); this.reading = 0;
    ctx.blockConcurrencyWhile(async () => { this.session = await ctx.storage.get('session') || null; });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  host() { return this.ctx.getWebSockets('teacher').find(ws => ws.readyState === 1 && ws.deserializeAttachment()?.room === this.session?.room); }
  live() { return this.session && this.session.expiresAt > Date.now(); }
  async revoke() {
    this.session = null; await this.ctx.storage.deleteAll();
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, '課堂已結束');
    for (const pending of this.pending.values()) pending.finish(fail('課堂已結束。', 410));
  }
  async alarm() { await this.revoke(); }
  async fetch(request) {
    const url = new URL(request.url); const pathname = url.pathname;
    if (pathname === '/control/open' && request.method === 'POST') {
      // One service is one teacher's classroom. Reopening invalidates every old invitation.
      if (this.live() && this.host()) return fail('此外網服務已有課堂進行中，請先從原 App 停止分享。', 409);
      await this.revoke();
      this.session = { room: token(), hostKey: token(), expiresAt: Date.now() + 8 * 3600 * 1000 };
      await this.ctx.storage.put('session', this.session); await this.ctx.storage.setAlarm(this.session.expiresAt);
      return json({ ok: true, protocol: PROTOCOL, ...this.session });
    }
    if (pathname === '/control/close' && request.method === 'POST') {
      let body; try { body = JSON.parse(new TextDecoder().decode(await readBody(request, 1024))); } catch { return fail('無效的要求。', 400); }
      if (this.session && !same(body.hostKey, this.session.hostKey)) return fail('課堂已變更。', 409);
      await this.revoke(); return json({ ok: true });
    }
    if (!this.live()) return fail('外網課堂未開放或已到期，請向老師取得新連結。', 410);
    if (pathname === '/connect') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !same(url.searchParams.get('key'), this.session.hostKey)) return fail('連線驗證失敗。', 403);
      for (const old of this.ctx.getWebSockets('teacher')) old.close(1000, '重新連線');
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['teacher']); server.serializeAttachment({ room: this.session.room });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (pathname.startsWith('/control/')) return fail('找不到操作。', 404);
    if (pathname.startsWith('/invite/')) {
      if (request.method !== 'GET' || !same(pathname.slice(8), this.session.room)) return fail('課堂連結已失效。', 403);
      const result = new Headers(headers); result.set('location', '/');
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      result.append('set-cookie', `classroom_remote=${this.session.room}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=28800`);
      result.append('set-cookie', `classroom_student=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`);
      return new Response(null, { status: 302, headers: result });
    }
    if (!same(cookie(request, 'classroom_remote'), this.session.room)) return fail('請使用老師提供的完整課堂連結。', 403);
    if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return fail('不允許跨網站操作。', 403);
    if (request.headers.get('sec-fetch-site') === 'cross-site') return fail('請重新開啟課堂連結。', 403);
    if (pathname === '/api/student/archive-upload') return fail('外網暫不支援 ZIP，請使用教室 Wi-Fi 上傳。', 413);
    const target = pathname + url.search;
    if (!allowedStudentRequest(request.method, target)) return fail('外網只提供學生課堂功能。', 403);
    const ws = this.host(); if (!ws) return fail('老師電腦暫時離線，請稍後重試。', 503);
    const now = Date.now(); for (const [key, record] of this.rate) if (record.until < now) this.rate.delete(key);
    const ip = request.headers.get('cf-connecting-ip') || 'local-test';
    const bucket = this.rate.get(ip) || { count: 0, until: now + 60000 };
    // A classroom can share one public IP: 60 students polling every 2 seconds
    // already produce 1,800 requests/minute, before page loads and submissions.
    if (++bucket.count > 2400 || this.rate.size > 1024) return fail('連線過於頻繁，請稍後重試。', 429);
    this.rate.set(ip, bucket);
    if (this.pending.size + this.reading >= 8) return fail('課堂忙碌中，請稍後重試。', 429);
    this.reading++;
    let body;
    try { body = await readBody(request, pathname === '/api/student/image-upload' ? MAX_REMOTE_BYTES : 256 * 1024); }
    catch { return fail('外網圖片上限 2 MB，請縮小檔案後再試。', 413); }
    finally { this.reading--; }
    if (!this.live() || ws !== this.host()) return fail('課堂連線已變更，請重新開啟連結。', 503);
    const forwarded = {};
    for (const key of ['content-type', 'x-page-id', 'x-file-name']) { const value = request.headers.get(key); if (value) forwarded[key] = value; }
    forwarded.cookie = 'classroom_student=' + cookie(request, 'classroom_student');
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(fail('老師電腦回應逾時，請稍後重試。', 504)), 15000);
      const finish = response => { clearTimeout(timer); this.pending.delete(id); resolve(response); };
      this.pending.set(id, { finish });
      try { ws.send(JSON.stringify({ type: 'request', id, method: request.method, path: target, headers: forwarded, body: encode(body), client: ip })); }
      catch { finish(fail('老師電腦已離線。', 503)); }
    });
  }
  async webSocketMessage(ws, raw) {
    if (!this.live() || ws !== this.host()) { ws.close(1008, '課堂已失效'); return; }
    if (typeof raw !== 'string' || raw.length > MAX_REMOTE_BYTES * 1.5 + 16384) return;
    let data; try { data = JSON.parse(raw); } catch { return; }
    const pending = this.pending.get(data.id); if (!pending || data.type !== 'response') return;
    try {
      if (!Number.isInteger(data.status) || data.status < 200 || data.status > 599) throw new Error();
      const responseHeaders = new Headers(headers);
      for (const key of ['content-type', 'content-security-policy']) if (typeof data.headers?.[key] === 'string') responseHeaders.set(key, data.headers[key]);
      if (data.headers?.location && ['/', '/join'].includes(data.headers.location)) responseHeaders.set('location', data.headers.location);
      for (const value of data.cookies || []) if (/^classroom_student=[a-f0-9.]+;/i.test(value)) responseHeaders.append('set-cookie', value.replace(/;\s*Secure/ig, '') + '; Secure');
      const body = Uint8Array.from(atob(data.body || ''), c => c.charCodeAt(0));
      if (body.length > MAX_REMOTE_BYTES) throw new Error();
      pending.finish(new Response([204, 205, 304].includes(data.status) ? null : body, { status: data.status, headers: responseHeaders }));
    } catch { pending.finish(fail('無法讀取老師電腦的回應。', 502)); }
  }
  webSocketClose(ws) { ws.close(); if (!this.host()) for (const pending of this.pending.values()) pending.finish(fail('老師電腦已離線。', 503)); }
  webSocketError(ws) { this.webSocketClose(ws); }
}
