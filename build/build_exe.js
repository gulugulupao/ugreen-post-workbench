/**
 * 打包成内置浏览器的 exe 安装器（Inno Setup 6）
 *
 * 用法:  node build/build_exe.js            # 完整打包
 *        node build/build_exe.js --dry      # 只组装 payload，不编译
 *
 * 产物: build/dist/绿联发帖工作台_安装版_V{版本}.exe
 *
 * 为什么从 NSIS 换成 Inno Setup:
 *   NSIS 想把窗口做大必须手工 SetWindowPos 挪每一个控件，实测文字穿模、错位
 *   （MUI2 的按钮在主窗口、控件在子对话框，两套坐标互相打架）。
 *   Inno Setup 原生支持：WizardSizePercent（整体放大）、WizardResizable（可拖拽调大小）、
 *   WizardImageFile（欢迎页品牌大图）、简体中文语言包 —— 全是官方支持的自定义项。
 *
 * 目录约定（重要）:
 *   postcore.findChrome 找的是「应用根/browser/chrome-win64/chrome.exe」，
 *   不是 webpost/browser/ —— 放错位置会导致内置浏览器找不到。
 *
 * 数据/程序分离:  程序装在 {localappdata}\UGREENPostWorkbench\app，
 *   登录态/草稿/缓存在上级 UGREENPostWorkbench —— 卸载只删 app，数据默认保留
 *   （卸载时询问是否连数据一起删）。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(BUILD, 'dist');
const PAYLOAD = path.join(BUILD, 'payload');
// 版本号统一读 webpost/package.json（和服务端 /api/diag 同源），别在脚本里另写一份
const APP_VERSION = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'webpost', 'package.json'), 'utf8')).version || '1.0.0'; }
  catch (e) { return '1.0.0'; }
})();
const ISCC = path.join(BUILD, 'tools', 'innosetup', 'ISCC.exe');
const DRY = process.argv.includes('--dry');
// 图标文件名带版本号：Windows 图标缓存按"文件路径"缓存，同名换内容会继续显示旧图标
// （用户升级后快捷方式还是旧图标的根因）。带版本 = 每次升级都是新的缓存条目。
const ICON_NAME = 'app_icon_v' + APP_VERSION + '.ico';

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

// ---------- 1. 找 chromium ----------
function findChromium() {
  const cands = [];
  if (process.env.CHROMIUM_SRC) cands.push(process.env.CHROMIUM_SRC);
  cands.push(path.join(ROOT, 'browser', 'chrome-win64'));
  const ms = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(ms)) {
    fs.readdirSync(ms).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
      .forEach(d => cands.push(path.join(ms, d, 'chrome-win64')));
  }
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'chrome.exe'))) return c;
  }
  return null;
}

// ---------- 2. 组装 payload ----------
function buildPayload(chromiumSrc) {
  fs.mkdirSync(PAYLOAD, { recursive: true });
  const force = process.argv.includes('--force');

  log('  · node 运行时');
  fs.mkdirSync(path.join(PAYLOAD, 'node'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'node', 'node.exe'), path.join(PAYLOAD, 'node', 'node.exe'));

  // 代码每次都重新同步 —— 踩过坑：只复用浏览器导致的 payload 里 server.js 是旧版，
  // 新加的端口保护分支没进去。浏览器才是该复用的大件。
  log('  · webpost（服务端 + 前端 + 依赖）');
  copyDir(path.join(ROOT, 'webpost'), path.join(PAYLOAD, 'webpost'));
  ['auth.json', 'boards_cache.json', 'draft', 'draft-images', 'shots', 'accounts', 'browser'].forEach(n => {
    rmrf(path.join(PAYLOAD, 'webpost', n));
  });

  // Chromium 有 400+ 文件、复制定要一两分钟，已就绪就别再拷一遍（--force 强制重建）。
  if (fs.existsSync(path.join(PAYLOAD, 'browser', 'chrome-win64', 'chrome.exe')) && !force) {
    log('  · Chromium 已内置，复用（加 --force 强制重建）');
  } else {
    log('  · Chromium（最大头，复制需要一两分钟）');
    copyDir(chromiumSrc, path.join(PAYLOAD, 'browser', 'chrome-win64'));
  }

  log('  · 说明文档与许可证（启动脚本由 write_bat.js 统一生成）');
  if (fs.existsSync(path.join(ROOT, 'LICENSE.txt'))) {
    fs.copyFileSync(path.join(ROOT, 'LICENSE.txt'), path.join(PAYLOAD, 'LICENSE.txt'));
    // 署名与商标说明：道义约定，不是许可条款，单独一份不混进 MIT 正文
    if (fs.existsSync(path.join(ROOT, 'ATTRIBUTION.txt'))) {
      fs.copyFileSync(path.join(ROOT, 'ATTRIBUTION.txt'), path.join(PAYLOAD, 'ATTRIBUTION.txt'));
    }
  } else {
    die('缺少 LICENSE.txt（许可证必须随程序分发）');
  }
  // 图标：快捷方式、安装器、卸载器、favicon 全用这一份
  if (fs.existsSync(path.join(ROOT, 'icon.ico'))) {
    fs.copyFileSync(path.join(ROOT, 'icon.ico'), path.join(PAYLOAD, ICON_NAME));
    fs.copyFileSync(path.join(ROOT, 'icon.ico'), path.join(BUILD, 'app_icon.ico'));
    // payload 是增量复用的（浏览器大件不重拷）—— 旧命名的图标残留必须清掉，
    // 否则会被 [Files] 一并复制进程序目录，和"带版本图标"的设计打架（实测踩过）
    fs.rmSync(path.join(PAYLOAD, 'app_icon.ico'), { force: true });
  } else {
    die('缺少 icon.ico（快捷方式与安装器图标）');
  }
  if (fs.existsSync(path.join(ROOT, '使用说明.md'))) {
    fs.copyFileSync(path.join(ROOT, '使用说明.md'), path.join(PAYLOAD, '使用说明.md'));
  }
  if (fs.existsSync(path.join(ROOT, 'webpost', '使用说明-网页版.md'))) {
    fs.copyFileSync(path.join(ROOT, 'webpost', '使用说明-网页版.md'),
      path.join(PAYLOAD, 'webpost', '使用说明-网页版.md'));
  }
}

// ---------- 3. 生成许可页 RTF ----------
// Inno 的 LicenseFile 同样支持 RTF；RTF 全部非 ASCII 字符用 \uN 转义，没有编码问题。
// 排版：标题大号加粗绿色、章节标题加粗、正文 9pt 微软雅黑。
function rtfEscape(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch;
    else if (c < 128) out += ch;
    else out += '\\u' + (c > 32767 ? c - 65536 : c) + '?';
  }
  return out;
}
function buildLicenseRtf(srcTxt, outRtf) {
  const lines = fs.readFileSync(srcTxt, 'utf8').split(/\r?\n/);
  const parts = [
    '{\\rtf1\\ansi\\deff0\\uc1',
    '{\\fonttbl{\\f0\\fnil\\fcharset134 Microsoft YaHei;}}',
    '{\\colortbl;\\red31\\green111\\blue67;\\red120\\green120\\green120;}',
    '\\fs18',
  ];
  for (let raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const t = line.trim();
    if (!t) { parts.push('\\par'); continue; }
    if (/^[═=\-—]{4,}$/.test(t)) continue;               // 装饰线不要
    if (/^#/.test(t)) continue;                           // 注释行不要
    const isTitle = /LICENSE/.test(t) && /绿联社区发帖工作台/.test(t);
    const isHead = /^(MIT License|【中文大意】|第三方组件)/.test(t);
    if (isTitle) {
      parts.push('{\\b\\fs26\\cf1 ' + rtfEscape(t) + '}\\par\\par');
    } else if (isHead) {
      parts.push('{\\b\\fs21\\cf1 ' + rtfEscape(t) + '}\\par');
    } else if (/^(\d+\.|\d+\s|·|-)/.test(t)) {
      const m = t.match(/^([\d]+\.|·|-)\s*(.*)$/);
      if (m) parts.push('\\fi-220\\li420{\\b ' + rtfEscape(m[1]) + '}  ' + rtfEscape(m[2]) + '\\par');
      else parts.push(rtfEscape(line) + '\\par');
    } else if (/^Copyright \(c\)/.test(t)) {
      parts.push('{\\b ' + rtfEscape(t) + '}\\par');
    } else {
      parts.push(rtfEscape(line) + '\\par');
    }
  }
  parts.push('}');
  fs.writeFileSync(outRtf, parts.join('\r\n'), 'ascii');
}

// ---------- 4. 生成 ISS 并编译（Inno Setup）----------
function pack() {
  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  // 文件名带版本号：一是发版时一眼能认出版本，二是换图标后 Windows 图标缓存
  // 按"文件路径"缓存，同名会继续显示旧图标 —— 换个名字就是新的缓存条目。
  const outBase = '绿联发帖工作台_安装版_V' + APP_VERSION;
  const iss = path.join(BUILD, 'installer.iss');
  // 固定 AppId：升级安装靠它识别"同一个程序"（换版本号也不装成两份）
  const APP_ID = '9C4B7D2E-8A31-4F6B-B5D9-2E7C1A8F3D64';

  const issText = '\uFEFF' + [
    '; 由 build_exe.js 自动生成 —— 别手改这个文件，改 build_exe.js 里的模板',
    '#define MyAppName "绿联社区发帖工作台"',
    '#define MyAppVersion "' + APP_VERSION + '"',
    '#define PayloadPath "' + PAYLOAD + '"',
    '[Setup]',
    'AppId={{' + APP_ID + '}}',
    'AppName={#MyAppName}',
    'AppVersion={#MyAppVersion}',
    'AppVerName={#MyAppName} V{#MyAppVersion}',
    'DefaultDirName={localappdata}\\UGREENPostWorkbench\\app',
    'UsePreviousAppDir=yes',
    'DirExistsWarning=no',
    'AppendDefaultDirName=no',
    'PrivilegesRequired=lowest',
    'WizardStyle=modern',
    // 窗口放大 135%（官方支持的参数，不用手工挪控件）
    'WizardSizePercent=135,135',
    'WizardResizable=yes',
    'WizardImageFile=wizard.bmp',
    'SetupIconFile=app_icon.ico',
    'UninstallDisplayIcon={app}\\' + ICON_NAME + '',
    'LicenseFile=license_install.rtf',
    'OutputDir=' + DIST,
    'OutputBaseFilename=' + outBase,
    'Compression=lzma2/max',
    'SolidCompression=yes',
    'DisableProgramGroupPage=yes',
    'UninstallFilesDir={app}',
    'CloseApplications=yes',
    'RestartApplications=no',
    '',
    '[Languages]',
    'Name: "chinesesimplified"; MessagesFile: "compiler:Languages\\ChineseSimplified.isl"',
    '',
    '[Files]',
    'Source: "{#PayloadPath}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs',
    '',
    '[InstallDelete]',
    'Type: files; Name: "{app}\\uninstall.exe"',
    'Type: files; Name: "{app}\\unins000.exe"',
    // 图标文件名带版本号 → 每次升级都会留下上一个版本的 ico，要用通配符清。
    // 删除发生在复制新文件之前，不会误删本次要装的那份（实测验证过）
    'Type: files; Name: "{app}\\app_icon*.ico"',
    '',
    '[Icons]',
    'Name: "{autodesktop}\\绿联发帖工作台"; Filename: "{app}\\启动发帖工作台.bat"; IconFilename: "{app}\\' + ICON_NAME + '"; Comment: "绿联社区发帖工作台"',
    'Name: "{autoprograms}\\绿联社区发帖工作台\\绿联发帖工作台"; Filename: "{app}\\启动发帖工作台.bat"; IconFilename: "{app}\\' + ICON_NAME + '"; Comment: "绿联社区发帖工作台"',
    'Name: "{autoprograms}\\绿联社区发帖工作台\\卸载 绿联社区发帖工作台"; Filename: "{uninstallexe}"; Comment: "卸载（登录状态和草稿可选保留）"',
    'Name: "{autoprograms}\\绿联社区发帖工作台\\使用说明"; Filename: "{app}\\使用说明.md"',
    '',
    '[Run]',
    // 装完刷新一次系统图标缓存（ie4uinit -show 是微软文档认可的刷新方式，无副作用）
    'Filename: "{sys}\\ie4uinit.exe"; Parameters: "-show"; Flags: runhidden',
    'Filename: "{app}\\启动发帖工作台.bat"; Description: "启动 绿联社区发帖工作台"; Flags: nowait postinstall skipifsilent runminimized',
    '',
    '[Code]',
    'var',
    '  WipeData: Boolean;',
    '',
    '// 装完清掉上一个版本的图标文件。',
    '// 踩坑：写在 [InstallDelete] 里删不掉 —— 那时资源管理器还握着旧 ico 的句柄（图标缓存）。',
    '// 放到 ssPostInstall（快捷方式已经指向新图标）再删，就删得掉了。',
    'procedure CurStepChanged(CurStep: TSetupStep);',
    'var',
    '  FindRec: TFindRec;',
    'begin',
    '  if CurStep = ssPostInstall then begin',
    '    if FindFirst(ExpandConstant(\'{app}\\app_icon_v*.ico\'), FindRec) then begin',
    '      try',
    '        repeat',
    '          if FindRec.Name <> \'app_icon_v{#MyAppVersion}.ico\' then',
    '            DeleteFile(ExpandConstant(\'{app}\\\') + FindRec.Name);',
    '        until not FindNext(FindRec);',
    '      finally',
    '        FindClose(FindRec);',
    '      end;',
    '    end;',
    '  end;',
    'end;',
    '',
    'function InitializeUninstall(): Boolean;',
    'var',
    '  R: Integer;',
    'begin',
    '  // 先结束正在运行的程序：黑窗口(cmd)标题是 "UGREEN Post Workbench"，按标题整树杀掉，',
    '  // 否则 node.exe 正被占用删不掉 —— 用户会看到"卸载完还剩 node.exe"（实测踩过）。',
    `  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /FI "WINDOWTITLE eq UGREEN Post Workbench*" /T', '', SW_HIDE, ewWaitUntilTerminated, R);`,
    '  Sleep(800);',
    '  // 兜底：按可执行文件路径再杀一次（标题被人手滑改掉的情况）',
    `  Exec('wmic.exe', 'process where "ExecutablePath like ''' + ExpandConstant('{app}') + '%''" delete', '', SW_HIDE, ewWaitUntilTerminated, R);`,
    '  Sleep(400);',
    '  // 静默卸载（/VERYSILENT）不能弹窗卡住自动化 —— 按"保留数据"处理',
    '  WipeData := False;',
    '  if not UninstallSilent() then',
    `    WipeData := (MsgBox('要同时删除登录状态和草稿吗？' #13#10 #13#10 '选「是」：彻底清除，重装后需要重新登录' #13#10 '选「否」：保留它们，重装后直接能用、草稿还在', mbConfirmation, MB_YESNO) = IDYES);`,
    '  Result := True;',
    'end;',
    '',
    'procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);',
    'begin',
    '  if (CurUninstallStep = usUninstall) and WipeData then begin',
    `    DelTree(ExpandConstant('{localappdata}\\UGREENPostWorkbench\\draft'), True, True, True);`,
    `    DelTree(ExpandConstant('{localappdata}\\UGREENPostWorkbench\\shots'), True, True, True);`,
    `    DelTree(ExpandConstant('{localappdata}\\UGREENPostWorkbench\\accounts'), True, True, True);`,
    `    DeleteFile(ExpandConstant('{localappdata}\\UGREENPostWorkbench\\auth.json'));`,
    `    DeleteFile(ExpandConstant('{localappdata}\\UGREENPostWorkbench\\boards_cache.json'));`,
    '  end;',
    '  // 杀完进程文件能删干净，但目录句柄释放慢半拍，会留一串空目录壳 ——',
    '  // 卸载收尾（usDone）时再补删一次 {app}，实测可清掉空壳',
    '  if CurUninstallStep = usDone then',
    '    DelTree(ExpandConstant(\'{app}\'), True, True, True);',
    'end;',
    '',
  ].join('\r\n');

  fs.writeFileSync(iss, issText, 'utf8');

  log('  编译 Inno Setup 安装器（体积大，需要几分钟）...');
  const r = spawnSync(ISCC, ['/' + 'Qp', iss], { encoding: 'utf8', cwd: BUILD, windowsHide: true });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const tail = out.split('\n').filter(l => l.trim()).slice(-6).join('\n');
  console.log(tail);
  const outExe = path.join(DIST, outBase + '.exe');
  if (r.status !== 0 || !fs.existsSync(outExe)) {
    die('Inno Setup 编译失败\n' + out.slice(0, 1200));
  }
  log('\n  [OK] ' + outExe);
  log('       体积 ' + (fs.statSync(outExe).size / 1024 / 1024).toFixed(1) + ' MB');
}

(function main() {
  if (!fs.existsSync(ISCC)) die('缺少 Inno Setup 编译器: ' + ISCC + '\n  安装: innosetup-6.7.3.exe /VERYSILENT /DIR=<目录>');
  const chromium = findChromium();
  if (!chromium) die('未找到 Chromium；先运行一次工作台完成下载，或用 CHROMIUM_SRC 指定 chrome-win64 目录');
  log('  Chromium 来源: ' + chromium);

  // 启动脚本由 write_bat.js 统一产出两个变体（zip 版带下载兜底 / exe 版不带），
  // 保证两边行为一致：都带环境检测 + 端口占用分支（否则重复双击会无限重启）。
  log('  · 启动脚本');
  const rb = spawnSync(process.execPath, [path.join(BUILD, 'write_bat.js')],
    { encoding: 'utf8', windowsHide: true });
  console.log('    ' + String(rb.stdout || '').trim().replace(/\n/g, '\n    '));
  if (rb.status !== 0) die('生成启动脚本失败: ' + String(rb.stderr || '').slice(0, 300));

  buildPayload(chromium);
  // 许可页 RTF（--dry 也生成，方便单独检查排版）
  buildLicenseRtf(path.join(PAYLOAD, 'LICENSE.txt'), path.join(BUILD, 'license_install.rtf'));
  if (DRY) { log('\n  --dry：payload 已就绪，跳过编译'); return; }
  pack();
})();
