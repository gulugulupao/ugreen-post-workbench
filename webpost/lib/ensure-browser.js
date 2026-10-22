/* 绿联社区发帖工作台 — Copyright (c) 2026 很多问题的小明同学（GitHub @gulugulupao）
 * 授权：MIT License + 附加保护条款（保留署名 / 禁止冒名 / 禁止商用冒用），完整文本见 LICENSE.txt
 */
/**
 * 浏览器组件自检 / 自动下载
 * 被 启动发帖工作台.bat 调用。职责：
 *   1. 调用 postcore.findChrome() 看本机是否已有可用 Chromium
 *   2. 没有则依次尝试官方源、国内镜像下载，直到成功
 *   3. 全程用 UTF-8 输出中文（避免 bat 的 GBK/UTF-8 编码事故）
 *
 * 退出码: 0 = 浏览器可用; 1 = 全部源都失败
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
// 切控制台到 UTF-8，保证 bat 里中文提示不乱码
try { spawnSync('chcp', ['65001'], { stdio: 'ignore', shell: true, windowsHide: true }); } catch (e) {}

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'node_modules', 'playwright-core', 'cli.js');

// 下载源：官方优先，失败依次退到国内镜像
const HOSTS = [
  { name: '官方源 (cdn.playwright.dev)', host: '' },
  { name: '阿里云镜像 (npmmirror)', host: 'https://cdn.npmmirror.com/binaries/playwright' },
  { name: '腾讯云镜像', host: 'https://mirrors.cloud.tencent.com/playwright' },
];

// 自带一份轻量探测，不 require postcore —— postcore 在找不到浏览器时会直接 exit，
// 那样下载兜底就永远跑不到了。
function findChrome() {
  const APP_ROOT = path.join(__dirname, '..', '..');
  const cands = [];
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  cands.push(path.join(APP_ROOT, 'browser', 'chrome-win64', 'chrome.exe'));
  cands.push(path.join(APP_ROOT, 'browser', 'chrome-win', 'chrome.exe'));
  const localAppData = process.env.LOCALAPPDATA
    || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const msDir = path.join(localAppData, 'ms-playwright');
  if (fs.existsSync(msDir)) {
    fs.readdirSync(msDir).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => {
      cands.push(path.join(msDir, d, 'chrome-win64', 'chrome.exe'));
      cands.push(path.join(msDir, d, 'chrome-win', 'chrome.exe'));
    });
  }
  cands.push('C:/Program Files/Google/Chrome/Application/chrome.exe');
  cands.push('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
  cands.push('C:/Program Files/Microsoft/Edge/Application/msedge.exe');
  cands.push('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

function tryInstall(host) {
  const env = Object.assign({}, process.env);
  if (host) env.PLAYWRIGHT_DOWNLOAD_HOST = host;
  else delete env.PLAYWRIGHT_DOWNLOAD_HOST;

  const r = spawnSync(process.execPath, [CLI, 'install', 'chromium'], {
    env,
    stdio: ['ignore', 'inherit', 'pipe'],
    cwd: ROOT,
    windowsHide: true,
  });
  return { code: r.status, err: (r.stderr || '').toString() };
}

function main() {
  const exist = findChrome();
  if (exist) {
    console.log('  [OK] 浏览器组件已就绪: ' + exist);
    return 0;
  }

  // 实测：playwright install chromium 会拉 4 个组件共约 317MB，落地 719MB；
  // 官方 CDN 曾实测跑满 58 分钟。写"200MB / 1-20 分钟"会让人以为卡死了。
  console.log('  未检测到浏览器组件，开始自动下载（约 320MB，视网络 5-60 分钟）...');
  console.log('  提示: 若长时间无进度，可 Ctrl+C 中断后手动下载，或改用内置的 exe 完整版。');

  for (let i = 0; i < HOSTS.length; i++) {
    const h = HOSTS[i];
    console.log('\n  >> 尝试下载源 ' + (i + 1) + '/' + HOSTS.length + ': ' + h.name);
    const r = tryInstall(h.host);
    const now = findChrome();
    if (now) {
      console.log('\n  [OK] 下载完成: ' + now);
      return 0;
    }
    console.log('  [X] 该源失败' + (r.err ? ': ' + r.err.split('\n').filter(Boolean).slice(-1)[0] : ''));
  }

  console.log('\n  [X] 所有下载源均失败。请检查网络，或联系分发者获取"完整版 exe"（内置浏览器，无需下载）。');
  return 1;
}

process.exit(main());
