/* 绿联社区发帖工作台 — Copyright (c) 2026 很多问题的小明同学（GitHub @gulugulupao）
 * 授权：MIT License + 附加保护条款（保留署名 / 禁止冒名 / 禁止商用冒用），完整文本见 LICENSE.txt
 */
/**
 * server.js — 绿联社区网页版发帖工作台
 * 本地服务: 页面 + 图片保存 + 草稿 + 一键发布(复用 postcore 填帖链路)
 *
 * 启动: node server.js  (默认 http://127.0.0.1:8791)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
// 切控制台到 UTF-8, 保证 bat 启动时中文输出正常
try { require('child_process').execSync('chcp 65001 >nul', { stdio: 'ignore' }); } catch (e) {}
// 全局异常防护: Node 15+ 默认 unhandledRejection 会直接杀进程。
// 版块扫描/发布都是重异步(chromium)操作, 用户关一下弹出的浏览器窗口就可能
// 抛 "Target closed" —— 不接住的话整个服务崩掉, 黑窗口直接落到 pause。
process.on('uncaughtException', err => {
  console.error('[异常-已拦截] ' + (err && err.stack || err));
});
process.on('unhandledRejection', err => {
  console.error('[异步异常-已拦截] ' + (err && err.stack || err));
});
const { chromium } = require('playwright-core');
const { Poster, AUTH, ACCOUNTS_DIR, authPathFor, CHROME, USER_DIR, checkPostUrl, editPostFlow } = require('./lib/postcore');
const { getBoards, CACHE_FILE } = require('./lib/boards');

const PORT = process.env.PORT || 8791;
const BASE = __dirname;
const ROOT = path.resolve(BASE, '..'); // 绿联社区发帖工具/
const PUBLIC = path.join(BASE, 'public');
// 报错截图里是"已登录的论坛页面"，不能落在程序目录（会被打包/复制带走），
// 一律放到用户目录
const SHOTS = path.join(USER_DIR, 'shots');
// 草稿和插图存到用户目录（与登录凭证同级），这样卸载/重装 exe 不会丢稿子
const DRAFT = path.join(USER_DIR, 'draft');
const DRAFT_IMG = path.join(DRAFT, 'images');
// 旧版草稿在应用目录(BASE/draft)，新版在用户目录。
// 不做递归复制（跨个人目录的批量写会被安全策略拦截，且 cpSync 在目标已存在时会嵌套复制）。
// 改为读取时回退：新位置没有就去旧位置找，见 /api/draft。
const LEGACY_DRAFT = path.join(BASE, 'draft');
const LEGACY_DRAFT_IMG = path.join(LEGACY_DRAFT, 'images');
try { fs.mkdirSync(DRAFT_IMG, { recursive: true }); } catch (e) { console.error('草稿目录创建失败: ' + e.message); }
try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) {}
// 发布记录（V1.2.0）：发过的帖子链接/时间/账号存本机，可"再发一次"。
// 同样放用户目录：卸载重装不丢，也不进程序目录（不随包带走）
const POSTS = path.join(USER_DIR, 'posts');
const POSTS_LOG = path.join(POSTS, 'log.json');
try { fs.mkdirSync(POSTS, { recursive: true }); } catch (e) {}

function readPosts() {
  try { return JSON.parse(fs.readFileSync(POSTS_LOG, 'utf8')) || []; } catch (e) { return []; }
}
// 从请求体里粗算字数/图片数（记录用，不追求精确）
function plainLen(body) {
  try { return String((body && body.html) || '').replace(/<[^>]+>/g, '').replace(/\s+/g, '').length; } catch (e) { return 0; }
}
function imgCount(body) {
  try { return (String((body && body.html) || '').match(/<img/g) || []).length; } catch (e) { return 0; }
}function writePosts(list) {
  // 只留最近 100 条，别让这个文件无限长大
  const keep = list.slice(0, 100);
  try { fs.writeFileSync(POSTS_LOG, JSON.stringify(keep, null, 2), 'utf8'); } catch (e) {}
  return keep;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

let publishing = false; // 发布锁, 防止并发
let heldPoster = null;  // 填入模式留下的浏览器实例（窗口要留给用户检查，下次发帖前再收掉）

// ---------- 网页端登录(分发版核心: 每个用户登自己的账号) ----------
let loginBrowser = null;
let loginPage = null;
let loginState = 'idle'; // idle | waiting | success | failed
let loginUser = '';
let loginAccount = '';   // 本次登录存成的账号名（'' = 默认账号）
let loginTimer = null;
let loginDeadline = 0;   // 登录轮询的超时点，避免永远 waiting
let loginCtx = null;

// 账号名 -> 文件名。论坛昵称里可能有空格/斜杠等，直接拿去拼路径会出事。
function sanitizeAccountName(s) {
  let n = String(s || '').trim().replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 30).trim();
  if (!n) n = '';
  // 'default' 是默认账号保留字（代表 AUTH 那份凭证），别和它撞名
  if (n.toLowerCase() === 'default') n = 'default_1';
  // Windows 保留设备名 / 点开头：写成 accounts/CON.json 会直接失败
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..*)?$/i.test(n) || n.startsWith('.')) n = 'a_' + n;
  return n;
}

async function loginStart(saveAs) {
  // 清理旧登录会话
  await loginCancel();
  loginState = 'waiting';
  loginUser = '';
  loginAccount = '';
  try {
    loginBrowser = await chromium.launch({
      executablePath: CHROME, headless: false,
      // --start-maximized：从最小化的黑窗口启动时，Chromium 会跟着缩在任务栏里不露面
      args: ['--no-sandbox', '--start-maximized', '--window-size=1200,900'],
    });
    loginCtx = await loginBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      viewport: null, locale: 'zh-CN',
    });
    loginPage = await loginCtx.newPage();
    await loginPage.goto('https://club.ugnas.com/member.php?mod=logging&action=login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await loginPage.bringToFront().catch(() => {});   // 尽力把窗口顶到最前
    // 轮询不能无限跑：用户打开登录窗后不管它、或卡在别的域上，都会永远 waiting
    loginDeadline = Date.now() + 5 * 60 * 1000;

    // [测试专用] 环境变量提供账号时自动填表(仅用于E2E验证, 正常使用不设置此变量)
    // 测试后门：必须同时开 UGREEN_E2E=1 才启用，免得用户机器上恰好有这两个
    // 环境变量时，登录窗被静默自动填表提交
    if (process.env.UGREEN_E2E === '1' && process.env.LOGIN_AUTO_PHONE && process.env.LOGIN_AUTO_PWD) {
      try {
        await loginPage.waitForSelector('input[type="text"]', { timeout: 30000 });
        await new Promise(r => setTimeout(r, 2500)); // SPA 输入框就绪等待
        const phoneInput = loginPage.locator('input[type="text"]').first();
        await phoneInput.click();
        await phoneInput.fill(process.env.LOGIN_AUTO_PHONE);
        await loginPage.locator('input[type="password"]').first().fill(process.env.LOGIN_AUTO_PWD);
        const cb = loginPage.locator('.ivu-checkbox-input').first();
        if (!(await cb.isChecked())) await cb.click();
        await loginPage.locator('.login-btn').first().click();
        console.log('[登录][测试] 已自动填表并提交');
      } catch (e) { console.log('[登录][测试] 自动填表失败:', e.message.slice(0, 100)); }
    }
    // 轮询检测登录成功(SSO 登录后会跳回 club.ugnas.com)
    // 坑（真实踩过，用户实测炸出来的）：早期用 url.includes('club.ugnas.com') 判断，
    // 但 SSO 登录页 web.ugnas.com/account/login 的 redirect_uri 参数里就带着
    // "club.ugnas.com" 字样 —— 轮询以为已经跳回论坛，把还在登录页的浏览器强行
    // 导航到 forum.php，然后每 2.5 秒重载一次，用户永远输不了密码。
    // 必须 new URL() 后按 hostname 精确判断，且没登录时绝不乱导航。
    let lastKick = 0;
    loginTimer = setInterval(async () => {
      try {
        if (loginDeadline && Date.now() > loginDeadline) { loginFail('等待登录超时（5 分钟）'); return; }
        if (!loginPage || loginPage.isClosed()) { loginFail('登录窗口被关闭'); return; }
        let u = null;
        try { u = new URL(loginPage.url()); } catch (e) {}
        // 还在账号登录页（web.ugnas.com）时保持安静，让用户安心输密码
        if (!u || u.hostname !== 'club.ugnas.com') return;
        // 严格判据: 必须存在"退出登录"链接才算真登录(.kmname 未登录时也存在, 不可靠)
        // 顺带读 document.readyState —— 页面还没加载完时先不判断，免得把
        // 刚登录完、还在跳转的人误踢回登录页
        const st = await loginPage.evaluate(() => {
          const logout = document.querySelector('a.info_loginout, a[href*="action=logout"]');
          const nameEl = document.querySelector('.kmname');
          return {
            ready: document.readyState,
            user: logout ? (nameEl ? nameEl.innerText.trim() : '已登录') : '',
          };
        });
        const info = st.ready === 'complete' ? st.user : '';
        if (info) {
          loginUser = info;
          // 存档位置三种情况：
          //   '__default__' -> 覆盖早期版本留下的默认账号 auth.json（老用户的"重新登录"）
          //   给了名字      -> 覆盖那个号（账号柜里的"重新登录"）
          //   没给名字      -> 新账号，直接用论坛昵称命名，用户不用再想起名
          const wantDefault = String(saveAs) === '__default__';
          let name, targetPath;
          if (wantDefault) {
            name = ''; targetPath = AUTH;
          } else {
            name = sanitizeAccountName(saveAs) || sanitizeAccountName(info) || ('账号' + Date.now().toString(36));
            targetPath = path.join(ACCOUNTS_DIR, name + '.json');
            try { fs.mkdirSync(ACCOUNTS_DIR, { recursive: true }); } catch (e) {}
          }
          await loginCtx.storageState({ path: targetPath });
          if (!wantDefault) {
            try {
              fs.writeFileSync(path.join(ACCOUNTS_DIR, name + '.info.json'),
                JSON.stringify({ user: info, savedAt: new Date().toISOString() }));
            } catch (e) {}
          }
          loginAccount = name;
          loginState = 'success';
          clearInterval(loginTimer); loginTimer = null;
          console.log('[登录] 成功:', info, '-> 账号「' + name + '」已保存');
          // 清掉板块缓存(可能存的是未登录态的脏数据), 下次扫描强制刷新
          try { fs.unlinkSync(CACHE_FILE); console.log('[登录] 已清除板块缓存'); } catch (e) {}
          // 关闭登录窗口(避免用户误操作; 发帖时会另开窗口)
          try { await loginBrowser.close(); } catch (e) {}
          loginBrowser = null; loginCtx = null; loginPage = null;
          return;
        }
        // 还没登录成功：万一被 SSO 甩到论坛普通页，温和地送回登录页（15 秒最多一次）
        // 正停在 member.php 登录入口时不折腾
        if (u.pathname !== '/member.php' && Date.now() - lastKick > 15000) {
          lastKick = Date.now();
          await loginPage.goto('https://club.ugnas.com/member.php?mod=logging&action=login',
            { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }
      } catch (e) { /* 轮询中导航失败不中断, 继续等 */ }
    }, 2500);
    return { ok: true };
  } catch (e) {
    loginFail(e.message);
    return { ok: false, error: e.message };
  }
}
function loginFail(reason) {
  loginState = 'failed';
  loginUser = '';
  if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
  // 早期失败时不关浏览器，会留下一个孤儿 Chromium 窗口
  if (loginBrowser) { try { loginBrowser.close(); } catch (e) {} }
  loginBrowser = null; loginCtx = null; loginPage = null;
  console.log('[登录] 失败:', reason);
}
async function loginCancel() {
  if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
  if (loginBrowser) { try { await loginBrowser.close(); } catch (e) {} }
  loginBrowser = null; loginCtx = null; loginPage = null;
  if (loginState === 'waiting') loginState = 'idle';
}

