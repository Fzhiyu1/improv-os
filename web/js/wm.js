// 窗口管理器：创建/拖拽/聚焦/红绿灯/缩放/最小化到 Dock
let zTop = 100;
let winCount = 0;
const windows = new Set();

export function createWindow({ title = '', width = 760, height = 520, x, y } = {}) {
  const el = document.createElement('div');
  el.className = 'window opening';
  const vw = innerWidth, vh = innerHeight;
  width = Math.min(width, vw - 40);
  height = Math.min(height, vh - 110);
  const offset = (winCount++ % 8) * 28;
  el.style.width = width + 'px';
  el.style.height = height + 'px';
  el.style.left = (x ?? Math.max(20, (vw - width) / 2 - 120 + offset)) + 'px';
  el.style.top = (y ?? Math.max(36, (vh - height) / 2 - 60 + offset)) + 'px';
  el.style.zIndex = ++zTop;
  el.innerHTML = `
    <div class="titlebar">
      <div class="traffic">
        <button class="tl tl-close" title="关闭"><span>×</span></button>
        <button class="tl tl-min" title="最小化"><span>−</span></button>
        <button class="tl tl-max" title="缩放"><span>+</span></button>
      </div>
      <div class="win-title"></div>
      <div class="win-actions"></div>
    </div>
    <div class="win-body"></div>
    <div class="win-resize"></div>`;
  document.getElementById('windows').appendChild(el);
  requestAnimationFrame(() => el.classList.remove('opening'));

  const titlebar = el.querySelector('.titlebar');
  const titleEl = el.querySelector('.win-title');
  const body = el.querySelector('.win-body');
  const actions = el.querySelector('.win-actions');
  titleEl.textContent = title;

  const closeCbs = [];
  const win = {
    el, body,
    setTitle(t) { titleEl.textContent = t; },
    setStatus(t) { statusEl(el).textContent = t; },
    addAction(svg, tip, fn) {
      const b = document.createElement('button');
      b.className = 'win-action'; b.title = tip; b.innerHTML = svg;
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      actions.appendChild(b);
      return b;
    },
    onClose(fn) { closeCbs.push(fn); },
    close() {
      closeCbs.forEach(f => { try { f(); } catch {} });
      windows.delete(win);
      el.classList.add('closing');
      setTimeout(() => el.remove(), 180);
    },
    focus() { el.style.zIndex = ++zTop; setFocus(el); },
  };
  windows.add(win);

  // 聚焦
  el.addEventListener('pointerdown', () => win.focus(), true);
  setFocus(el);

  // 红绿灯
  el.querySelector('.tl-close').addEventListener('click', e => { e.stopPropagation(); win.close(); });
  el.querySelector('.tl-min').addEventListener('click', e => { e.stopPropagation(); minimize(win, title); });
  let maxState = null;
  el.querySelector('.tl-max').addEventListener('click', e => {
    e.stopPropagation();
    el.classList.add('animating');
    if (!maxState) {
      maxState = { l: el.style.left, t: el.style.top, w: el.style.width, h: el.style.height };
      el.style.left = '8px'; el.style.top = '32px';
      el.style.width = (innerWidth - 16) + 'px';
      el.style.height = (innerHeight - 32 - 84) + 'px';
    } else {
      Object.assign(el.style, { left: maxState.l, top: maxState.t, width: maxState.w, height: maxState.h });
      maxState = null;
    }
    setTimeout(() => el.classList.remove('animating'), 280);
  });

  // 拖拽（仅标题栏，避开按钮）。三处性能要点：
  // ① setPointerCapture——指针滑进任何 iframe（应用内容区）事件也不丢，否则窗口拖到一半卡住不跟手
  // ② down 时缓存尺寸，move 里不再读 offset* 强制重排
  // ③ rAF 合帧写入，120Hz 指针不超频刷样式
  titlebar.addEventListener('pointerdown', e => {
    if (e.target.closest('.tl') || e.target.closest('.win-action')) return;
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    const w = el.offsetWidth;
    try { titlebar.setPointerCapture(e.pointerId); } catch {}
    let raf = 0, nx, ny;
    const move = ev => {
      nx = Math.min(Math.max(ev.clientX - sx, -w + 80), innerWidth - 30);
      ny = Math.min(Math.max(ev.clientY - sy, 25), innerHeight - 40);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; el.style.left = nx + 'px'; el.style.top = ny + 'px'; });
    };
    const up = () => {
      try { titlebar.releasePointerCapture(e.pointerId); } catch {}
      titlebar.removeEventListener('pointermove', move); titlebar.removeEventListener('pointerup', up); titlebar.removeEventListener('pointercancel', up);
    };
    titlebar.addEventListener('pointermove', move); titlebar.addEventListener('pointerup', up); titlebar.addEventListener('pointercancel', up);
  });

  // 右下角缩放（同款 capture + rAF）
  const rz = el.querySelector('.win-resize');
  rz.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    const sw = el.offsetWidth - e.clientX, sh = el.offsetHeight - e.clientY;
    try { rz.setPointerCapture(e.pointerId); } catch {}
    let raf = 0, nw, nh;
    const move = ev => {
      nw = Math.max(360, sw + ev.clientX);
      nh = Math.max(240, sh + ev.clientY);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; el.style.width = nw + 'px'; el.style.height = nh + 'px'; });
    };
    const up = () => {
      try { rz.releasePointerCapture(e.pointerId); } catch {}
      rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); rz.removeEventListener('pointercancel', up);
    };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up); rz.addEventListener('pointercancel', up);
  });

  return win;
}

