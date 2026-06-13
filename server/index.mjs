// 现编OS — 单进程服务：静态托管 + SSE 生成代理 + 自编译/自修复循环 + 文件缓存 + 限流
// 零 npm 依赖。key 只存在于环境变量/.env，永不下发前端。
import './lib/env.mjs';   // 必须最先：.env 注入要赶在一切模块层 env 读取之前（import 提升坑）
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeGet } from './lib/ssrf.mjs';
import { makeStore } from './lib/store.mjs';
import { makeLimiter } from './lib/ratelimit.mjs';
import { ocHealth, createSession, sendMessage, deleteSession, listSessions, subscribeEvents } from './lib/opencode.mjs';
import { mapEvent } from './lib/agent-events.mjs';
import { makeGate } from './lib/gate.mjs';
import { clientIp, makeOriginGuard, isLan } from './lib/origin.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PORT = Number(process.env.PORT || 7100);
const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 12000);
const APPS_DIR = path.join(ROOT, 'apps');
const WEB_DIR = path.join(ROOT, 'web');
const STATS_FILE = path.join(APPS_DIR, 'stats.json');
if (!API_KEY) { console.error('缺少 ANTHROPIC_AUTH_TOKEN'); process.exit(1); }
fs.mkdirSync(APPS_DIR, { recursive: true });

// ---------- 全局统计 ----------
let stats = { totalGens: 0, totalTokens: 0, totalVisits: 0 };
try { stats = { ...stats, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) }; } catch {}
function bumpStats(tokens) {
  stats.totalGens++; stats.totalTokens += tokens || 0;
  dailyTokens += tokens || 0;            // 计入今日 token 预算（公网成本硬闸）
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch {}
}
function bumpVisit() {
  stats.totalVisits++;
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch {}
}

// ---------- 活动日志（内网控制台数据源：NDJSON 追加，1MB 轮转一份）----------
const ACTIVITY_FILE = path.join(APPS_DIR, 'activity.ndjson');
// 累计浏览量计数器首次启用：用尚存的活动日志做种子（轮转只剩 ~2MB 窗口，必然低估真实历史）
if (!stats.totalVisits) {
  let seed = 0;
  for (const f of [ACTIVITY_FILE + '.1', ACTIVITY_FILE]) {
    try { seed += fs.readFileSync(f, 'utf8').split('\n').filter(l => l.includes('"type":"visit"')).length; } catch {}
  }
  if (seed) { stats.totalVisits = seed; try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch {} }
}
function logActivity(type, data = {}) {
  try {
    if (fs.existsSync(ACTIVITY_FILE) && fs.statSync(ACTIVITY_FILE).size > 1024 * 1024)
      fs.renameSync(ACTIVITY_FILE, ACTIVITY_FILE + '.1');
    fs.appendFileSync(ACTIVITY_FILE, JSON.stringify({ t: Date.now(), type, ...data }) + '\n');
  } catch {}
}
// 近 5 分钟活跃访客（纯内存，控制台「在线人数」用）
const seenIps = new Map();
function touchVisitor(ip) {
  seenIps.set(ip, Date.now());
  if (seenIps.size > 2000) { const now = Date.now(); for (const [k, t] of seenIps) if (now - t > 300_000) seenIps.delete(k); }
}
function visitors5m() { const now = Date.now(); let n = 0; for (const t of seenIps.values()) if (now - t < 300_000) n++; return n; }

// ---------- 限流（三道闸：每 IP 每小时 + 全站每日次数 + 全站每日 token 预算）----------
const RATE_PER_HOUR = Number(process.env.RATE_PER_HOUR || 30);
const DAILY_CAP = Number(process.env.DAILY_CAP || 3000);
const DAILY_TOKEN_BUDGET = Number(process.env.DAILY_TOKEN_BUDGET || 0); // 0=不限；公网设正值即开 token 硬熔断
const ipHits = new Map();
let dailyCount = 0, dailyTokens = 0, dailyDate = new Date().toDateString();
function rateCheck(ip) {
  const today = new Date().toDateString();
  if (today !== dailyDate) { dailyDate = today; dailyCount = 0; dailyTokens = 0; }
  if (DAILY_TOKEN_BUDGET > 0 && dailyTokens >= DAILY_TOKEN_BUDGET) return 'budget';
  if (dailyCount >= DAILY_CAP) return 'daily';
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < 3600_000);
  if (hits.length >= RATE_PER_HOUR) { ipHits.set(ip, hits); return 'ip'; }
  hits.push(now); ipHits.set(ip, hits); dailyCount++;
  return null;
}

// ---------- 内容黑名单（轻量兜底，prompt 内另有拒绝指令；收紧到绝对高风险词，避免误杀历史/心理/影评类正常搜索） ----------
const BLOCK = /(色情|裸体|porn|nude|赌博|毒品|炸弹|爆炸物|枪支弹药|习近平|政治敏感)/i;

// ---------- 运行时能力（生成应用经父窗口桥调用） ----------
const STORE_DIR = path.join(APPS_DIR, '_store');
const store = makeStore(STORE_DIR, { block: s => BLOCK.test(s) });
// 受 AI 审核的 store 命名空间（公开留言墙等 UGC 直接展示给所有访客的应用）。逗号分隔 appId。
const MODERATED = new Set((process.env.MODERATED_APPIDS || '').split(',').map(s => s.trim()).filter(Boolean));
// AI 审核闸：小调用判断 UGC 是否适合公开展示。判定失败（上游异常）按拒绝处理——公开墙宁严勿漏。
function moderate(text) {
  return new Promise(resolve => {
    anthropicCall({
      system: '你是内容审核员。判断给定的访客留言能否在面向所有人（含未成年人）的公开留言墙上展示。拒绝：辱骂攻击、色情、暴力、赌博毒品、政治敏感、广告引流（含联系方式/网址）、人肉隐私。允许：正常问候、吐槽、玩笑、对网站的评价（包括差评）。只输出一行：OK 或 NO:原因（4字内）。',
      messages: [{ role: 'user', content: String(text).slice(0, 2000) }],
      maxTokens: 20,
    }, (err, r) => {
      if (err) return resolve({ ok: false, reason: 'upstream' });
      const t = String(r.text || '').trim();
      resolve(t.startsWith('OK') ? { ok: true } : { ok: false, reason: t.replace(/^NO:?/, '').slice(0, 12) || '未通过' });
    });
  });
}
// 慢轨 agent：固定工作目录（并发限 1 保证不冲突）+ 验证脚本源
const AGENT_WORK = path.join(APPS_DIR, '_agent');
const VERIFIER_SRC = path.join(ROOT, 'server', 'verify-html.mjs');
const agentGate = makeGate(1, Number(process.env.DEEP_QUEUE || 8));   // 深轨并发 1 + 队列上限
const DEEP_TIMEOUT_MS = Number(process.env.DEEP_TIMEOUT_SEC || 150) * 1000; // 硬墙钟超时：挂死的 agent 不能占着唯一坑位堵死慢轨