// ---------- 诊断报告（反馈通道用）----------
// 版本号唯一源头：webpost/package.json。早期这里硬编码，发版忘了改，
// 用户发来的诊断包上写的就是错的版本，等于没法定位问题
const VERSION = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();

/**
 * 组装一份"能照着排查"的诊断报告。
 * 隐私红线（分发给别人用，这条比功能本身更重要）：
 *   只收排查必需的信息 —— 环境、官方发帖页体检、版块权限快照。
 *   绝不收：账号密码、登录凭证文件、昵称、草稿正文与图片、本机路径。
 */
// 脱敏：环境结果里有两条会带出本机绝对路径（顺带暴露 Windows 用户名），
// 报告是要发给别人的，这里只留结论、不留路径。
function redactEnv(env) {
  if (!env || !Array.isArray(env.items)) return env;
  const items = env.items.map(i => {
    let d = String(i.detail || '');
    if (i.name === '用户目录可写') d = i.level === 'OK' ? '可写' : d.replace(/[A-Za-z]:\\[^\s，,]*/g, '(已隐去本机路径)');
    else if (i.name === '浏览器组件') {
      const m = d.match(/[\\\/]([^\\\/]+)$/);
      d = m ? m[1] : '已内置';
    }
    return Object.assign({}, i, { detail: d });
  }).filter(i => !/^端口 /.test(i.name));   // 服务自己就占着端口，这项必然误报
  return Object.assign({}, env, { items });
}

