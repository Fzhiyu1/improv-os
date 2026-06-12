// Spotlight：⌘K（Win/Linux 为 Ctrl+K，代码本就监听 metaKey||ctrlKey）/ 菜单栏放大镜。缓存命中秒开；未命中 → 安装（生成并落盘）

// 平台自适应的搜索入口提示：界面文案统一引用，别再硬编码 ⌘K（Windows 用户看不懂）
const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const coarse = matchMedia('(pointer: coarse)').matches;
export const SPOT_KEY = isMac ? '⌘K' : 'Ctrl+K';
export const SPOT_HINT = coarse ? '点菜单栏的放大镜' : `按 <b>${SPOT_KEY}</b>`;     // 富文本场景
export const SPOT_PLAIN = coarse ? '点菜单栏的放大镜' : `按 ${SPOT_KEY}`;           // 纯文本场景（alert）
import { genericAppIcon, openSearchApp, timeAgo } from './apps.js';

let overlay, input, results, items = [], selected = 0, debounce;

export function initSpotlight() {
  overlay = document.createElement('div');
  overlay.id = 'spotlight';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="spot-panel">
      <div class="spot-bar">
        <svg class="spot-mag" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8.5" cy="8.5" r="5.8"/><line x1="13" y1="13" x2="17.5" y2="17.5" stroke-linecap="round"/></svg>
        <input class="spot-input" type="text" placeholder="Spotlight 搜索" spellcheck="false" autocomplete="off">
      </div>
      <div class="spot-results" hidden></div>
    </div>`;
  document.body.appendChild(overlay);
  input = overlay.querySelector('.spot-input');
  results = overlay.querySelector('.spot-results');

  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) hide(); });
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(search, 120); });
  let imeAt = 0;   // Safari 怪癖：compositionend 先于选词回车的 keydown，isComposing 已是 false——用时间戳兜底
  input.addEventListener('compositionend', () => { imeAt = Date.now(); });
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229 || Date.now() - imeAt < 100) return;   // 输入法选词中：按键归输入法，不触发搜索
    if (e.key === 'Escape') hide();
    else if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); items[selected]?.action(); }
  });

  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === ' ')) { e.preventDefault(); toggle(); }
  });
}

export function toggle() { overlay.hidden ? show() : hide(); }
export function show() {
  overlay.hidden = false;
  input.value = '';
  results.hidden = true;
  results.innerHTML = '';
  requestAnimationFrame(() => input.focus());
  search();
}
function hide() { overlay.hidden = true; }

async function search() {
  const q = input.value.trim();
  let hits = [], qSlug = '';
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await r.json();
    hits = data.hits || [];
    qSlug = data.slug || '';
  } catch {}
  items = [];

  const rows = [];
  if (hits.length) {
    rows.push(`<div class="spot-section">应用程序</div>`);
    for (const h of hits) {
      const i = items.length;
      items.push({ action: () => { hide(); openSearchApp({ name: h.name, slug: h.slug, cached: true, meta: h }); } });
      rows.push(`<div class="spot-row" data-i="${i}">
        <span class="spot-icon">${genericAppIcon}</span>
        <span class="spot-name"></span>
        <span class="spot-kind">${timeAgo(h.updatedAt || h.createdAt)}</span>
      </div>`);
    }
  }
  if (q) {
    const exact = hits.some(h => h.name.toLowerCase() === q.toLowerCase());
    if (!exact) {
      rows.push(`<div class="spot-section">App Store</div>`);
      const i1 = items.length;
      items.push({ action: () => { hide(); openSearchApp({ name: q, slug: qSlug, cached: false, mode: 'fast' }); } });
      rows.push(`<div class="spot-row" data-i="${i1}">
        <span class="spot-icon">${genericAppIcon}</span>
        <span class="spot-name spot-q"></span>
        <span class="spot-kind">获取</span>
      </div>`);
      const i2 = items.length;
      items.push({ action: () => { hide(); openSearchApp({ name: q, slug: qSlug, cached: false, mode: 'deep' }); } });
      rows.push(`<div class="spot-row spot-deep" data-i="${i2}">
        <span class="spot-icon">${genericAppIcon}</span>
        <span class="spot-name spot-q2"></span>
        <span class="spot-kind">完整版</span>
      </div>`);
    }
  }

  results.innerHTML = rows.join('');
  // 文本用 textContent 注入，避免注入
  const nameEls = results.querySelectorAll('.spot-name');
  let hi = 0;
  for (const h of hits) { if (nameEls[hi]) nameEls[hi++].textContent = h.name; }
  const qe = results.querySelector('.spot-q'); if (qe) qe.textContent = q;
  const qe2 = results.querySelector('.spot-q2'); if (qe2) qe2.textContent = q;

  results.hidden = items.length === 0;
  results.querySelectorAll('.spot-row').forEach(row => {
    row.addEventListener('click', () => items[+row.dataset.i]?.action());
    row.addEventListener('pointermove', () => select(+row.dataset.i));
  });
  select(0);
}

function select(i) {
  if (!items.length) return;
  selected = Math.max(0, Math.min(items.length - 1, i));
  results.querySelectorAll('.spot-row').forEach(r => r.classList.toggle('selected', +r.dataset.i === selected));
}
