// Safari 薄壳：工具栏是真的，访问的每一个网页都是现场渲染（生成）的
import { createWindow } from './wm.js';
import { runGeneration, mountApp } from './theater.js';
import { UI } from './icons.js';

const browsers = new Set();

// 轻量 hash（djb2）：同一网址同一命名空间即可，无需加密强度
function hashUrl(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

export function openBrowser(initial = '') {
  const win = createWindow({ title: 'Safari浏览器', width: 1000, height: 660 });
  const inst = { win, history: [], idx: -1, cache: new Map(), iframe: null };
  browsers.add(inst);
  win.onClose(() => browsers.delete(inst));

  // 工具栏
  const tb = document.createElement('div');
  tb.className = 'safari-toolbar';
  tb.innerHTML = `
    <button class="sf-btn sf-back" title="后退" disabled>${UI.back}</button>
    <button class="sf-btn sf-fwd" title="前进" disabled>${UI.forward}</button>
    <div class="sf-address"><span class="sf-lock"></span><input class="sf-input" type="text" spellcheck="false" placeholder="搜索或输入网站名称"></div>
    <button class="sf-btn sf-reload" title="重新载入此页">${UI.refresh}</button>`;
  win.body.parentElement.insertBefore(tb, win.body);
  win.el.classList.add('safari-window');

  const input = tb.querySelector('.sf-input');
  const backBtn = tb.querySelector('.sf-back');
  const fwdBtn = tb.querySelector('.sf-fwd');

  const updateNav = () => {
    backBtn.disabled = inst.idx <= 0;
    fwdBtn.disabled = inst.idx >= inst.history.length - 1;
  };

  async function navigate(url, { push = true, force = false, ctx = null } = {}) {
    url = url.trim();
    if (!url) return;
    if (inst.navigating) return;          // 防止并发导航互相打架（前一次还在生成时忽略新点击）
    inst.navigating = true;
    input.value = url;
    win.setTitle(`${url}`);
    if (push) {
      inst.history = inst.history.slice(0, inst.idx + 1);
      inst.history.push(url);
      inst.idx = inst.history.length - 1;
    }
    updateNav();
    if (!force && inst.cache.has(url)) {
      inst.iframe = mountApp(win, inst.cache.get(url), 'web:' + hashUrl(url));
      inst.navigating = false;
      return;
    }
    win.body.classList.remove('app-mounted');
    try {
      const { html } = await runGeneration({ win, type: 'browser', q: url, appId: 'web:' + hashUrl(url), ctx });
      inst.cache.set(url, html);
      inst.iframe = win.body.querySelector('iframe');
    } catch (e) { if (!e?.handled) console.warn(e); }
    finally { inst.navigating = false; }
  }
  inst.navigate = navigate;
  // 套娃跳转的来路上下文：当前页 URL + <title> + 样式开头——下一页生成时保持同站连贯（含配色字体）
  inst.fromCtx = linkText => {
    const cur = inst.history[inst.idx];
    if (!cur) return null;
    const html = inst.cache.get(cur) || '';
    const title = html.match(/<title>([^<]{1,80})/)?.[1] || '';
    const style = (html.match(/<style[^>]*>([\s\S]{1,600})/)?.[1] || '').replace(/\s+/g, ' ').trim();
    return { from: cur.slice(0, 200), fromTitle: title.trim(), link: String(linkText || '').slice(0, 60), style };
  };

  let imeAt = 0;
  input.addEventListener('compositionend', () => { imeAt = Date.now(); });
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229 || Date.now() - imeAt < 100) return;   // 输入法选词的回车不触发导航（含 Safari 时序怪癖）
    if (e.key === 'Enter') navigate(input.value);
  });
  backBtn.addEventListener('click', () => { if (inst.idx > 0) { inst.idx--; navigate(inst.history[inst.idx], { push: false }); } });
  fwdBtn.addEventListener('click', () => { if (inst.idx < inst.history.length - 1) { inst.idx++; navigate(inst.history[inst.idx], { push: false }); } });
  tb.querySelector('.sf-reload').addEventListener('click', () => { const u = inst.history[inst.idx]; if (u) { inst.cache.delete(u); navigate(u, { push: false, force: true }); } });

  navigate(initial || '起始页：常用网站导航');
  return win;
}

// 生成页面内的链接点击 → postMessage 套娃导航（带来路上下文，让下一页接得上）
addEventListener('message', e => {
  if (e.data?.type !== 'navigate' || typeof e.data.url !== 'string') return;
  for (const inst of browsers) {
    const f = inst.win.body.querySelector('iframe');
    if (f && f.contentWindow === e.source) {
      inst.navigate(e.data.url.slice(0, 200), { ctx: inst.fromCtx(e.data.text) });
      return;
    }
  }
});