// 快轨全局并发闸：保护上游测试网关不被打爆（值按上游能承受的并发调）
const GEN_CONCURRENCY = Number(process.env.GEN_CONCURRENCY || 5);
const GEN_QUEUE = Number(process.env.GEN_QUEUE || 24);
const genGate = makeGate(GEN_CONCURRENCY, GEN_QUEUE);
// 内网保底通道：公网把 genGate 打满时，内网同事仍有自己的并发坑位（上游总并发上限 = GEN + LAN_GEN）。
// 内网（isLan）同时免一切限流与同源守卫；内容黑名单内外网一视同仁。
const LAN_GEN_CONCURRENCY = Number(process.env.LAN_GEN_CONCURRENCY || 3);
const lanGate = makeGate(LAN_GEN_CONCURRENCY, Number(process.env.LAN_GEN_QUEUE || 16));
const capLimit = {
  ai: makeLimiter({ windowMs: 60000, max: Number(process.env.CAP_AI_PER_MIN || 20) }),
  http: makeLimiter({ windowMs: 60000, max: Number(process.env.CAP_HTTP_PER_MIN || 30) }),
  store: makeLimiter({ windowMs: 60000, max: Number(process.env.CAP_STORE_PER_MIN || 120) }),
};

// 反盗用同源守卫：烧 token / 触发上游的接口只接受来自本站页面的请求（白名单可经 .env ALLOWED_ORIGINS 扩展）
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const originOk = makeOriginGuard(ALLOWED_ORIGINS);
const GUARDED = new Set(['/api/generate', '/api/modify', '/api/repair', '/api/capability/ai', '/api/capability/http', '/api/capability/store']);

// 转义用户输入，防止 prompt 注入（换行/引号截断 system prompt）
const escapeForPrompt = s => JSON.stringify(String(s)).slice(1, -1);

// ---------- 注入每个生成应用的系统层：基础样式 + 崩溃上报 ----------
const SYS_INJECT = `<style id="__sys">
:root{--bg:#f5f5f7;--panel:#fff;--line:#e3e3e6;--blue:#0a82ff;--text:#1d1d1f;--dim:#86868b}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Helvetica Neue",sans-serif;font-size:13px;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#c9c9ce;border-radius:4px}::-webkit-scrollbar-track{background:transparent}
button{font:inherit;border:1px solid var(--line);background:#fff;border-radius:6px;padding:4px 12px;cursor:pointer;color:var(--text)}
button:hover{background:#f7f7f9}button:active{background:#ededf0}
button.primary{background:var(--blue);border-color:var(--blue);color:#fff}button.primary:active{filter:brightness(.92)}
input,select,textarea{font:inherit;border:1px solid var(--line);border-radius:6px;padding:4px 9px;background:#fff;color:var(--text);outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(10,130,255,.18)}
</style>
<script>window.addEventListener('error',function(e){try{parent.postMessage({type:'apperror',message:String((e&&(e.message||e.error))||'未知错误').slice(0,300)},'*')}catch(_){}});<\/script>
<script id="__ime">/* 输入法守卫：中文选词的回车（含 Safari compositionend 先于 keydown 的怪癖）不传给应用 */
(function(){var t=0;addEventListener('compositionend',function(){t=Date.now()},true);
addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.isComposing||e.keyCode===229||Date.now()-t<100))e.stopImmediatePropagation()},true)})();<\/script>
<script id="__ls">/* 沙箱 iframe 无 allow-same-origin 时 localStorage 直接抛 SecurityError——换成内存垫片，应用代码无感知（跨会话记忆请用 os.store） */
(function(){try{localStorage.length}catch(e){var m={};var shim={getItem:function(k){return k in m?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};try{Object.defineProperty(window,'localStorage',{value:shim});Object.defineProperty(window,'sessionStorage',{value:shim})}catch(_){}}})();<\/script>
<script>
(function(){
  var seq=0, waiting={}, appId=null, queued=[];
  window.addEventListener('message',function(e){
    var d=e.data;
    if(!d||d.__os!==true)return;
    if(d.kind==='init'){ if(appId===null){ appId=d.appId; queued.forEach(function(f){f()}); queued=[]; } return; }
    if(d.id&&waiting[d.id]){ var w=waiting[d.id]; delete waiting[d.id]; d.ok?w.resolve(d.result):w.reject(new Error(d.error||'调用失败')); }
  });
  function call(cap,method,args){
    return new Promise(function(resolve,reject){
      function go(){
        var id=++seq; waiting[id]={resolve:resolve,reject:reject};
        parent.postMessage({__os:true,id:id,cap:cap,method:method,args:args},'*');
        setTimeout(function(){ if(waiting[id]){delete waiting[id];reject(new Error('请求超时'))} },20000);
      }
      appId!==null?go():queued.push(go);
    });
  }
  window.os={
    ai:{ ask:function(p){return call('ai','ask',{prompt:p})} },
    http:{ get:function(url){return call('http','get',{url:url})} },
    store:{
      get:function(k){return call('store','op',{op:'get',key:k})},
      set:function(k,v){return call('store','op',{op:'set',key:k,value:v})},
      keys:function(){return call('store','op',{op:'keys'})},
      del:function(k){return call('store','op',{op:'del',key:k})}
    }
  };
})();
<\/script>`;

function injectSys(html) {
  if (html.includes('id="__sys"')) return html;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + '\n' + SYS_INJECT);
  const h = html.match(/<html[^>]*>/i);
  if (h) return html.replace(h[0], h[0] + '\n<head>' + SYS_INJECT + '</head>');
  return SYS_INJECT + html;
}

// ---------- 生成 prompt（口径：一本正经的 macOS，绝不玩梗） ----------
const STYLE_NOTE = `系统会自动注入基础样式（body 字体与重置、macOS 风格滚动条、button/input/select/textarea 控件样式，及 CSS 变量 --bg/--panel/--line/--blue/--text/--dim）。不要重写这些基础，直接使用；你只写应用布局与特有样式。`;

const SYSTEM_PROMPT = `你是 macOS 系统应用的开发者。用户在 macOS 上打开了一个应用，你负责输出这个应用。

规则：
1. 输出一个完整的、自包含的单文件 HTML 应用，从 <!DOCTYPE html> 开始，到 </html> 结束。除此之外不输出任何文字、解释或 markdown 代码围栏。
2. 禁止引用任何外部资源（无 CDN、无外链图片、无外部字体、无网络请求）。图标用内联 SVG（SF Symbols 风格细线条图标），避免用 emoji 充当界面图标。
3. ${STYLE_NOTE}
4. 视觉风格：严肃、克制、专业地还原 macOS 原生应用的设计语言——工具栏、侧栏、列表、1px var(--line) 分隔线、8-10px 圆角、克制的留白。不要花哨渐变和夸张配色。
5. 精炼实现：目标 250 行以内。优先保证核心功能完整可用，砍掉装饰性内容和次要功能；示例数据 3-5 条即可，但要可信、专业。JS 不用任何框架，直接操作 DOM。
6. 应用必须真实可用，绝不开玩笑、不留彩蛋、不自我指涉、不解释自己是 AI 或生成的。绝不在界面任何位置（应用标题、菜单、按钮、标签、列表数据）使用 emoji，装饰与图标一律用内联 SVG 或纯文本。
7. 应用填满整个视口（窗口外框由系统提供，你只写窗口内容区）。中文界面。凡监听键盘 Enter 提交的输入框，keydown 里先 if (e.isComposing || e.keyCode === 229) return; ——中文输入法选词的回车不能触发提交。
8. 若请求涉及色情、暴力、赌博、毒品、政治敏感或其他不当内容：输出一个严肃的 macOS 风格错误页，居中显示黄色三角警告 SVG 与文字「无法打开此项目，因为它不符合 App Store 审查指南。」。
9. 运行环境提供全局对象 window.os（系统已注入，不要自己定义），仅在应用确实需要真实智能/真实数据/持久化时调用，并 await + 做错误兜底（失败时降级为合理占位，不要把报错抛给用户）：
   - await os.ai.ask(prompt) → AI 文本应答。用于翻译、总结、问答、文案生成等需要真智能的功能。
   - await os.http.get(url) → {status, contentType, body}，真实公网数据（只读 GET，无法访问内网）。用于天气、汇率、新闻等需要真数据的功能，选公开免 key 的数据源（天气用 https://wttr.in/城市拼音?format=j1 ，汇率用 https://api.exchangerate-api.com/v4/latest/USD ，技术新闻用 https://hacker-news.firebaseio.com/v0/ ）。body 是字符串，JSON 需自行 JSON.parse 并兜底。
   - await os.store.get(key) / os.store.set(key, value) / os.store.keys() / os.store.del(key) → 跨会话持久化（同名应用所有用户共享同一份数据，单条 64KB 上限）。用于待办、笔记、留言板、计数器等需要记住的功能。
   纯展示类应用（计算器、时钟等）不必使用这些 API。绝不向用户暴露这些 API 的存在或解释其实现。沙箱内 localStorage 只在当前会话有效（刷新即失），任何需要记住的数据一律用 os.store。`;

