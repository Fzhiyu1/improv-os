import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_PORT = 17320;
let mock, child;

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ port: APP_PORT, path: pathname }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function readSse(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ port: APP_PORT, path: pathname }, r => {
      let raw = '';
      r.on('data', c => raw += c);
      r.on('end', () => resolve(raw));
    }).on('error', reject);
  });
}

before(async () => {
  mock = http.createServer((req, res) => {
    if (req.url !== '/chat/completions') { res.writeHead(404); return res.end('nope'); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const j = JSON.parse(body);
      assert.strictEqual(j.model, 'openrouter/free');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'google/gemma-4-26b-a4b-it-20260403:free',
        choices: [{
          finish_reason: 'stop',
          message: { content: '```html\n<!DOCTYPE html><html><body><main>低功率计算器</main></body></html>\n```' }
        }],
        usage: { prompt_tokens: 12, completion_tokens: 34 }
      }));
    });
  });
  await new Promise(r => mock.listen(0, r));
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      MODEL_MODE: 'low_power',
      OPENROUTER_API_KEY: 'test-or-key',
      OPENROUTER_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
      OPENROUTER_MODEL: 'openrouter/free',
      ICON_BACKFILL: '0',
      OC_PORT: '1',
      ANTHROPIC_AUTH_TOKEN: 'unused-in-low-power',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 120; i++) {
    try { await getJson('/api/stats'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('服务未就绪');
});
after(() => { child?.kill('SIGKILL'); mock?.close(); });

test('低功率模式 /api/stats 暴露 openrouter runtime', async () => {
  const s = await getJson('/api/stats');
  assert.deepStrictEqual(s.runtime, {
    mode: 'low_power',
    provider: 'openrouter',
    resolvedModel: 'openrouter/free',
  });
});

test('低功率模式 /api/generate 能清理 fenced html 并完成 done', async () => {
  const raw = await readSse('/api/generate?type=dock&q=test&vw=390');
  assert.match(raw, /event: done/);
  assert.match(raw, /低功率计算器/);
  assert.doesNotMatch(raw, /```html/);
});
