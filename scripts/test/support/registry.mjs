// A local stand-in for the AWS Agent Registry control API, for running
// the registry scripts in a child process: point the SDK at it with
// AWS_ENDPOINT_URL (registryEnv). It answers list, get and status
// updates for the records it holds, records every request, and answers
// anything else with HTTP 500 so an unexpected write fails the test.

import http from 'node:http';

export async function fakeRegistry(records) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, body });
      const reply = (status, payload) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      const path = req.url.split('?')[0];
      let m;
      if (req.method === 'POST' && (m = /^\/registries\/([^/]+)\/records-list$/.exec(path))) {
        const byName = body.filters?.find((f) => f.name === 'name')?.values?.[0];
        const page = records.filter((r) => (r.registryId ?? 'reg-1') === m[1] && (!byName || r.name === byName));
        return reply(200, { registryRecords: page.map(({ md, registryId, ...r }) => ({ recordType: 'SKILL', updatedAt: '2026-10-01T00:00:00Z', ...r })) });
      }
      if (req.method === 'GET' && (m = /^\/registries\/([^/]+)\/records\/([^/]+)$/.exec(path))) {
        const r = records.find((x) => x.recordId === decodeURIComponent(m[2]));
        if (!r) return reply(404, { message: 'not found' });
        const { md, registryId, ...rest } = r;
        return reply(200, { ...rest, descriptors: { agentSkillsDefinition: { additionalData: { skillMd: { data: md ?? '' } } } } });
      }
      if (req.method === 'PATCH' && (m = /^\/registries\/([^/]+)\/records\/([^/]+)\/status$/.exec(path))) {
        return reply(200, { recordId: decodeURIComponent(m[2]), status: body.status });
      }
      reply(500, { message: `fake registry: unexpected ${req.method} ${path}` });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Environment that sends the SDK to `registry` with dummy credentials and no profile. */
export function registryEnv(base, registry) {
  return {
    ...base,
    AWS_ENDPOINT_URL: registry.url,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    AWS_REGION: 'us-east-1',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  };
}

/** A registry endpoint that answers every request with HTTP 400 ValidationException and `message`. */
export async function failingRegistry(message) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-amzn-errortype', 'ValidationException');
      res.end(JSON.stringify({ message }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
