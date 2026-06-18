import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeModelMode, resolveModelRoute, stripOpenRouterFence } from '../server/lib/model-mode.mjs';

test('normalizeModelMode falls back to normal', () => {
  assert.strictEqual(normalizeModelMode('normal'), 'normal');
  assert.strictEqual(normalizeModelMode('low_power'), 'low_power');
  assert.strictEqual(normalizeModelMode('ai_gateway'), 'ai_gateway');
  assert.strictEqual(normalizeModelMode('deepseek'), 'deepseek');
  assert.strictEqual(normalizeModelMode('weird'), 'normal');
  assert.strictEqual(normalizeModelMode(''), 'normal');
});

test('resolveModelRoute maps modes to providers', () => {
  assert.deepStrictEqual(resolveModelRoute({ mode: 'normal', normalModel: 'claude-sonnet-4-6' }), {
    provider: 'anthropic', modelMode: 'normal', model: 'claude-sonnet-4-6'
  });
  assert.deepStrictEqual(resolveModelRoute({ mode: 'low_power', normalModel: 'claude-sonnet-4-6' }), {
    provider: 'openrouter', modelMode: 'low_power', model: 'openrouter/free'
  });
  assert.deepStrictEqual(resolveModelRoute({ mode: 'ai_gateway', normalModel: 'claude-sonnet-4-6', aiModel: 'gpt-5.3-codex-spark' }), {
    provider: 'ai_gateway', modelMode: 'ai_gateway', model: 'gpt-5.3-codex-spark'
  });
  assert.deepStrictEqual(resolveModelRoute({ mode: 'deepseek', normalModel: 'claude-sonnet-4-6', deepseekModel: 'deepseek-v4-flash' }), {
    provider: 'deepseek', modelMode: 'deepseek', model: 'deepseek-v4-flash'
  });
  // 默认 deepseek 模型
  assert.deepStrictEqual(resolveModelRoute({ mode: 'deepseek', normalModel: 'claude-sonnet-4-6' }), {
    provider: 'deepseek', modelMode: 'deepseek', model: 'deepseek-v4-flash'
  });
});

// 回归：URL 拼接不能用 new URL('/chat/completions', base)——前导 / 会砍掉 base 的 /v1 路径段（曾致 404 / 打到网页前端）
test('chat/completions URL 保留 base 的路径段', () => {
  for (const base of ['https://ai.fzhiyu.dev/v1', 'https://ai.fzhiyu.dev/v1/', 'https://openrouter.ai/api/v1']) {
    const url = new URL(base.replace(/\/+$/, '') + '/chat/completions');
    assert.ok(url.pathname.endsWith('/v1/chat/completions'), `${base} -> ${url.href} 应保留 /v1`);
  }
});

test('stripOpenRouterFence removes fenced html wrapper', () => {
  const input = '```html\n<!DOCTYPE html><html><body>ok</body></html>\n```';
  assert.strictEqual(stripOpenRouterFence(input), '<!DOCTYPE html><html><body>ok</body></html>');
});
