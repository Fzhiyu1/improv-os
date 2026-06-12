// 系统装配：开机 → 菜单栏 → Dock → Spotlight → 桌面
import './bridge.js'; // 激活能力桥的全局 message 监听
import { initSignal } from './signal.js';
import { DOCK_APPS, TRASH, launchApp } from './apps.js';
import { initSpotlight, toggle as toggleSpotlight, SPOT_KEY, SPOT_PLAIN } from './spotlight.js';
import { createWindow, focusedWindow, macAlert } from './wm.js';
import { setMuted, isMuted } from './theater.js';
import { UI } from './icons.js';

// ---------- 开机 ----------
const boot = document.getElementById('boot');
const bootBar = boot.querySelector('.boot-bar');
let p = 0;
const bootTimer = setInterval(() => {
  p += Math.random() * 22;
  bootBar.style.width = Math.min(100, p) + '%';
  if (p >= 100) {
    clearInterval(bootTimer);
    setTimeout(() => {
      boot.classList.add('boot-done');
      document.getElementById('desktop').hidden = false;
      setTimeout(() => boot.remove(), 600);
      setTimeout(firstRunNotice, 1200);
      setTimeout(openDeepLink, 700);   // 分享链接 ?app=<slug>：开机后直接弹出对应应用
    }, 250);
  }
}, 180);

