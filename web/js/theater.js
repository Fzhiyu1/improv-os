// 生成剧场：以"正在安装"的姿态直播代码生成，完成后无缝切换为可用应用
// 网关以巨型块吐流（首块 ~2.5s，之后每块数 KB），这里用排水队列把它演成连续喷射
import { UI } from './icons.js';
import { macAlert } from './wm.js';
import { registerFrame, unregisterFrame, announce } from './bridge.js';

// ---------- 打字音效（WebAudio，极轻） ----------
let audioCtx = null, muted = JSON.parse(localStorage.getItem('xb-muted') || 'false');
export const isMuted = () => muted;
export function setMuted(m) { muted = m; localStorage.setItem('xb-muted', JSON.stringify(m)); }
addEventListener('pointerdown', () => { if (!audioCtx) try { audioCtx = new AudioContext(); } catch {} }, { once: true });
let lastTick = 0;
function tick() {
  if (muted || !audioCtx || audioCtx.state !== 'running') return;
  const now = performance.now();
  if (now - lastTick < 42) return;
  lastTick = now;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'square'; o.frequency.value = 1500 + Math.random() * 900;
  g.gain.setValueAtTime(0.011, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
  o.connect(g).connect(audioCtx.destination);
  o.start(t); o.stop(t + 0.02);
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function highlight(line) {
  let h = esc(line);
  h = h.replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="c-tag">$2</span>');
  h = h.replace(/("[^"]*"|'[^']*')/g, '<span class="c-str">$1</span>');
  h = h.replace(/\b(function|const|let|var|return|if|else|for|while|new|class|document|window)\b/g, '<span class="c-kw">$1</span>');
  return h;
}

// ---------- SSE 解析（fetch 流） ----------
async function consumeSSE(url, opts, onEvent) {
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    const j = await r.json().catch(() => ({ error: '系统出现未知错误' }));
    throw Object.assign(new Error(j.error || '系统出现未知错误'), { detail: j.detail, status: r.status });
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = 'message', data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) { try { onEvent(event, JSON.parse(data)); } catch {} }
    }
  }
}

