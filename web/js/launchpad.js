// 应用程序（启动台）：网格展示所有已安装（生成缓存）的应用，分类胶囊 + 自动图标，点击秒开。
// 图标确定性生成：名字 hash → macOS 系渐变 + 关键词字形（SF 风格线条），无关键词则用首字。
import { createWindow } from './wm.js';
import { openSearchApp, timeAgo } from './apps.js';

// ---------- macOS 系统色渐变（上浅下深）----------
const GRADS = [
  ['#42A5F5', '#1565C0'], ['#FF7043', '#E64A19'], ['#66BB6A', '#2E7D32'], ['#AB47BC', '#6A1B9A'],
  ['#FFA726', '#EF6C00'], ['#EC407A', '#AD1457'], ['#26C6DA', '#00838F'], ['#7E57C2', '#4527A0'],
  ['#EF5350', '#C62828'], ['#9CCC65', '#558B2F'], ['#5C6BC0', '#283593'], ['#FFCA28', '#F57F17'],
];
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i); return h >>> 0; };

// ---------- 关键词 → SF 风格白色线条字形（viewBox 64，画在中央）----------
const W = 'fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"';
const GLYPHS = [
  [/计算|算账|账单/, `<rect x="20" y="16" width="24" height="32" rx="4" ${W}/><line x1="25" y1="24" x2="39" y2="24" ${W}/><circle cx="26" cy="33" r="1.6" fill="#fff"/><circle cx="32" cy="33" r="1.6" fill="#fff"/><circle cx="38" cy="33" r="1.6" fill="#fff"/><circle cx="26" cy="41" r="1.6" fill="#fff"/><circle cx="32" cy="41" r="1.6" fill="#fff"/><circle cx="38" cy="41" r="1.6" fill="#fff"/>`],
  [/时钟|闹钟|计时|秒表|番茄|倒计时/, `<circle cx="32" cy="32" r="16" ${W}/><path d="M32 22 v10 l7 5" ${W}/>`],
  [/日历|日程|课表|排班/, `<rect x="17" y="18" width="30" height="28" rx="4" ${W}/><line x1="17" y1="27" x2="47" y2="27" ${W}/><line x1="25" y1="14" x2="25" y2="21" ${W}/><line x1="39" y1="14" x2="39" y2="21" ${W}/>`],
  [/记|笔记|备忘|日记|清单|待办|todo/i, `<rect x="19" y="15" width="26" height="34" rx="4" ${W}/><line x1="25" y1="25" x2="39" y2="25" ${W}/><line x1="25" y1="32" x2="39" y2="32" ${W}/><line x1="25" y1="39" x2="33" y2="39" ${W}/>`],
  [/天气|气温|温度/, `<circle cx="26" cy="26" r="7" ${W}/><path d="M24 44 a7 7 0 0 1 1 -14 a9 9 0 0 1 17 2.5 a6.5 6.5 0 0 1 -1.5 12.8 z" ${W}/>`],
  [/音乐|歌|钢琴|节拍/, `<path d="M40 18 l-14 3.5 v18" ${W}/><circle cx="22" cy="42" r="4.5" ${W}/><circle cx="36" cy="38" r="4.5" ${W}/><path d="M40 18 v16" ${W}/>`],
  [/游戏|棋|牌|消消|贪吃|拼图|俄罗斯|猜|连连/, `<rect x="14" y="22" width="36" height="22" rx="11" ${W}/><line x1="24" y1="29" x2="24" y2="37" ${W}/><line x1="20" y1="33" x2="28" y2="33" ${W}/><circle cx="40" cy="30" r="1.8" fill="#fff"/><circle cx="44" cy="36" r="1.8" fill="#fff"/>`],
  [/地图|导航|定位|位置/, `<path d="M32 16 a11 11 0 0 1 11 11 c0 8 -11 21 -11 21 s-11 -13 -11 -21 a11 11 0 0 1 11 -11 z" ${W}/><circle cx="32" cy="27" r="4" ${W}/>`],
  [/相机|拍照|照片|相册|图库/, `<rect x="15" y="22" width="34" height="24" rx="5" ${W}/><path d="M25 22 l3 -5 h8 l3 5" ${W}/><circle cx="32" cy="34" r="7" ${W}/>`],
  [/邮件|信箱/, `<rect x="15" y="20" width="34" height="24" rx="4" ${W}/><path d="M16 23 l16 12 l16 -12" ${W}/>`],
  [/翻译|词典|单词|英语|背单词/, `<path d="M18 20 h14 M25 16 v4 M22 20 c0 8 6 14 10 16 M28 20 c0 8 -6 14 -10 16" ${W}/><path d="M38 46 l6 -16 l6 16 M40.5 41 h7" ${W}/>`],
  [/股|汇率|基金|理财|行情|金价/, `<path d="M16 44 l9 -10 l7 5 l14 -17" ${W}/><path d="M40 22 h6 v6" ${W}/>`],
  [/血压|健康|心率|体重|药|医/, `<path d="M32 46 c-9 -7 -16 -12.5 -16 -19.5 a8.5 8.5 0 0 1 16 -4 a8.5 8.5 0 0 1 16 4 c0 7 -7 12.5 -16 19.5 z" ${W}/><path d="M21 31 h6 l3 -6 l4 10 l3 -4 h6" ${W}/>`],
  [/书|阅读|小说|百科|文章/, `<path d="M32 20 c-4 -3 -10 -3 -14 -1 v26 c4 -2 10 -2 14 1 c4 -3 10 -3 14 -1 v-26 c-4 -2 -10 -2 -14 1 z" ${W}/><line x1="32" y1="20" x2="32" y2="46" ${W}/>`],
  [/新闻|资讯|热榜|头条/, `<rect x="16" y="18" width="32" height="28" rx="4" ${W}/><line x1="22" y1="26" x2="36" y2="26" ${W}/><line x1="22" y1="33" x2="42" y2="33" ${W}/><line x1="22" y1="39" x2="42" y2="39" ${W}/><line x1="40" y1="22" x2="42" y2="22" ${W}/>`],
  [/聊天|对话|问答|助手|客服/, `<path d="M32 17 c-10 0 -18 6.5 -18 14.5 c0 5 3.2 9.5 8 12 c-0.3 2 -1.3 4.4 -3.5 6.5 c3.3 -0.4 6.3 -1.9 8.5 -3.6 c1.6 0.4 3.2 0.6 5 0.6 c10 0 18 -6.5 18 -14.5 S42 17 32 17 z" ${W}/>`],
  [/视频|影|电影|播放/, `<rect x="16" y="20" width="32" height="24" rx="5" ${W}/><path d="M28 27 l10 5 l-10 5 z" fill="#fff" stroke="none"/>`],
  [/运动|健身|锻炼|跑步|步数/, `<circle cx="32" cy="32" r="16" ${W}/><path d="M32 16 a16 16 0 0 1 0 32" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" opacity=".45"/><path d="M24 32 l5 5 l11 -11" ${W}/>`],
  [/文件|文档|管理器/, `<path d="M17 20 h12 l4 5 h14 v19 a4 4 0 0 1 -4 4 h-22 a4 4 0 0 1 -4 -4 z" ${W}/>`],
  [/画|绘|涂鸦|设计|调色/, `<path d="M32 16 a16 16 0 1 0 0 32 c3 0 4 -2 3 -4 c-1.5 -3 1 -5 4 -5 h4 a5 5 0 0 0 5 -5 c0 -10 -7 -18 -16 -18 z" ${W}/><circle cx="24" cy="27" r="2" fill="#fff"/><circle cx="33" cy="23" r="2" fill="#fff"/><circle cx="41" cy="28" r="2" fill="#fff"/>`],
];

