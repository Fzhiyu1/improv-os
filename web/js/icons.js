// 全部图标内联 SVG，无外部资源。Dock 图标为 macOS 风格手绘近似。
const sq = (inner, defs = '') =>
  `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${defs}<rect x="2" y="2" width="60" height="60" rx="14" fill="url(#_bg)"/>${inner}</svg>`;

export const DockIcons = {
  finder: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="fnd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3FA9F5"/><stop offset="1" stop-color="#1470CC"/></linearGradient>
    <linearGradient id="fnd2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8F4FE"/><stop offset="1" stop-color="#BBDFF7"/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#fnd2)"/>
    <path d="M32 2 h16 a12 12 0 0 1 12 12 v36 a12 12 0 0 1 -12 12 h-16 z" fill="url(#fnd)"/>
    <path d="M32 2 c-6 10 -8 20 -7 30 c0.5 6 2 12 4.5 18 l2.5 12" fill="none" stroke="#0E5AA8" stroke-width="2.4"/>
    <line x1="20" y1="22" x2="20" y2="32" stroke="#1470CC" stroke-width="2.6" stroke-linecap="round"/>
    <line x1="45" y1="22" x2="45" y2="32" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M16 40 c5 5 11 7 16 7 c6 0 12 -2 17 -7" fill="none" stroke="#0E5AA8" stroke-width="2.4" stroke-linecap="round"/>
  </svg>`,
  safari: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="sfr" cx="0.5" cy="0.35" r="0.8"><stop offset="0" stop-color="#3EC6F0"/><stop offset="1" stop-color="#1667D9"/></radialGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="#F2F2F4"/>
    <circle cx="32" cy="32" r="26" fill="url(#sfr)"/>
    ${Array.from({ length: 24 }, (_, i) => { const a = i * 15 * Math.PI / 180, r1 = i % 2 ? 22.5 : 21, x1 = 32 + Math.cos(a) * r1, y1 = 32 + Math.sin(a) * r1, x2 = 32 + Math.cos(a) * 24.5, y2 = 32 + Math.sin(a) * 24.5; return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#fff" stroke-width="1.1" opacity="0.9"/>`; }).join('')}
    <polygon points="44,20 28.5,28.5 35.5,35.5" fill="#FF4B3E"/>
    <polygon points="20,44 35.5,35.5 28.5,28.5" fill="#F2F2F4"/>
  </svg>`,
  messages: sq(`<path d="M32 14 c-11.6 0 -21 7.8 -21 17.4 c0 6.2 3.9 11.6 9.8 14.7 c-0.4 2.4 -1.6 5.5 -4.3 7.9 c3.9 -0.4 7.6 -2.3 10.2 -4.3 c1.7 0.4 3.5 0.6 5.3 0.6 c11.6 0 21 -7.8 21 -17.4 S43.6 14 32 14 z" fill="#fff"/>`,
    `<defs><linearGradient id="_bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6BE36F"/><stop offset="1" stop-color="#13BD2E"/></linearGradient></defs>`),
  mail: sq(`<rect x="12" y="18" width="40" height="28" rx="4" fill="#fff"/>
    <path d="M12 22 l20 14 l20 -14" fill="none" stroke="#1D6FF2" stroke-width="2.2"/>
    <path d="M13 44 l14 -11 M51 44 l-14 -11" fill="none" stroke="#9CC3F7" stroke-width="1.6"/>`,
    `<defs><linearGradient id="_bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1FA5FD"/><stop offset="1" stop-color="#156FF0"/></linearGradient></defs>`),
  maps: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="60" height="60" rx="14" fill="#F4F1E8"/>
    <path d="M2 30 q18 -6 30 2 t30 -4 v22 a14 14 0 0 1 -14 14 h-32 a14 14 0 0 1 -14 -14 z" fill="#CDE8B5"/>
    <path d="M2 16 h60" stroke="#F7D154" stroke-width="7"/>
    <path d="M22 2 v60" stroke="#fff" stroke-width="6"/>
    <path d="M22 16 q14 10 24 30 q3 7 16 8" fill="none" stroke="#3E83F1" stroke-width="3.4"/>
    <circle cx="46" cy="26" r="7.5" fill="#E94B3C"/><circle cx="46" cy="26" r="3" fill="#fff"/>
  </svg>`,
  photos: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="60" height="60" rx="14" fill="#fff"/>
    ${['#FBB13C', '#F86E51', '#EE4395', '#B05BC6', '#5856D6', '#39A0ED', '#34C77B', '#A8D830'].map((c, i) =>
      `<ellipse cx="32" cy="20.5" rx="6.5" ry="11" fill="${c}" opacity="0.82" transform="rotate(${i * 45} 32 32)"/>`).join('')}
  </svg>`,
  facetime: sq(`<rect x="10" y="20" width="28" height="24" rx="6" fill="#fff"/>
    <path d="M40 28 l12 -7 v22 l-12 -7 z" fill="#fff"/>`,
    `<defs><linearGradient id="_bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6BE36F"/><stop offset="1" stop-color="#13BD2E"/></linearGradient></defs>`),
  calculator: sq(`<rect x="14" y="10" width="36" height="44" rx="7" fill="#2B2B2D"/>
    <rect x="18" y="14" width="28" height="10" rx="2.5" fill="#C8E5C0"/>
    ${[0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c =>
      `<circle cx="${22 + c * 8}" cy="${31 + r * 7}" r="2.6" fill="${c === 3 ? '#FF9F0A' : '#8E8E93'}"/>`).join('')).join('')}`,
    `<defs><linearGradient id="_bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D8D8DC"/><stop offset="1" stop-color="#ABABB0"/></linearGradient></defs>`),
  notes: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="nt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD338"/><stop offset="1" stop-color="#FFC107"/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="#fff"/>
    <path d="M2 16 a14 14 0 0 1 14 -14 h32 a14 14 0 0 1 14 14 v4 h-60 z" fill="url(#nt)"/>
    ${[0, 1, 2, 3, 4, 5, 6].map(i => `<circle cx="${11 + i * 7}" cy="11" r="1.6" fill="#B98A00"/>`).join('')}
    <line x1="12" y1="32" x2="52" y2="32" stroke="#D9D9DE" stroke-width="2.4" stroke-linecap="round"/>
    <line x1="12" y1="41" x2="52" y2="41" stroke="#D9D9DE" stroke-width="2.4" stroke-linecap="round"/>
    <line x1="12" y1="50" x2="38" y2="50" stroke="#D9D9DE" stroke-width="2.4" stroke-linecap="round"/>
  </svg>`,
  music: sq(`<path d="M44 14 l-18 4.5 v23 a7 7 0 1 0 3.5 6 v-21.5 l11 -2.8 v14 a7 7 0 1 0 3.5 6 z" fill="#fff"/>`,
    `<defs><linearGradient id="_bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FB5C74"/><stop offset="1" stop-color="#FA233B"/></linearGradient></defs>`),
  weather: sq(`<circle cx="24" cy="24" r="10" fill="#FFD60A"/>
    <path d="M22 46 a9 9 0 0 1 1 -18 a11 11 0 0 1 21 3 a8 8 0 0 1 -2 15 z" fill="#fff"/>`,
    `<defs><linearGradient id="_bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4DA7F2"/><stop offset="1" stop-color="#1D6FD3"/></linearGradient></defs>`),
  settings: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="st" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E3E3E8"/><stop offset="1" stop-color="#B0B0B8"/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#st)"/>
    <circle cx="32" cy="32" r="17" fill="none" stroke="#6E6E73" stroke-width="9" stroke-dasharray="5.34 3.56"/>
    <circle cx="32" cy="32" r="13" fill="#8E8E93"/><circle cx="32" cy="32" r="6.5" fill="#D9D9DE"/>
  </svg>`,
  launchpad: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="lpd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FDFDFE"/><stop offset="1" stop-color="#D8D8DD"/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#lpd)"/>
    ${[['#FF9500', 18, 18], ['#34C759', 32, 18], ['#007AFF', 46, 18], ['#FF3B30', 18, 32], ['#AF52DE', 32, 32], ['#5AC8FA', 46, 32], ['#FFCC00', 18, 46], ['#FF2D55', 32, 46], ['#8E8E93', 46, 46]].map(([c, x, y]) => `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="3" fill="${c}"/>`).join('')}
  </svg>`,
  github: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="ghb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3B3B40"/><stop offset="1" stop-color="#141417"/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#ghb)"/>
    <path transform="translate(12 11.5) scale(2.5)" fill="#fff" fill-rule="evenodd" clip-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
  </svg>`,
  trash: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="tr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FBFBFD"/><stop offset="1" stop-color="#D4D4DA"/></linearGradient></defs>
    <path d="M16 14 h32 l-3.5 42 a5 5 0 0 1 -5 4.6 h-15 a5 5 0 0 1 -5 -4.6 z" fill="url(#tr)" stroke="#A8A8B0" stroke-width="1.5"/>
    ${[0, 1, 2, 3, 4].map(i => `<line x1="${20.5 + i * 5.8}" y1="18" x2="${22.5 + i * 4.8}" y2="56" stroke="#B7B7BF" stroke-width="1.2"/>`).join('')}
    ${[0, 1, 2].map(i => `<path d="M17 ${24 + i * 11} q15 4 30 0" fill="none" stroke="#B7B7BF" stroke-width="1.2"/>`).join('')}
    <rect x="14" y="11" width="36" height="5" rx="2.5" fill="#C9C9CF" stroke="#A8A8B0" stroke-width="1"/>
  </svg>`,
};