function statusEl(el) {
  let s = el.querySelector('.win-status');
  if (!s) { s = document.createElement('div'); s.className = 'win-status'; el.querySelector('.win-actions').prepend(s); }
  return s;
}

function setFocus(el) {
  document.querySelectorAll('.window.focused').forEach(w => w.classList.remove('focused'));
  el.classList.add('focused');
}

export function focusedWindow() {
  let best = null, bz = -1;
  windows.forEach(w => { const z = +w.el.style.zIndex; if (z > bz && !w.el.classList.contains('minimized')) { bz = z; best = w; } });
  return best;
}

// 最小化到 Dock 右侧
function minimize(win, title) {
  const el = win.el;
  const dock = document.getElementById('dock-minis');
  const r1 = el.getBoundingClientRect(), r2 = dock.getBoundingClientRect();
  el.style.transition = 'transform .32s cubic-bezier(.4,0,1,1), opacity .32s';
  el.style.transformOrigin = 'center';
  el.style.transform = `translate(${r2.left + 24 - r1.left - r1.width / 2}px, ${r2.top - r1.top - r1.height / 2}px) scale(0.05)`;
  el.style.opacity = '0';
  setTimeout(() => { el.classList.add('minimized'); el.style.display = 'none'; }, 320);
  const mini = document.createElement('button');
  mini.className = 'dock-icon dock-mini';
  mini.innerHTML = `<div class="dock-mini-thumb">${(win.el.querySelector('.win-title')?.textContent || title || '').slice(0, 2)}</div><span class="dock-label">${win.el.querySelector('.win-title')?.textContent || title}</span>`;
  mini.addEventListener('click', () => {
    mini.remove();
    el.classList.remove('minimized');
    el.style.display = '';
    requestAnimationFrame(() => { el.style.transform = ''; el.style.opacity = ''; win.focus(); });
    setTimeout(() => { el.style.transition = ''; }, 350);
  });
  dock.appendChild(mini);
}

// macOS 风格 sheet：从窗口标题栏下滑的输入面板，盖住应用内容区。返回 Promise<string|null>。
export function macSheet({ win, title, message, placeholder = '', confirmText = '好' }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'sheet-overlay';
    ov.innerHTML = `
      <div class="mac-sheet">
        <div class="sheet-title"></div>
        <div class="sheet-msg"></div>
        <textarea class="sheet-input" rows="3" spellcheck="false"></textarea>
        <div class="sheet-actions">
          <button class="sheet-btn sheet-cancel">取消</button>
          <button class="sheet-btn sheet-ok primary" disabled></button>
        </div>
      </div>`;
    ov.querySelector('.sheet-title').textContent = title || '';
    ov.querySelector('.sheet-msg').textContent = message || '';
    const ta = ov.querySelector('.sheet-input');
    ta.placeholder = placeholder;
    const okBtn = ov.querySelector('.sheet-ok');
    okBtn.textContent = confirmText;
    win.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('open'));
    setTimeout(() => ta.focus(), 80);

    let settled = false;
    const close = val => { if (settled) return; settled = true; ov.classList.remove('open'); setTimeout(() => ov.remove(), 220); resolve(val); };
    const submit = () => { const v = ta.value.trim(); if (v) close(v); };
    ta.addEventListener('input', () => { okBtn.disabled = !ta.value.trim(); });
    ov.querySelector('.sheet-cancel').addEventListener('click', () => close(null));
    okBtn.addEventListener('click', submit);
    let imeAt = 0;
    ta.addEventListener('compositionend', () => { imeAt = Date.now(); });
    ta.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229 || Date.now() - imeAt < 100) return;   // 输入法选词中的 Esc 只收候选框，不关对话框
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  });
}

// macOS 风格警告框
export function macAlert({ title, message, icon }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'alert-overlay';
    ov.innerHTML = `
      <div class="mac-alert">
        <div class="alert-icon">${icon || ''}</div>
        <div class="alert-title"></div>
        <div class="alert-msg"></div>
        <button class="alert-btn">好</button>
      </div>`;
    ov.querySelector('.alert-title').textContent = title;
    ov.querySelector('.alert-msg').textContent = message || '';
    document.body.appendChild(ov);
    const done = () => { ov.remove(); resolve(); };
    ov.querySelector('.alert-btn').addEventListener('click', done);
    ov.querySelector('.alert-btn').focus();
    ov.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') done(); });
  });
}