// 名字 → 64 viewBox squircle 图标（id 唯一化，几十个同屏不串渐变）
export function launchpadIcon(name) {
  const h = hash(name);
  const [c1, c2] = GRADS[h % GRADS.length];
  const gid = 'lp' + (h % 100000);
  const glyph = GLYPHS.find(([re]) => re.test(name))?.[1]
    || `<text x="32" y="42" text-anchor="middle" font-family="-apple-system,'PingFang SC',sans-serif" font-size="26" font-weight="600" fill="#fff">${esc(firstChar(name))}</text>`;
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#${gid})"/>${glyph}</svg>`;
}
function firstChar(name) {
  const m = String(name).trim().match(/[一-鿿]|[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : '·';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 分类（启发式，匹配不上归「其他」）----------
const CATS = [
  ['效率', /记|账|清单|待办|日程|计划|笔记|备忘|打卡|管理|办公|文档|表格|日历|课表|排班|todo/i],
  ['工具', /计算|转换|查|器|测|尺|秤|码|定时|闹钟|时钟|番茄|天气|翻译|词典|汇率|文件/],
  ['娱乐', /游戏|棋|牌|乐园|消消|贪吃|拼图|俄罗斯|猜|连连|视频|影|音乐|歌|钢琴/],
  ['信息与阅读', /新闻|资讯|热榜|头条|阅读|小说|百科|书|股|基金|行情|金价/],
  ['健康与生活', /血压|健康|心率|体重|药|医|食谱|菜|运动|健身|跑步|步数|宠物|家/],
  ['创意', /画|绘|涂鸦|设计|调色|相机|拍照|作曲/],
];
const catOf = name => CATS.find(([, re]) => re.test(name))?.[0] || '其他';

// ---------- 启动台窗口 ----------
let lpWin = null;
export function openLaunchpad() {
  if (lpWin && document.body.contains(lpWin.el)) { lpWin.focus(); refresh(lpWin); return lpWin; }
  const win = createWindow({ title: '应用程序', width: 980, height: 640 });
  lpWin = win;
  win.body.classList.add('lp-body');
  win.body.innerHTML = `
    <div class="lp-head">
      <div class="lp-title">${launchpadGlyph()}<span>应用程序</span></div>
      <input class="lp-search" type="search" placeholder="搜索">
    </div>
    <div class="lp-cats"></div>
    <div class="lp-scroll"><div class="lp-grid"></div><div class="lp-empty" hidden></div></div>`;
  const state = { apps: [], cat: '全部', q: '' };
  win.body.querySelector('.lp-search').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); render(win, state); });
  win._lpState = state;
  refresh(win);
  return win;
}