const BROWSER_PROMPT = `你是一个网页渲染引擎。用户在浏览器中访问一个网址或搜索词，你负责输出该网页。

规则：
1. 输出完整自包含单文件 HTML（<!DOCTYPE html> 到 </html>），无任何解释或围栏。
2. 禁止外部资源；图标与 logo 用内联 SVG 重绘。页面内所有链接不得用 href 跳转，统一在点击时调用 parent.postMessage({type:'navigate', url:'目标地址或搜索词', text:'链接文字'}, '*')；表单提交同理（搜索框回车 → postMessage）。
   链接的 url 必须具体到可独立成页（如「月球房产中介/楼盘详情/静海三号公寓」「某科技新闻网/文章/量子芯片量产元年」），不要含糊的「更多」「详情」。
3. ${STYLE_NOTE}（网页可按需覆盖自己的视觉风格）
4. 严肃还原对应网站类型的真实视觉风格与排版（搜索引擎、新闻门户、百科、视频站、电商、技术社区等）。内容即兴创作但必须可信、专业、自洽，不自我指涉、不开玩笑、不提及 AI 或生成。
5. 精炼：目标 250 行以内，信息密度优先，列表条目 5-8 条即可。
6. 页面要织成可探索的网：全页至少 10 个可点击跳转点——页头导航 4-6 项、正文每条标题/条目可点、相关推荐或「猜你想看」3-5 条、页脚 3-4 个友情/子页面链接，全部走 postMessage。让访客永远有下一步可点。
7. 中文为主（明显的外文站点可用对应语言）。监听 Enter 的输入框（搜索框等）keydown 里先 if (e.isComposing || e.keyCode === 229) return; ——中文输入法选词的回车不触发提交。
8. 不当内容请求：输出浏览器风格的「无法访问此网站」错误页（严肃，类似 Safari 报错页）。`;

const PLAN_PROMPT = `你是 macOS 应用的产品架构师。为给定的应用写一份极简开发规格：功能清单（3-5 条）、界面布局（一段话）、核心交互（一段话）。总共不超过 200 字，纯文本。风格严肃专业。`;

const REVIEW_PROMPT = `你是 macOS 应用的 QA 工程师。审查给定的 HTML 应用代码，列出最多 4 个最重要的问题（功能缺陷、交互不可用、明显 bug）。每条一行，简短。纯文本。如果代码质量良好，输出「验收通过」。`;

// 窄屏（手机全屏窗口）追加的布局要求：桌面三栏布局塞进 ~390px 会直接挤爆
function mobileNote(type, vw) {
  if (!vw || vw > 760) return '';
  return type === 'browser'
    ? `\n目标设备是手机（视口宽约 ${vw}px）：输出该网站的移动版排版——单栏流式布局、顶部汉堡菜单或横滑导航、卡片纵向堆叠、触摸目标 ≥44px、正文字号 ≥14px，不出现需要横向滚动的桌面布局。`
    : `\n目标设备是手机（视口宽约 ${vw}px 的全屏窗口）：单栏布局；侧栏改为顶部分段控件、横滑标签或可折叠抽屉；触摸目标 ≥44px、正文字号 ≥14px；hover 交互改为点击；底部留出操作空间，不出现需要横向滚动的桌面布局。`;
}

function buildUserPrompt(type, q, ctx, vw) {
  const s = escapeForPrompt(q);
  if (type === 'browser') {
    let trail = '';
    if (ctx && ctx.from) {
      const fromName = escapeForPrompt(ctx.fromTitle || ctx.from);
      trail = `\n来路：用户正在浏览「${fromName}」(${escapeForPrompt(ctx.from)})${ctx.link ? `，点击了「${escapeForPrompt(ctx.link)}」` : ''}跳转而来。` +
        `\n若目标与来路同属一个站点：保持同站连贯——相同的站名、配色、页头导航与页脚，内容与来路页面承接呼应（点的是哪条就讲哪条），绝不自相矛盾；若是不同站点：全新设计，不受来路影响。` +
        (ctx.style ? `\n来路页面的样式开头如下（同站时延续其中的配色、字体与圆角体系）：\n${escapeForPrompt(ctx.style)}` : '');
    }
    return `用户访问：${s}${trail}${mobileNote(type, vw)}\n渲染这个网页。`;
  }
  return `应用名称：「${s}」${mobileNote(type, vw)}\n输出这个应用。`;
}

// ---------- 上游调用 ----------
const UPSTREAM_MAX_RETRY = Number(process.env.UPSTREAM_MAX_RETRY || 5);
function anthropicCall(opts, cb, attempt = 0) {
  const { system, messages, maxTokens, onThinking, onText } = opts;
  const body = JSON.stringify({
    model: MODEL, max_tokens: maxTokens, stream: true,
    thinking: { type: 'disabled' },
    system, messages,
  });
  const url = new URL('/v1/messages', BASE_URL);
  const up = (url.protocol === 'http:' ? http : https).request(url, {
    method: 'POST', timeout: 180_000,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(body) },
  }, r => {
    // 上游限速 429：指数退避重试（网关有 RPM 限速，瞬时超速自动恢复 + 形成背压）
    if (r.statusCode === 429 && attempt < UPSTREAM_MAX_RETRY) {
      r.resume();                                   // drain 响应体，释放连接
      const backoff = Math.min(10000, 600 * 2 ** attempt) + Math.floor(Math.random() * 500);
      logActivity('retry429', { attempt: attempt + 1, backoff });
      setTimeout(() => { if (!opts.isAborted?.()) anthropicCall(opts, cb, attempt + 1); }, backoff);
      return;
    }
    if (r.statusCode !== 200) {
      let err = ''; r.on('data', c => err += c);
      r.on('end', () => {
        console.error(`[上游错误] ${r.statusCode} (重试 ${attempt} 次后): ${err.slice(0, 200)}`); // 仅服务端日志，不回传前端
        logActivity('upstream_error', { status: r.statusCode, retries: attempt });
        const e = new Error('生成服务暂时不可用，请稍后重试。');
        e.userSafe = true;
        cb(e);
      });
      return;
    }
    let buf = '', full = '', tokens = 0, stopReason = null;
    r.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = evt.split('\n').find(l => l.startsWith('data: '))?.slice(6);
        if (!data) continue;
        try {
          const d = JSON.parse(data);
          if (d.type === 'content_block_delta') {
            if (d.delta?.type === 'thinking_delta') onThinking?.(d.delta.thinking);
            else if (d.delta?.type === 'text_delta') { full += d.delta.text; onText?.(d.delta.text); }
          } else if (d.type === 'message_delta') {
            if (d.usage) tokens = d.usage.output_tokens || tokens;
            if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
          }
        } catch {}
      }
    });
    r.on('end', () => cb(null, { text: full, tokens, stopReason }));
  });
  up.on('timeout', () => up.destroy(new Error('上游超时')));
  up.on('error', e => cb(e));
  up.end(body);
  opts.onRequest?.(up);   // 让会话拿到现役请求句柄（429 重试会换新请求，destroy 要打到现役那只）
  return up;
}

