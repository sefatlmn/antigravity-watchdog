// Minimal stand-in for Antigravity's `sidecar_sdk`, used when the panel server
// runs outside Antigravity (in a plain browser). It implements the
// subset main.mjs uses: page(), api(), run() and Response. Agent API calls are
// Antigravity-only and are not provided here.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const BIND_HOST = '127.0.0.1';
const LOOPBACK_HOST_RE = /^(?:127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|localhost|\[::1\])(?::\d+)?$/i;

export class Response {
  /**
   * @param {string | Buffer} body
   * @param {{ contentType?: string, status?: number, headers?: Record<string, string> }} [options]
   */
  constructor(body, { contentType = 'text/plain', status = 200, headers = undefined } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class SidecarApp {
  #pages = new Map();
  #apis = new Map();
  #token = process.env.WATCHDOG_PANEL_TOKEN || randomBytes(16).toString('hex');
  #port = Number(process.env.WATCHDOG_PANEL_PORT || 0);

  page(path, handler) { this.#pages.set(path, handler); }

  api(path, handler, method = 'POST') {
    if (!this.#apis.has(path)) this.#apis.set(path, new Map());
    this.#apis.get(path).set(method.toUpperCase(), handler);
  }

  run() {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://${BIND_HOST}`);
        const cookieHeader = req.headers.cookie || '';
        const cookieMatch = cookieHeader.match(/(?:^|;\s*)sidecar_token=([^;]+)/);
        const cookieToken = cookieMatch ? cookieMatch[1] : null;
        const authHeader = req.headers.authorization;
        const bearerToken = (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) ? authHeader.slice(7).trim() : null;
        const rawHeaderToken = req.headers['x-sidecar-token'];
        const headerToken = Array.isArray(rawHeaderToken) ? rawHeaderToken[0] : rawHeaderToken;
        const queryToken = url.searchParams.get('token');
        const candidates = [headerToken, queryToken, cookieToken, bearerToken].filter(Boolean);

      const remoteIp = req.socket?.remoteAddress || '';
      const isRemoteLoopback =
        remoteIp === '127.0.0.1' ||
        remoteIp === '::1' ||
        remoteIp === '::ffff:127.0.0.1' ||
        remoteIp.startsWith('127.') ||
        remoteIp.startsWith('::ffff:127.');
      const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
      const isHostLoopback = LOOPBACK_HOST_RE.test(hostHeader);
      const isLoopback = isRemoteLoopback && isHostLoopback;

      // Reject non-loopback requests unconditionally (prevents DNS rebinding and host spoofing)
      if (!isLoopback) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized: non-loopback access denied' }));
        return;
      }

      const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      if (secFetchSite === 'cross-site') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden: cross-origin access denied' }));
        return;
      }
      const originHeader = req.headers.origin;
      if (originHeader) {
        let isOriginLoopback = false;
        try {
          const originUrl = new URL(originHeader);
          isOriginLoopback = LOOPBACK_HOST_RE.test(originUrl.host);
        } catch {}
        if (!isOriginLoopback) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden: cross-origin access denied' }));
          return;
        }
      }

      const isSafeEndpoint = req.method === 'GET' || [
        '/api/dashboard',
        '/api/git-state',
        '/api/git_state',
        '/api/health',
      ].includes(url.pathname);

      // Like the real SDK, non-GET mutating calls need the token; reads and status queries are open on loopback.
      if (!isSafeEndpoint && !candidates.includes(this.#token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (req.method === 'GET' && this.#pages.has(url.pathname)) {
        const content = await this.#pages.get(url.pathname)();
        const cookieHeaderVal = `sidecar_token=${this.#token}; Path=/; HttpOnly; SameSite=Strict`;
        if (content instanceof Response) {
          res.writeHead(content.status || 200, {
            'Content-Type': content.contentType,
            'Set-Cookie': cookieHeaderVal,
            ...content.headers
          });
          res.end(content.body);
          return;
        }
        res.writeHead(200, {
          'Content-Type': url.pathname.endsWith('.js') ? 'application/javascript' : 'text/html',
          'Set-Cookie': cookieHeaderVal,
        });
        res.end(content);
        return;
      }

      const methods = this.#apis.get(url.pathname);
      if (!methods) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const handler = methods.get(req.method);
      if (!handler) {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

        const chunks = [];
        let bodyBytes = 0;
        let payloadTooLarge = false;
        req.on('data', (chunk) => {
          if (payloadTooLarge) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bodyBytes += buf.length;
          if (bodyBytes > MAX_BODY_BYTES) {
            payloadTooLarge = true;
            if (!res.headersSent) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Payload too large' }));
            }
            req.destroy();
            return;
          }
          chunks.push(buf);
        });
        req.on('end', async () => {
          if (payloadTooLarge) return;
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const data = {};
            for (const [key, value] of url.searchParams.entries()) {
              if (key.toLowerCase() !== 'token') data[key] = value;
            }
            if (body) {
              const contentType = String(req.headers['content-type'] || '').toLowerCase();
              if (!contentType.includes('application/json')) {
                res.writeHead(415, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unsupported Media Type: application/json required' }));
                return;
              }
              let parsed;
              try {
                parsed = JSON.parse(body);
              } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                return;
              }
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                Object.assign(data, parsed);
              }
            }
            const result = await handler(data, req);
            if (result instanceof Response) {
              res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...result.headers });
              res.end(result.body);
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err?.message || String(err) }));
            }
          }
        });
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err?.message || String(err) }));
        }
      }
    });

    return new Promise((resolve) => {
      server.listen(this.#port, BIND_HOST, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        // The line a person opens in a browser to reach the panel.
        console.log(`WATCHDOG_PANEL_URL=http://${BIND_HOST}:${port}/?token=${this.#token}`);
        resolve(server);
      });
    });
  }
}
