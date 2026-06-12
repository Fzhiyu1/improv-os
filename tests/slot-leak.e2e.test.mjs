// 回归：访客在快轨生成中途断开，并发槽必须释放（2026-06-12 事故）。
// 根因：res close 里 s.current?.destroy() 不带 error 不会触发 'error' 事件 →
// anthropicCall 的 cb 永不执行 → s.step 的 Promise 永久 pending → genGate 槽位永久泄漏，
// 表现为待机时 fastActive 不归零（线上曾长期显示 4/10）。
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_PORT = 17311;
let mock, child;

// 假上游：SSE 持续吐 text_delta 永不结束——保证断开发生在生成中途
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
      ...process.env,
      PORT: String(APP_PORT),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
      ANTHROPIC_AUTH_TOKEN: 'test-key',
      GEN_CONCURRENCY: '2',
      RATE_PER_HOUR: '100',
      OC_PORT: '1',          // 让 opencode 健康检查瞬间失败，跳过启动清扫
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {               // 等服务就绪
    try { await getStats(); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('服务未就绪');
});

after(() => { child?.kill('SIGKILL'); mock?.close(); });

function getStats() {
  return new Promise((resolve, reject) => {
    http.get({ port: APP_PORT, path: '/api/stats' }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// 发起生成，收到首批 SSE 字节后掐断连接（模拟访客中途关页面）
function generateThenDrop(q) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      port: APP_PORT,
      path: `/api/generate?type=dock&q=${encodeURIComponent(q)}`,
      headers: { referer: `http://127.0.0.1:${APP_PORT}/` },   // 过同源守卫
    }, r => {
      if (r.statusCode !== 200) return reject(new Error(`HTTP ${r.statusCode}`));
      r.once('data', () => setTimeout(() => { req.destroy(); resolve(); }, 120));
    });
    req.on('error', reject);
  });
}

test('快轨生成中途断开：并发槽必须释放，fastActive 归零', async () => {
  await generateThenDrop('计算器');
  await generateThenDrop('备忘录');               // 连断两次，GEN_CONCURRENCY=2 全部打满过

  let live;
  for (let i = 0; i < 30; i++) {                  // 3 秒内必须归零
    live = (await getStats()).live;
    if (live.fastActive === 0) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.strictEqual(live.fastActive, 0, `断开后槽位未释放：fastActive=${live.fastActive}（泄漏复现）`);
});