function cleanHtml(t) {
  let html = t.trim().replace(/^```html?\n?/, '').replace(/\n?```\s*$/, '');
  const start = html.search(/<!DOCTYPE/i);
  if (start > 0) html = html.slice(start);
  return html;
}
const hasDoctype = h => /^<!DOCTYPE/i.test(h);
const hasClose = h => /<\/html>\s*$/i.test(h);

// 自编译：结构检查 + 每个 <script> 块做真实语法编译
function compileCheck(html) {
  const issues = [];
  if (!hasDoctype(html)) issues.push('文档没有以 <!DOCTYPE html> 开头');
  if (!hasClose(html)) issues.push('文档没有以 </html> 结束（输出被截断或不完整）');
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '', js = m[2];
    if (/type\s*=\s*["']?(module|application\/json|text\/template)/i.test(attrs)) continue;
    if (!js.trim()) continue;
    try { new vm.Script(js); } catch (e) {
      issues.push(`脚本语法错误：${String(e.message).slice(0, 160)}`);
    }
  }
  return issues;
}

// ---------- SSE ----------
function sse(res, event, data) {
  if (res.writableEnded || res.destroyed) return; // 客户端已断开，别再写
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function saveApp({ slug, name, html, tokens, secs, mode }) {
  const dir = path.join(APPS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  let opens = 0, createdAt = new Date().toISOString();
  try { const old = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); opens = old.opens || 0; createdAt = old.createdAt || createdAt; } catch {}
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name, slug, createdAt, updatedAt: new Date().toISOString(), tokens, secs, mode: mode || 'fast', opens }, null, 2));
  indexApp(slug);          // 落盘即更新内存索引（创建或重新生成都覆盖）
  queueIcon(slug, name);   // 异步配一个 AI 设计的图标，不阻塞主流程
}

// ---------- AI 应用图标：落盘后异步生成，存量开机补齐（独立 1 并发闸不抢访客通道）----------
const ICON_PROMPT = `你是 macOS 应用图标设计师。为给定应用输出一个内联 SVG 图标：
- 只输出 <svg>…</svg>，无任何解释、无 markdown 围栏。
- viewBox="0 0 64 64"；背景是 <rect x="2" y="2" width="60" height="60" rx="14"> 的 squircle，配贴合应用主题的双色 linearGradient；中央一个简洁有辨识度的图形符号（细线条或填充，SF Symbols 气质），构图克制。
- 不含任何文字、<script>、<image>、<foreignObject>、事件属性或外部引用。渐变 id 用与应用相关的独特字符串，避免与同屏其他图标冲突。`;
const iconGate = makeGate(1, 300);
function queueIcon(slug, name) {
  const f = path.join(APPS_DIR, slug, 'icon.svg');
  if (fs.existsSync(f)) return;
  iconGate.run(() => new Promise(resolve => {
    if (fs.existsSync(f)) return resolve();
    anthropicCall({
      system: ICON_PROMPT,
      messages: [{ role: 'user', content: `应用名称：「${escapeForPrompt(String(name).slice(0, 60))}」` }],
      maxTokens: 1500,
    }, (err, r) => {
      try {
        const svg = !err && String(r.text).match(/<svg[\s\S]*<\/svg>/i)?.[0];
        // 安全闸：SVG 经 <img> 引用不执行脚本，但仍拒绝一切可执行/外联痕迹
        if (svg && svg.length < 20000 && !/<script|<image|<foreignObject|<use|on\w+\s*=|javascript:|href\s*=/i.test(svg)) {
          fs.writeFileSync(f, svg);
          const cur = appIndex.get(slug); if (cur) cur.icon = true;   // 图标就绪：启动台下次列出即用 <img>
          logActivity('icon', { slug, q: String(name).slice(0, 60) });
        }
      } catch {}
      // 节流：每个图标之间留足间隔，绝不与访客抢上游 RPM（2026-06-12 补齐任务曾打满网关引发 429 风暴）
      setTimeout(resolve, ICON_PACE_MS);
    });
  })).catch(() => {});
}
const ICON_PACE_MS = Number(process.env.ICON_PACE_SEC || 25) * 1000;

// ---------- 生成会话：带自动续写与自动修复的流水线 ----------
function makeSession(req, res) {
  const s = { aborted: false, current: null, totalTokens: 0, abortStep: null };
  // 断开检测必须挂在 res 上：Node 15+ 的 req(IncomingMessage) close 在「消息体读完」就触发——
  // GET 没人读 body 侥幸无感，POST（修复）读完 body 即触发，曾导致修复一启动就自杀且永久沉默
  // destroy() 不带 error 不会发 'error' 事件 → cb 永不执行 → step 的 Promise 永久 pending——
  // 曾导致访客中途关页面就永久泄漏一个并发槽（待机 fastActive 不归零），必须手动 reject 摇醒等待者
  res.on('close', () => {
    if (res.writableEnded) return;
    s.aborted = true;
    try { s.current?.destroy(); } catch {}
    s.abortStep?.(new Error('aborted'));
  });
  s.step = opts => new Promise((resolve, reject) => {
    if (s.aborted) return reject(new Error('aborted'));
    s.abortStep = reject;
    opts.isAborted = () => s.aborted;             // 429 退避窗口里断开：不再发起重试白烧上游
    opts.onRequest = up => { s.current = up; };
    s.current = anthropicCall(opts, (err, r) => {
      s.abortStep = null;
      if (err) return reject(err);
      s.totalTokens += r.tokens;
      resolve(r);
    });
  });
  return s;
}

