/* 绿联社区发帖工作台 — Copyright (c) 2026 很多问题的小明同学（GitHub @gulugulupao）
 * 授权：MIT License + 附加保护条款（保留署名 / 禁止冒名 / 禁止商用冒用），完整文本见 LICENSE.txt
 */
/**
 * postcore.js — 绿联社区填帖核心模块（被 server.js 和 autopost.js 共用）
 * 封装: 启动浏览器(带登录态) -> 开发帖页 -> 填标题/分类/正文 -> 上传图片 -> 替换占位符 -> (可选)发布
 */
const { chromium } = require('playwright-core');
const { diagnosePage } = require('./doctor');
const fa = require('./forum_adapter');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // 绿联社区发帖工具/

// 登录凭证放"用户专属目录"，不放应用目录。
// 原因: 应用目录里的 auth.json 会随文件夹拷贝/打包一起被分享出去，等于把登录态送人。
// 放 %LOCALAPPDATA% 后，工具文件夹可以随便拷给别人，始终干净。
function userDataDir() {
  // 测试隔离（V1.5.1）：设了 UGREEN_USER_DIR 就用指定目录，
  // 自动化测试从此不再碰真实用户数据（曾两次把测试记录写进用户发布记录，教训深刻）
  if (process.env.UGREEN_USER_DIR) {
    const dir = process.env.UGREEN_USER_DIR;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return dir;
  }
  const base = process.env.LOCALAPPDATA
    || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const dir = path.join(base, 'UGREENPostWorkbench');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}
const USER_DIR = userDataDir();
const AUTH = path.join(USER_DIR, 'auth.json');              // 默认账号
const ACCOUNTS_DIR = path.join(USER_DIR, 'accounts');       // 多账号目录

