/**
 * 打包 zip 便携版（不含浏览器，首次启动按需下载）
 *
 * 用法: node build/build_zip.js
 * 产物: E:/WorkBuddy产物/绿联发帖工具_分发版.zip
 *
 * 与 exe 版的区别只有一个：浏览器不内置。其余（node 运行时、前端、服务端、
 * 启动脚本、说明）完全一致，所以两边功能也完全一致。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(__dirname, 'stage_zip');
const OUT = 'E:/WorkBuddy产物/绿联发帖工具_分发版.zip';
const SEVEN_Z = 'C:/Program Files/7-Zip/7z.exe';

function log(s) { console.log(s); }
function die(s) { console.error('\n[X] ' + s); process.exit(1); }
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// 1. 启动脚本（zip 变体：带浏览器下载兜底）
const rb = spawnSync(process.execPath, [path.join(__dirname, 'write_bat.js')],
  { encoding: 'utf8', windowsHide: true });
log('  · 启动脚本');
log('    ' + String(rb.stdout || '').trim().replace(/\n/g, '\n    '));
if (rb.status !== 0) die('生成启动脚本失败');

// 2. 组装
rmrf(STAGE);
fs.mkdirSync(STAGE, { recursive: true });

log('  · node 运行时');
fs.mkdirSync(path.join(STAGE, 'node'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'node', 'node.exe'), path.join(STAGE, 'node', 'node.exe'));

log('  · webpost（服务端 + 前端 + 依赖）');
copyDir(path.join(ROOT, 'webpost'), path.join(STAGE, 'webpost'));
// 运行时数据一律不带：登录凭证、草稿、截图、版块缓存、额外账号
['auth.json', 'boards_cache.json', 'draft', 'draft-images', 'shots', 'accounts', 'browser'].forEach(n => {
  rmrf(path.join(STAGE, 'webpost', n));
});

log('  · 启动脚本、说明与许可证');
fs.copyFileSync(path.join(ROOT, '启动发帖工作台.bat'), path.join(STAGE, '启动发帖工作台.bat'));
fs.copyFileSync(path.join(ROOT, '使用说明.md'), path.join(STAGE, '使用说明.md'));
if (fs.existsSync(path.join(ROOT, 'LICENSE.txt'))) {
  fs.copyFileSync(path.join(ROOT, 'LICENSE.txt'), path.join(STAGE, 'LICENSE.txt'));
  if (fs.existsSync(path.join(ROOT, 'ATTRIBUTION.txt'))) {
    fs.copyFileSync(path.join(ROOT, 'ATTRIBUTION.txt'), path.join(STAGE, 'ATTRIBUTION.txt'));
  }
} else {
  die('缺少 LICENSE.txt（许可证必须随程序分发）');
}

log('  · 命令行高级用法（可选）');
['login.js', 'autopost.js', 'md2post.py'].forEach(f => {
  if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
});

// 3. 压缩
if (!fs.existsSync(SEVEN_Z)) die('缺少 7-Zip: ' + SEVEN_Z);
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
log('  · 压缩中...');
const r = spawnSync(SEVEN_Z, ['a', '-tzip', '-mx=7', OUT, '.'], { cwd: STAGE, encoding: 'utf8', windowsHide: true });
if (r.status !== 0 || !fs.existsSync(OUT)) die('压缩失败\n' + String(r.stdout || r.stderr || '').slice(0, 500));

const mb = fs.statSync(OUT).size / 1024 / 1024;
log('\n  [OK] ' + OUT);
log('       体积 ' + mb.toFixed(1) + ' MB');

let files = 0, bytes = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; }
  }
})(STAGE);
log('       含 ' + files + ' 个文件（未压缩 ' + (bytes / 1024 / 1024).toFixed(1) + ' MB）');