// 核心：生成 → 截断续写 → 编译检查 → 修复，全程 SSE 直播
async function producePage(s, res, { system, userPrompt, label }) {
  let r = await s.step({
    system, messages: [{ role: 'user', content: userPrompt }],
    maxTokens: MAX_TOKENS, onText: t => sse(res, 'code', { t }),
  });
  // 用清理后的 HTML 作为续写上下文（去掉 markdown 围栏，保证 assistant 前缀干净一致）
  let html = cleanHtml(r.text);

  let contRounds = 0;
  while (!hasClose(html) && r.stopReason === 'max_tokens' && contRounds < 2) {
    contRounds++;
    sse(res, 'stage', { name: 'continue', label: '正在写入剩余组件' });
    r = await s.step({
      system,
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: html },
      ],
      maxTokens: MAX_TOKENS, onText: t => sse(res, 'code', { t }),
    });
    html = cleanHtml(html + r.text);
  }

  // 编译检查 → 修复（1 轮）
  let issues = compileCheck(html);
  if (issues.length && !s.aborted) {
    sse(res, 'stage', { name: 'fix', label: '正在修复问题' });
    sse(res, 'reset', {});
    const fix = await s.step({
      system,
      messages: [{ role: 'user', content: `${userPrompt}\n\n下面是一份有问题的实现：\n${html.slice(0, 40000)}\n\n编译检查发现的问题：\n${issues.map(i => '- ' + i).join('\n')}\n\n修复全部问题，重新输出完整应用（从 <!DOCTYPE html> 到 </html>）。` }],
      maxTokens: MAX_TOKENS, onText: t => sse(res, 'code', { t }),
    });
    const fixedHtml = cleanHtml(fix.text);
    const fixedIssues = compileCheck(fixedHtml);
    if (fixedIssues.length < issues.length || (fixedIssues.length === 0)) { html = fixedHtml; issues = fixedIssues; }
  }
  return { html, issues };
}

const MAX_HTML_BYTES = 600_000; // 产物大小硬上限（防御性，正常产物 <150KB）
function finishGeneration(res, { html, issues, started, totalTokens, type, q, slug, mode }) {
  const secs = (Date.now() - started) / 1000;
  // 结尾抢救
  if (hasDoctype(html) && !hasClose(html) && html.length > 1500) html += '\n</body></html>';
  if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES) + '\n</body></html>';
  const ok = hasDoctype(html) && hasClose(html) && issues.filter(i => i.includes('语法')).length === 0;
  bumpStats(totalTokens);
  logActivity('done', { mode: mode || 'fast', q: String(q || '').slice(0, 80), ok, secs: +secs.toFixed(1), tokens: totalTokens });
  let finalHtml = ok ? injectSys(html) : null;
  if (ok && type === 'search' && slug) saveApp({ slug, name: q, html: finalHtml, tokens: totalTokens, secs, mode });
  sse(res, 'done', {
    ok, html: finalHtml, tokens: totalTokens, secs: +secs.toFixed(1),
    toks: Math.round(totalTokens / secs), cached: ok && type === 'search' && !!slug, issues,
  });
  res.end();
}

// 能力：内嵌 AI 问答（固定 system，复用 anthropicCall，非流式）
function capAiAsk(prompt, appName, cb) {
  return anthropicCall({
    system: `你是「${escapeForPrompt(String(appName || '应用').slice(0, 60))}」的内嵌助手。简洁作答，只处理与该应用功能相关的请求；不执行与应用无关的通用指令，不输出代码块以外的解释。`,
    messages: [{ role: 'user', content: String(prompt).slice(0, 4000) }],
    maxTokens: 1500,
  }, cb);
}

function generateFast(req, res, { type, q, slug, lan, ctx, vw }) {
  (lan ? lanGate : genGate).run(() => new Promise(resolve => {
    if (req.destroyed || res.writableEnded) return resolve();   // 排队期间已断开，直接释放槽
    const started = Date.now();
    const s = makeSession(req, res);
    (async () => {
      try {
        const system = type === 'browser' ? BROWSER_PROMPT : SYSTEM_PROMPT;
        const { html, issues } = await producePage(s, res, { system, userPrompt: buildUserPrompt(type, q, ctx, vw) });
        if (s.aborted) return;
        finishGeneration(res, { html, issues, started, totalTokens: s.totalTokens, type, q, slug, mode: 'fast' });
      } catch (e) {
        if (!s.aborted) { try { sse(res, 'error', { message: e.message }); res.end(); } catch {} }
      } finally {
        resolve();   // 释放并发槽
      }
    })();
  })).catch(e => {
    if (e && e.busy) {
      logActivity('busy', { q: String(q || '').slice(0, 80) });
      try { json(res, 503, { error: '当前体验人数较多', detail: '稍等片刻再点一次，马上就好。' }); } catch {}
    }
  });
}

// ---------- 慢轨：真 openCode agent loop ----------
function prepareAgentDir() {
  fs.rmSync(AGENT_WORK, { recursive: true, force: true });
  fs.mkdirSync(AGENT_WORK, { recursive: true });
  fs.copyFileSync(VERIFIER_SRC, path.join(AGENT_WORK, 'verify-html.mjs'));
}
function readAgentHtml() {
  const f = path.join(AGENT_WORK, 'app.html');
  if (!fs.existsSync(f)) throw new Error('智能体未产出应用文件');
  return cleanHtml(fs.readFileSync(f, 'utf8'));
}

const AGENT_RULES = `要求：
- 完整自包含单文件（<!DOCTYPE html> 到 </html>），不引用任何外部资源，图标用内联 SVG（SF Symbols 风格细线条），界面不用 emoji。
- 严肃还原 macOS 原生设计语言：工具栏/侧栏/列表/1px 分隔线/8-10px 圆角/克制留白。中文界面，应用填满视口，真实可用，绝不开玩笑、不自我指涉、不提及 AI 或生成。监听 Enter 的输入框 keydown 先 if (e.isComposing || e.keyCode === 229) return; ——中文输入法选词回车不触发提交。
- 运行环境提供全局对象 window.os（系统会自动注入，请勿自己定义），按需 await 调用并做错误兜底：os.ai.ask(prompt) 真智能问答；os.http.get(url) 公网只读数据（天气用 https://wttr.in/城市拼音?format=j1 ，汇率用 https://api.exchangerate-api.com/v4/latest/USD）；os.store.get/set/keys/del 跨会话共享持久化（同名应用共享数据）。纯展示类应用不必使用。
- 写完后运行 \`node verify-html.mjs app.html\` 验证；若报问题就修复并重新验证，直到输出 OK。完成后简短确认即可，不要解释实现。`;

function buildAgentTask(appName) {
  return `你是一名 macOS 应用工程师。在当前目录创建文件 app.html，这是一个名为「${appName}」的 macOS 风格单文件 HTML 应用。\n\n${AGENT_RULES}`;
}
function buildModifyTask(appName, instruction) {
  return `当前目录的 app.html 是一个名为「${appName}」的 macOS 风格 HTML 应用。请按下面的需求修改它：\n\n${instruction}\n\n注意：文件顶部 <style id="__sys"> 与紧随其后的 window.os 注入脚本是系统注入的，请勿改动；只修改应用自身的结构、样式与逻辑，用编辑而非整体重写，保留与需求无关的部分。\n\n${AGENT_RULES}`;
}

