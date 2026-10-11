// One local HTTP server standing in for every usage endpoint the plugin can call:
//   GET /v1/usage/claude          providerproxy/anthropic      (Bearer <proxy key>)
//   GET /v1/usage/chatgpt         providerproxy/openai-codex   (Bearer <proxy key>)
//   GET /api/oauth/usage          anthropic                    (Bearer <DSH sign-in access token>)
//   GET /backend-api/wham/usage   openai-codex                 (Bearer <access>, ChatGPT-Account-Id)
//
// Each account answers from a mutable response:
//   { kind: 'ok', windows }                 200 with the provider's payload shape
//   { kind: 'status', status, message? }    error status; ProviderProxy-style JSON error body
//   { kind: 'malformed', body }             200 with an unparseable / windowless body
//   { kind: 'hang' }                        never answers (until the client gives up or close())
//   { kind: 'echo', windows, secret }       200 whose plan / limit names contain `secret`
// Every request is logged with the outcome the client could have applied, so a test can
// compute what the plugin should be showing without reading plugin internals.
import { createServer } from 'node:http';
import { bodyFor, accountById, representable } from './scenario.mjs';

/** A 200 the plugin can apply must carry at least one window its payload shape can express. */
const usable = (account, windows) => representable(account, windows).length > 0;

const ROUTES = {
  '/v1/usage/claude': 'providerproxy/anthropic',
  '/v1/usage/chatgpt': 'providerproxy/openai-codex',
  '/api/oauth/usage': 'anthropic',
  '/backend-api/wham/usage': 'openai-codex',
};

export async function startMockUpstream({ proxyKey, tokens = {} } = {}) {
  const responses = new Map();
  const requests = [];
  const hung = new Set();
  const expected = { ...tokens };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const account = ROUTES[url.pathname];
    const authorization = req.headers.authorization ?? null;
    const entry = { at: Date.now(), account: account ?? null, method: req.method, path: url.pathname, authorization, outcome: 'fail', windows: null };
    requests.push(entry);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (account === undefined) return send(404, { error: { message: 'Unknown API route' } });
    const bearer = accountById(account).proxy ? proxyKey : expected[account];
    if (bearer === undefined || authorization !== `Bearer ${bearer}`) {
      return send(401, { error: { message: 'Invalid client token', type: 'authentication_error' } });
    }
    const response = responses.get(account) ?? { kind: 'status', status: 503, message: 'No usage is available' };
    switch (response.kind) {
      case 'ok':
        entry.outcome = usable(account, response.windows) ? 'ok' : 'fail';
        entry.windows = response.windows;
        return send(200, bodyFor(account, response.windows, entry.at));
      case 'echo': {
        entry.outcome = usable(account, response.windows) ? 'ok' : 'fail';
        entry.windows = response.windows;
        const body = bodyFor(account, response.windows, entry.at);
        if (accountById(account).family === 'codex') {
          body.plan_type = `plan ${response.secret}`;
          for (const extra of body.additional_rate_limits) extra.limit_name = `${extra.limit_name} ${response.secret}`;
        } else {
          for (const limit of body.limits) if (limit.scope) limit.scope.model.display_name = `${limit.scope.model.display_name} ${response.secret}`;
        }
        return send(200, body);
      }
      case 'status':
        return send(response.status, { error: { message: response.message ?? `Upstream failed (${response.status})`, type: 'upstream_error' } });
      case 'malformed':
        return send(200, response.body);
      case 'hang':
        hung.add(res);
        res.on('close', () => hung.delete(res));
        return undefined;
      default:
        return send(500, { error: { message: 'bad mock response' } });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    proxyBaseURL: `${origin}/v1`,
    upstream: { anthropic: `${origin}/api/oauth/usage`, 'openai-codex': `${origin}/backend-api/wham/usage` },
    requests,
    /** Set what an account answers from now on. */
    set(account, response) { responses.set(account, response); },
    /** Accept this access token for a DSH sign-in account. */
    expectToken(account, token) { expected[account] = token; },
    requestsFor(account, since = 0) { return requests.filter((r) => r.account === account && r.at >= since); },
    async close() {
      for (const res of hung) res.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
