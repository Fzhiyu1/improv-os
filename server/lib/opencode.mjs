// openCode serve 的纯 Node http 客户端（零依赖）。锚定本机 1.1.53 实测的 REST 形态。
import http from 'node:http';

const OC_HOST = process.env.OC_HOST || '127.0.0.1';
const OC_PORT = Number(process.env.OC_PORT || 4096);
const OC_PROVIDER = process.env.OC_PROVIDER || 'gateway';
const OC_MODEL = process.env.OC_MODEL || 'claude-sonnet-4-6';
// sendMessage 在 agent 回合结束前不返回任何字节，socket 空闲超时必须长于深轨硬墙钟（否则它先开枪）
const SEND_TIMEOUT_MS = (Number(process.env.DEEP_TIMEOUT_SEC || 150) + 60) * 1000;

function ocRequest(method, pathname, body, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: OC_HOST, port: OC_PORT, method, path: pathname, timeout,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`opencode ${res.statusCode}: ${buf.slice(0, 200)}`));
        try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('opencode 请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const q = dir => `?directory=${encodeURIComponent(dir)}`;

export async function ocHealth() {
  try { await ocRequest('GET', '/global/health', null, 3000); return true; } catch { return false; }
}

export async function createSession(dir, title = 'improv') {
  const r = await ocRequest('POST', '/session' + q(dir), { title: String(title).slice(0, 60) });
  return r.id;
}

export function sendMessage(sid, dir, { text, system }) {
  return ocRequest('POST', `/session/${sid}/message` + q(dir), {
    model: { providerID: OC_PROVIDER, modelID: OC_MODEL },
    ...(system ? { system } : {}),
    parts: [{ type: 'text', text }],
  }, SEND_TIMEOUT_MS);
}

export async function deleteSession(sid, dir) {
  try { await ocRequest('DELETE', `/session/${sid}` + q(dir), null, 5000); } catch {}
}

// 列出某工作目录下的全部会话（启动时清孤儿用；improv-os 是该目录唯一客户端）
export async function listSessions(dir) {
  try { const r = await ocRequest('GET', '/session' + q(dir), null, 5000); return Array.isArray(r) ? r : []; } catch { return []; }
}

// 订阅事件流：onEvent(evt) 收到每个解析后的事件对象；返回 stop() 关闭连接。
export function subscribeEvents(dir, onEvent) {
  const req = http.request({ host: OC_HOST, port: OC_PORT, method: 'GET', path: '/event' + q(dir), timeout: 0 }, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = raw.split('\n').find(l => l.startsWith('data: '));
        if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch {} }
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return () => { try { req.destroy(); } catch {} };
}
