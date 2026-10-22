// 登录绿联社区（命令行备用入口）
// 正常情况下用网页端登录: 启动工作台 -> 点「登录我的绿联账号」-> 在弹出窗口登录
// 本文件仅供高级用户/特殊情况使用（如网页端打不开时）。
//
// 用法:
//   node login.js 备注名 手机号 密码     # 添加账号 -> accounts/备注名.json
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { CHROME, AUTH } = require('./webpost/lib/postcore');

const ROOT = __dirname;
const ACCOUNTS_DIR = path.join(ROOT, 'accounts');

const args = process.argv.slice(2);
const accountName = args[0] || '';
const phoneArg = args[1] || '';
const passwordArg = args[2] || '';

if (!accountName || !phoneArg || !passwordArg) {
  console.log('用法: node login.js 备注名 手机号 密码');
  console.log('提示: 普通用户请直接用网页端登录（启动工作台后点「登录我的绿联账号」），不需要本命令。');
  process.exit(1);
}

(async () => {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: false, // 有头: 如需短信验证码可人工完成
    args: ['--no-sandbox', '--window-size=1400,900'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  try {
    console.log('1. 打开登录页（账号: ' + accountName + '）...');
    await page.goto('https://club.ugnas.com/member.php?mod=logging&action=login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[type="text"]', { timeout: 30000 });
    await page.waitForTimeout(2000);

    const phoneInput = page.locator('input[type="text"]').first();
    await phoneInput.click();
    await phoneInput.fill(phoneArg);
    await page.locator('input[type="password"]').first().fill(passwordArg);
    const checkbox = page.locator('.ivu-checkbox-input').first();
    if (!(await checkbox.isChecked())) await checkbox.click();
    await page.waitForTimeout(500);

    console.log('2. 点击登录...');
    await page.locator('.login-btn').first().click();
    try {
      await page.waitForURL('**club.ugnas.com**', { timeout: 40000 });
    } catch (e) {
      console.log('   等待跳回超时。如需短信验证码，请在浏览器窗口里手动完成');
      try { await page.waitForURL('**club.ugnas.com**', { timeout: 60000 }); } catch (e2) {}
    }
    await page.waitForTimeout(4000);

    // 验证登录态 + 读论坛用户名
    await page.goto('https://club.ugnas.com/forum.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const ok = await page.evaluate(() => {
      const nameEl = document.querySelector('.kmname');
      const logout = document.querySelector('a.info_loginout, a[href*="action=logout"]');
      return { loggedIn: !!logout, user: logout && nameEl ? nameEl.innerText.trim() : '' };
    });

    if (!ok.loggedIn) {
      console.log('WARN: 未检测到登录状态，请看重定向后的浏览器窗口，手动完成登录后重试');
      process.exit(1);
    }

    const authFile = path.join(ACCOUNTS_DIR, accountName + '.json');
    await ctx.storageState({ path: authFile });
    fs.writeFileSync(path.join(ACCOUNTS_DIR, accountName + '.info.json'), JSON.stringify({
      phone: phoneArg, user: ok.user, savedAt: new Date().toISOString(),
    }, null, 1));
    console.log('SUCCESS: 已登录，论坛用户名: ' + ok.user);
    console.log('会话已保存: ' + authFile);
    console.log('刷新工作台页面即可在账号下拉里选择「' + accountName + '」');
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
