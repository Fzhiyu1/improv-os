// 现编OS 内网运维控制台 —— 独立进程（重启主服务不杀自己），零 npm 依赖。
// 只面向内网：绑 0.0.0.0:7101，不进 Cloudflare 隧道（公网不可见）；所有请求需 ADMIN_TOKEN。
// 数据源：主服务 /api/live + /api/stats、apps/activity.ndjson、systemctl、journalctl、health.log。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = path.join(ROOT, '.env');
for (const line of (fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [])) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// ADMIN_TOKEN：缺失则生成并写回 .env（首次部署免手配；token 打到日志供取用）
let TOKEN = process.env.ADMIN_TOKEN || '';
if (!TOKEN) {
  TOKEN = crypto.randomBytes(16).toString('hex');
  fs.appendFileSync(ENV_FILE, `${fs.existsSync(ENV_FILE) && !fs.readFileSync(ENV_FILE, 'utf8').endsWith('\n') ? '\n' : ''}ADMIN_TOKEN=${TOKEN}\n`);
  console.log(`[admin] 已生成 ADMIN_TOKEN=${TOKEN}（写入 .env）`);
}
const PORT = Number(process.env.ADMIN_PORT || 7101);
const BIND = process.env.ADMIN_BIND || '0.0.0.0';
const MAIN = `http://127.0.0.1:${process.env.PORT || 7100}`;
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://os.fzhiyu.dev';
const ACTIVITY_FILE = path.join(ROOT, 'apps', 'activity.ndjson');
const UI_FILE = path.join(ROOT, 'admin', 'public', 'index.html');

// ---------- 鉴权：?token= / Cookie / Bearer，恒时比较 ----------
function authed(req, u) {
  const got = u.searchParams.get('token')
    || (req.headers.cookie || '').match(/(?:^|;\s*)xbadm=([A-Za-z0-9]+)/)?.[1]
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!got || got.length !== TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN)); } catch { return false; }
}