// 通用应用图标（Spotlight 结果等）
export const genericAppIcon = sq(
  `<path d="M24 18 l-8 14 l8 14 M40 18 l8 14 l-8 14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
   <line x1="35" y1="16" x2="29" y2="48" stroke="#fff" stroke-width="4" stroke-linecap="round"/>`,
  `<defs><linearGradient id="_bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8E8E93"/><stop offset="1" stop-color="#48484A"/></linearGradient></defs>`);

// 菜单栏 / UI 字形（模板色，currentColor）
export const UI = {
  apple: `<svg viewBox="0 0 17 17" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12.9 9.05c-.02-1.93 1.58-2.86 1.65-2.9-.9-1.31-2.3-1.49-2.79-1.51-1.19-.12-2.32.7-2.92.7-.6 0-1.53-.68-2.51-.66-1.29.02-2.48.75-3.15 1.9-1.34 2.33-.34 5.78.97 7.67.64.93 1.4 1.97 2.4 1.93.96-.04 1.33-.62 2.49-.62 1.16 0 1.49.62 2.51.6 1.04-.02 1.7-.94 2.33-1.87.73-1.08 1.03-2.12 1.05-2.17-.02-.01-2.01-.77-2.03-3.07zM10.97 3.4c.53-.64.89-1.53.79-2.42-.76.03-1.69.51-2.24 1.15-.49.57-.92 1.48-.81 2.35.85.07 1.72-.43 2.26-1.08z"/></svg>`,
  magnifier: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><circle cx="6.8" cy="6.8" r="4.6"/><line x1="10.3" y1="10.3" x2="14" y2="14" stroke-linecap="round"/></svg>`,
  controlCenter: `<svg viewBox="0 0 17 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2.5" width="15" height="5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="4.5" cy="5" r="1.7"/><rect x="1" y="8.5" width="15" height="5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="12.5" cy="11" r="1.7"/></svg>`,
  wifi: `<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 4.2 a10 10 0 0 1 13 0" stroke-width="1.5"/><path d="M3.8 6.8 a6.6 6.6 0 0 1 8.4 0" stroke-width="1.5"/><path d="M6.1 9.3 a3.2 3.2 0 0 1 3.8 0" stroke-width="1.5"/><circle cx="8" cy="11" r="1" fill="currentColor" stroke="none"/></svg>`,
  battery: `<svg viewBox="0 0 25 12" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1" opacity="0.5"/><rect x="2" y="2" width="15" height="8" rx="1.6" fill="currentColor"/><path d="M23 4 v4 a2.2 2.2 0 0 0 0 -4z" fill="currentColor" opacity="0.5"/></svg>`,
  refresh: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 8 a5.5 5.5 0 1 1 -1.6 -3.9"/><polyline points="13.7,1.6 13.7,4.6 10.7,4.6" stroke-linejoin="round"/></svg>`,
  wand: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 13 L11 5"/><path d="M10 2.5 v2 M10 2.5 h2 M13.5 6 v1.6 M13.5 6 h1.6 M5.5 2.5 v1.4 M5.5 2.5 h1.4"/><path d="M11 5 l1.6 1.6 -1.4 1.4 -1.6 -1.6 z" fill="currentColor"/></svg>`,
  back: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><polyline points="10,3 5,8 10,13"/></svg>`,
  forward: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><polyline points="6,3 11,8 6,13"/></svg>`,
  speaker: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 6 h2.5 L8 3 v10 L4.5 10 H2 z"/><path d="M10 5.5 a3.5 3.5 0 0 1 0 5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11.8 3.8 a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  speakerMuted: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 6 h2.5 L8 3 v10 L4.5 10 H2 z"/><line x1="10" y1="6" x2="14" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="14" y1="6" x2="10" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  warning: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M32 6 L60 54 a3 3 0 0 1 -2.6 4.5 H6.6 A3 3 0 0 1 4 54 z" fill="#FFCC00" stroke="#E5A800" stroke-width="1.5"/><rect x="29.4" y="22" width="5.2" height="18" rx="2.6" fill="#5c4a00"/><circle cx="32" cy="48" r="3.2" fill="#5c4a00"/></svg>`,
  doc: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M14 4 h26 l10 10 v46 h-36 z" fill="#fff" stroke="#C7C7CC" stroke-width="1.5"/><path d="M40 4 l10 10 h-10 z" fill="#E5E5EA" stroke="#C7C7CC" stroke-width="1.2"/>${[0, 1, 2, 3, 4].map(i => `<line x1="20" y1="${26 + i * 7}" x2="44" y2="${26 + i * 7}" stroke="#D1D1D6" stroke-width="2"/>`).join('')}</svg>`,
};
