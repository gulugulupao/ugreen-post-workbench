/* 绿联社区发帖工作台 — Copyright (c) 2026 很多问题的小明同学（GitHub @gulugulupao）
 * 授权：MIT License + 附加保护条款（保留署名 / 禁止冒名 / 禁止商用冒用），完整文本见 LICENSE.txt
 */
/**
 * doctor.js —— 官方发帖页结构自检
 *
 * 为什么需要它：
 *   整个工具建立在对绿联 Discuz 发帖页 DOM 的直接操作上（#subject / #e_iframe /
 *   #postsubmit / #typeid_ctrl ...）。官方哪天改版或换模板，这些选择器可能失效，
 *   届时用户只会看到一句莫名其妙的 "locator.click: Timeout"，
 *   根本不知道是网站变了还是自己操作错了。
 *
 *   这个模块负责在失败时把真实原因查出来，翻译成人话。
 *
 * 用法: const { diagnosePage } = require('./doctor');
 *       const r = await diagnosePage(page);   // r.items 是逐项结论
 */
const { chromium } = require('playwright-core');
const fa = require('./forum_adapter');

async function diagnosePage(page) {
  if (!page || page.isClosed()) {
    return { ok: false, items: [], hint: '页面已关闭，无法自检' };
  }

  let probe = null;
  try {
    probe = await page.evaluate(() => {
      const q = s => document.querySelector(s);
      const cnt = s => document.querySelectorAll(s).length;
      let iframeBody = 'none';
      try {
        const f = q('#e_iframe');
        if (f && f.contentDocument && f.contentDocument.body) iframeBody = 'ok';
        else if (f) iframeBody = 'blocked';
      } catch (e) { iframeBody = 'blocked'; }
      // 只取"提示信息"页里的原因关键词，不整段搬正文 —— 正文里有昵称等
      // 个人信息，而这份体检结果是要进诊断包发给作者的
      let reasonKey = '';
      if (/提示信息/.test(document.title)) {
        const t = (document.querySelector('.alert_info, #messagetext, .jump_c') || {}).innerText
          || (document.body ? document.body.innerText : '') || '';
        const keys = ['验证码', '发帖间隔', '审核', '见习', '权限', '积分', '禁言', '今日'];
        reasonKey = keys.find(k => t.indexOf(k) !== -1) || '';
      }
      return {
        url: location.href,
        pageTitle: document.title,
        reasonKey,
        loggedIn: !!q('a.info_loginout, a[href*="action=logout"]'),
        subject: cnt('#subject'),
        editorFrame: cnt('#e_iframe'),
        editorTextarea: cnt('#e_textarea'),
        iframeBody,
        submit: cnt('#postsubmit'),
        catCtrl: cnt('#typeid_ctrl'),
        uploadBtn: cnt('#e_image'),
        fileInput: cnt('input[type=file][accept*="png"]'),
        attachList: cnt('#e_imgattachlist'),
        formhash: cnt('input[name="formhash"]'),
      };
    });
  } catch (e) {
    return { ok: false, items: [], hint: '读取页面结构失败: ' + String(e.message).slice(0, 120) };
  }

  const items = [];
  const add = (name, ok, detail, why) => items.push({ name, ok, detail, why: why || '' });

  // 1. 是不是压根没进到发帖页。这是"根因级"失败：
  //    页面都没打开，后面所有元素当然都找不到 —— 这时候再逐项报
  //    "官方改版了"纯属误导，必须把归因收敛到这一条上。
  // 「提示信息」页不只是"没权限"：发帖间隔太短、要验证码、待审核、见习会员
  // 都走同一个页面。早期一律说成"没有发帖权限"，会让人白折腾换账号。
  const noPerm = /提示信息/.test(probe.pageTitle || '');
  const enteredPostPage = !noPerm;
  const blockedReason = (probe.reasonKey === '验证码') ? '要过验证码'
    : (probe.reasonKey === '发帖间隔' || probe.reasonKey === '今日') ? '发帖太频繁（官方限流），等一会儿再试'
      : (probe.reasonKey === '审核' || probe.reasonKey === '见习' || probe.reasonKey === '积分') ? '账号等级/审核状态不够（新号常见）'
        : (probe.reasonKey === '禁言') ? '账号被禁言了'
          : '当前账号在这个版块没有发帖权限（也可能是官方限流）';
  add('打开发帖页', enteredPostPage,
    enteredPostPage ? '页面标题正常' : '页面标题是「提示信息」',
    enteredPostPage ? '' : blockedReason + ' —— 换版块，或换个有权限的账号');

  // 2. 登录态
  add('登录状态', probe.loggedIn,
    probe.loggedIn ? '已登录' : '页面上看不到"退出登录"入口',
    probe.loggedIn ? '' : '登录态已失效 —— 点右上角账号 →「↻ 重新登录当前账号」');

  // 没进到发帖页时，下面的元素缺失全部写成"无法判断"，不再甩锅给官方改版
  const NR = '未进入发帖页，无法检查';

  // 3. 标题输入框
  add('标题输入框 #subject', enteredPostPage && probe.subject > 0,
    enteredPostPage ? (probe.subject > 0 ? '存在' : '找不到') : NR,
    enteredPostPage && probe.subject === 0 ? '官方可能换了标题框的 id —— 请联系工具作者更新' : '');

  // 4. 编辑器本体（iframe 或 textarea 任一可用即可）
  const hasEditor = probe.editorFrame > 0 || probe.editorTextarea > 0;
  add('正文编辑器 #e_iframe', enteredPostPage && hasEditor,
    enteredPostPage ? (hasEditor ? (probe.editorFrame ? 'iframe 模式' : 'textarea 模式') : '都找不到') : NR,
    enteredPostPage && !hasEditor ? '官方编辑器改版了 —— 请联系工具作者更新' : '');

  if (enteredPostPage && probe.editorFrame > 0) {
    add('编辑器可写入', probe.iframeBody === 'ok',
      probe.iframeBody === 'ok' ? '可访问' : '跨源无法访问',
      probe.iframeBody === 'ok' ? '' : 'iframe 变成跨域了，写入会失败');
  }

  // 5. 提交按钮
  add('发表按钮 #postsubmit', enteredPostPage && probe.submit > 0,
    enteredPostPage ? (probe.submit > 0 ? '存在 ' + probe.submit + ' 个' : '找不到') : NR,
    enteredPostPage && probe.submit === 0 ? '官方改了发表按钮 —— 请先用「填入论坛编辑器」手动点发表' : '');

  // 6. 分类下拉（部分版块本来就没有，只作提示，不算故障）
  add('分类下拉 #typeid_ctrl', enteredPostPage && probe.catCtrl > 0,
    enteredPostPage ? (probe.catCtrl > 0 ? '存在' : '没有（该版块可能本来就不要求分类）') : NR, '');

  // 7. 图片上传通道
  const hasUpload = probe.uploadBtn > 0 || probe.fileInput > 0;
  add('图片上传入口', enteredPostPage && hasUpload,
    enteredPostPage ? (hasUpload ? '存在' : '找不到上传按钮/文件框') : NR,
    enteredPostPage && !hasUpload ? '图片传不上去，正文里的图会丢；纯文字帖不受影响' : '');

  // 8. formhash（发布时的防 CSRF 令牌）
  add('发布令牌 formhash', enteredPostPage && probe.formhash > 0,
    enteredPostPage ? (probe.formhash > 0 ? '存在' : '找不到') : NR,
    enteredPostPage && probe.formhash === 0 ? '缺令牌，提交会被论坛拒绝' : '');

  // 9. 适配器层：逐个锚点试多套候选写法（官方改版时最先在这里发现苗头）。
  //    用了哪套写法也说清楚，作者远程就能知道该往哪个方向改。
  let faSum = null;
  try { faSum = fa.summarize(await fa.probe(page)); } catch (e) { faSum = null; }
  if (enteredPostPage && faSum) {
    const okCount = faSum.found.length;
    const used = faSum.found.map(f => f.split('(')[1].replace(')', '')).slice(0, 4).join('、');
    add('适配器候选命中 ' + okCount + '/' + fa.KEYS.length,
      faSum.missing.length === 0,
      okCount + ' 个锚点找得到' + (faSum.missing.length ? '，缺：' + faSum.missing.map(m => m.split('(')[0]).join('、') : ''),
      faSum.missing.length ? '这些锚点所有写法都不匹配 —— 请把诊断包发给作者' : '');
    if (used) add('（当前生效写法）', true, used, '');
  }

  // 阻断项：只有"根因"和真正的元素缺失才算，
  // 未进入发帖页时其余项已写成"无法检查"，不再重复计入。
  const rootNames = enteredPostPage
    ? ['打开发帖页', '登录状态', '标题输入框 #subject', '正文编辑器 #e_iframe', '发表按钮 #postsubmit']
    : ['打开发帖页'];
  const blocking = items.filter(i => rootNames.includes(i.name) && !i.ok);
  const ok = blocking.length === 0;
  const hint = !enteredPostPage
    ? ('这个账号进不了该版块的发帖页：' + blockedReason + '。换一个版块，或换个账号再发。')
    : ok ? '发帖页结构正常，发不了帖多半是账号/权限/网络问题'
      : blocking.map(b => b.name + '：' + (b.why || b.detail)).join('；');
  return {
    ok,
    items,
    url: probe.url,
    hint,
    version: { checkedAt: new Date().toISOString() },
  };
}

/**
 * 独立跑一次完整自检：用指定账号的凭证开一个无头页面打开发帖页检查。
 * 供 /api/doctor 调用（前端"一键体检"按钮）。
 */
async function runDoctor({ chrome, authPath, fid }) {
  let browser = null;
  try {
    browser = await chromium.launch({
      executablePath: chrome, headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    const ctx = await browser.newContext({
      storageState: authPath,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }, locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    await page.goto(`https://club.ugnas.com/forum.php?mod=post&action=newthread&fid=${fid || 9}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));
    const r = await diagnosePage(page);
    return r;
  } catch (e) {
    return { ok: false, items: [], hint: '自检失败: ' + String(e.message).slice(0, 160) };
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
  }
}

module.exports = { diagnosePage, runDoctor };