// ---------- 命令执行（系统服务控制要 user bus 环境给 systemctl --user 用）----------
const EXEC_ENV = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}` };
function run(argv, timeout = 15000) {
  return new Promise(resolve => {
    execFile(argv[0], argv.slice(1), { timeout, env: EXEC_ENV, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err ? err.message : '')).trim() }));
  });
}

// ---------- 服务状态 ----------
async function svcStatus() {
  const [imp, cf, oc] = await Promise.all([
    run(['systemctl', 'is-active', 'improv-os']),
    run(['systemctl', 'is-active', 'cloudflared']),
    run(['systemctl', '--user', 'is-active', 'opencode.service']),
  ]);
  const since = await run(['systemctl', 'show', 'improv-os', '-p', 'ActiveEnterTimestamp', '--value']);
  return {
    improv: imp.out || 'unknown', cloudflared: cf.out || 'unknown', opencode: oc.out || 'unknown',
    improvSince: since.out || '',
  };
}

// ---------- 公网端到端（缓存 30s，避免高频打边缘）----------
let pubCache = { t: 0, ok: null, ms: 0 };
function publicCheck() {
  if (Date.now() - pubCache.t < 30000) return Promise.resolve(pubCache);
  const t0 = Date.now();
  return new Promise(resolve => {
    const done = ok => { pubCache = { t: Date.now(), ok, ms: Date.now() - t0 }; resolve(pubCache); };
    try {
      const rq = https.get(`${PUBLIC_URL}/api/stats`, { timeout: 8000 }, r => { r.resume(); done(r.statusCode === 200); });
      rq.on('timeout', () => { rq.destroy(); done(false); });
      rq.on('error', () => done(false));
    } catch { done(false); }
  });
}

// ---------- 主服务 JSON 拉取 ----------
function getJson(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const rq = http.get(url, { timeout }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    rq.on('timeout', () => { rq.destroy(); reject(new Error('timeout')); });
    rq.on('error', reject);
  });
}

// ---------- 系统资源 ----------
async function sysInfo() {
  let memUsedPct = null, memAvailMb = null;
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = Number(mi.match(/MemTotal:\s+(\d+)/)?.[1] || 0);
    const avail = Number(mi.match(/MemAvailable:\s+(\d+)/)?.[1] || 0);
    if (total) { memUsedPct = Math.round((1 - avail / total) * 100); memAvailMb = Math.round(avail / 1024); }
  } catch {}
  const df = await run(['df', '-k', '/']);
  let diskPct = null;
  const m = df.out.split('\n').pop()?.match(/(\d+)%/);
  if (m) diskPct = Number(m[1]);
  return { load: os.loadavg().map(v => +v.toFixed(2)), memUsedPct, memAvailMb, diskPct, uptime: Math.floor(os.uptime()) };
}

// ---------- 时序采样（5s 一个点，保留 720 点 = 1 小时，给曲线用）----------
const series = [];
let lastStats = null;
async function sample() {
  const pt = { t: Date.now() };
  try {
    const live = await getJson(`${MAIN}/api/live`, 4000);
    Object.assign(pt, live);
    try { lastStats = await getJson(`${MAIN}/api/stats`, 4000); pt.totalGens = lastStats.totalGens; pt.totalTokens = lastStats.totalTokens; } catch {}
  } catch { pt.down = true; }
  series.push(pt);
  if (series.length > 720) series.shift();
}
setInterval(sample, 5000);
sample();

// ---------- 活动日志读取 / SSE 直播 ----------
function readActivity(n = 200) {
  let lines = [];
  try { lines = fs.readFileSync(ACTIVITY_FILE, 'utf8').trim().split('\n'); } catch {}
  if (lines.length < n) { try { lines = fs.readFileSync(ACTIVITY_FILE + '.1', 'utf8').trim().split('\n').concat(lines); } catch {} }
  return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function activityStream(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let pos = 0;
  try { pos = fs.statSync(ACTIVITY_FILE).size; } catch {}
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return clearInterval(timer);
    try {
      const st = fs.statSync(ACTIVITY_FILE);
      if (st.size < pos) pos = 0;                       // 轮转过，从头追
      if (st.size > pos) {
        const fd = fs.openSync(ACTIVITY_FILE, 'r');
        const buf = Buffer.alloc(st.size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd);
        pos = st.size;
        for (const line of buf.toString('utf8').split('\n')) if (line.trim()) res.write(`data: ${line.trim()}\n\n`);
      } else res.write(': ping\n\n');
    } catch { res.write(': ping\n\n'); }
  }, 1500);
  req.on('close', () => clearInterval(timer));
}

// ---------- 控制白名单（绝不透传任意命令）----------
const CONTROLS = {
  'restart-improv':      { argv: ['sudo', '-n', 'systemctl', 'restart', 'improv-os'], label: '重启主服务' },
  'stop-improv':         { argv: ['sudo', '-n', 'systemctl', 'stop', 'improv-os'], label: '停止主服务' },
  'start-improv':        { argv: ['sudo', '-n', 'systemctl', 'start', 'improv-os'], label: '启动主服务' },
  'restart-opencode':    { argv: ['systemctl', '--user', 'restart', 'opencode.service'], label: '重启智能体' },
  'stop-opencode':       { argv: ['systemctl', '--user', 'stop', 'opencode.service'], label: '停止智能体' },
  'start-opencode':      { argv: ['systemctl', '--user', 'start', 'opencode.service'], label: '启动智能体' },
  'restart-cloudflared': { argv: ['sudo', '-n', 'systemctl', 'restart', 'cloudflared'], label: '重启公网隧道' },
  'stop-cloudflared':    { argv: ['sudo', '-n', 'systemctl', 'stop', 'cloudflared'], label: '下线公网' },
  'start-cloudflared':   { argv: ['sudo', '-n', 'systemctl', 'start', 'cloudflared'], label: '上线公网' },
};

// ---------- 可调参数白名单（写 .env，重启主服务生效）----------
const CONF_KEYS = {
  GEN_CONCURRENCY:    { min: 1, max: 50, def: 5, label: '快轨并发上限', hint: '同时打上游的生成数（保护上游网关）', kind: 'number' },
  GEN_QUEUE:          { min: 0, max: 200, def: 24, label: '快轨排队上限', hint: '超出直接回「人数较多」', kind: 'number' },
  DEEP_QUEUE:         { min: 0, max: 50, def: 8, label: '深轨排队上限', hint: '完整版/修改的等待队列', kind: 'number' },
  RATE_PER_HOUR:      { min: 1, max: 100000, def: 30, label: '每 IP 每小时', hint: '单人生成次数限制', kind: 'number' },
  DAILY_CAP:          { min: 1, max: 10000000, def: 3000, label: '全站每日次数', hint: '日熔断', kind: 'number' },
  DAILY_TOKEN_BUDGET: { min: 0, max: 1000000000, def: 0, label: '每日 token 预算', hint: '0=不限（合作期）', kind: 'number' },
  UPSTREAM_MAX_RETRY: { min: 0, max: 10, def: 5, label: '429 重试次数', hint: '上游限速退避重试', kind: 'number' },
  MODEL_MODE:         { def: 'normal', label: '运行模式', hint: 'normal=公司网关；ai_gateway=ai.fzhiyu.dev（推荐，快且便宜）；low_power=OpenRouter 免费池', kind: 'enum', options: ['normal', 'ai_gateway', 'low_power'] },
  AI_MODEL:           { def: 'gpt-5.3-codex-spark', label: 'AI 网关模型', hint: 'ai_gateway 模式用的模型 id（gpt-5.3-codex-spark 实测 533 tok/s）', kind: 'text' },
  OPENROUTER_MODEL:   { def: 'openrouter/free', label: '低功率模型', hint: '默认用 OpenRouter 免费路由器；可替换为具体 free 模型 id', kind: 'text' },
};
function envValues() {
  const cur = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && CONF_KEYS[m[1]]) cur[m[1]] = m[2];
    }
  } catch {}
  const out = {};
  for (const [k, meta] of Object.entries(CONF_KEYS)) {
    const raw = cur[k] !== undefined ? cur[k] : meta.def;
    out[k] = { value: meta.kind === 'number' ? Number(raw) : raw, ...meta };
  }
  return out;
}
function setEnvKey(key, value) {
  let txt = ''; try { txt = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(txt)) txt = txt.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  else txt += (txt && !txt.endsWith('\n') ? '\n' : '') + line + '\n';
  fs.writeFileSync(ENV_FILE, txt);
}

// ---------- 日志查看（journalctl 读系统单元可能要权限，失败自动升 sudo -n）----------
async function unitLogs(unit, n) {
  if (unit === 'health') {
    let txt = ''; try { txt = fs.readFileSync(path.join(ROOT, 'health.log'), 'utf8'); } catch {}
    let status = ''; try { status = fs.readFileSync(path.join(ROOT, 'health.status'), 'utf8').trim(); } catch {}
    return `[health.status] ${status || '（无）'}\n\n` + (txt.split('\n').slice(-n).join('\n') || '（health.log 为空——没出过事）');
  }
  if (unit === 'opencode') {
    const r = await run(['journalctl', '--user', '-u', 'opencode.service', '-n', String(n), '--no-pager', '-o', 'short-iso']);
    return r.out || r.err || '（无日志）';
  }
  const sysUnit = unit === 'cloudflared' ? 'cloudflared' : unit === 'admin' ? 'improv-admin' : 'improv-os';
  let r = await run(['journalctl', '-u', sysUnit, '-n', String(n), '--no-pager', '-o', 'short-iso']);
  if (!r.ok || !r.out) r = await run(['sudo', '-n', 'journalctl', '-u', sysUnit, '-n', String(n), '--no-pager', '-o', 'short-iso']);
  return r.out || r.err || '（无日志）';
}

// ---------- HTTP ----------
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('请求格式错误')); } });
  });
}

const LOGIN_HTML = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>现编OS 控制台</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#c9d1d9;font:14px -apple-system,"PingFang SC",sans-serif}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 36px;text-align:center;width:300px}
h1{font-size:16px;margin:0 0 6px}p{color:#8b949e;font-size:12px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:8px 10px;font:inherit;outline:none;text-align:center}
input:focus{border-color:#58a6ff}button{margin-top:12px;width:100%;background:#238636;border:none;border-radius:6px;color:#fff;padding:8px;font:inherit;cursor:pointer}
button:hover{background:#2ea043}</style></head><body>
<div class="card"><h1>现编OS 运维控制台</h1><p>内网访问 · 需要管理令牌</p>
<input id="t" type="password" placeholder="ADMIN_TOKEN" autofocus>
<button onclick="location='/?token='+encodeURIComponent(document.getElementById('t').value)">进入</button>
<script>document.getElementById('t').addEventListener('keydown',e=>{if(e.key==='Enter')location='/?token='+encodeURIComponent(e.target.value)})</script>
</div></body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  // 未鉴权：只给登录页
  if (!authed(req, u)) {
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML); }
    return json(res, 401, { error: '未授权' });
  }
  // query 带 token 进来：种 cookie 并跳到干净地址（防 token 留在地址栏/历史）
  if (u.searchParams.get('token') && u.pathname === '/') {
    res.writeHead(302, { 'set-cookie': `xbadm=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`, location: '/' });
    return res.end();
  }

  try {
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(UI_FILE));
    }

    if (u.pathname === '/api/overview') {
      const [svc, pub, sys] = await Promise.all([svcStatus(), publicCheck(), sysInfo()]);
      let live = null, stats = lastStats;
      try { live = await getJson(`${MAIN}/api/live`, 3000); } catch {}
      return json(res, 200, { svc, pub: { ok: pub.ok, ms: pub.ms, url: PUBLIC_URL }, sys, live, stats, now: Date.now() });
    }

    if (u.pathname === '/api/activity') {
      const n = Math.min(1000, Number(u.searchParams.get('n')) || 200);
      return json(res, 200, { events: readActivity(n) });
    }

    if (u.pathname === '/api/activity/stream') return activityStream(req, res);

    if (u.pathname === '/api/series') return json(res, 200, { series });

    if (u.pathname === '/api/logs') {
      const unit = String(u.searchParams.get('unit') || 'improv-os');
      if (!['improv-os', 'opencode', 'cloudflared', 'health', 'admin'].includes(unit)) return json(res, 400, { error: '未知单元' });
      const n = Math.min(500, Number(u.searchParams.get('n')) || 120);
      return json(res, 200, { unit, text: await unitLogs(unit, n) });
    }

    if (u.pathname === '/api/control' && req.method === 'POST') {
      const b = await readBody(req);
      const ctl = CONTROLS[String(b.action || '')];
      if (!ctl) return json(res, 400, { error: '未知操作' });
      console.log(`[admin] 控制：${ctl.label} (${b.action})`);
      const r = await run(ctl.argv, 30000);
      return json(res, r.ok ? 200 : 500, { ok: r.ok, label: ctl.label, out: r.out, err: r.err });
    }

    if (u.pathname === '/api/env') return json(res, 200, { keys: envValues() });

    if (u.pathname === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      const applied = [];
      for (const [k, v] of Object.entries(b.values || {})) {
        const meta = CONF_KEYS[k];
        if (!meta) continue;
        if (meta.kind === 'number') {
          const n = Math.round(Number(v));
          if (!Number.isFinite(n) || n < meta.min || n > meta.max) return json(res, 400, { error: `${meta.label} 超出范围 [${meta.min}, ${meta.max}]` });
          setEnvKey(k, n); applied.push(`${k}=${n}`);
          continue;
        }
        if (meta.kind === 'enum') {
          const s = String(v || '').trim();
          if (!meta.options.includes(s)) return json(res, 400, { error: `${meta.label} 仅支持 ${meta.options.join('/')}` });
          setEnvKey(k, s); applied.push(`${k}=${s}`);
          continue;
        }
        const s = String(v || '').trim();
        if (!s) return json(res, 400, { error: `${meta.label} 不能为空` });
        setEnvKey(k, s); applied.push(`${k}=${s}`);
      }
      console.log(`[admin] 配置：${applied.join(' ')}`);
      let restarted = false;
      if (b.restart) { const r = await run(CONTROLS['restart-improv'].argv, 30000); restarted = r.ok; }
      return json(res, 200, { ok: true, applied, restarted, needRestart: !b.restart && applied.length > 0 });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e).slice(0, 200) });
  }
});
server.listen(PORT, BIND, () => console.log(`现编OS 控制台运行于 http://${BIND}:${PORT}（内网）`));
