/**
 * autopost.js — 绿联社区命令行填帖工具（命令行版入口）
 * 填帖逻辑已抽到 webpost/lib/postcore.js，本文件只做参数解析和输出。
 *
 * 用法:
 *   node autopost.js post.json                      # 填入后停下, 自己检查发布
 *   node autopost.js post.json --submit             # 直接发布
 *   node autopost.js post.json --fid=9 --cat=用户教程
 */
const path = require('path');
const fs = require('fs');
const { Poster } = require('../webpost/lib/postcore');

const argv = process.argv.slice(2);
const pos = argv.filter(a => !a.startsWith('--'));
const flags = {};
argv.filter(a => a.startsWith('--')).forEach(a => {
  const [k, v = ''] = a.slice(2).split('=');
  flags[k] = v;
});
const jsonPath = pos[0];
const DO_SUBMIT = 'submit' in flags;

if (!jsonPath) {
  console.log('用法: node autopost.js post.json [--submit] [--fid=9] [--cat=用户教程]');
  process.exit(1);
}

(async () => {
  const post = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf-8'));
  const cat = flags.cat || '';
  console.log('=== 绿联社区自动填帖 ===');
  console.log('标题:', post.title);
  console.log('图片:', (post.images || []).length, '张');
  console.log('模式:', DO_SUBMIT ? '直接发布' : '填入待确认(不加 --submit 不会发布)');

  const poster = new Poster(m => console.log('  ' + m));
  try {
    await poster.launch();
    await poster.openEditor(flags.fid || '9');
    await poster.fill(post.title, post.html, cat);
    await poster.uploadImages(post.images || []);
    await poster.screenshot(DO_SUBMIT ? 'autopost_published.png' : 'autopost_preview.png');
    if (DO_SUBMIT) {
      const url = await poster.publish();
      console.log('发布成功:', url);
    } else {
      poster.log('已填入。论坛页面已弹出，请检查后点「发表帖子」');
    }
  } catch (e) {
    console.error('ERR:', e.message);
    process.exitCode = 1;
  } finally {
    await poster.close();
  }
})();