async function buildDiag({ account, fid, deep }) {
  // 1. 环境自检（快）
  let env = null;
  try {
    const r = require('child_process').spawnSync(
      process.execPath, [path.join(__dirname, 'lib', 'check-env.js'), '--json'],
      { encoding: 'utf8', windowsHide: true });
    env = redactEnv(JSON.parse(String(r.stdout || '').trim()));
  } catch (e) { env = null; }

  // 2. 官方发帖页体检（要开浏览器，慢，deep 才做）
  let doctor = null;
  if (deep) {
    const authPath = authPathFor(account);
    if (!fs.existsSync(authPath)) {
      doctor = { ok: false, items: [], hint: '这个账号还没有登录凭证，先登录后再体检' };
    } else {
      try {
        const { runDoctor } = require('./lib/doctor');
        doctor = await runDoctor({ chrome: CHROME, authPath, fid });
      } catch (e) { doctor = { ok: false, items: [], hint: '体检失败: ' + e.message.slice(0, 120) }; }
    }
  }

  // 3. 版块权限快照 —— 只要结构，不要任何凭证
  let boards = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(USER_DIR, 'boards_cache.json'), 'utf8'));
    const list = raw.boards || [];
    // 只要结构，不要身份：昵称是唯一的个人信息，一律不进包
    boards = {
      fetchedAt: raw.fetchedAt ? new Date(raw.fetchedAt).toISOString() : null,
      total: list.length,
      canPost: list.filter(b => b.canPost).length,
      list: list.map(b => ({ fid: b.fid, name: b.name, canPost: !!b.canPost, cats: (b.cats || []).length })),
    };
  } catch (e) { boards = null; }

  // 4. 拼成人能读的文本
  const L = [];
  L.push('【绿联发帖工作台 · 诊断报告】');
  L.push('时间: ' + new Date().toLocaleString('zh-CN'));
  L.push('版本: ' + VERSION);
  L.push('');
  L.push('—— 环境 ——');
  if (env && env.items) {
    env.items.forEach(i => L.push('  ' + (i.level === 'OK' ? '✓' : i.level === 'WARN' ? '!' : '✗')
      + ' ' + i.name + ': ' + i.detail));
  } else L.push('  (未能获取)');
  L.push('');
  L.push('—— 官方发帖页体检' + (deep ? '' : '（未执行）') + ' ——');
  if (doctor) {
    L.push('  结论: ' + (doctor.ok ? '正常' : '有问题'));
    if (doctor.hint) L.push('  ' + doctor.hint);
    (doctor.items || []).forEach(i => L.push('   ' + (i.ok ? '✓' : '✗') + ' ' + i.name + ': ' + i.detail));
  } else L.push('  (本次没跑在线体检)');
  L.push('');
  L.push('—— 版块权限 ——');
  if (boards) {
    L.push('  可发帖版块 ' + boards.canPost + ' / 共 ' + boards.total);
    L.push('  扫描时间: ' + (boards.fetchedAt || '-'));
  } else L.push('  (还没有扫描记录)');
  L.push('');
  L.push('—— 隐私说明 ——');
  L.push('  本报告不含任何个人信息：无账号密码、无登录凭证、无昵称、无草稿正文与图片、无本机路径。');
  L.push('  只有「哪些环境项通过了 / 哪些发帖页元素没找到 / 能在几个版块发帖」这三类结论。');

  return {
    ok: true,
    text: L.join('\n'),
    env, doctor, boards,
    version: VERSION,
    at: new Date().toISOString(),
  };
}

