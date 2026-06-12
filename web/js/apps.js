// Dock 应用清单与启动逻辑：除 Safari（薄壳）外，一切皆为现场生成，永不缓存
import { DockIcons, genericAppIcon, UI } from './icons.js';
import { createWindow, macSheet } from './wm.js';
import { runGeneration, mountCachedApp } from './theater.js';
import { openBrowser } from './browser.js';

export const DOCK_APPS = [
  { id: 'finder', name: '访达', icon: DockIcons.finder, q: '访达（macOS 文件管理器，含侧栏常用位置、文件列表视图、可切换图标视图）', size: [900, 580] },
  { id: 'launchpad', name: '应用程序', icon: DockIcons.launchpad, special: 'launchpad' },
  { id: 'safari', name: 'Safari浏览器', icon: DockIcons.safari, special: 'browser' },
  { id: 'messages', name: '信息', icon: DockIcons.messages, q: '信息（macOS 即时通讯应用，左侧会话列表含若干联系人与历史对话，右侧聊天界面可发送消息并收到自动回复）', size: [820, 560] },
  { id: 'mail', name: '邮件', icon: DockIcons.mail, q: '邮件（macOS 邮件客户端，三栏布局：邮箱列表、邮件列表含若干真实感邮件、正文阅读区，可写新邮件）', size: [920, 600] },
  { id: 'maps', name: '地图', icon: DockIcons.maps, q: '地图（macOS 地图应用，用 SVG/Canvas 绘制一座虚构城市的街区地图，含搜索框、缩放控制、地点标记与信息卡片）', size: [900, 620] },
  { id: 'photos', name: '照片', icon: DockIcons.photos, q: '照片（macOS 照片应用，图库网格用 CSS/SVG 生成多张抽象风景缩略图，点击查看大图，含侧栏相簿分类）', size: [900, 600] },
  { id: 'facetime', name: 'FaceTime通话', icon: DockIcons.facetime, q: 'FaceTime（macOS 视频通话应用，含联系人列表、通话记录、模拟来电界面与接听后的虚拟画面，用 CSS 动画模拟摄像头画面）', size: [760, 540] },
  { id: 'calculator', name: '计算器', icon: DockIcons.calculator, q: '计算器（macOS 计算器，支持四则运算、百分号、正负切换、键盘输入，深色面板配橙色运算键）', size: [360, 500] },
  { id: 'notes', name: '备忘录', icon: DockIcons.notes, q: '备忘录（macOS 备忘录，左侧笔记列表含几条已有笔记，右侧编辑区可新建编辑，自动保存到内存）', size: [860, 560] },
  { id: 'music', name: '音乐', icon: DockIcons.music, q: '音乐（macOS 音乐播放器，含侧栏、专辑墙用 CSS 渐变生成封面、底部播放条，可用 WebAudio 合成简短旋律真实播放）', size: [920, 600] },
  { id: 'weather', name: '天气', icon: DockIcons.weather, q: '天气（macOS 天气应用，当前城市天气大卡片含动态 CSS 天气动画、未来一周预报、多城市侧栏）', size: [820, 580] },
  { id: 'settings', name: '系统设置', icon: DockIcons.settings, q: '系统设置（macOS 系统设置，左侧设置分类侧栏、右侧设置面板，开关与滑块可交互，含外观、桌面与程序坞、声音等分组）', size: [780, 560] },
  { id: 'github', name: 'GitHub', icon: DockIcons.github, href: 'https://github.com/Fzhiyu1/improv-os' },   // 唯一的"真应用"：直跳本机源码仓库
];

export const TRASH = { id: 'trash', name: '废纸篓', icon: DockIcons.trash, q: '废纸篓（macOS 废纸篓窗口，文件列表含若干被删除的文件、清倒废纸篓按钮与确认对话框）', size: [700, 460] };

// 点开 Dock 应用：弹跳 → 新窗口 → 现场生成
export function launchApp(app, dockEl) {
  if (app.href) { bounce(dockEl); window.open(app.href, '_blank', 'noopener'); return; }
  if (app.special === 'browser') { bounce(dockEl); openBrowser(); return; }
  if (app.special === 'launchpad') { bounce(dockEl); import('./launchpad.js').then(m => m.openLaunchpad()); return; }
  bounce(dockEl);
  const [w, h] = app.size || [760, 520];
  const win = createWindow({ title: app.name, width: w, height: h });
  win.addAction(UI.refresh, '重新生成', () => regen(win, 'dock', app.q, null, 'app:' + app.id));
  runGeneration({ win, type: 'dock', q: app.q, appId: 'app:' + app.id }).catch(swallow);
}

// Spotlight 召唤的应用（缓存命中 → 秒开；未命中 → 生成并落盘）
export function openSearchApp({ name, slug, cached, mode = 'fast', meta }) {
  const win = createWindow({ title: name, width: 800, height: 560 });
  win.addAction(UI.wand, '修改此应用', () => promptModify(win, name, slug));
  win.addAction(UI.refresh, '重新生成', () => regen(win, 'search', name, slug, slug));
  if (cached) {
    mountCachedApp(win, slug);
    if (meta?.updatedAt) {
      const ago = timeAgo(meta.updatedAt);
      win.setStatus(`已安装 · ${ago}`);
    }
  } else {
    runGeneration({ win, type: 'search', q: name, mode, appId: slug }).catch(swallow);
  }
  return win;
}

function regen(win, type, q, slug, appId) {
  win.body.classList.remove('app-mounted');
  runGeneration({ win, type, q, appId }).catch(swallow);
}

// 修改已安装应用：openCode agent 增量编辑现有代码并写回缓存
async function promptModify(win, name, slug) {
  const instruction = await macSheet({
    win,
    title: `修改「${name}」`,
    message: '描述你想要的改动，将在现有应用上直接修改。',
    placeholder: '例如：换成深色外观；顶部加一个搜索框；把列表改成网格…',
    confirmText: '修改',
  });
  if (!instruction) return;
  win.body.classList.remove('app-mounted');
  runGeneration({
    win, type: 'search', q: name, appId: slug,
    post: { url: '/api/modify', body: { slug, instruction } },
  }).catch(swallow);
}

function bounce(el) {
  if (!el) return;
  el.classList.remove('bouncing');
  void el.offsetWidth;
  el.classList.add('bouncing');
  setTimeout(() => el.classList.remove('bouncing'), 1400);
}

function swallow(e) { if (!e?.handled) console.warn(e); }

export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚更新';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前更新`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前更新`;
  return `${Math.floor(s / 86400)} 天前更新`;
}

export { genericAppIcon };
