// 分享深链 OG 卡片 e2e：/?app=<slug> 时 og:title/标题须替换为该应用名（爬虫只看 HTML）。
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_PORT = 17314;
const SLUG = 'abcdef012345';
const FIXTURE = path.join(ROOT, 'apps', SLUG);
let child;

before(async () => {
  fs.mkdirSync(FIXTURE, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, 'meta.json'),
    JSON.stringify({ name: '前任道歉信<生成器>', slug: SLUG, createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(FIXTURE, 'index.html'), '<!DOCTYPE html><html></html>');
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: { ...process.env, PORT: String(APP_PORT), ANTHROPIC_AUTH_TOKEN: 'test-key', OC_PORT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 120; i++) {
    try { await get('/api/stats'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('服务未就绪');
});
after(() => { child?.kill('SIGKILL'); fs.rmSync(FIXTURE, { recursive: true, force: true }); });

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ port: APP_PORT, path: p }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => resolve({ code: r.statusCode, body: b }));
    }).on('error', reject);
  });
}

test('深链 OG：og:title 替换为应用名且 HTML 转义', async () => {
  const { code, body } = await get(`/?app=${SLUG}`);
  assert.strictEqual(code, 200);
  assert.match(body, /og:title" content="有人在现编OS上安装了「前任道歉信&lt;生成器&gt;」"/);
  assert.match(body, /<title>前任道歉信&lt;生成器&gt; — 现编OS<\/title>/);
  assert.match(body, /og:description" content="点开链接直接运行它/);
});

test('普通首页保持默认 OG，不受污染', async () => {
  const { body } = await get('/');
  assert.match(body, /og:title" content="现编OS — 一台没装任何软件的电脑"/);
});

test('不存在的 slug / 非法 slug：原样返回首页不报错', async () => {
  for (const q of ['?app=000000000000', '?app=../../etc', '?app=<script>']) {
    const { code, body } = await get(`/${q}`);
    assert.strictEqual(code, 200);
    assert.match(body, /og:title" content="现编OS — 一台没装任何软件的电脑"/);
  }
});