// ---------- 账号柜 ----------
// '' 代表默认账号（早期版本留下的 auth.json 那份凭证），其余是 accounts/<名字>.json
function listAccounts() {
  const list = [];
  if (fs.existsSync(AUTH)) list.push({ name: '', label: '默认账号', user: '', isDefault: true });
  try {
    if (fs.existsSync(ACCOUNTS_DIR)) {
      fs.readdirSync(ACCOUNTS_DIR)
        .filter(f => f.endsWith('.json') && !f.endsWith('.info.json'))
        .forEach(f => {
          const name = f.replace(/\.json$/, '');
          let user = '';
          try {
            user = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, name + '.info.json'), 'utf-8')).user || '';
          } catch (e) {}
          list.push({ name, label: user ? user : name, user, isDefault: false });
        });
    }
  } catch (e) {}
  return list;
}

// ---------- 工具 ----------
// 本机服务，但浏览器里的任意网页都能 fetch 127.0.0.1 —— 早期这里写的是
// Access-Control-Allow-Origin: *，等于把"用它已登录的账号发帖 / 删号 / 读诊断包"
// 的权限送给了任意网页。现在只认同源，并校验 Host 与 Origin。
const ORIGIN = 'http://127.0.0.1:' + PORT;
function isLocalAllowed(req) {
  const host = String(req.headers.host || '');
  if (host !== '127.0.0.1:' + PORT && host !== 'localhost:' + PORT) return false;
  const o = req.headers.origin;
  if (!o) return true;                       // 地址栏直敲 / curl，没有 Origin
  return String(o) === ORIGIN || String(o) === 'http://localhost:' + PORT;
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ORIGIN,
    Vary: 'Origin',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      // 超限：回 413 并明确结束这条 Promise。早期这里是裸 req.destroy()，
      // 既不 resolve 也不 reject —— 发布锁会永远卡住，服务不重启再也发不了帖。
      if (data.length > 60 * 1024 * 1024) {
        try { res.writeHead(413, { 'Content-Type': 'text/plain' }); res.end('body too large'); } catch (e) {}
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('请求被中断')));
  });
}