// ---------- 主入口 ----------
// post: { url, body } 时走 POST（用于运行时修复），否则 GET /api/generate
// 演出形态：实时渲染——应用在窗口里逐块长出来（禁脚本预览 iframe + document.write 流式喂入），
// 底部一条小代码滚动条证明它是现写的；完成后无缝切换为沙箱可交互 iframe。
export function runGeneration({ win, type, q, mode = 'fast', post = null, appId = null, ctx = null }) {
  if (appId) win._appId = appId;
  return new Promise((resolve, reject) => {
    const body = win.body;
    body.classList.remove('app-mounted');
    body.innerHTML = `
      <div class="theater2">
        <div class="t2-status">
          <span class="t2-label">正在打开<span class="t2-app"></span>…</span>
          <span class="t2-stat"><span class="t-toks">0</span> tokens/s</span>
          <div class="t2-progress"><div class="t2-bar"></div></div>
        </div>
        <div class="t2-stage">
          <iframe class="t2-preview" sandbox="allow-same-origin"></iframe>
          <div class="t2-veil"><div class="t2-spinner"></div><div class="t2-veil-text">正在准备应用…</div></div>
        </div>
        <div class="t2-ticker"></div>
      </div>`;
    body.querySelector('.t2-app').textContent = `“${q}”`;
    const labelEl = body.querySelector('.t2-label');
    const bar = body.querySelector('.t2-bar');
    const toksEl = body.querySelector('.t-toks');
    const ticker = body.querySelector('.t2-ticker');
    const veil = body.querySelector('.t2-veil');
    const veilText = body.querySelector('.t2-veil-text');
    const preview = body.querySelector('.t2-preview');
    let doc = preview.contentDocument;
    doc.open();

    const ctrl = new AbortController();
    let alive = true;
    win.onClose(() => { alive = false; ctrl.abort(); });

    const tickLine = (text, cls) => {
      const d = document.createElement('div');
      d.className = 'tk-line ' + (cls || '');
      d.textContent = text;
      ticker.appendChild(d);
      while (ticker.childElementCount > 40) ticker.firstElementChild.remove();
      ticker.scrollTop = ticker.scrollHeight;
      return d;
    };
    tickLine('> 正在准备应用…', 'tk-dim');
    const earlyTimers = [
      setTimeout(() => { if (alive && !firstByte) { tickLine('> 正在加载组件…', 'tk-dim'); veilText.textContent = '正在加载…'; } }, 900),
      setTimeout(() => { if (alive && !firstByte) { tickLine('> 即将就绪…', 'tk-dim'); veilText.textContent = '即将就绪…'; } }, 2000),
    ];

    // ---- 排水队列：把巨块流演成连续喷射 ----
    const queue = []; // {kind:'code'|'think'|'meta'|'stage'|'reset', text?|label?}
    let qChars = 0, drained = 0, doneStats = null, finished = false, failed = null;
    let firstByte = 0, drainStart = 0, veilLifted = false;
    let codeBuf = '', tickerBuf = '';
    const EXPECT = 16000;

    const statTimer = setInterval(() => {
      if (!drainStart) return;
      const secs = (performance.now() - drainStart) / 1000;
      toksEl.textContent = Math.round(drained / 3 / Math.max(secs, 0.2));
      bar.style.width = Math.min(96, drained / EXPECT * 100) + '%';
    }, 120);

    const renderCode = text => {
      codeBuf += text;
      // 实时渲染：流式喂给预览文档（浏览器解析器原生支持分块 HTML）
      try { doc.write(text); } catch {}
      if (!veilLifted && codeBuf.length > 400) { veilLifted = true; veil.classList.add('lifted'); }
      // 底部代码滚动条
      tickerBuf += text;
      const lines = tickerBuf.split('\n');
      tickerBuf = lines.pop();
      for (const l of lines) if (l.trim()) tickLine(l.slice(0, 220), 'tk-code');
    };
    const renderAux = text => {
      tickerBuf += text;
      const lines = tickerBuf.split('\n');
      tickerBuf = lines.pop();
      for (const l of lines) if (l.trim()) tickLine(l.slice(0, 220), 'tk-dim');
    };

    let lastFrame = performance.now();
    function drainLoop(now) {
      if (!alive) return;
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;
      if (queue.length) {
        if (!drainStart) drainStart = performance.now();
        // 视觉速率：跟随真实到达均速，但不低于 3800 字/秒；收到 done 后 2.5 倍冲刺
        const elapsed = (performance.now() - (firstByte || performance.now())) / 1000;
        const arriveRate = elapsed > 0.3 ? (drained + qChars) / elapsed : 0;
        let rate = Math.max(3800, arriveRate * 0.95);
        if (doneStats) rate *= 2.5;
        if (qChars > 30000) rate = Math.max(rate, qChars / 4);
        let budget = Math.ceil(rate * dt);
        while (budget > 0 && queue.length) {
          const item = queue[0];
          if (item.kind === 'stage') {
            labelEl.innerHTML = `${item.label}<span class="t2-app"></span>…`;
            labelEl.querySelector('.t2-app').textContent = `“${q}”`;
            tickLine(`> ${item.label}…`, 'tk-stage');
            if (!veilLifted) veilText.textContent = item.label;   // agent 模式无代码瀑布，靠 veil 显示阶段
            queue.shift(); continue;
          }
          if (item.kind === 'reset') {
            // 只重置可视状态：清空预览文档与代码缓冲，重新升起遮罩；不丢弃队列里 reset 之后的修复代码
            codeBuf = ''; tickerBuf = '';
            try { doc.open(); } catch {}
            veilLifted = false; veil.classList.remove('lifted');
            veilText.textContent = '正在应用修复…';
            queue.shift(); continue;
          }
          const take = Math.min(budget, item.text.length);
          const chunk = item.text.slice(0, take);
          item.text = item.text.slice(take);
          if (!item.text.length) queue.shift();
          qChars -= take; drained += take; budget -= take;
          if (item.kind === 'code') renderCode(chunk);
          else renderAux(chunk);
          tick();
        }
      } else if (doneStats || failed) {
        finish(); return;
      }
      requestAnimationFrame(drainLoop);
    }
    requestAnimationFrame(drainLoop);

    function finish() {
      if (finished) return; finished = true;
      clearInterval(statTimer);
      earlyTimers.forEach(clearTimeout);
      if (failed) {
        reject(Object.assign(new Error(failed.message), { handled: showError(win, failed.message, failed.detail) }));
        return;
      }
      const stats = doneStats;
      bar.style.width = '100%';
      // 优先用服务端编译校验后的最终产物；流文本仅作兜底抢救
      let html = stats.html;
      if (!html) {
        html = codeBuf.trim().replace(/^```html?\n?/, '').replace(/\n?```\s*$/, '');
        const ds = html.search(/<!DOCTYPE/i);
        if (ds > 0) html = html.slice(ds);
        if (/^<!DOCTYPE/i.test(html) && !/<\/html>\s*$/i.test(html) && html.length > 1500) html += '\n</body></html>';
      }
      if (!html || !/^<!DOCTYPE/i.test(html)) {
        reject(Object.assign(new Error('生成结果无效'), { handled: showError(win, '无法打开此应用', '请稍后重试。') }));
        return;
      }
      const visSecs = drainStart ? (performance.now() - drainStart) / 1000 : stats.secs;
      try { doc.close(); } catch {}
      tickLine(`> 已就绪（${stats.secs} 秒 · ${stats.tokens} tokens）`, 'tk-ok');
      setTimeout(() => {
        if (!alive) return;
        mountApp(win, html, win._appId);
        armCrashRepair(win, q, html);
        win.setStatus(`${stats.secs}s · ${Math.max(stats.toks || 0, Math.round(stats.tokens / Math.max(visSecs, 0.5)))} tok/s`);
        resolve({ html, stats });
      }, 380);
    }

    const ctxQs = ctx ? Object.entries(ctx).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('') : '';
    const fetchUrl = post ? post.url : `/api/generate?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}&mode=${mode}${ctxQs}`;
    const fetchOpts = post
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(post.body), signal: ctrl.signal }
      : { signal: ctrl.signal };
    consumeSSE(fetchUrl, fetchOpts, (event, d) => {
      if (!firstByte) firstByte = performance.now();
      if (event === 'thinking') { queue.push({ kind: 'think', text: d.t }); qChars += d.t.length; }
      else if (event === 'code') { queue.push({ kind: 'code', text: d.t }); qChars += d.t.length; }
      else if (event === 'meta') { queue.push({ kind: 'meta', text: d.t }); qChars += d.t.length; }
      else if (event === 'stage') queue.push({ kind: 'stage', label: d.label });
      else if (event === 'reset') queue.push({ kind: 'reset' });
      else if (event === 'done') doneStats = d;
      else if (event === 'error') failed = { message: d.message || '系统出现未知错误' };
    }).catch(e => {
      if (ctrl.signal.aborted) { failed = failed || { message: '已取消' }; return; }
      failed = { message: e.message, detail: e.detail };
    });
  });
}