// 慢轨 / 修改共用：订阅事件→发任务→读产物→落盘
async function runAgent(req, res, { q, slug, started, taskText, sessionTitle, preflight }) {
  let sid = null, stopEvents = null, done = false;
  // 同 makeSession：POST(modify) 的 req close 在读完 body 即触发，会立刻掐断事件直播；用 res close 才是真断开
  res.on('close', () => { if (!res.writableEnded) try { stopEvents?.(); } catch {} });
  try {
  await agentGate.run(async () => {
    try {
      prepareAgentDir();
      if (preflight) preflight();
      if (!(await ocHealth())) { sse(res, 'error', { message: '智能体服务暂时不可用，请稍后重试。' }); res.end(); return; }
      sid = await createSession(AGENT_WORK, sessionTitle);
      sse(res, 'stage', { name: 'plan', label: '正在分析需求' });
      stopEvents = subscribeEvents(AGENT_WORK, oc => {
        const m = mapEvent(oc, sid);
        if (m && !res.writableEnded) sse(res, m.event, m.data);
      });
      // 阻塞到回合结束；硬墙钟超时兜底——挂死的 agent 会占住唯一深轨坑位堵死所有人
      const sendP = sendMessage(sid, AGENT_WORK, { text: taskText });
      sendP.catch(() => {});   // 超时弃赛后底层 reject 不能变成 unhandled rejection
      let hardTimer;
      const r = await Promise.race([
        sendP,
        new Promise((_, rej) => { hardTimer = setTimeout(() => rej(Object.assign(
          new Error('智能体运行超时，已中止。请重试，或改用快速生成。'), { userSafe: true, timeout: true })), DEEP_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(hardTimer));
      stopEvents?.(); stopEvents = null;
      done = true;
      const html = readAgentHtml();
      const issues = compileCheck(html);
      const tokens = r?.info?.tokens ? (r.info.tokens.output || 0) + (r.info.tokens.input || 0) : 0;
      finishGeneration(res, { html, issues, started, totalTokens: tokens, type: 'search', q, slug, mode: 'deep' });
    } catch (e) {
      logActivity('agent_error', { q: String(q || '').slice(0, 80), msg: String(e?.message || e).slice(0, 100), timeout: !!e?.timeout });
      if (!done && !res.writableEnded) { try { sse(res, 'error', { message: e.userSafe ? e.message : '智能体运行出错，请稍后重试。' }); res.end(); } catch {} }
    } finally {
      stopEvents?.();
      if (sid) deleteSession(sid, AGENT_WORK);   // 超时路径也走这里：删会话即终止 opencode 侧的运行
    }
  });
  } catch (e) {
    if (e && e.busy && !res.writableEnded) {
      logActivity('busy_deep', { q: String(q || '').slice(0, 80) });
      try { sse(res, 'error', { message: '完整版当前排队较多，请稍后再试，或改用快速生成。' }); res.end(); } catch {}
    }
  }
}

function generateDeepAgent(req, res, { q, slug }) {
  runAgent(req, res, { q, slug, started: Date.now(), taskText: buildAgentTask(q), sessionTitle: q });
}

function modifyApp(req, res, { slug, instruction }) {
  const appDir = path.join(APPS_DIR, slug);
  const srcFile = path.join(appDir, 'index.html');
  if (!fs.existsSync(srcFile)) { sse(res, 'error', { message: '应用不存在或尚未安装' }); res.end(); return; }
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(appDir, 'meta.json'), 'utf8')); } catch {}
  const name = meta.name || slug;
  runAgent(req, res, {
    q: name, slug, started: Date.now(),
    taskText: buildModifyTask(name, instruction),
    sessionTitle: '修改:' + name,
    preflight: () => fs.copyFileSync(srcFile, path.join(AGENT_WORK, 'app.html')),
  });
}

// 慢轨（旧）：规划 → 编码（含续写/修复）→ 评审 → 终修。openCode 不可用时的回退备选。
function generateDeep(req, res, { q, slug }) {
  const started = Date.now();
  const s = makeSession(req, res);
  (async () => {
    try {
      sse(res, 'stage', { name: 'plan', label: '正在分析需求' });
      const plan = await s.step({ system: PLAN_PROMPT, messages: [{ role: 'user', content: `应用：「${q}」` }], maxTokens: 800, onText: t => sse(res, 'meta', { t }) });
      sse(res, 'stage', { name: 'code', label: '正在编写应用' });
      const userPrompt = `应用名称：「${q}」\n开发规格：\n${plan.text}\n按规格输出这个应用。`;
      let { html, issues } = await producePage(s, res, { system: SYSTEM_PROMPT, userPrompt });
      sse(res, 'stage', { name: 'review', label: '正在测试与审查' });
      const review = await s.step({ system: REVIEW_PROMPT, messages: [{ role: 'user', content: `应用：「${q}」\n代码：\n${html.slice(0, 40000)}` }], maxTokens: 800, onText: t => sse(res, 'meta', { t }) });
      if (!/验收通过/.test(review.text) && !s.aborted) {
        sse(res, 'stage', { name: 'fix', label: '正在修复问题' });
        sse(res, 'reset', {});
        const fix = await s.step({
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `${userPrompt}\n\n现有实现：\n${html.slice(0, 40000)}\n\nQA 审查发现的问题：\n${review.text}\n\n修复全部问题，重新输出完整应用。` }],
          maxTokens: MAX_TOKENS, onText: t => sse(res, 'code', { t }),
        });
        const fixedHtml = cleanHtml(fix.text);
        if (hasDoctype(fixedHtml) && compileCheck(fixedHtml).filter(i => i.includes('语法')).length === 0) { html = fixedHtml; issues = compileCheck(fixedHtml); }
      }
      if (s.aborted) return;
      finishGeneration(res, { html, issues, started, totalTokens: s.totalTokens, type: 'search', q, slug, mode: 'deep' });
    } catch (e) {
      if (!s.aborted) { try { sse(res, 'error', { message: e.message }); res.end(); } catch {} }
    }
  })();
}

// 运行时崩溃修复：POST {name, html, error} → 修复流。与快轨同走 genGate（修复也烧上游并发）
function repairApp(req, res, { name, html, error, lan }) {
  const started = Date.now();
  const s = makeSession(req, res);
  (lan ? lanGate : genGate).run(async () => {
    if (s.aborted || res.writableEnded) return;   // 排队期间已断开
    try {
      sse(res, 'stage', { name: 'fix', label: '正在修复问题' });
      const fix = await s.step({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `应用名称：「${escapeForPrompt(name)}」\n下面的实现在运行时报错：\n${escapeForPrompt(String(error).slice(0, 300))}\n\n代码：\n${String(html).slice(0, 40000)}\n\n修复该错误，保持应用功能与外观不变，重新输出完整应用（从 <!DOCTYPE html> 到 </html>）。` }],
        maxTokens: MAX_TOKENS, onText: t => sse(res, 'code', { t }),
      });
      if (s.aborted) return;
      finishGeneration(res, { html: cleanHtml(fix.text), issues: compileCheck(cleanHtml(fix.text)), started, totalTokens: s.totalTokens, type: 'repair', q: name, slug: null, mode: 'repair' });
    } catch (e) {
      if (!s.aborted) { try { sse(res, 'error', { message: e.message }); res.end(); } catch {} }
    }
  }).catch(e => {
    if (e && e.busy && !res.writableEnded) {
      logActivity('busy', { q: String(name || '').slice(0, 80) });
      try { sse(res, 'error', { message: '当前使用人数较多，请稍后再试。' }); res.end(); } catch {}
    }
  });
}

