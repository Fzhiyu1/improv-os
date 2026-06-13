// 点赞 e2e：/api/like 改 meta.likes + 同步内存索引（/api/apps 立即反映）、unlike 递减、clamp 不为负、
// 公网跨站被同源守卫拒。复用真服务；用临时 apps 目录种一个缓存应用，测后清理。
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_PORT = 17315;
const SLUG = 'aaaaaaaaaaaa';
const APP_DIR = path.join(ROOT, 'apps', SLUG);
let child;

function post(pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      port: APP_PORT, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ code: r.statusCode, body: b })); });
    req.on('error', reject); req.end(data);
  });
}
function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ port: APP_PORT, path: pathname }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const likesOf = async slug => (await getJson('/api/apps')).apps.find(a => a.slug === slug)?.likes;

before(async () => {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(path.join(APP_DIR, 'meta.json'), JSON.stringify({ name: '点赞测试', slug: SLUG, opens: 1, likes: 0 }));
  fs.writeFileSync(path.join(APP_DIR, 'index.html'), '<!DOCTYPE html><html></html>');
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: { ...process.env, PORT: String(APP_PORT), ANTHROPIC_AUTH_TOKEN: 'test-key', OC_PORT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 120; i++) {   // 并发跑多个 e2e 时服务启动会抢资源，给足重试窗口
    try { await getJson('/api/stats'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('服务未就绪');
});
after(() => { child?.kill('SIGKILL'); fs.rmSync(APP_DIR, { recursive: true, force: true }); });

test('内网点赞 +1，/api/apps 立即反映（索引同步，零扫盘）', async () => {
  const r = await post('/api/like', { slug: SLUG, op: 'like' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(JSON.parse(r.body).likes, 1);
  assert.strictEqual(await likesOf(SLUG), 1, '索引应即时更新');
});

test('unlike 递减，且不低于 0（clamp）', async () => {
  assert.strictEqual(JSON.parse((await post('/api/like', { slug: SLUG, op: 'unlike' })).body).likes, 0);
  // 再 unlike 一次：已是 0，应仍为 0 不变负
  assert.strictEqual(JSON.parse((await post('/api/like', { slug: SLUG, op: 'unlike' })).body).likes, 0);
});

test('不存在的 slug → 404', async () => {
  assert.strictEqual((await post('/api/like', { slug: 'ffffffffffff', op: 'like' })).code, 404);
});

test('公网（带 cf 头）跨站 Origin 被同源守卫拒 403', async () => {
  const r = await post('/api/like', { slug: SLUG, op: 'like' }, { 'cf-connecting-ip': '203.0.113.9', origin: 'https://evil.com' });
  assert.strictEqual(r.code, 403);
});