// ---------- 编辑器 HTML -> 发布格式 ----------
function convertEditorHtml(html) {
  const images = [];
  let n = 0;
  // /draft-images/xxx.png -> [[IMG_n]] 占位符
  let converted = html.replace(/<img\b[^>]*src="\/draft-images\/([^"]+)"[^>]*>/gi, (m, name) => {
    // 名字来自页面内容，必须校验落点还在图片目录里 —— 否则正文里写个
    // ../../Users/xxx/私密.png 就能把任意本地文件上传到公开论坛
    try {
      const abs = path.resolve(DRAFT_IMG, path.basename(decodeURIComponent(name)));
      if (abs.startsWith(DRAFT_IMG + path.sep)) images.push(abs);
    } catch (e) {}
    return `[[IMG_${++n}]]`;
  });
  // 兜底: data: URL 图片落地
  converted = converted.replace(/<img\b[^>]*src="data:image\/(\w+);base64,([^"]+)"[^>]*>/gi, (m, ext, b64) => {
    const fname = `paste_${Date.now()}_${++n}.${ext === 'jpeg' ? 'jpg' : ext}`;
    fs.writeFileSync(path.join(DRAFT_IMG, fname), Buffer.from(b64, 'base64'));
    images.push(path.join(DRAFT_IMG, fname));
    return `[[IMG_${n}]]`;
  });
  return { html: converted, images };
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  // favicon：public/favicon.ico（与应用快捷方式同一套图标）。
  // 早期这里回 204 空响应，标签页一直是默认的空白图标。
  if (p === '/favicon.ico') {
    const fav = path.join(PUBLIC, 'favicon.ico');
    if (fs.existsSync(fav)) {
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      return fs.createReadStream(fav).pipe(res);
    }
    res.writeHead(204); return res.end();
  }

  // 只服务本机的同源页面：任意网页都不能偷偷调这个服务（发帖/删号/读诊断包）
  if (!isLocalAllowed(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden'); }

  // CORS 预检
  if (req.method === 'OPTIONS') {
    if (!isLocalAllowed(req)) { res.writeHead(403); return res.end(); }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    });
    return res.end();
  }

  try {
    // ===== API =====
    if (p === '/api/status' && req.method === 'GET') {
      // auth = "本机是否有任一可用账号"。以前只看默认那份 auth.json，
      // 结果用第二个账号登录时登录门会一直弹 —— 现在按账号柜整体判断。
      return send(res, 200, { ok: true, auth: listAccounts().length > 0, loginState, loginUser, account: loginAccount, version: VERSION });
    }

    if (p === '/api/env' && req.method === 'GET') {
      // 环境自检：操作系统/磁盘/端口/浏览器/网络，供前端展示或排查用
      const { spawnSync } = require('child_process');
      const script = path.join(__dirname, 'lib', 'check-env.js');
      const r = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', windowsHide: true });
      try {
        return send(res, 200, JSON.parse(String(r.stdout || '').trim()));
      } catch (e) {
        return send(res, 200, { ok: false, errors: 1, warnings: 0, items: [], error: '检测脚本执行失败' });
      }
    }

    // ===== 网页端登录(分发版) =====
    if (p === '/api/login/start' && req.method === 'POST') {
      if (loginState === 'waiting') return send(res, 200, { ok: true, msg: '登录窗口已打开, 请完成登录' });
      const body = await readBody(req).catch(() => ({}));
      const r = await loginStart(body.saveAs || '');
      return send(res, 200, r);
    }
    if (p === '/api/login/status' && req.method === 'GET') {
      // auth 按账号柜整体判断，别再只看 auth.json —— 新登录的号都存 accounts/ 里
      // loginUrl: 登录窗口当前停在哪个页面（只本机可读，排查"卡在哪一步"用）
      let loginUrl = '';
      try { if (loginPage && !loginPage.isClosed()) loginUrl = loginPage.url(); } catch (e) {}
      return send(res, 200, { ok: true, state: loginState, user: loginUser, account: loginAccount, auth: listAccounts().length > 0, loginUrl });
    }
    if (p === '/api/login/cancel' && req.method === 'POST') {
      await loginCancel();
      return send(res, 200, { ok: true });
    }

    // ===== 诊断报告（反馈通道）=====
    // 隐私红线：只收集"排查故障必需"的信息，绝不包含
    //   · 账号密码 / 登录凭证(auth.json、accounts/*.json)
    //   · 草稿正文与图片
    //   · 任何剪贴板/文件内容
    // 收集完会先给用户在页面上过目一遍再复制，做到所见即所得。
    // ===== 发布记录（V1.2.0）=====
    // 发过的帖子：链接/时间/账号/标题/版块/正文摘要。存本机，可一键"再发一次"。
    if (p === '/api/posts' && req.method === 'GET') {
      return send(res, 200, { ok: true, items: readPosts() });
    }
    if (p === '/api/posts' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const list = readPosts();
        if (body.del) {
          const i = Number(body.del) - 1;
          if (!list[i]) return send(res, 200, { ok: false, error: '序号不对' });
          list.splice(i, 1);
          writePosts(list);
          return send(res, 200, { ok: true, items: readPosts() });
        }
        // 正文只存"够回看"的长度，不无限堆 —— 但正文要能"再发一次"，所以全存
        const rec = {
          at: Date.now(),
          time: new Date().toLocaleString('zh-CN'),
          title: String(body.title || '').slice(0, 120),
          url: String(body.url || ''),
          board: String(body.board || ''),
          account: String(body.account || '默认账号'),
          chars: Number(body.chars || 0),
          images: Number(body.images || 0),
          html: String(body.html || '').slice(0, 200000),
          status: String(body.status || 'published'),
        };
        if (!rec.url) return send(res, 200, { ok: false, error: '缺少帖子链接' });
        list.unshift(rec);
        writePosts(list);
        return send(res, 200, { ok: true, items: readPosts() });
      } catch (e) {
        return send(res, 200, { ok: false, error: '记录失败: ' + e.message.slice(0, 120) });
      }
    }

    if (p === '/api/check-post' && req.method === 'POST') {
      // 手动检测审核状态（V1.4.0）：用已登录态无头打开帖子 URL 看一眼。
      // Discuz 没有公开的审核结果接口，这是唯一可靠的办法。
      try {
        const body = await readBody(req);
        const url = String(body.url || '');
        if (!/club\.ugnas\.com/.test(url)) return send(res, 200, { ok: false, error: '不是有效的社区帖子链接' });
        const list = readPosts();
        const rec = list[Number(body.index) - 1];
        if (!rec) return send(res, 200, { ok: false, error: '序号不对' });
        const r = await checkPostUrl(url, body.account || rec.account || '');
        rec.status = r.status;
        rec.statusReason = r.reason;
        rec.checkedAt = Date.now();
        writePosts(list);
        return send(res, 200, { ok: true, status: r.status, reason: r.reason });
      } catch (e) {
        return send(res, 200, { ok: false, error: '检测失败: ' + String(e.message).slice(0, 140) });
      }
    }

    // 编辑已发帖子（V1.5.0）：apply=false 只把论坛内容拉回来；apply=true 用传入内容覆盖并保存
    if (p === '/api/edit-post' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const url = String(body.url || '');
        if (!/club\.ugnas\.com/.test(url)) return send(res, 200, { ok: false, error: '不是有效的社区帖子链接' });
        if (body.apply) {
          if (!String(body.html || '').trim()) return send(res, 200, { ok: false, error: '编辑器内容是空的，不覆盖' });
        }
        const logs = [];
        const r = await editPostFlow({
          url, account: String(body.account || ''),
          title: String(body.title || ''), html: String(body.html || ''),
          apply: !!body.apply,
          log: (m) => { logs.push(m); console.log('[编辑]', m); },
        });
        if (body.apply) {
          // 编辑成功也刷新记录里的状态
          try {
            const list = readPosts();
            const rec = list[Number(body.index) - 1];
            if (rec) { rec.status = 'published'; rec.editedAt = Date.now(); writePosts(list); }
          } catch (_) {}
        }
        return send(res, 200, {
          ok: true, apply: !!body.apply,
          oldTitle: r.oldTitle || '', oldHtml: r.oldHtml || '',
          logs,
        });
      } catch (e) {
        return send(res, 200, { ok: false, error: String(e.message || '编辑失败').slice(0, 200) });
      }
    }

    if (p === '/api/diag' && req.method === 'GET') {
      const account = u.searchParams.get('account') || '';
      const fid = u.searchParams.get('fid') || '9';
      const deep = u.searchParams.get('deep') === '1';
      const r = await buildDiag({ account, fid, deep });
      return send(res, 200, r);
    }
    // 打包下载（.zip），供通过 GitHub issue 等渠道当附件提交
    if (p === '/api/diag/zip' && req.method === 'GET') {
      const r = await buildDiag({
        account: u.searchParams.get('account') || '',
        fid: u.searchParams.get('fid') || '9',
        deep: u.searchParams.get('deep') === '1',
      });
      try {
        const { zipStore } = require('./lib/minizip');
        const files = [
          { name: '诊断报告.txt', data: Buffer.from(r.text, 'utf8') },
          { name: 'env.json', data: Buffer.from(JSON.stringify(r.env, null, 2), 'utf8') },
          { name: 'doctor.json', data: Buffer.from(JSON.stringify(r.doctor, null, 2), 'utf8') },
          { name: 'boards.json', data: Buffer.from(JSON.stringify(r.boards, null, 2), 'utf8') },
          { name: 'README-报告说明.txt', data: Buffer.from(
            '这份包里只有排查故障所需的信息。\n\n'
            + '包含：环境检测结果、官方发帖页体检结果、版块权限快照。\n'
            + '不包含：账号密码、登录凭证文件、昵称、你的草稿正文与图片、任何本机路径。\n\n'
            + '可以放心地把整个包发给作者。\n', 'utf8') },
        ];
        const buf = zipStore(files);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="ugreen-workbench-diag.zip"',
          'Content-Length': buf.length,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(buf);
      } catch (e) {
        return send(res, 200, { ok: false, error: '打包失败: ' + e.message });
      }
    }

    // 官方发帖页结构自检 —— 官网改版后会在这里暴露出具体哪一项失效
    if (p === '/api/doctor' && req.method === 'GET') {
      const account = u.searchParams.get('account') || '';
      const fid = u.searchParams.get('fid') || '9';
      const authPath = authPathFor(account);
      if (!fs.existsSync(authPath)) {
        return send(res, 200, { ok: false, items: [], hint: '这个账号还没有登录凭证，先登录后再体检' });
      }
      const { runDoctor } = require('./lib/doctor');
      try {
        const r = await runDoctor({ chrome: CHROME, authPath, fid });
        return send(res, 200, r);
      } catch (e) {
        return send(res, 200, { ok: false, items: [], hint: '体检失败: ' + e.message.slice(0, 160) });
      }
    }

    // 账号柜(多账号): 列出本机保存的所有账号
    if (p === '/api/accounts' && req.method === 'GET') {
      return send(res, 200, { ok: true, accounts: listAccounts() });
    }

    // 移除某个账号 —— 只删本机凭证，不会在绿联官网注销
    if (p === '/api/account/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const name = sanitizeAccountName(body.name);
      if (!name) return send(res, 200, { ok: false, error: '默认账号不能这样移除' });
      const f = path.join(ACCOUNTS_DIR, name + '.json');
      if (!fs.existsSync(f)) return send(res, 200, { ok: false, error: '账号不存在: ' + name });
      try {
        fs.unlinkSync(f);
        try { fs.unlinkSync(path.join(ACCOUNTS_DIR, name + '.info.json')); } catch (e) {}
        console.log('[账号] 已移除 ' + name);
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    // 版块列表+权限(带缓存)
    if (p === '/api/boards' && req.method === 'GET') {
      const account = u.searchParams.get('account') || '';
      const force = u.searchParams.get('force') === '1';
      try {
        const data = await getBoards(account, m => console.log('[版块]', m), force);
        return send(res, 200, { ok: true, ...data });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/image' && req.method === 'POST') {
      const body = await readBody(req);
      const m = String(body.dataUrl || '').match(/^data:image\/(\w+);base64,(.+)$/s);
      if (!m) return send(res, 400, { ok: false, error: '不是有效的图片数据' });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const fname = `img_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
      fs.writeFileSync(path.join(DRAFT_IMG, fname), Buffer.from(m[2], 'base64'));
      return send(res, 200, { ok: true, url: '/draft-images/' + fname });
    }

    if (p === '/api/draft' && req.method === 'GET') {
      const f = path.join(DRAFT, 'draft.json');
      // 新位置没有就回退读旧位置（应用目录），避免换目录后旧稿子读不到
      const src = fs.existsSync(f) ? f : path.join(LEGACY_DRAFT, 'draft.json');
      if (fs.existsSync(src)) {
        try { return send(res, 200, { ok: true, draft: JSON.parse(fs.readFileSync(src, 'utf-8')) }); }
        catch (e) { return send(res, 200, { ok: true, draft: null }); }
      }
      return send(res, 200, { ok: true, draft: null });
    }

    if (p === '/api/import-md' && req.method === 'POST') {
      // 导入 Markdown: 前端传 md文本 + 一起选中的图片文件; 按md里的相对路径落盘后调 md2post.py
      const body = await readBody(req);
      const md = String(body.md || '');
      if (!md.trim()) return send(res, 400, { ok: false, error: '文件是空的' });
      const { mdToHtml } = require('./lib/md2html.js');
      const tmpDir = path.join(DRAFT, 'import_' + Date.now().toString(36));
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        // 1. 把上传的图片按 md 中引用的相对路径写入 tmpDir
        const uploaded = {};
        (body.images || []).forEach(im => {
          const m = String(im.dataUrl || '').match(/^data:image\/(\w+);base64,(.+)$/s);
          if (m && im.name) uploaded[path.basename(im.name)] = Buffer.from(m[2], 'base64');
        });
        const refPaths = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1].trim()).filter(s => !/^https?:\/\//.test(s));
        let placed = 0;
        refPaths.forEach(rel => {
          const base = path.basename(rel.replace(/\\/g, '/'));
          if (uploaded[base]) {
            // rel 来自 md 内容，可能写 ../../ 越出 tmpDir —— 解析后校验前缀
            const dest = path.resolve(tmpDir, rel.replace(/\\/g, '/'));
            if (dest.startsWith(path.resolve(tmpDir) + path.sep)) {
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, uploaded[base]);
              placed++;
            }
          }
        });
        // 2. 转换（纯 JS 实现，不再依赖外部 Python —— 旧实现硬编码了开发机 Python 路径，换机器必失败）
        const post = mdToHtml(md, tmpDir);
        // 3. 本地图片复制到 draft/images, 占位符换成编辑器可用路径
        let html = post.html;
        let count = 0;
        (post.images || []).forEach((src, i) => {
          try {
            const ext = path.extname(src) || '.png';
            const name = `imp_${Date.now().toString(36)}_${i}${ext}`;
            fs.copyFileSync(src, path.join(DRAFT_IMG, name));
            html = html.split(`[[IMG_${i + 1}]]`).join(`<img src="/draft-images/${name}" alt="插图">`);
            count++;
          } catch (e) { console.error('导入图片失败:', src, e.message); }
        });
        return send(res, 200, { ok: true, title: post.title, html, imageCount: count, placed, refCount: refPaths.length });
      } catch (e) {
        return send(res, 200, { ok: false, error: '转换失败: ' + e.message.slice(0, 200) });
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      }
    }

    if (p === '/api/draft' && req.method === 'POST') {
      const body = await readBody(req);
      fs.writeFileSync(path.join(DRAFT, 'draft.json'), JSON.stringify({ title: body.title || '', html: body.html || '', savedAt: new Date().toISOString() }));
      return send(res, 200, { ok: true });
    }

    if (p === '/api/publish' && req.method === 'POST') {
      if (publishing) return send(res, 409, { ok: false, error: '正在发布中，请稍候' });
      publishing = true;
      // 上一次"填入模式"留下的窗口：这次开新流程前先收掉（顺手存一次登录态）
      if (heldPoster) {
        try { await heldPoster.refreshAuth(); } catch (_) {}
        try { await heldPoster.close(); } catch (_) {}
        heldPoster = null;
      }
      const logs = [];
      let poster = null;
      // body/images 要在 catch 里用到（降级模式要回传正文与图片名），所以先在外层声明
      let body = null, images = [];
      try {
        body = await readBody(req);
        if (!String(body.title || '').trim()) throw new Error('标题不能为空');
        if (!String(body.html || '').replace(/<[^>]+>/g, '').trim() && !/\[\[IMG/.test(body.html)) throw new Error('正文不能为空');
        const converted = convertEditorHtml(body.html || '');
        const html = converted.html;
        images = converted.images;
        const submit = !!body.submit;
        logs.push(submit ? '模式: 直接发布' : '模式: 填入编辑器(不发布)');
        logs.push('账号: ' + (body.account || '默认账号') + ' · 版块: ' + (body.boardName || body.fid || '9'));
        poster = new Poster(m => { logs.push(m); console.log('[发布]', m); }, { shotDir: SHOTS, account: body.account || '' });
        await poster.launch();
        await poster.openEditor(String(body.fid || '9'));
        await poster.fill(body.title, html, body.cat || '');
        await poster.uploadImages(images);
        const shot = await poster.screenshot(submit ? 'webpost_published.png' : 'webpost_preview.png');
        let postUrl = '';
        if (submit) {
          postUrl = await poster.publish();
          await poster.screenshot('webpost_after_submit.png');
        } else if (poster.headed) {
          // 填入模式：窗口必须留着 —— 用户还要自己看一遍再点发表。
          // 踩坑（V1.4.1 修）：以前这里无条件 poster.close()，刚填完就把窗口关了，
          // 日志却写着"页面已弹出请检查"，用户根本来不及看，等于白填。
          heldPoster = poster;
          logs.push('论坛窗口保持打开：慢慢检查，确认后自己点「发表帖子」，关掉窗口也不影响内容');
        }
        // 只有"真发出去了"才清草稿图 —— 只填入编辑器不发布时，帖子没发出去，
        // 图却清掉了，用户整篇图的底稿就没了
        if (submit) {
          try {
            const used = new Set(images.map(p => path.basename(p)));
            for (const f of fs.readdirSync(DRAFT_IMG)) {
              if (used.has(f)) fs.unlinkSync(path.join(DRAFT_IMG, f));
            }
            logs.push('已清理本次使用的草稿图片');
          } catch (_) {}
        }
        // 填入模式不关窗口（heldPoster 里留着），发布模式照旧关掉
        if (!heldPoster || heldPoster !== poster) await poster.close();
        return send(res, 200, { ok: true, logs, screenshot: shot, postUrl, submit });
      } catch (e) {
        const msg = String(e.message || '');
        logs.push('错误: ' + msg);
        // 官方论坛改版 / 登录态失效 / 无权限，都会表现为同一句看不懂的
        // "locator.click: Timeout ..."。这里跑一遍结构自检，把真实原因查出来。
        if (poster) {
          try {
            const dg = await poster.diagnose();
            if (dg) {
              logs.push('--- 自动诊断 ---');
              if (dg.hint) logs.push(dg.hint);
              (dg.items || []).filter(i => !i.ok).forEach(i => logs.push('  ✗ ' + i.name + '：' + i.detail));
            }
          } catch (_) {}
        }
        // locator.…: Timeout 这类原始报错对用户毫无意义，换成能照着做的结论
        if (/Timeout|strict mode|not found|等待/i.test(msg)) {
          logs.push('→ 多半是登录态失效或该版块无权限；仍不行就点右上角「🩺 体检」看哪一项坏了');
        }
        // poster 可能为 null（比如参数校验在 new Poster 之前就抛了），别在这里二次抛异常
        if (poster) {
          try { if (poster.page) await poster.screenshot('webpost_error.png'); } catch (_) {}
          try { await poster.close(); } catch (_) {}
        }
        // 待审核：帖子交上去了，只是管理员没放行。不算失败 —— 记进发布记录
        // 并标"待审核"，让用户知道要等，而不是以为发失败了再发一遍。
        if (/^PENDING_REVIEW/.test(String(e.message))) {
          try {
            const list0 = readPosts();
            list0.unshift({
              at: Date.now(), time: new Date().toLocaleString('zh-CN'),
              title: String((body && body.title) || '').slice(0, 120), url: '',
              board: String((body && body.boardName) || (body && body.fid) || ''),
              account: String((body && body.account) || '默认账号'),
              chars: plainLen(body), images: imgCount(body),
              html: String((body && body.html) || '').slice(0, 200000),
              status: 'pending',
            });
            writePosts(list0);
          } catch (_) {}
          logs.push('帖子已提交，等待管理员审核（已记入发布记录）');
          return send(res, 200, { ok: false, pending: true, error: '帖子已提交成功，正在等待管理员审核，通过后才会显示。已记入「📝 发布记录」。', logs, screenshot: 'webpost_after_submit.png' });
        }
        // 降级模式：自动链路失败时，把"可以直接照着做"的东西交给前端 ——
        // 正文 HTML（可复制粘贴）+ 目标发帖页 URL，让用户手动发完这一篇。
        // 官方大改版当天，工具不至于变成砖头。
        const fallback = {
          html: String((body && body.html) || ''),
          url: 'https://club.ugnas.com/forum.php?mod=post&action=newthread&fid=' + String((body && body.fid) || '9'),
          title: String((body && body.title) || ''),
          images: images.map(p => path.basename(p)),
        };
        return send(res, 200, {
          ok: false, error: e.message, logs, screenshot: 'webpost_error.png', fallback,
        });
      } finally {
        publishing = false;
      }
    }

    // ===== 静态文件 =====
    let filePath;
    if (p === '/' || p === '/index.html') filePath = path.join(PUBLIC, 'index.html');
    else     if (p.startsWith('/draft-images/')) {
      // 只取文件名，任何 ../ 都别想跑出图片目录
      const rel = path.basename(p.slice('/draft-images/'.length));
      filePath = path.join(DRAFT_IMG, rel);
      // 旧版草稿的插图还在应用目录，取其回退，避免换目录后旧稿子里全是裂图
      if (!fs.existsSync(filePath)) {
        const old = path.join(LEGACY_DRAFT_IMG, rel);
        if (fs.existsSync(old)) filePath = old;
      }
    }
    else if (p.startsWith('/shots/')) filePath = path.join(SHOTS, path.basename(p.slice('/shots/'.length)));
    else filePath = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));

    // 目录白名单校验（早期统一拿 BASE 卡，可 DRAFT_IMG 在用户目录里 ——
    // 结果所有 /draft-images/ 请求一律 404，草稿里的图全是裂图）
    const inDir = d => filePath === d || filePath.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
    if (!(inDir(PUBLIC) || inDir(DRAFT_IMG) || inDir(LEGACY_DRAFT_IMG) || inDir(SHOTS))
        || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, error: e.message });
  }
});

// 端口被占用时明确退出(退出码 2)，bat 据此不再无限重启
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error('[错误] 端口 ' + PORT + ' 已被占用 —— 多半是已经开了一个工作台。');
    console.error('       请直接用已打开的那个页面；或关掉旧的黑色窗口后再启动。');
    process.exit(2);
  }
  // 端口被系统保留(EACCES)这类也不是重启能解决的 —— 用退出码 3 让 bat 停下来
  console.error('[错误] 服务启动失败: ' + e.message);
  if (e.code === 'EACCES') {
    console.error('');
    console.error('       端口 ' + PORT + ' 被系统保留了（常见于 Hyper-V / WSL 占用端口段）。');
    console.error('       换台机器，或重启电脑后再试。');
    process.exit(3);
  }
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('==========================================');
  console.log(' 绿联社区网页版发帖工作台已启动');
  console.log(' 浏览器打开: http://127.0.0.1:' + PORT);
  console.log(' (在微信里 Alt+A 截图, 回到本页面 Ctrl+V 即可插图)');
  console.log('==========================================');
  // 服务真正监听成功后再开页面 —— 以前是 bat 先 start 再起服务，
  // 慢一点的机器会先弹一个"无法访问"的空页面。
  // 崩溃自动重启时不再重复开标签页（listen 只会成功回调一次）。
  if (process.env.NO_OPEN !== '1') {
    try { require('child_process').exec('start "" "http://127.0.0.1:' + PORT + '"'); } catch (e) {}
  }
});