// ---------- 应用缓存检索 ----------
// 内存应用索引：slug -> meta（含 icon 布尔）。落盘时增量维护，避免每次 /api/apps·/api/search·/api/stats
// 都全量同步扫盘——单进程下扫盘阻塞事件循环，会拖慢同期所有请求（含正在跑的生成 SSE），且随应用数线性恶化。
const appIndex = new Map();
function indexApp(slug) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(APPS_DIR, slug, 'meta.json'), 'utf8'));
    m.icon = fs.existsSync(path.join(APPS_DIR, slug, 'icon.svg'));   // 有 AI 图标则前端用之
    appIndex.set(slug, m);
    return m;
  } catch { appIndex.delete(slug); return null; }
}
function buildAppIndex() {
  appIndex.clear();
  let n = 0;
  for (const slug of fs.readdirSync(APPS_DIR)) {
    if (fs.existsSync(path.join(APPS_DIR, slug, 'meta.json'))) { indexApp(slug); n++; }
  }
  console.log(`[index] 应用索引就绪：${n} 个`);
}
// 返回索引快照（新数组，元素为索引内 meta 的引用——调用方只读/排序，勿改元素属性）
function listApps() { return [...appIndex.values()]; }
const slugify = q => crypto.createHash('sha1').update(q.trim().toLowerCase()).digest('hex').slice(0, 12);

