// 运行模式：
//   normal     -> 公司网关（Anthropic /v1/messages 格式）
//   low_power  -> OpenRouter 免费池（OpenAI /chat/completions 格式，已知出站易被劫持/不稳）
//   ai_gateway -> 自建 OpenAI 兼容网关 ai.fzhiyu.dev（走 Cloudflare，不经公司内网劫持，快且便宜）
//   deepseek   -> DeepSeek 官方 API（OpenAI 兼容，国产合规，v4-flash 实测 115 tok/s 单次 ~7800 tok 长输出）
const MODES = new Set(['normal', 'low_power', 'ai_gateway', 'deepseek']);
export function normalizeModelMode(mode) {
  return MODES.has(mode) ? mode : 'normal';
}

export function resolveModelRoute({ mode, normalModel, lowPowerModel = 'openrouter/free', aiModel = 'gpt-5.3-codex-spark', deepseekModel = 'deepseek-v4-flash' }) {
  const modelMode = normalizeModelMode(mode);
  if (modelMode === 'low_power') return { provider: 'openrouter', modelMode, model: lowPowerModel };
  if (modelMode === 'ai_gateway') return { provider: 'ai_gateway', modelMode, model: aiModel };
  if (modelMode === 'deepseek') return { provider: 'deepseek', modelMode, model: deepseekModel };
  return { provider: 'anthropic', modelMode, model: normalModel };
}

export function stripOpenRouterFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:html|xml)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}
