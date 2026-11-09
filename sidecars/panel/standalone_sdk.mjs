// Minimal stand-in for Antigravity's `sidecar_sdk`, used when the panel server
// runs outside Antigravity (in a plain browser). It implements the
// subset main.mjs uses: page(), api(), run() and Response. Agent API calls are
// Antigravity-only and are not provided here.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const BIND_HOST = '127.0.0.1';

export class Response {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

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
      const url = new URL(req.url, `http://${BIND_HOST}`);
      const cookieHeader = req.headers.cookie || '';
      const cookieMatch = cookieHeader.match(/(?:^|;\s*)sidecar_token=([^;]+)/);
      const cookieToken = cookieMatch ? cookieMatch[1] : null;
      const authHeader = req.headers.authorization;
      const bearerToken = (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) ? authHeader.slice(7).trim() : null;
      const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token') || cookieToken || bearerToken;

      const remoteIp = req.socket?.remoteAddress || '';
      const isRemoteLoopback =
        remoteIp === '127.0.0.1' ||
        remoteIp === '::1' ||
        remoteIp === '::ffff:127.0.0.1' ||
        remoteIp.startsWith('127.') ||
        remoteIp.startsWith('::ffff:127.');
      const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
      const isHostLoopback = /^(?:127(?:\.\d+){3}|localhost|\[::1\])(?::\d+)?$/i.test(hostHeader);
      const isLoopback = isRemoteLoopback && isHostLoopback;

      // Reject non-loopback requests unconditionally (prevents DNS rebinding and host spoofing)
      if (!isLoopback) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized: non-loopback access denied' }));
        return;
      }

      const isSafeEndpoint = req.method === 'GET' || [
        '/api/dashboard',
        '/api/sync',
        '/api/git-state',
        '/api/git_state',
        '/api/health',
        '/api/active-workspace',
      ].includes(url.pathname);

      // Like the real SDK, non-GET mutating calls need the token; reads and status queries are open on loopback.
      if (!isSafeEndpoint && provided !== this.#token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (req.method === 'GET' && this.#pages.has(url.pathname)) {
        const content = await this.#pages.get(url.pathname)();
        const cookieHeaderVal = `sidecar_token=${this.#token}; Path=/; SameSite=Lax`;
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

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = {};
          for (const [key, value] of url.searchParams.entries()) {
            if (key.toLowerCase() !== 'token') data[key] = value;
          }
          if (body) Object.assign(data, JSON.parse(body));
          const result = await handler(data, req);
          if (result instanceof Response) {
            res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...result.headers });
            res.end(result.body);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });

    return new Promise((resolve) => {
      server.listen(this.#port, BIND_HOST, () => {
        const { port } = server.address();
        // The line a person opens in a browser to reach the panel.
        console.log(`WATCHDOG_PANEL_URL=http://${BIND_HOST}:${port}/?token=${this.#token}`);
        resolve(server);
      });
    });
  }
}
