/**
 * 论坛适配器层（2026-10-20 加固三件套之一）
 *
 * 为什么要有这一层：
 *   以前所有 #subject / #e_iframe / #postsubmit 都散落在 postcore.js 里，官方一改版
 *   就得满代码翻选择器，还容易漏。现在把"官方发帖页的 DOM 契约"全部集中到这个文件：
 *   - 每个逻辑锚点给多套候选（备用 id / name / 表单结构 / 按钮文字）
 *   - 任何一个锚点失效，报错会说清"是哪一个锚点、试过哪些候选"
 *   - 官方改版时只改这个文件，postcore.js 一行不用动
 *
 * 契约来源：绿联社区 = Discuz! X5.1（实测确认），候选写法按 Discuz 常见模板排列。
 */
'use strict';

// 逻辑锚点 -> 候选选择器（按优先级排列）
// kind: 'fill' 可输入；'click' 可点击；'node' 仅存在性判断（含容器/列表）
const ANCHORS = {
  subject: {
    label: '标题输入框',
    kind: 'fill',
    candidates: ['#subject', 'input[name="subject"]', 'form#postform input[name="subject"]'],
  },
  typeidCtrl: {
    label: '主题分类下拉',
    kind: 'click',
    candidates: ['#typeid_ctrl', '#typeid_ctrl', 'a#typeid_ctrl', '#typeidctrl'],
  },
  typeidValue: {
    label: '主题分类值',
    kind: 'node',
    candidates: ['#typeid', 'input[name="typeid"]', 'form#postform input[name="typeid"]'],
  },
  editorIframe: {
    label: '正文编辑器（富文本）',
    kind: 'node',
    candidates: ['#e_iframe', 'iframe#e_iframe', 'iframe.cke_wysiwyg_frame', 'form#postform iframe'],
  },
  editorTextarea: {
    label: '正文编辑器（纯文本）',
    kind: 'fill',
    candidates: ['#e_textarea', 'textarea[name="message"]', 'textarea#e_textarea'],
  },
  imageBtn: {
    label: '插入图片按钮',
    kind: 'click',
    candidates: ['#e_image', 'a#e_image', '#e_image1', 'a[title*="图片"]', 'a[onclick*="image"]'],
  },
  fileInput: {
    label: '图片上传输入',
    kind: 'node',
    candidates: [
      'input[type=file][accept*="png"][multiple]',
      'input[type=file][accept*="image"]',
      'input[type=file][multiple]',
      'input[type=file]',
    ],
  },
  attachList: {
    label: '已上传图片列表',
    kind: 'node',
    candidates: ['#e_imgattachlist', '#imgattachlist', 'div[id*="imgattachlist"]'],
  },
  attachOkBtn: {
    label: '图片插入确认按钮',
    kind: 'node',
    candidates: ['button[onclick*="hideAttachMenu"]', '#attach_menu button'],
  },
  submit: {
    label: '发表帖子按钮',
    kind: 'click',
    // candidates 必须是"浏览器原生合法"的选择器（探测与 evaluate 走这条）
    candidates: [
      'form#postform #postsubmit',
      '#postsubmit',
      'input[name="topicsubmit"]',
      'button[name="topicsubmit"]',
    ],
    // pwCandidates 是 Playwright 专用语法（:visible / :has-text），只能给 locator 用。
    // 踩坑：这两种语法塞进 document.querySelector 会直接抛错被 try/catch 吞掉，
    // 导致"按按钮文字兜底"看起来像失效了 —— 所以必须分开存。
    pwCandidates: [
      'form#postform #postsubmit',
      '#postsubmit:visible',
      '#postsubmit',
      'input[name="topicsubmit"]',
      'button:has-text("发表帖子")',
      'button:has-text("发表")',
    ],
  },
};

const KEYS = Object.keys(ANCHORS);

/** 返回该锚点在页面里第一个命中的选择器字符串（用于 page.evaluate 内的 querySelector） */
function domSnippet(key) {
  const a = ANCHORS[key];
  return `(${a.candidates.map(s => `document.querySelector(${JSON.stringify(s)})`).join(' || ')})`;
}

/** 在页面里取第一个命中的候选元素，返回其选择器（找不到返回 null） */
async function resolveSelector(page, key) {
  const a = ANCHORS[key];
  if (!a) return null;
  return page.evaluate((cands) => {
    for (const s of cands) {
      try { if (document.querySelector(s)) return s; } catch (e) { /* 选择器可能被浏览器拒绝 */ }
    }
    return null;
  }, a.candidates);
}

/** Playwright locator 版：优先用 pwCandidates（支持 :visible / :has-text），返回第一个命中的 */
async function resolveLocator(page, key) {
  const a = ANCHORS[key];
  if (!a) return null;
  const cands = a.pwCandidates || a.candidates;
  for (const sel of cands) {
    try {
      const loc = page.locator(sel);
      if (await loc.count() > 0) return loc;
    } catch (e) { /* 下一候选 */ }
  }
  return null;
}

/** 探测全部锚点：{ key: {ok, used, label} } —— 体检页与报错共用 */
async function probe(page) {
  const out = {};
  for (const key of KEYS) {
    const used = await resolveSelector(page, key).catch(() => null);
    out[key] = { ok: !!used, used, label: ANCHORS[key].label, candidates: ANCHORS[key].candidates.length };
  }
  return out;
}

/** 把探测结果翻成人话：哪些锚点在、哪些没了（缺失项优先列） */
function summarize(prob) {
  const missing = [], found = [];
  for (const key of KEYS) {
    (prob[key] && prob[key].ok ? found : missing).push(ANCHORS[key].label + '(' + key + ')');
  }
  return { missing, found };
}

/** 统一构造"改版了"的报错，带上缺的是哪个锚点 */
function anchorError(key, extra) {
  const a = ANCHORS[key];
  return new Error(
    (extra || '操作失败') + '：找不到' + a.label +
    '（' + key + '，试过 ' + a.candidates.length + ' 种写法）—— 官方发帖页可能改版了，' +
    '请先点「🩺 体检」确认，或直接复制全文到论坛手动发'
  );
}

module.exports = { ANCHORS, KEYS, domSnippet, resolveSelector, resolveLocator, probe, summarize, anchorError };
