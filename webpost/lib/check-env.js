/* 绿联社区发帖工作台 — Copyright (c) 2026 很多问题的小明同学（GitHub @gulugulupao）
 * 授权：MIT License + 附加保护条款（保留署名 / 禁止冒名 / 禁止商用冒用），完整文本见 LICENSE.txt
 */
/**
 * 环境检测器 —— 启动前体检，把"换台机器就跑不起来"的问题提前暴露出来
 *
 * 用法:
 *   node lib/check-env.js          快速体检（不启动浏览器）
 *   node lib/check-env.js --deep   完整体检（真实启动一次 Chromium）
 *   node lib/check-env.js --json   输出 JSON（供前端 /api/env 用）
 *
 * 退出码: 0 = 可用（可能带警告）; 1 = 存在阻断性问题
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dns = require('dns');
const { spawnSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8791);
const NEED_FREE_MB = 800; // chromium 解压后约 440MB，再留余量

const items = [];
function add(level, name, detail, fix) {
  items.push({ level, name, detail: detail || '', fix: fix || '' });
}

// ---------- 1. 操作系统 ----------
function checkOS() {
  const rel = os.release();           // 形如 10.0.19045
  const major = parseInt(String(rel).split('.')[0], 10);
  const isWin = os.platform() === 'win32';
  if (!isWin) {
    add('ERROR', '操作系统', '当前不是 Windows：' + os.platform(), '本工具只支持 Windows');
    return;
  }
  if (major >= 10) {
    add('OK', '操作系统', 'Windows ' + rel);
  } else if (major === 6) {
    // 6.1=Win7, 6.2=Win8, 6.3=Win8.1
    add('ERROR', '操作系统', 'Windows ' + rel + '（版本过低）',
      '内置浏览器要求 Windows 10 及以上，请升级系统');
  } else {
    add('WARN', '操作系统', 'Windows ' + rel + '（未能识别版本）', '建议 Windows 10 及以上');
  }
}

// ---------- 2. 桌面会话（headed 登录窗必须） ----------
function checkDesktopSession() {
  const sn = process.env.SESSIONNAME || '';
  const hasDesktop = /Console|RDP/i.test(sn) || sn !== '';
  if (hasDesktop) {
    add('OK', '桌面会话', '已登录桌面会话（可弹出登录窗口）');
  } else {
    add('WARN', '桌面会话', '未检测到桌面会话（SESSIONNAME 为空）',
      '远程命令行/计划任务环境下弹不出登录窗口，请在本机桌面双击启动');
  }
}

// ---------- 3. 磁盘空间 ----------
function checkDisk() {
  try {
    const target = process.env.LOCALAPPDATA || os.tmpdir();
    const st = fs.statfsSync(target);
    const freeMB = Math.floor((st.bavail * st.bsize) / 1024 / 1024);
    if (freeMB >= NEED_FREE_MB) {
      add('OK', '磁盘空间', '可用 ' + freeMB + ' MB');
    } else {
      add('ERROR', '磁盘空间', '仅剩 ' + freeMB + ' MB，不足 ' + NEED_FREE_MB + ' MB',
        '清理磁盘，浏览器组件解压后约占 440MB');
    }
  } catch (e) {
    add('WARN', '磁盘空间', '无法读取（' + e.message + '）', '');
  }
}

// ---------- 4. 用户目录可写（登录凭证存放处） ----------
function checkUserDataWritable() {
  try {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const dir = path.join(base, 'UGREENPostWorkbench');
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write_test');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    add('OK', '用户目录可写', dir);
  } catch (e) {
    add('ERROR', '用户目录可写', '写入失败：' + e.message,
      '检查 %LOCALAPPDATA% 权限，或改用管理员身份运行');
  }
}

// ---------- 5. Node 运行时 ----------
function checkNode() {
  const bundled = path.join(APP_ROOT, 'node', 'node.exe');
  if (fs.existsSync(bundled)) {
    add('OK', 'Node 运行时', '使用自带便携版 node ' + process.version);
    return;
  }
  const r = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) {
    add('WARN', 'Node 运行时', '未找到自带 node，回退系统 node ' + String(r.stdout).trim(),
      '建议用完整分发包（自带 node）');
  } else {
    add('ERROR', 'Node 运行时', '既无自带 node，系统也没有 node',
      '请下载完整分发包，或安装 Node.js 后重试');
  }
}

// ---------- 6. Chromium ----------
function findChrome() {
  const cands = [];
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  cands.push(path.join(APP_ROOT, 'browser', 'chrome-win64', 'chrome.exe'));
  cands.push(path.join(APP_ROOT, 'browser', 'chrome-win', 'chrome.exe'));
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
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

async function checkChromium(deep) {
  const chrome = findChrome();
  if (!chrome) {
    add('ERROR', '浏览器组件', '未找到 Chromium/Chrome/Edge',
      '首次启动会自动下载（约 320MB）；若一直失败，改用内置浏览器的完整版 exe');
    return;
  }
  const mb = (() => {
    try { return Math.round(fs.statSync(chrome).size / 1024 / 1024 * 10) / 10; } catch (e) { return 0; }
  })();
  add('OK', '浏览器组件', chrome + (mb ? ' (' + mb + ' MB)' : ''));

  if (deep) {
    // 真实启动一次，确认能跑起来（缺 DLL / 版本不兼容能在这里暴露）
    try {
      const { chromium } = require('playwright-core');
      const b = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
      await b.close();
      add('OK', '浏览器可启动', 'Chromium 实际启动测试通过');
    } catch (e) {
      add('ERROR', '浏览器可启动', '启动失败：' + String(e.message).slice(0, 160),
        '可能是缺系统运行库或版本不兼容，建议改用完整版 exe（内置浏览器）');
    }
  }
}

// ---------- 7. Python（仅命令行 md2post.py 需要，主流程已不依赖） ----------
function checkPython() {
  const r = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  const r3 = r.status === 0 ? null : spawnSync('python3', ['--version'], { encoding: 'utf8', windowsHide: true });
  const ok = r.status === 0 || (r3 && r3.status === 0);
  if (ok) {
    add('OK', 'Python（可选）', '已安装，命令行版 md2post.py 可用');
  } else {
    add('OK', 'Python（可选）', '未安装 —— 不影响使用',
      '网页版导入 Markdown 已改为内置 JS 实现，不需要 Python');
  }
}

// ---------- 8. 端口占用 ----------
function checkPort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', e => {
      if (e.code === 'EADDRINUSE') {
        add('WARN', '端口 ' + PORT, '已被占用（可能已经开了一个工作台）',
          '直接用已打开的那个即可；或关掉旧的黑色窗口再启动');
      } else {
        add('WARN', '端口 ' + PORT, '无法监听：' + e.code, '');
      }
      resolve();
    });
    srv.once('listening', () => {
      add('OK', '端口 ' + PORT, '可用');
      srv.close(() => resolve());
    });
    srv.listen(PORT, '127.0.0.1');
  });
}

// ---------- 9. 网络连通 ----------
function checkNetwork() {
  return new Promise(resolve => {
    const t = setTimeout(() => {
      add('WARN', '网络连通', '检测超时', '登录和发帖需要联网，请检查网络');
      resolve();
    }, 6000);
    dns.lookup('club.ugnas.com', err => {
      clearTimeout(t);
      if (err) {
        add('WARN', '网络连通', '无法解析 club.ugnas.com（' + err.code + '）',
          '登录、发帖、下载浏览器都需要联网');
      } else {
        add('OK', '网络连通', '可解析绿联社区域名');
      }
      resolve();
    });
  });
}

// ---------- 输出 ----------
function render(jsonMode) {
  if (jsonMode) {
    const errs = items.filter(i => i.level === 'ERROR').length;
    const warns = items.filter(i => i.level === 'WARN').length;
    console.log(JSON.stringify({ ok: errs === 0, errors: errs, warnings: warns, items }, null, 2));
    return errs === 0 ? 0 : 1;
  }
  console.log('');
  console.log('========== 环境检测 ==========');
  for (const i of items) {
    const tag = i.level === 'OK' ? '[正常]' : i.level === 'WARN' ? '[警告]' : '[错误]';
    console.log('  ' + tag + ' ' + i.name + (i.detail ? ' :: ' + i.detail : ''));
    if (i.fix && i.level !== 'OK') console.log('          -> ' + i.fix);
  }
  const errs = items.filter(i => i.level === 'ERROR');
  const warns = items.filter(i => i.level === 'WARN');
  console.log('--------------------------------');
  console.log('  正常 ' + items.filter(i => i.level === 'OK').length +
    ' / 警告 ' + warns.length + ' / 错误 ' + errs.length);
  if (errs.length) {
    console.log('');
    console.log('  存在 ' + errs.length + ' 个阻断性问题，解决后才能正常使用：');
    errs.forEach(e => console.log('    - ' + e.name + '：' + (e.fix || e.detail)));
  } else {
    console.log('  环境就绪，可以正常使用。');
  }
  console.log('');
  return errs.length ? 1 : 0;
}

(async () => {
  try { spawnSync('chcp', ['65001'], { stdio: 'ignore', shell: true, windowsHide: true }); } catch (e) {}
  const deep = process.argv.includes('--deep');
  const jsonMode = process.argv.includes('--json');

  checkOS();
  checkDesktopSession();
  checkDisk();
  checkUserDataWritable();
  checkNode();
  await checkChromium(deep);
  checkPython();
  await checkPort();
  await checkNetwork();

  process.exit(render(jsonMode));
})();