// 运行时崩溃自动修复：生成应用启动后 8 秒内若上报 JS 错误，自动触发一次修复
function armCrashRepair(win, q, html) {
  const f = win.body.querySelector('iframe');
  if (!f) return;
  const onMsg = e => {
    if (e.data?.type !== 'apperror' || e.source !== f.contentWindow) return;
    cleanup();
    if (win._repaired) return;
    win._repaired = true;
    runGeneration({ win, type: 'repair', q, post: { url: '/api/repair', body: { name: q, html, error: e.data.message } } }).catch(() => {});
  };
  const cleanup = () => removeEventListener('message', onMsg);
  addEventListener('message', onMsg);
  setTimeout(cleanup, 8000);
  win.onClose(cleanup);
}

function showError(win, message, detail) {
  win.body.innerHTML = `
    <div class="app-error">
      <div class="app-error-icon">${UI.warning}</div>
      <div class="app-error-title"></div>
      <div class="app-error-msg"></div>
    </div>`;
  win.body.querySelector('.app-error-title').textContent = message;
  win.body.querySelector('.app-error-msg').textContent = detail || '';
  return true;
}

// 给挂载好的 iframe 接能力桥：登记白名单 + 告知 appId
function wireBridge(win, f, appId) {
  if (!appId) return;
  f.addEventListener('load', () => { registerFrame(f, appId); announce(f, appId); });
  win.onClose(() => unregisterFrame(f));
}

// 将生成的 HTML 挂载为沙箱 iframe
export function mountApp(win, html, appId) {
  win.body.innerHTML = '';
  const f = document.createElement('iframe');
  f.className = 'app-frame';
  f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-pointer-lock');
  f.srcdoc = html;
  win.body.appendChild(f);
  win.body.classList.add('app-mounted');
  wireBridge(win, f, appId || win._appId);
  return f;
}

// 打开已缓存应用（秒开）
export function mountCachedApp(win, slug, appId) {
  win.body.innerHTML = '';
  const f = document.createElement('iframe');
  f.className = 'app-frame';
  f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-pointer-lock');
  f.src = `/api/app/${slug}`;
  win.body.appendChild(f);
  win.body.classList.add('app-mounted');
  wireBridge(win, f, appId || slug);
  return f;
}

export { macAlert };