// 旧版兼容: 把以前落在应用目录里的凭证迁过来(并清掉旧文件)
(function migrateLegacy() {
  const legacyAuth = path.join(ROOT, 'auth.json');
  if (fs.existsSync(legacyAuth) && !fs.existsSync(AUTH)) {
    try {
      fs.copyFileSync(legacyAuth, AUTH);
      fs.unlinkSync(legacyAuth);
      console.log('[提示] 登录凭证已迁移到用户目录: ' + AUTH);
    } catch (e) {}
  }
  const legacyAcc = path.join(ROOT, 'accounts');
  if (fs.existsSync(legacyAcc) && !fs.existsSync(ACCOUNTS_DIR)) {
    try { fs.renameSync(legacyAcc, ACCOUNTS_DIR); } catch (e) {}
  }
})();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Chromium 动态探测(分发到别的机器也能用) ----------
function findChrome() {
  const candidates = [];
  // 1. 环境变量指定
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  // 2. 工具自带的浏览器目录
  candidates.push(path.join(ROOT, 'browser', 'chrome-win64', 'chrome.exe'));
  candidates.push(path.join(ROOT, 'browser', 'chrome-win', 'chrome.exe'));
  // 3. Playwright 缓存目录(版本号通配)
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const msDir = path.join(localAppData, 'ms-playwright');
  if (fs.existsSync(msDir)) {
    fs.readdirSync(msDir).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => {
      candidates.push(path.join(msDir, d, 'chrome-win64', 'chrome.exe'));
      candidates.push(path.join(msDir, d, 'chrome-win', 'chrome.exe'));
    });
  }
  // 4. 用户机器上的常见浏览器
  candidates.push('C:/Program Files/Google/Chrome/Application/chrome.exe');
  candidates.push('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
  candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'));
  candidates.push('C:/Program Files/Microsoft/Edge/Application/msedge.exe');
  candidates.push('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}
let CHROME = findChrome();
if (!CHROME) {
  // 退出码 3 = "环境缺失，重启一万次也好不了"。
  // 早期这里是 1，启动 bat 会当成"意外崩溃"每 3 秒重启一次，黑窗口一直闪。
  console.error('');
  console.error('[错误] 没找到可用的浏览器(Chromium/Chrome/Edge)。');
  console.error('       便携版：请重新解压安装包，别删掉 browser 目录。');
  console.error('       源码版：运行 node node_modules/playwright-core/cli.js install chromium');
  console.error('       也可以设置环境变量 CHROME_PATH 指向某个 chrome.exe。');
  console.error('       （若被安全软件拦截，把它加白名单后再启动）');
  process.exit(3);
}

// 账号 cookie 路径: accounts/<备注名>.json; 不传则用默认 auth.json
function authPathFor(account) {
  // 只有真正为空才代表"默认账号"；'default' 可能是账号柜里的一个普通账号，
  // 早期一律返回 AUTH 会导致"选了 A 号却用 B 号的身份发出去"
  if (!account) return AUTH;
  // 账号名来自请求参数，必须清洗 + 校验落点，防 ../ 穿越
  const name = String(account).replace(/[\\/:*?"<>|]/g, '_').slice(0, 30);
  const p = path.join(ACCOUNTS_DIR, name + '.json');
  if (!p.startsWith(ACCOUNTS_DIR + path.sep)) return AUTH;
  return p;
}

class Poster {
  constructor(onLog, opts = {}) {
    this.log = onLog || (() => {});
    this.shotDir = opts.shotDir || ROOT; // 截图输出目录
    this.account = opts.account || null; // 账号备注名(多账号)
    fs.mkdirSync(this.shotDir, { recursive: true });
    this.browser = null;
    this.ctx = null;
    this.page = null;
  }

  checkAuth() {
    return fs.existsSync(authPathFor(this.account));
  }

  async launch() {
    const authPath = authPathFor(this.account);
    if (!fs.existsSync(authPath)) {
      throw new Error(this.account
        ? '账号「' + this.account + '」的登录态不存在，请先运行: node login.js ' + this.account
        : '登录态不存在，请先运行 node login.js');
    }
    // 默认有头模式: 用户能看到论坛页面, 自己检查/点发表; 无桌面环境时降级 headless
    try {
      this.browser = await chromium.launch({
        executablePath: CHROME, headless: false,
        // --start-maximized：从最小化的黑窗口启动时，Chromium 会缩在任务栏里不露面（用户实测踩过）
        args: ['--no-sandbox', '--start-maximized', '--window-size=1400,1000'],
      });
      this.headed = true;
      this.log('浏览器已启动（可见窗口，请勿手动操作它，等自动填完）');
    } catch (e) {
      this.log('有头模式启动失败(' + e.message.slice(0, 60) + ')，降级无头模式');
      this.browser = await chromium.launch({
        executablePath: CHROME, headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      });
      this.headed = false;
    }
    this.ctx = await this.browser.newContext({
      storageState: authPath,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      // 有头模式 viewport 用 null：让页面铺满最大化窗口；无头模式保持固定尺寸（截图尺寸稳定）
      viewport: this.headed ? null : { width: 1400, height: 1000 }, locale: 'zh-CN',
    });
    this.page = await this.ctx.newPage();
  }

  async openEditor(fid = '9') {
    const url = `https://club.ugnas.com/forum.php?mod=post&action=newthread&fid=${fid}`;
    this.log('打开发帖页: ' + url);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    await this.page.bringToFront().catch(() => {});   // 尽力把窗口顶到最前，别缩在任务栏里
    if ((await this.page.title()).includes('提示信息')) {
      const bodyText = await this.page.evaluate(() => document.body.innerText.slice(0, 300));
      if (/没有权限|无权|抱歉/.test(bodyText)) {
        throw new Error('当前账号在该版块没有发帖权限，请切换账号或版块');
      }
      throw new Error('登录态已失效，请重新运行 node login.js');
    }
  }

  async fill(title, html, cat) {
    const page = this.page;
    // 标题/分类全部走适配器（多候选），改版时只改 forum_adapter.js
    const subj = await fa.resolveLocator(page, 'subject');
    if (!subj) throw fa.anchorError('subject', '填标题失败');
    await subj.first().fill(String(title).slice(0, 80));
    this.log('标题已填: ' + title);
    if (cat) {
      try {
        const ctrl = await fa.resolveLocator(page, 'typeidCtrl');
        if (ctrl) {
          await ctrl.first().click();
          await sleep(600);
          await page.locator('li', { hasText: cat }).first().click();
          await sleep(400);
          const v = await page.evaluate(() => document.querySelector('#typeid').value);
          this.log('主题分类: ' + cat + ' (value=' + v + ')');
        }
      } catch (e) {
        this.log('主题分类设置失败(不影响): ' + e.message.slice(0, 60));
      }
    }
    // 官方若把编辑器从 iframe 模式切成纯文本模式（#e_textarea），这里会静默
    // 写入失败、发出一篇空帖。两种通道都试，都不行就明说，别闷声发空帖。
    const iframeSel = await fa.resolveSelector(page, 'editorIframe');
    const taSel = await fa.resolveSelector(page, 'editorTextarea');
    const how = await page.evaluate(({ h, iframeSel, taSel }) => {
      if (iframeSel) {
        const f = document.querySelector(iframeSel);
        if (f && f.contentDocument && f.contentDocument.body) {
          f.contentDocument.body.innerHTML = h;
          return 'iframe';
        }
      }
      if (taSel) {
        const ta = document.querySelector(taSel);
        if (ta) {
          const tmp = document.createElement('div');
          tmp.innerHTML = h;
          ta.value = tmp.innerText;      // 纯文本模式写不了 HTML，退化为纯文字
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          return 'textarea';
        }
      }
      return '';
    }, { h: html, iframeSel, taSel });
    if (!how) throw fa.anchorError('editorIframe', '写正文失败');
    this.log('正文已写入 (' + html.length + ' 字符, ' + how + ' 模式)');
  }

  /** 上传图片并把 [[IMG_n]] 占位符替换为论坛图片。images: 本地绝对路径数组 */
  async uploadImages(images) {
    const page = this.page;
    if (!images || !images.length) { this.log('无图片，跳过上传'); return; }
    const missing = images.filter(p => !fs.existsSync(p));
    if (missing.length) throw new Error('图片不存在: ' + missing.join(', '));
    this.log('上传 ' + images.length + ' 张图片...');
    const imgBtn = await fa.resolveLocator(page, 'imageBtn');
    if (!imgBtn) throw fa.anchorError('imageBtn', '打开图片上传失败');
    await imgBtn.first().click();
    await sleep(1500);
    const fileLoc = await fa.resolveLocator(page, 'fileInput');
    if (!fileLoc) throw fa.anchorError('fileInput', '上传图片失败');
    await fileLoc.first().setInputFiles(images);
    const listSel = await fa.resolveSelector(page, 'attachList');
    let ok = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const cnt = await page.evaluate((sel) => {
        const d = sel ? document.querySelector(sel) : null;
        return d ? d.querySelectorAll('img[id^="image_"]').length : 0;
      }, listSel);
      if (cnt >= images.length) { ok = true; break; }
      if (i % 5 === 4) this.log('等待上传... ' + cnt + '/' + images.length);
    }
    if (!ok) throw new Error('图片上传超时（等了 60 秒还没全部上传完）');
    const aids = await page.evaluate((sel) => {
      const d = sel ? document.querySelector(sel) : null;
      if (!d) return [];
      return Array.from(d.querySelectorAll('img[id^="image_"]')).map(i => ({ aid: i.id.replace('image_', ''), url: i.src }));
    }, listSel);
    this.log('上传完成, aids: ' + aids.map(a => a.aid).join(','));
    // 坑（V1.4.0 修）：iframeSel 曾经只在 fill() 里有，uploadImages 直接拿来用会
    // ReferenceError —— 带图发帖必挂。之前回归样例里没图，这个坑一直没暴露出来。
    const iframeSel = await fa.resolveSelector(page, 'editorIframe');
    await page.evaluate(({ aids, iframeSel }) => {
      const f = iframeSel ? document.querySelector(iframeSel) : null;
      if (!f || !f.contentDocument) return;
      const doc = f.contentDocument;
      let html = doc.body.innerHTML;
      aids.forEach((a, i) => {
        const src = a.url.replace(/&/g, '&amp;');
        html = html.split(`[[IMG_${i + 1}]]`).join(`<img src="${src}" border="0" aid="attachimg_${a.aid}" alt="">`);
      });
      doc.body.innerHTML = html;
    }, { aids, iframeSel });
    // 关掉 Discuz 的"插入附件"弹层（多候选，找不到就跳过 —— 有的模板没有这个按钮）
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      btns.forEach(b => {
        if ((b.innerText || '').trim() === '确定' && /hideAttachMenu/.test(b.getAttribute('onclick') || '')) b.click();
      });
    });
    await sleep(800);
    this.log('图片已插入正文');
  }

  // 官方论坛改版后的兜底诊断：把"为什么点不动"翻译成人话
  async diagnose() {
    try {
      if (!this.page || this.page.isClosed()) return null;
      return await diagnosePage(this.page);
    } catch (e) { return null; }
  }

  async screenshot(name) {
    const p = path.join(this.shotDir, name);
    await this.page.screenshot({ path: p });
    // 只记文件名：完整路径会带出 Windows 用户名，日志是要发给作者看的
    this.log('截图: ' + path.basename(p));
    return name; // 返回文件名(前端通过 /shots/ 访问)
  }

  async publish() {
    this.log('发布中...');
    // 坑：部分版块的发帖页里 #postsubmit 会出现两次（主表单 + 页面另一处同名按钮），
    // 直接 locator('#postsubmit').click() 会触发 Playwright 的 strict mode 报错。
    // 候选顺序（主表单内 > 可见的 > 同名第一个 > 按钮文字兜底）现在统一放在适配器里。
    const submitted = await (async () => {
      for (const sel of fa.ANCHORS.submit.candidates) {
        try {
          const loc = this.page.locator(sel);
          if (await loc.count() === 0) continue;
          await loc.first().click({ timeout: 8000 });
          return true;
        } catch (e) { /* 换下一个候选 */ }
      }
      return false;
    })();
    if (!submitted) throw fa.anchorError('submit', '点发表失败');
    await sleep(6000);
    const url = this.page.url();
    // 坑：按钮点下去成功了，不代表帖子发出去了。发帖间隔太短 / 要验证码 / 标题违规 /
    // 待审核时，Discuz 会原地停在发帖页 —— 早期这里直接把当前 URL 当帖子链接返回，
    // 前端显示"发布成功"，点进去却是发帖页。
    if (/mod=post|action=newthread/.test(url)) {
      let hint = '';
      try {
        hint = await this.page.evaluate(() => {
          const el = document.querySelector('#messagetext, .alert-error, .error, .tip');
          const body = (document.body.innerText || '').replace(/\s+/g, ' ');
          return (el && el.innerText ? el.innerText : body).slice(0, 200);
        });
      } catch (e) {}
      // 待审核也是一种"发成功"：帖子交上去了，只是管理员没放行前别人看不见。
      // 以前这种情况会被当成普通失败，用户以为自己发帖失败又重发一遍。
      if (/审核/.test(hint)) {
        const err = new Error('PENDING_REVIEW:帖子已提交成功，正在等待管理员审核，审核通过后才会显示');
        err.pending = true;
        throw err;
      }
      throw new Error('点了「发表帖子」但页面没跳到帖子，多半被论坛拦下了'
        + (hint ? '：' + hint : '') + '。建议改用「填入论坛编辑器」自己看一眼再发表');
    }
    this.log('发布后URL: ' + url);
    return url;
  }

  async refreshAuth() {
    try { await this.ctx.storageState({ path: authPathFor(this.account) }); } catch (e) {}
  }

  async close() {
    try { await this.refreshAuth(); } catch (e) {}
    if (this.browser) await this.browser.close();
  }
}

/**
 * 检查一篇已发帖子的当前状态（V1.4.0）：
 *   published = 帖子正常显示（管理员已放行）
 *   pending   = 提示里带"审核"（还在审核中）
 *   removed   = 提示不存在/被删除/无权访问（被拒或被删）
 * 用无头浏览器 + 已登录态打开帖子 URL 看一眼，不弹窗不打扰。
 */
async function checkPostUrl(url, account) {
  const authPath = authPathFor(account);
  if (!fs.existsSync(authPath)) throw new Error('登录态不存在，先登录再检测');
  let browser, ctx;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    ctx = await browser.newContext({ storageState: authPath, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => {
      const title = document.title || '';
      const el = document.querySelector('#messagetext, .alert_info, .alert-error, .jump_c');
      const tip = el ? el.innerText : '';
      const body = (document.body.innerText || '').slice(0, 3000);
      return { title, tip, body };
    });
    if (/提示信息|提示信息/.test(info.title) || info.tip) {
      const t = (info.tip || info.title);
      if (/审核/.test(t)) return { status: 'pending', reason: '还在审核中' };
      if (/不存在|已被删除|删除|无权|权限/.test(t)) return { status: 'removed', reason: '帖子不存在或无权访问（可能未通过审核或被删除）' };
      return { status: 'removed', reason: t.replace(/\s+/g, ' ').slice(0, 80) };
    }
    return { status: 'published', reason: '帖子正常显示' };
  } finally {
    try { if (ctx) await ctx.close(); } catch (e) {}
    try { if (browser) await browser.close(); } catch (e) {}
  }
}

/**
 * 编辑已发帖子（V1.5.0）：
 *   apply=false 只读取（把论坛上的标题/正文拉回工作台）
 *   apply=true  读取后用传入的 title/html 覆盖，并点「提交编辑」保存
 * 有头模式：这是写操作，让用户能亲眼看到过程。
 * 不依赖 URL 拼接（Discuz 编辑需要 tid+pid），直接在帖子页找「编辑」链接进去，最稳。
 */
async function editPostFlow({ url, title, html, account, apply, log }) {
  const authPath = authPathFor(account);
  if (!fs.existsSync(authPath)) throw new Error('登录态不存在，先登录再编辑');
  const say = (m) => { try { log(m); } catch (e) {} };
  let browser, ctx;
  try {
    browser = await chromium.launch({
      executablePath: CHROME, headless: false,
      args: ['--no-sandbox', '--start-maximized', '--window-size=1400,1000'],
    });
    ctx = await browser.newContext({ storageState: authPath, viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    say('打开发帖记录里的帖子页面…');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    // 「提示信息」页 = 帖子没了/没权限/还在审核
    const pageTitle = await page.title();
    if (/提示信息/.test(pageTitle)) {
      const tip = await page.evaluate(() => {
        const el = document.querySelector('#messagetext, .alert_info, .alert-error, .jump_c');
        return el ? el.innerText : '';
      }).catch(() => '');
      throw new Error('打不开这篇帖子：' + (tip || pageTitle).replace(/\s+/g, ' ').slice(0, 100));
    }

    // 找「编辑」入口（Discuz 各楼层都有，取第一个能用的）
    const editHref = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="action=edit"]'));
      for (const a of links) {
        if (a.offsetParent !== null) return a.href;
      }
      return links.length ? links[0].href : '';
    });
    if (!editHref) throw new Error('这篇帖子上没找到「编辑」入口 —— 可能不是你发的，或该版块不允许编辑');
    say('进入编辑页…');
    await page.goto(editHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    // 编辑页也可能弹「提示信息」（如编辑时间窗限制）
    if (/提示信息/.test(await page.title())) {
      const tip = await page.evaluate(() => {
        const el = document.querySelector('#messagetext, .alert_info, .alert-error');
        return el ? el.innerText : '';
      }).catch(() => '');
      throw new Error('进不了编辑页：' + (tip || '论坛拒绝了这次编辑').replace(/\s+/g, ' ').slice(0, 100));
    }

    // 读现有内容（编辑器 iframe 或纯文本框，两通道都试）
    const iframeSel = await fa.resolveSelector(page, 'editorIframe');
    const taSel = await fa.resolveSelector(page, 'editorTextarea');
    const subjSel = await fa.resolveSelector(page, 'subject');
    const old = await page.evaluate(({ iframeSel, taSel, subjSel }) => {
      let html = '';
      if (iframeSel) {
        const f = document.querySelector(iframeSel);
        if (f && f.contentDocument) html = f.contentDocument.body.innerHTML;
      }
      if (!html && taSel) {
        const ta = document.querySelector(taSel);
        if (ta) html = ta.value;
      }
      const t = subjSel ? (document.querySelector(subjSel) || {}).value || '' : '';
      return { title: t, html };
    }, { iframeSel, taSel, subjSel });
    say('已读到原帖内容（' + old.html.length + ' 字符）');

    if (!apply) {
      await ctx.storageState({ path: authPath }).catch(() => {});
      await browser.close();
      return { ok: true, oldTitle: old.title, oldHtml: old.html };
    }

    // 覆盖：标题 + 正文
    if (subjSel && title) {
      await page.locator(subjSel).first().fill(String(title).slice(0, 80));
      say('标题已填: ' + title);
    }
    if (iframeSel) {
      await page.evaluate(({ iframeSel, html }) => {
        const f = document.querySelector(iframeSel);
        if (f && f.contentDocument) f.contentDocument.body.innerHTML = html;
      }, { iframeSel, html });
    } else if (taSel) {
      await page.evaluate(({ taSel, html }) => {
        const ta = document.querySelector(taSel);
        if (ta) {
          const tmp = document.createElement('div');
          tmp.innerHTML = html;
          ta.value = tmp.innerText;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, { taSel, html });
    } else {
      throw new Error('编辑页上找不到正文编辑器（官方可能改版了）');
    }
    say('新内容已写入，提交保存…');

    // 提交按钮：Discuz 编辑页仍是 form#postform #postsubmit（文字是「提交编辑」）
    let saved = false;
    for (const sel of fa.ANCHORS.submit.candidates) {
      try {
        const loc = page.locator(sel);
        if (await loc.count() === 0) continue;
        await loc.first().click({ timeout: 8000 });
        saved = true;
        break;
      } catch (e) { /* 下一个候选 */ }
    }
    if (!saved) throw new Error('编辑页上没找到保存按钮（官方可能改版了）');
    await page.waitForTimeout(5000);
    const afterUrl = page.url();
    if (/action=edit/.test(afterUrl)) {
      // 原地不动多半是被拦了（编辑间隔/权限变化），把提示带出来
      const tip = await page.evaluate(() => {
        const el = document.querySelector('#messagetext, .alert_info, .alert-error');
        return el ? el.innerText : '';
      }).catch(() => '');
      throw new Error('点了保存但没跳走，可能被论坛拦下：' + (tip || afterUrl).replace(/\s+/g, ' ').slice(0, 120));
    }
    await ctx.storageState({ path: authPath }).catch(() => {});
    say('编辑已保存 ✓');
    return { ok: true, edited: true, url: afterUrl };
  } finally {
    // 编辑流程保留窗口 3 秒让用户瞥一眼结果，然后收掉（内容已保存，无需用户操作）
    try { if (browser) { await new Promise(r => setTimeout(r, 3000)); await browser.close(); } } catch (e) {}
  }
}

module.exports = { Poster, CHROME, AUTH, ACCOUNTS_DIR, authPathFor, USER_DIR, checkPostUrl, editPostFlow };
