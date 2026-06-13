// 内外网分治 e2e：内网直连（私网/回环 socket 且无 cf 头）免同源守卫、走独立 lanGate 保底并发；
// 公网（带 cf-connecting-ip）维持同源守卫与 genGate。复用 slot-leak 同款真服务 + 假流式上游。
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_PORT = 17313;
let mock, child;

before(async () => {
  mock = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tick = setInterval(() => {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '<div>x</div>\n' } })}\n\n`);
    }, 40);
    res.on('close', () => clearInterval(tick));
  });
  await new Promise(r => mock.listen(0, r));
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: {
      ...process.env, PORT: String(APP_PORT),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
      ANTHROPIC_AUTH_TOKEN: 'test-key',
      GEN_CONCURRENCY: '2', LAN_GEN_CONCURRENCY: '2', RATE_PER_HOUR: '100', OC_PORT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 120; i++) {
    try { await live(); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('服务未就绪');
});
after(() => { child?.kill('SIGKILL'); mock?.close(); });

function live() {
  return new Promise((resolve, reject) => {
    http.get({ port: APP_PORT, path: '/api/stats' }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b).live); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

test('内网裸请求（无 Referer 无 Origin）免同源守卫，走 lanGate 而非 genGate', async () => {
  let duringLan, duringFast;
  await new Promise((resolve, reject) => {
    const req = http.get({ port: APP_PORT, path: '/api/generate?type=dock&q=%E6%97%A5%E5%8E%86' }, r => {
      assert.strictEqual(r.statusCode, 200, '内网裸请求应放行');
      r.once('data', async () => {
        const l = await live();
        duringLan = l.lanActive; duringFast = l.fastActive;
        req.destroy(); resolve();           // 顺带验证内网通道断开释放
      });
    });
    req.on('error', reject);
  });
  assert.strictEqual(duringLan, 1, '生成中 lanActive 应为 1');
  assert.strictEqual(duringFast, 0, '不应占用公网 genGate');

  let l;
  for (let i = 0; i < 30; i++) {
    l = await live();
    if (l.lanActive === 0) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.strictEqual(l.lanActive, 0, '内网中途断开后 lanGate 槽位应释放');
});

test('公网裸请求（带 cf 头、无来源）仍被同源守卫拒绝 403', async () => {
  const code = await new Promise((resolve, reject) => {
    http.get({
      port: APP_PORT, path: '/api/generate?type=dock&q=x',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.strictEqual(code, 403);
});
