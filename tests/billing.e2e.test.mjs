// 计费 e2e：mock 上游返回带 usage 的 SSE（message_start 含输入/缓存读写，message_delta 含输出），
// 跑一次生成后断言 /api/stats 的 tokens 四类分项精确增长 + 成本按单价换算。ICON_BACKFILL=0 隔离开机图标补齐。
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_PORT = 17316;
const USAGE = { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, out: 500 };
let mock, child;

before(async () => {
  mock = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: USAGE.input_tokens, cache_read_input_tokens: USAGE.cache_read_input_tokens, cache_creation_input_tokens: USAGE.cache_creation_input_tokens, output_tokens: 1 } } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '<!DOCTYPE html><html><body>x</body></html>' } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: USAGE.out }, delta: { stop_reason: 'end_turn' } })}\n\n`);
    res.end();
  });
  await new Promise(r => mock.listen(0, r));
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: {
      ...process.env, PORT: String(APP_PORT),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
      ANTHROPIC_AUTH_TOKEN: 'test-key', OC_PORT: '1',
      ICON_BACKFILL: '0',   // 关掉开机图标补齐，避免污染 token 断言
      PRICE_IN_PER_M: '3', PRICE_OUT_PER_M: '6', PRICE_CACHE_READ_PER_M: '0.3', PRICE_CACHE_WRITE_PER_M: '3.75',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 120; i++) {
    try { await stats(); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('服务未就绪');
});
after(() => { child?.kill('SIGKILL'); mock?.close(); });

function stats() {
  return new Promise((resolve, reject) => {
    http.get({ port: APP_PORT, path: '/api/stats' }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function generate() {
  return new Promise((resolve, reject) => {
    http.get({ port: APP_PORT, path: '/api/generate?type=dock&q=test' }, r => {   // 内网直连免守卫
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

test('生成后 token 四类分项精确入账（输入/输出/缓存读/缓存写分开）', async () => {
  const before = await stats();
  await generate();
  const after = await stats();
  const d = (k, sub) => after[k][sub] - before[k][sub];
  assert.strictEqual(d('tokens', 'in'), USAGE.input_tokens, '未命中输入');
  assert.strictEqual(d('tokens', 'out'), USAGE.out, '输出');
  assert.strictEqual(d('tokens', 'cacheRead'), USAGE.cache_read_input_tokens, '缓存读');
  assert.strictEqual(d('tokens', 'cacheCreate'), USAGE.cache_creation_input_tokens, '缓存写');
  assert.strictEqual(after.totalGens - before.totalGens, 1, '生成计次 +1');
  // totalTokens 全量累加 = in+out+cacheRead+cacheCreate
  assert.strictEqual(after.totalTokens - before.totalTokens, 1000 + 500 + 200 + 50);
});

test('成本按四类单价换算', async () => {
  const before = await stats();
  await generate();
  const after = await stats();
  // 本轮新增成本 = (1000*3 + 500*6 + 200*0.3 + 50*3.75)/1e6 元
  const expectDelta = (1000 * 3 + 500 * 6 + 200 * 0.3 + 50 * 3.75) / 1e6;
  assert.ok(typeof after.cost === 'number', '配了单价应返回数字成本');
  assert.ok(Math.abs((after.cost - before.cost) - expectDelta) < 1e-6, `成本增量应为 ${expectDelta}`);
});