function launchpadGlyph() {
  return `<svg viewBox="0 0 64 64" width="26" height="26" xmlns="http://www.w3.org/2000/svg">
    ${[['#FF9500', 20, 20], ['#007AFF', 44, 20], ['#34C759', 20, 44], ['#FF2D55', 44, 44]].map(([c, x, y]) => `<rect x="${x - 9}" y="${y - 9}" width="18" height="18" rx="5.5" fill="${c}"/>`).join('')}
  </svg>`;
}

async function refresh(win) {
  const state = win._lpState;
  try {
    const r = await fetch('/api/apps');
    state.apps = (await r.json()).apps || [];
  } catch { state.apps = []; }
  // 分类胶囊：全部 + 实际出现的分类（按数量降序）
  const counts = new Map();
  for (const a of state.apps) counts.set(catOf(a.name), (counts.get(catOf(a.name)) || 0) + 1);
  const cats = ['全部', ...[...counts.entries()].sort((x, y) => y[1] - x[1]).map(([c]) => c)];
  const catsEl = win.body.querySelector('.lp-cats');
  catsEl.innerHTML = cats.map(c => `<button class="lp-cat${c === state.cat ? ' on' : ''}" data-cat="${c}">${c}</button>`).join('');
  catsEl.querySelectorAll('.lp-cat').forEach(b => b.addEventListener('click', () => {
    state.cat = b.dataset.cat;
    catsEl.querySelectorAll('.lp-cat').forEach(x => x.classList.toggle('on', x === b));
    render(win, state);
  }));
  render(win, state);
}

function render(win, state) {
  const grid = win.body.querySelector('.lp-grid');
  const empty = win.body.querySelector('.lp-empty');
  let list = state.apps;
  if (state.cat !== '全部') list = list.filter(a => catOf(a.name) === state.cat);
  if (state.q) list = list.filter(a => a.name.toLowerCase().includes(state.q));
  grid.innerHTML = list.map((a, i) => `
    <button class="lp-app" data-i="${i}" title="打开 ${a.opens || 0} 次 · ${timeAgo(a.updatedAt || a.createdAt)}">
      <span class="lp-icon">${a.icon ? `<img src="/api/icon?slug=${a.slug}" alt="" loading="lazy">` : launchpadIcon(a.name)}</span>
      <span class="lp-name">${esc(a.name)}</span>
    </button>`).join('');
  grid.querySelectorAll('.lp-app').forEach(b => b.addEventListener('click', () => {
    const a = list[Number(b.dataset.i)];
    openSearchApp({ name: a.name, slug: a.slug, cached: true, meta: a });
  }));
  if (!state.apps.length) {
    empty.hidden = false;
    empty.innerHTML = '尚未安装任何应用。<br>按 <b>⌘K</b> 搜索想要的应用，安装后会出现在这里。';
  } else if (!list.length) {
    empty.hidden = false;
    empty.textContent = '没有匹配的应用。';
  } else empty.hidden = true;
  win.setStatus?.(`${state.apps.length} 个应用`);
}