// ---------- 手机虚拟键盘补偿 ----------
// iOS Safari 键盘弹起不缩 layout viewport，应用里 fixed bottom 的输入条会被盖住一半。
// visualViewport 跟踪真实可视高度：键盘弹起时窗口收到可视区内（CSS 用 --vvh），并把被顶起的页面拉回原位。
if (window.visualViewport) {
  const vv = window.visualViewport;
  const sync = () => {
    const kb = innerHeight - vv.height > 100;   // 高度差过百视为键盘弹起（横竖屏切换不会误判）
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    document.body.classList.toggle('kb-open', kb);
    if (kb) scrollTo(0, 0);                     // iOS 会把整页顶出屏幕，拉回来
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
}

// ---------- 菜单栏静态图标 ----------
document.getElementById('mb-apple').innerHTML = UI.apple;
document.getElementById('mb-battery').innerHTML = UI.battery;
initSignal();   // WiFi 图标 = 承载压力指示器（人多变弱 + 过载通知）
document.getElementById('mb-spot').innerHTML = UI.magnifier;
document.getElementById('mb-cc').innerHTML = UI.controlCenter;

// ---------- 时钟 ----------
const clockEl = document.getElementById('mb-clock');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function tickClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  clockEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]} ${hh}:${mm}`;
}
tickClock(); setInterval(tickClock, 5000);

// ---------- 菜单栏 ----------
const menubar = document.getElementById('menubar');
let openMenu = null;
function closeMenus() { openMenu?.remove(); openMenu = null; document.querySelectorAll('.mb-item.active').forEach(e => e.classList.remove('active')); }
addEventListener('pointerdown', e => { if (!e.target.closest('.mb-menu') && !e.target.closest('.mb-item')) closeMenus(); });

function showMenu(anchor, entries) {
  closeMenus();
  anchor.classList.add('active');
  const m = document.createElement('div');
  m.className = 'mb-menu';
  for (const it of entries) {
    if (it === '-') { m.appendChild(Object.assign(document.createElement('div'), { className: 'mb-sep' })); continue; }
    const d = document.createElement('div');
    d.className = 'mb-menu-item' + (it.disabled ? ' disabled' : '');
    d.textContent = it.label;
    if (!it.disabled) d.addEventListener('click', () => { closeMenus(); it.fn?.(); });
    m.appendChild(d);
  }
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, r.left) + 'px';
  m.style.top = r.bottom + 4 + 'px';
  document.body.appendChild(m);
  openMenu = m;
}

const appleMenu = [
  { label: '关于本机', fn: aboutWindow },
  '-',
  { label: '系统设置…', fn: () => launchApp(DOCK_APPS.find(a => a.id === 'settings')) },
  { label: 'App Store…', fn: () => toggleSpotlight() },
  '-',
  { label: '强制退出当前应用', fn: () => focusedWindow()?.close() },
  '-',
  { label: '睡眠', disabled: true },
  { label: '重新启动…', fn: () => location.reload() },
  { label: '关机…', fn: () => { document.body.classList.add('shutdown'); setTimeout(() => location.reload(), 1800); } },
];
document.getElementById('mb-apple').addEventListener('pointerdown', e => { e.stopPropagation(); showMenu(e.currentTarget, appleMenu); });

const stockMenus = {
  '文件': [{ label: '新建窗口', fn: () => toggleSpotlight() }, { label: '关闭窗口', fn: () => focusedWindow()?.close() }],
  '编辑': [{ label: '撤销', disabled: true }, { label: '重做', disabled: true }, '-', { label: '剪切', disabled: true }, { label: '拷贝', disabled: true }, { label: '粘贴', disabled: true }],
  '显示': [{ label: '进入全屏幕', fn: () => document.documentElement.requestFullscreen?.() }],
  '前往': [{ label: '应用程序', fn: () => import('./launchpad.js').then(m => m.openLaunchpad()) }, { label: 'App Store', fn: () => toggleSpotlight() }],
  '窗口': [{ label: '最小化', disabled: true }, { label: '前置全部窗口', disabled: true }],
  '帮助': [{ label: '现编OS 使用手册', fn: readmeWindow }],
};
document.querySelectorAll('.mb-item[data-menu]').forEach(el => {
  el.addEventListener('pointerdown', e => { e.stopPropagation(); showMenu(el, stockMenus[el.dataset.menu] || []); });
});

// 右侧：声音开关 + 放大镜
const sndBtn = document.getElementById('mb-sound');
function renderSnd() { sndBtn.innerHTML = isMuted() ? UI.speakerMuted : UI.speaker; }
renderSnd();
sndBtn.addEventListener('click', () => { setMuted(!isMuted()); renderSnd(); });
document.getElementById('mb-spot').addEventListener('click', () => toggleSpotlight());

// ---------- Dock ----------
const dockIconsEl = document.getElementById('dock-icons');
for (const app of DOCK_APPS) {
  const b = document.createElement('button');
  b.className = 'dock-icon';
  b.innerHTML = `${app.icon}<span class="dock-label">${app.name}</span>`;
  b.addEventListener('click', () => launchApp(app, b));
  dockIconsEl.appendChild(b);
}
const trashBtn = document.createElement('button');
trashBtn.className = 'dock-icon dock-trash';
trashBtn.innerHTML = `${TRASH.icon}<span class="dock-label">${TRASH.name}</span>`;
trashBtn.addEventListener('click', () => launchApp(TRASH, trashBtn));
document.getElementById('dock-trash-slot').appendChild(trashBtn);

// Dock 放大效果
const dock = document.getElementById('dock');
dock.addEventListener('pointermove', e => {
  for (const ic of dock.querySelectorAll('.dock-icon')) {
    const r = ic.getBoundingClientRect();
    const d = Math.abs(e.clientX - (r.left + r.width / 2));
    const s = Math.max(1, 1.55 - d / 110);
    ic.style.setProperty('--mag', s.toFixed(3));
  }
});
dock.addEventListener('pointerleave', () => {
  dock.querySelectorAll('.dock-icon').forEach(ic => ic.style.setProperty('--mag', 1));
});

// ---------- 桌面图标 ----------
document.getElementById('desk-readme').addEventListener('dblclick', readmeWindow);

// ---------- Spotlight ----------
initSpotlight();

// ---------- 关于本机（一本正经的配置单） ----------
async function aboutWindow() {
  let s = { apps: 0, totalGens: 0, totalTokens: 0, model: '' };
  try { s = await (await fetch('/api/stats')).json(); } catch {}
  const win = createWindow({ title: '', width: 540, height: 396 });
  win.el.classList.add('about-window');
  win.body.innerHTML = `
    <div class="about">
      <div class="about-logo">${UI.apple}</div>
      <div class="about-name">现编OS <span>Tahoe</span></div>
      <div class="about-ver">版本 26.0（构建 1A815）</div>
      <table class="about-specs">
        <tr><td>芯片</td><td>Apple M4 Pro</td></tr>
        <tr><td>内存</td><td>16 GB 统一内存</td></tr>
        <tr><td>启动磁盘</td><td>Macintosh HD</td></tr>
        <tr><td>图形卡</td><td>Apple M4 Pro（16 核）</td></tr>
        <tr><td>应用程序</td><td>${s.apps} 个可用</td></tr>
        <tr><td>序列号</td><td>C02XB${(s.totalGens + 100000).toString(36).toUpperCase()}2026</td></tr>
        <tr><td>源代码</td><td><a class="src-link" href="https://github.com/Fzhiyu1/improv-os" target="_blank" rel="noopener">github.com/Fzhiyu1/improv-os</a></td></tr>
      </table>
      <div class="about-note">此电脑上的应用程序均按需提供。</div>
    </div>`;
}

// ---------- 使用手册（手写，不生成） ----------
function readmeWindow() {
  const win = createWindow({ title: '自述文件.txt', width: 560, height: 460 });
  win.body.innerHTML = `
    <div class="readme">
      <h2>欢迎使用 现编OS</h2>
      <p>这是一台外观正常的电脑。它与您用过的电脑只有一个区别：<b>它不预装任何软件。</b></p>
      <p>当您打开一个应用，系统会现场把它写出来——您看到的进度条不是在解压安装包，而是在逐行编写这个应用本身。每次打开，得到的都是一个全新的版本。</p>
      <p>建议尝试：</p>
      <ul>
        <li>打开 Dock 上的「计算器」，观察它被写出来的过程；</li>
        <li>再打开一次「计算器」，注意它和上一个不一样；</li>
        <li>打开 Safari，访问任何网站——那个网站也是现编的；</li>
        <li>按 <b>${SPOT_KEY}</b>（或点菜单栏放大镜）搜索一个不存在的应用，例如「帮我妈记血压」，然后安装它；</li>
        <li>被安装过的应用会保留——下一位访客搜索时可以直接打开您安装的版本。</li>
      </ul>
      <p class="readme-dim">系统资源有限，每小时可安装的应用数量有上限。<br>关于本机 &gt; 可查看系统真实配置。<br>整机开源：<a class="src-link" href="https://github.com/Fzhiyu1/improv-os" target="_blank" rel="noopener">github.com/Fzhiyu1/improv-os</a></p>
    </div>`;
}

// ---------- 分享深链：?app=<slug> 直接打开对应缓存应用 ----------
async function openDeepLink() {
  const slug = new URLSearchParams(location.search).get('app');
  if (!slug || !/^[a-f0-9]{12}$/.test(slug)) return;
  try {
    const { apps } = await (await fetch('/api/apps')).json();
    const meta = apps.find(a => a.slug === slug);
    if (!meta) {   // 死链兜底：应用已被清掉时不再静默，把失望转化为一次新的现编
      macAlert({ title: '无法打开此应用', message: `它已被卸载（或从未存在过）。${SPOT_PLAIN}现编一个新的吧——反正这台电脑上所有应用都是现做的。` });
      return;
    }
    const m = await import('./apps.js');
    m.openSearchApp({ name: meta.name, slug, cached: true, meta });
  } catch {}
}

// ---------- 首次访问通知 ----------
function firstRunNotice() {
  if (localStorage.getItem('xb-seen')) return;
  localStorage.setItem('xb-seen', '1');
  const n = document.createElement('div');
  n.className = 'notification';
  n.innerHTML = `
    <div class="notif-icon">${UI.apple}</div>
    <div class="notif-text"><b>欢迎使用现编OS</b><br>本机未预装任何软件。双击桌面「自述文件」了解详情。</div>`;
  document.body.appendChild(n);
  requestAnimationFrame(() => n.classList.add('show'));
  n.addEventListener('click', () => { n.remove(); readmeWindow(); });
  setTimeout(() => { n.classList.remove('show'); setTimeout(() => n.remove(), 400); }, 8000);
}