// ---------- HTTP 路由 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  const lan = isLan(req);   // 内网直连：免限流/免同源守卫/走保底并发通道
  // 默认安全头：same-origin 让同源请求带 referer、跨站绝不带（配合下面的同源守卫）；nosniff 防 MIME 嗅探
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-content-type-options', 'nosniff');
  // 反盗用：烧 token / 触发上游的接口必须来自本站（挡跨站 fetch、iframe 嵌入、裸脚本白嫖）
  if (GUARDED.has(u.pathname) && !lan && !originOk(req)) {
    logActivity('origin_block', { path: u.pathname, ip, origin: String(req.headers.origin || '').slice(0, 60), referer: String(req.headers.referer || '').slice(0, 60) });
    return json(res, 403, { error: '请求来源不被允许', detail: '请直接从 os.fzhiyu.dev 访问使用。' });
  }
  touchVisitor(ip);
  if (u.pathname === '/') { bumpVisit(); logActivity('visit', { ip, ua: String(req.headers['user-agent'] || '').slice(0, 90) }); }

  if (u.pathname === '/api/generate') {
    const type = u.searchParams.get('type') || 'dock';        // dock | search | browser
    const mode = u.searchParams.get('mode') || 'fast';        // fast | deep
    const q = (u.searchParams.get('q') || '').slice(0, 200).trim();
    if (!q) return json(res, 400, { error: '缺少参数' });
    if (BLOCK.test(q)) { logActivity('blocked', { q: q.slice(0, 80), ip }); return json(res, 451, { error: '无法打开此项目', detail: '它不符合 App Store 审查指南。' }); }
    const limited = lan ? null : rateCheck(ip);
    if (limited) logActivity('limited', { reason: limited, ip, q: q.slice(0, 80) });
    if (limited) return json(res, 429, {
      error: limited === 'budget' ? '今日体验配额已用尽'
           : limited === 'daily' ? '系统暂时无法完成此操作'
           : '已达到本小时的使用限制',
      detail: limited === 'budget' ? '今天大家玩得太热情，服务器需要喘口气，明天再来吧。'
            : limited === 'daily' ? '今日系统配额已用尽，请明天再试。'
            : '请稍后再试。配额每小时自动恢复。',
    });
    // 套娃来路上下文（仅浏览器）：让下一页与来路同站连贯。含黑名单词或超限则整体丢弃，不影响主请求
    let ctx = null;
    if (type === 'browser') {
      const from = (u.searchParams.get('from') || '').slice(0, 200).trim();
      const fromTitle = (u.searchParams.get('fromTitle') || '').slice(0, 80).trim();
      const link = (u.searchParams.get('link') || '').slice(0, 60).trim();
      const style = (u.searchParams.get('style') || '').slice(0, 650).trim();
      if (from && !BLOCK.test(from + fromTitle + link + style)) ctx = { from, fromTitle, link, style };
    }
    const deep = mode === 'deep' && type === 'search';
    const vw = Math.min(Math.max(Number(u.searchParams.get('vw')) || 0, 0), 4000);   // 客户端视口宽度（0=未知按桌面）
    logActivity('gen', { mode: deep ? 'deep' : 'fast', kind: type, q: q.slice(0, 80), ip, ...(lan && { lan: 1 }), ...(vw && vw <= 760 && { mob: 1 }) });
    if (deep) return generateDeepAgent(req, res, { q, slug: slugify(q) });
    return generateFast(req, res, { type, q, slug: type === 'search' ? slugify(q) : null, lan, ctx, vw });
  }

  if (u.pathname === '/api/capability/http') {
    if (!lan && !capLimit.http.check(ip)) return json(res, 429, { error: '请求过于频繁' });
    const target = u.searchParams.get('url') || '';
    logActivity('cap_http', { host: (() => { try { return new URL(target).host; } catch { return ''; } })(), ip });
    safeGet(target).then(r => json(res, 200, r)).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  if (u.pathname === '/api/capability/store' && req.method === 'POST') {
    if (!lan && !capLimit.store.check(ip)) return json(res, 429, { error: '请求过于频繁' });
    readBody(req).then(async b => {
      if (!b.appId || !b.op) return json(res, 400, { error: '缺少参数' });
      // 公开留言墙等受审核命名空间：写入先过 AI 审核闸，不过不落盘
      if (b.op === 'set' && MODERATED.has(String(b.appId))) {
        const verdict = await moderate(JSON.stringify(b.value ?? ''));
        if (!verdict.ok) {
          logActivity('mod_block', { appId: String(b.appId).slice(0, 40), reason: verdict.reason, ip });
          return json(res, 400, { error: '留言未通过审核', detail: '请文明发言后重试。' });
        }
      }
      return store.op(String(b.appId), { op: b.op, key: b.key, value: b.value })
        .then(result => json(res, 200, { result: result === undefined ? null : result }));
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  if (u.pathname === '/api/capability/ai' && req.method === 'POST') {
    if (!lan && DAILY_TOKEN_BUDGET > 0 && dailyTokens >= DAILY_TOKEN_BUDGET) return json(res, 429, { error: '今日体验配额已用尽' });
    if (!lan && !capLimit.ai.check(ip)) return json(res, 429, { error: '请求过于频繁' });
    readBody(req).then(b => {
      if (!b.prompt) return json(res, 400, { error: '缺少参数' });
      logActivity('cap_ai', { appName: String(b.appName || '').slice(0, 40), ip });
      capAiAsk(b.prompt, b.appName, (err, r) => {
        if (err) return json(res, 502, { error: '服务暂时不可用' });
        dailyTokens += r.tokens || 0;       // 能力 AI 也计入日预算
        json(res, 200, { text: r.text });
      });
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  if (u.pathname === '/api/repair' && req.method === 'POST') {
    const limited = lan ? null : rateCheck(ip);
    if (limited) return json(res, 429, { error: '已达到本小时的使用限制', detail: '请稍后再试。' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 300000) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, html, error } = JSON.parse(body);
        if (!name || !html) return json(res, 400, { error: '缺少参数' });
        logActivity('repair', { q: String(name).slice(0, 80), error: String(error || '').slice(0, 120), ip, ...(lan && { lan: 1 }) });
        repairApp(req, res, { name: String(name).slice(0, 200), html, error, lan });
      } catch { json(res, 400, { error: '请求格式错误' }); }
    });
    return;
  }

  if (u.pathname === '/api/modify' && req.method === 'POST') {
    const limited = lan ? null : rateCheck(ip);
    if (limited) return json(res, 429, { error: '已达到本小时的使用限制', detail: '请稍后再试。' });
    readBody(req, 8000).then(b => {
      const slug = String(b.slug || '');
      const instruction = String(b.instruction || '').slice(0, 1000).trim();
      if (!/^[a-f0-9]{12}$/.test(slug) || !instruction) return json(res, 400, { error: '缺少参数' });
      if (BLOCK.test(instruction)) return json(res, 451, { error: '无法处理此修改', detail: '它不符合 App Store 审查指南。' });
      logActivity('modify', { slug, instruction: instruction.slice(0, 100), ip });
      modifyApp(req, res, { slug, instruction });
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  if (u.pathname === '/api/icon') {
    const slug = u.searchParams.get('slug') || '';
    if (!/^[a-f0-9]{12}$/.test(slug)) return json(res, 400, { error: '缺少参数' });
    const f = path.join(APPS_DIR, slug, 'icon.svg');
    if (!fs.existsSync(f)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    return res.end(fs.readFileSync(f));
  }

  if (u.pathname === '/api/apps') {
    // 启动台：全部已安装应用（常用在前）
    return json(res, 200, { apps: listApps().sort((a, b) => (b.opens || 0) - (a.opens || 0)) });
  }

  if (u.pathname === '/api/search') {
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const apps = listApps();
    const hits = q ? apps.filter(a => a.name.toLowerCase().includes(q)).slice(0, 8)
                   : apps.sort((a, b) => (b.opens || 0) - (a.opens || 0)).slice(0, 12);
    return json(res, 200, { hits, slug: slugify(q || '') });
  }

  const appMatch = u.pathname.match(/^\/api\/app\/([a-f0-9]{12})$/);
  if (appMatch) {
    const dir = path.join(APPS_DIR, appMatch[1]);
    const f = path.join(dir, 'index.html');
    if (!fs.existsSync(f)) return json(res, 404, { error: 'not found' });
    try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); m.opens = (m.opens || 0) + 1; fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(m, null, 2)); const idx = appIndex.get(appMatch[1]); if (idx) idx.opens = m.opens; } catch {}
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    // 存量应用在落盘时还没有输入法守卫/localStorage 垫片，出口处补注（新应用已含，跳过）
    let appHtml = fs.readFileSync(f, 'utf8');
    if (!appHtml.includes('id="__ime"')) {
      const guard = `<script id="__ime">(function(){var t=0;addEventListener('compositionend',function(){t=Date.now()},true);addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.isComposing||e.keyCode===229||Date.now()-t<100))e.stopImmediatePropagation()},true)})();</scr` + `ipt>`;
      appHtml = appHtml.replace(/<head[^>]*>/i, m => m + guard);
    }
    if (!appHtml.includes('id="__ls"')) {
      const shim = `<script id="__ls">(function(){try{localStorage.length}catch(e){var m={};var s={getItem:function(k){return k in m?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};try{Object.defineProperty(window,'localStorage',{value:s});Object.defineProperty(window,'sessionStorage',{value:s})}catch(_){}}})();</scr` + `ipt>`;
      appHtml = appHtml.replace(/<head[^>]*>/i, m => m + shim);
    }
    return res.end(appHtml);
  }

  if (u.pathname === '/api/live') {
    // 轻量实时承载（纯内存，供菜单栏 WiFi 信号与内网控制台高频轮询）
    return json(res, 200, {
      fastActive: genGate.active, fastMax: GEN_CONCURRENCY, fastQueue: genGate.pending,
      lanActive: lanGate.active, lanMax: LAN_GEN_CONCURRENCY,
      deepActive: agentGate.active, deepQueue: agentGate.pending,
      visitors5m: visitors5m(), todayGens: dailyCount, todayTokens: dailyTokens,
      totalVisits: stats.totalVisits,
    });
  }

  if (u.pathname === '/api/stats') {
    return json(res, 200, {
      apps: listApps().length, totalGens: stats.totalGens, totalTokens: stats.totalTokens, totalVisits: stats.totalVisits, model: MODEL,
      live: {
        fastActive: genGate.active, fastQueue: genGate.pending, fastMax: GEN_CONCURRENCY,
        lanActive: lanGate.active, lanMax: LAN_GEN_CONCURRENCY,
        deepActive: agentGate.active, deepQueue: agentGate.pending, deepMax: 1,
        todayGens: dailyCount,
      },
    });
  }

  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  const fp = path.join(WEB_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (fp.startsWith(WEB_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    let body = fs.readFileSync(fp);
    // 分享深链 OG 卡片：/?app=<slug> 时把 og:title/描述/标题换成该应用——
    // 微信/QQ/X 爬虫只看 HTML，链接展开的第一眼就是「有人现编了什么」
    const dlSlug = p === '/index.html' ? u.searchParams.get('app') : null;
    if (dlSlug && /^[a-f0-9]{12}$/.test(dlSlug)) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(APPS_DIR, dlSlug, 'meta.json'), 'utf8'));
        const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        body = body.toString()
          .replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.name)} — 现编OS</title>`)
          .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(`有人在现编OS上安装了「${meta.name}」`)}$2`)
          .replace(/(<meta property="og:description" content=")[^"]*(")/, '$1点开链接直接运行它——这台电脑上所有应用都是 AI 当场现编的。$2');
        logActivity('deeplink', { slug: dlSlug, q: String(meta.name).slice(0, 80), ip });
      } catch {}
    }
    // no-cache：持续迭代项目，确保老访客也能拿到最新前端（文件小，每次校验代价可忽略）
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return res.end(body);
  }
  json(res, 404, { error: 'not found' });
});
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('请求格式错误')); } });
  });
}
buildAppIndex();   // 启动全量扫一次构建内存索引；此后增量维护，请求路径不再扫盘
server.listen(PORT, () => console.log(`现编OS 运行于 http://localhost:${PORT}  模型=${MODEL} 限流=${RATE_PER_HOUR}/h`));

// 启动清扫：进程被杀时 finally 不会执行，opencode 里会留下孤儿会话白吃内存。
// improv-os 是 AGENT_WORK 目录的唯一客户端，启动瞬间该目录下所有会话必为孤儿，全删。
(async () => {
  try {
    if (!(await ocHealth())) return;
    const orphans = await listSessions(AGENT_WORK);
    for (const s of orphans) await deleteSession(s.id, AGENT_WORK);
    if (orphans.length) console.log(`[agent] 启动清理孤儿会话 ${orphans.length} 个`);
  } catch {}
})();

// 存量应用图标补齐：iconGate 串行慢速消化，重启只补缺失的
setTimeout(() => {
  try {
    const missing = listApps().filter(a => !a.icon);
    if (missing.length) console.log(`[icon] 待补图标 ${missing.length} 个`);
    for (const a of missing) queueIcon(a.slug, a.name);
  } catch {}
}, 5000);
