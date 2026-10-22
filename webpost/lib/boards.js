/* 绿联社区发帖工作台 — Copyright (c) 2026 很多问题的小明同学（GitHub @gulugulupao）
 * 授权：MIT License + 附加保护条款（保留署名 / 禁止冒名 / 禁止商用冒用），完整文本见 LICENSE.txt
 */
/**
 * boards.js — 绿联社区版块探测: 版块列表 + 各版块发帖权限 + 各版块分类
 * 并发打开发帖页检测(标题含"提示信息"=无权限), 结果缓存1小时
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { CHROME, authPathFor, USER_DIR } = require('./postcore');

// 缓存放用户目录而不是应用目录：exe 卸载只删 app 子目录，缓存不会跟着没；
// 而且万一装到只读目录（公司机器常见）也照样能写。
const CACHE_FILE = path.join(USER_DIR, 'boards_cache.json');
const CACHE_TTL = 60 * 60 * 1000; // 1小时
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBoards(account, onLog) {
  const log = onLog || (() => {});
  const authPath = authPathFor(account);
  if (!fs.existsSync(authPath)) throw new Error('登录态不存在');

  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  try {
    const ctx = await browser.newContext({
      storageState: authPath,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }, locale: 'zh-CN',
    });

    // 1. 抓版块列表 + 当前登录用户名
    const listPage = await ctx.newPage();
    await listPage.goto('https://club.ugnas.com/forum.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);
    const listInfo = await listPage.evaluate(() => {
      const map = new Map();
      document.querySelectorAll('a[href*="forumdisplay&fid="]').forEach(a => {
        const m = a.href.match(/fid=(\d+)/);
        const name = (a.innerText || a.title || '').trim();
        if (m && name && name.length < 20 && m[1] !== '0') map.set(m[1], name);
      });
      const logout = document.querySelector('a.info_loginout, a[href*="action=logout"]');
      const userEl = document.querySelector('.kmname');
      return { boards: Array.from(map, ([fid, name]) => ({ fid, name })), loggedIn: !!logout, user: logout && userEl ? userEl.innerText.trim() : '' };
    });
    if (!listInfo.loggedIn) {
      await listPage.close();
      throw new Error('登录态已失效，请重新登录（点击页面上方「未登录」）');
    }
    const boards = listInfo.boards;
    await listPage.close();
    log('发现 ' + boards.length + ' 个版块，开始检测发帖权限…');

    // 2. 并发打开发帖页: 检测权限 + 收集分类
    const CONC = 5;
    const results = [];
    for (let i = 0; i < boards.length; i += CONC) {
      const batch = boards.slice(i, i + CONC);
      const batchRes = await Promise.all(batch.map(async (b) => {
        const page = await ctx.newPage();
        try {
          await page.goto(`https://club.ugnas.com/forum.php?mod=post&action=newthread&fid=${b.fid}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await sleep(2500); // 等页面JS初始化(点太早分类菜单不弹)
          const noPerm = await page.evaluate(() => document.title.includes('提示信息'));
          let cats = [];
          if (!noPerm) {
            // 分类: 点开自定义下拉, 读 #typeid_ctrl_menu 或首项为"选择主题分类"的ul
            try {
              await page.waitForSelector('#typeid_ctrl', { timeout: 5000 });
              await page.locator('#typeid_ctrl').click();
              await sleep(900);
              cats = await page.evaluate(() => {
                const read = (menu) => {
                  if (!menu) return [];
                  return Array.from(menu.querySelectorAll('li')).map(li => (li.innerText || '').trim()).filter(t => t && t !== '选择主题分类');
                };
                let r = read(document.querySelector('#typeid_ctrl_menu'));
                if (r.length) return r;
                const uls = Array.from(document.querySelectorAll('ul'));
                for (const ul of uls) {
                  const lis = Array.from(ul.querySelectorAll('li'));
                  if (lis.length && (lis[0].innerText || '').trim() === '选择主题分类') {
                    return lis.map(li => (li.innerText || '').trim()).filter(t => t && t !== '选择主题分类');
                  }
                }
                return [];
              });
            } catch (e) {}
          }
          return { fid: b.fid, name: b.name, canPost: !noPerm, cats };
        } catch (e) {
          return { ...b, canPost: false, cats: [], error: e.message.slice(0, 60) };
        } finally {
          await page.close().catch(() => {});
        }
      }));
      results.push(...batchRes);
      log('已检测 ' + results.length + '/' + boards.length);
    }

    const data = { account: account || 'default', user: listInfo.user || '', fetchedAt: Date.now(), boards: results };
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 1));
    return data;
  } finally {
    await browser.close();
  }
}

function getCachedBoards(account) {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (Date.now() - d.fetchedAt > CACHE_TTL) return null;
    if ((d.account || 'default') !== (account || 'default')) return null;
    return d;
  } catch (e) { return null; }
}

// 扫描一次要开十几个页面、几十秒。没有锁的时候，切账号 + 启动扫描会
// 并发跑两次，慢的那次后写缓存，可能把新账号的结果覆盖成旧的。
let scanning = null;
async function getBoards(account, onLog, force) {
  if (!force) {
    const cached = getCachedBoards(account);
    if (cached) { (onLog || (() => {}))('使用缓存的版块数据(' + new Date(cached.fetchedAt).toLocaleTimeString() + ')'); return cached; }
  }
  // 已经在扫了：直接复用这次结果，别再开一个 Chromium
  if (scanning) {
    (onLog || (() => {}))('已有扫描在进行中，等它的结果');
    return scanning;
  }
  scanning = fetchBoards(account, onLog).finally(() => { scanning = null; });
  return scanning;
}

module.exports = { getBoards, fetchBoards, CACHE_FILE };
