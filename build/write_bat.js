// 生成启动批处理（必须 CRLF + 纯 ASCII）
// 单独写成脚本是为了避开 bash/python 两层反斜杠转义 —— 之前 sed 和 -c 都把文件写坏过。
//
// 两个变体：
//   zip 版（源码分发）: 浏览器可能没带 -> 先跑 ensure-browser 下载，再环境检测
//   exe 版（内置浏览器）: 不需要下载 -> 只跑环境检测
// 两个变体都必须有端口占用分支（退出码 2），否则重复双击会陷入无限重启。
//
// 注意：JS 字符串里的反斜杠必须写成 \\，否则 '...\node.exe' 里的 \n 会变成换行符，
// 生成的 bat 直接报废（踩过一次）。

const HEAD = [
  '@echo off',
  'rem UGREEN Post Workbench - Copyright (c) 2026 Author (GitHub @gulugulupao)',
  'rem License: MIT (see LICENSE.txt). Attribution notes: ATTRIBUTION.txt.',
  'cd /d %~dp0',
  'title UGREEN Post Workbench',
  '',
  'rem === 1. find node: bundled portable node > system PATH ===',
  'set NODE=',
  'if exist "%~dp0node\\node.exe" set NODE=%~dp0node\\node.exe',
  'if not defined NODE set NODE=node',
  '',
  'rem === 2. bundled dependencies ===',
  'set NODE_PATH=%~dp0webpost\\node_modules',
  '',
];

const STEP_ENSURE = [
  'rem === 3. check browser; download if missing, auto retries with CN mirrors ===',
  '"%NODE%" "%~dp0webpost\\lib\\ensure-browser.js"',
  'if errorlevel 1 (',
  '  echo.',
  '  echo [ERROR] Browser component is unavailable. Read the message above.',
  '  echo         Tip: ask for the full EXE edition, which has the browser bundled.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
];

const STEP_ENVCHECK = [
  'rem === 3.5 environment check: OS / disk / port / browser / network ===',
  '"%NODE%" "%~dp0webpost\\lib\\check-env.js"',
  'if errorlevel 1 (',
  '  echo.',
  '  echo [ERROR] Environment check failed. Read the report above and fix the issue.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
];

const TAIL = [
  'rem === 4. start server ===',
  'rem the server opens the page itself after it is really listening.',
  'rem auto-restart loop: if the server crashes, bring it back in 3s.',
  'rem close this window to stop the workbench completely.',
  'rem',
  'rem Exit code contract (see 开发备忘.md):',
  'rem   2 = port 8791 in use       -> restarting never helps, stop and explain',
  'rem   3 = environment broken     -> restarting never helps, stop and explain',
  'rem   anything else = crashed    -> keep the 3s auto-restart (resilience)',
  ':restart',
  '"%NODE%" "%~dp0webpost\\server.js"',
  'if errorlevel 2 (',
  '  if not errorlevel 3 (',
  '    echo.',
  '    echo [ERROR] Port 8791 is already in use. Another workbench may be running.',
  '    echo         Use the page you already opened, or close the old window first.',
  '    pause',
  '    exit /b 1',
  '  )',
  ')',
  'if errorlevel 3 (',
  '  echo.',
  '  echo [ERROR] The environment is broken, so restarting will not help.',
  '  echo         Read the message above and fix that first.',
  '  echo         Portable edition: re-extract the package, keep the browser folder.',
  '  echo         Source edition:   run  node node_modules/playwright-core/cli.js install chromium',
  '  echo         If a security program blocked it, allow it, then start again.',
  '  pause',
  '  exit /b 1',
  ')',
  'echo.',
  'echo [WARN] Service exited unexpectedly. Restarting in 3 seconds...',
  'echo        Tip: close this window to stop the workbench.',
  'ping -n 4 127.0.0.1 >nul',
  'goto restart',
  '',
];

const TARGETS = [
  ['E:/WorkBuddy产物/日常搜索/绿联社区发帖工具/启动发帖工作台.bat',
    HEAD.concat(STEP_ENSURE, STEP_ENVCHECK, TAIL)],
  ['E:/WorkBuddy产物/日常搜索/绿联社区发帖工具/build/payload/启动发帖工作台.bat',
    HEAD.concat(STEP_ENVCHECK, TAIL)],
];

const fs = require('fs');
for (const [p, lines] of TARGETS) {
  fs.writeFileSync(p, Buffer.from(lines.join('\r\n'), 'ascii'));
  const s = fs.readFileSync(p).toString('binary');
  const crlf = s.split('\r\n').length - 1;
  const bare = s.split('\n').length - 1 - crlf;
  console.log(p.split('绿联社区发帖工具/')[1], '-> CRLF:', crlf, 'bareLF:', bare,
    bare === 0 ? 'OK' : 'BAD');
}
