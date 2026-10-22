/**
 * 生成「反馈通道」三方案可交互样板
 * 产物: build/反馈通道样板.html  （单文件，二维码 base64 内嵌，双击即可体验）
 * 用途: 给用户挑方案，选定后按所选方案实现进 index.html
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const QR = path.join(ROOT, 'webpost', 'public', 'wechat-qr.png');
const OUT = path.join(__dirname, '反馈通道样板.html');

const qrB64 = 'data:image/png;base64,' + fs.readFileSync(QR).toString('base64');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>反馈通道 · 三方案样板</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:"Microsoft YaHei","PingFang SC",sans-serif; background:#e9edf1; color:#333; padding:26px 20px 60px; }
  .wrap { max-width:1180px; margin:0 auto; }
  h1 { font-size:22px; color:#1f6f43; margin-bottom:6px; }
  .sub { font-size:14px; color:#666; margin-bottom:22px; line-height:1.8; }
  .sub b { color:#d03050; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:22px; }
  .plan { background:#fff; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,.08); overflow:hidden; display:flex; flex-direction:column; }
  .plan-head { padding:12px 16px; border-bottom:1px solid #eee; }
  .plan-head h2 { font-size:16px; color:#1f6f43; }
  .plan-head p { font-size:12.5px; color:#888; margin-top:4px; line-height:1.6; }
  .stage { position:relative; height:430px; background:#f0f2f5; overflow:hidden; }
  /* —— 模拟工作台 —— */
  .mk-header { background:#1f6f43; color:#fff; padding:9px 14px; display:flex; align-items:center; gap:10px; font-size:13px; }
  .mk-header .dot { width:26px; height:26px; border-radius:6px; background:rgba(255,255,255,.2); }
  .mk-main { display:flex; gap:8px; padding:8px 10px; height:calc(100% - 44px); }
  .mk-pane { flex:1; background:#fff; border-radius:6px; box-shadow:0 1px 3px rgba(0,0,0,.06); position:relative; }
  .mk-pane .ph { padding:6px 10px; font-size:11px; color:#bbb; border-bottom:1px solid #f0f0f0; }
  .mk-pane .lines { padding:10px; }
  .mk-pane .l { height:9px; background:#eef1f4; border-radius:4px; margin-bottom:8px; }
  .mk-pane .l.s { width:55%; } .mk-pane .l.m { width:78%; } .mk-pane .l.g { background:#e3ece7; width:40%; }
  .mk-status { position:absolute; bottom:0; left:0; right:0; padding:4px 10px; font-size:10.5px; color:#bbb; border-top:1px solid #f0f0f0; }
  /* —— 微信名片（三个方案共用样式） —— */
  .wxcard { background:#fff; border-radius:12px; box-shadow:0 10px 34px rgba(0,0,0,.22); padding:16px 18px 14px; width:228px; text-align:center; z-index:30; }
  .wxcard .cap { font-size:12px; color:#999; margin-bottom:8px; display:flex; align-items:center; justify-content:center; gap:5px; }
  .wxcard img { width:118px; height:59px; object-fit:contain; }
  .wxcard .name { font-size:15px; font-weight:700; color:#1f6f43; margin-top:7px; }
  .wxcard .gh { display:block; margin-top:8px; font-size:11.5px; color:#555; background:#f4f6f8; border-radius:6px; padding:5px 8px; text-decoration:none; }
  .wxcard .gh:hover { background:#e8f5ee; color:#1f6f43; }
  .wxcard .gh b { color:#1f6f43; }
  .wxcard .tip { font-size:10.5px; color:#aaa; margin-top:7px; }
  /* ====== 方案 A：页脚署名 + hover 名片 ====== */
  .a-footer { position:absolute; left:0; right:0; bottom:0; background:#fafbfc; border-top:1px solid #e8e8e8; text-align:center; padding:7px 0 8px; font-size:12px; color:#999; z-index:20; }
  .a-footer a { color:#1f6f43; font-weight:600; text-decoration:none; position:relative; padding:6px 2px; }
  .a-footer .wxcard { position:absolute; bottom:34px; left:50%; transform:translateX(-50%) translateY(8px); opacity:0; pointer-events:none; transition:all .22s ease; }
  .a-footer a:hover .wxcard, .a-footer .wxcard:hover { opacity:1; transform:translateX(-50%) translateY(0); pointer-events:auto; }
  .a-footer a:hover::after { content:""; position:absolute; left:50%; bottom:-6px; transform:translateX(-50%); border:6px solid transparent; border-top-color:#fff; filter:drop-shadow(0 -1px 1px rgba(0,0,0,.08)); }
  /* ====== 方案 B：右下角反馈球 ====== */
  .b-fab { position:absolute; right:16px; bottom:16px; width:52px; height:52px; border-radius:50%; background:#1f6f43; color:#fff; border:none; cursor:pointer; font-size:22px; box-shadow:0 6px 18px rgba(31,111,67,.42); transition:transform .18s; z-index:22; }
  .b-fab:hover { transform:scale(1.08); }
  .b-fab .badge { position:absolute; top:-3px; right:-3px; background:#d03050; color:#fff; font-size:10px; padding:1px 5px; border-radius:8px; }
  .b-card { position:absolute; right:16px; bottom:78px; display:none; }
  .b-card.show { display:block; animation:pop .2s ease; }
  @keyframes pop { from { opacity:0; transform:translateY(8px);} to { opacity:1; transform:none;} }
  .b-card .wxcard { width:246px; text-align:left; padding:14px 16px; }
  .b-card .row { display:flex; gap:12px; align-items:center; }
  .b-card img { width:104px; height:52px; flex-shrink:0; }
  .b-card .t { font-size:13.5px; font-weight:700; color:#1f6f43; }
  .b-card .s { font-size:11px; color:#888; margin-top:3px; line-height:1.5; }
  .b-card .btn { display:block; width:100%; margin-top:10px; background:#1f6f43; color:#fff; border:none; border-radius:7px; padding:8px 0; font-size:12.5px; cursor:pointer; }
  .b-card .btn.ghost { background:#eef4f1; color:#1f6f43; margin-top:6px; text-decoration:none; text-align:center; }
  .b-card .btn:hover { filter:brightness(1.08); }
  /* ====== 方案 C：失败弹窗内引导 ====== */
  .c-mask { position:absolute; inset:0; background:rgba(0,0,0,.38); display:flex; align-items:center; justify-content:center; z-index:25; }
  .c-modal { background:#fff; border-radius:10px; width:330px; max-height:92%; overflow:auto; box-shadow:0 16px 50px rgba(0,0,0,.3); }
  .c-modal .mh { padding:12px 16px; border-bottom:1px solid #f0f0f0; font-size:14px; font-weight:700; color:#d03050; }
  .c-modal .mb { padding:12px 16px; font-size:12.5px; line-height:1.7; color:#444; }
  .c-modal .diag { background:#faf6f6; border:1px solid #f3d9d9; border-radius:7px; padding:8px 10px; font-size:11.5px; color:#a33; margin:8px 0; }
  .c-modal .wxline { display:flex; gap:12px; align-items:center; background:#f6faf7; border:1px solid #dcebe2; border-radius:8px; padding:9px 11px; margin-top:10px; }
  .c-modal .wxline img { width:96px; height:48px; }
  .c-modal .wxline .t { font-size:12.5px; font-weight:700; color:#1f6f43; }
  .c-modal .wxline .s { font-size:11px; color:#888; margin-top:2px; }
  .c-modal .mf { padding:10px 16px 14px; display:flex; gap:8px; }
  .c-modal .mf button { flex:1; border:none; border-radius:7px; padding:9px 0; font-size:12.5px; cursor:pointer; }
  .c-modal .copy { background:#1f6f43; color:#fff; }
  .c-modal .close { background:#f0f0f0; color:#555; }
  /* toast */
  .toast { position:fixed; left:50%; bottom:34px; transform:translateX(-50%); background:#333; color:#fff; font-size:13px; padding:9px 18px; border-radius:8px; opacity:0; transition:.25s; pointer-events:none; z-index:99; }
  .toast.show { opacity:1; }
  /* 对比表 */
  table { width:100%; border-collapse:collapse; margin-top:26px; background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,.08); font-size:13.5px; }
  th,td { padding:11px 14px; text-align:left; border-bottom:1px solid #f0f0f0; line-height:1.6; }
  th { background:#1f6f43; color:#fff; font-weight:600; white-space:nowrap; }
  tr:last-child td { border-bottom:none; }
  td.good { color:#1f6f43; font-weight:700; } td.bad { color:#d03050; }
  .note { margin-top:20px; background:#fff8e6; border:1px solid #f3e3ad; border-radius:10px; padding:14px 18px; font-size:13.5px; line-height:1.9; }
  .note b { color:#8a6d1a; }
  h3.sec { margin:34px 0 12px; font-size:17px; color:#333; }
</style>
</head>
<body>
<div class="wrap">
  <h1>反馈通道 · 三个方案</h1>
  <div class="sub">
    下面三个白框都是<b>可以真交互的</b>：鼠标放上去、点一下试试。
    背景模拟的是发帖工作台的样子（绿色顶栏 + 左右编辑区）。工作台是全屏布局、没有滚动条，
    所以「页脚」会挤占编辑区高度，这是 A 和 B 的核心差别。
  </div>

  <div class="grid">
    <!-- ===== 方案 A ===== -->
    <div class="plan">
      <div class="plan-head">
        <h2>方案 A · 底部作者栏（你的原设想）</h2>
        <p>状态栏下面加一行小字，鼠标放到「很多问题的小明同学」上弹出微信名片。<br>→ 把鼠标移到页面底部那行字上试试</p>
      </div>
      <div class="stage">
        <div class="mk-header"><div class="dot"></div>绿联社区 · 发帖工作台 <span style="opacity:.7;font-size:11px">✓ 示例用户</span></div>
        <div class="mk-main">
          <div class="mk-pane"><div class="ph">编辑区</div><div class="lines"><div class="l g"></div><div class="l m"></div><div class="l"></div><div class="l s"></div></div></div>
          <div class="mk-pane"><div class="ph">预览区</div><div class="lines"><div class="l g"></div><div class="l m"></div><div class="l"></div></div></div>
        </div>
        <div class="a-footer">
          作者：<a href="https://github.com/gulugulupao" target="_blank">很多问题的小明同学
            <span class="wxcard">
              <span class="cap">💬 微信扫码 / 搜一搜</span>
              <img src="__QR__" alt="微信公众号二维码">
              <div class="name">很多问题的小明同学</div>
              <span class="gh">GitHub：<b>github.com/gulugulupao</b></span>
              <div class="tip">发帖问题 / 改版失灵，来这里找我</div>
            </span>
          </a> · 用得顺手上个关注也行
        </div>
      </div>
    </div>

    <!-- ===== 方案 B ===== -->
    <div class="plan">
      <div class="plan-head">
        <h2>方案 B · 右下角悬浮「反馈」球（推荐）</h2>
        <p>右下角常驻一颗绿色小球，点开就是名片 + 一键复制诊断报告。<br>→ 点右下角那颗球试试，再点「复制诊断报告」</p>
      </div>
      <div class="stage">
        <div class="mk-header"><div class="dot"></div>绿联社区 · 发帖工作台 <span style="opacity:.7;font-size:11px">✓ 示例用户</span></div>
        <div class="mk-main">
          <div class="mk-pane"><div class="ph">编辑区</div><div class="lines"><div class="l g"></div><div class="l m"></div><div class="l"></div><div class="l s"></div></div></div>
          <div class="mk-pane"><div class="ph">预览区</div><div class="lines"><div class="l g"></div><div class="l m"></div><div class="l"></div></div></div>
        </div>
        <button class="b-fab" onclick="toggleB()">💬<span class="badge">1</span></button>
        <div class="b-card" id="bcard">
          <div class="wxcard">
            <div class="row">
              <img src="__QR__" alt="微信公众号二维码">
              <div>
                <div class="t">很多问题的小明同学</div>
                <div class="s">微信扫码或搜一搜<br>发帖问题 / 官方改版失灵，直接喊我</div>
              </div>
            </div>
            <button class="btn" onclick="copyDiag(event)">📋 复制诊断报告（发给作者秒定位）</button>
            <a class="btn ghost" href="https://github.com/gulugulupao" target="_blank">GitHub：github.com/gulugulupao</a>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 方案 C ===== -->
    <div class="plan">
      <div class="plan-head">
        <h2>方案 C · 失败时主动引导（智能追加）</h2>
        <p>页面平时很干净；一旦发布失败，失败弹窗里直接长出二维码和「复制诊断报告」。<br>→ 这是叠加在 A 或 B 之上的逻辑，图里模拟了发布失败的样子</p>
      </div>
      <div class="stage">
        <div class="mk-header"><div class="dot"></div>绿联社区 · 发帖工作台 <span style="opacity:.7;font-size:11px">✓ 示例用户</span></div>
        <div class="mk-main">
          <div class="mk-pane"><div class="ph">编辑区</div><div class="lines"><div class="l g"></div><div class="l m"></div><div class="l"></div></div></div>
          <div class="mk-pane"><div class="ph">预览区</div><div class="lines"><div class="l g"></div><div class="l m"></div></div></div>
        </div>
        <div class="c-mask">
          <div class="c-modal">
            <div class="mh">✗ 发布失败</div>
            <div class="mb">
              错误：locator("#subject") timeout…<br>
              <div class="diag">🩺 自动诊断：标题输入框 #subject 找不到 —— 官方发帖页可能改版了</div>
              需要帮忙？微信找我，把诊断报告一起发我，说得清楚得多：
              <div class="wxline">
                <img src="__QR__" alt="微信二维码">
                <div>
                  <div class="t">很多问题的小明同学</div>
                  <div class="s">微信搜一搜，或扫码</div>
                </div>
              </div>
            </div>
            <div class="mf">
              <button class="copy" onclick="copyDiag(event)">📋 复制诊断报告</button>
              <button class="close" onclick="alert('这里是样板，实际会关闭弹窗')">先不了</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <h3 class="sec">三个方案怎么选</h3>
  <table>
    <tr><th></th><th>A · 底部作者栏</th><th>B · 悬浮反馈球</th><th>C · 失败时引导</th></tr>
    <tr><td><b>显眼度</b></td><td class="bad">低（不出事没人看页脚）</td><td class="good">高（一直在视野里）</td><td class="good">精确（只在需要时出现）</td></tr>
    <tr><td><b>占用空间</b></td><td class="bad">常驻一行，挤占编辑区</td><td class="good">一颗小球，不挡内容</td><td class="good">零占用</td></tr>
    <tr><td><b>出问题时</b></td><td>用户得自己想到去看页脚</td><td>随手就能点开反馈</td><td class="good">自动送到眼前，还带诊断</td></tr>
    <tr><td><b>品牌署名</b></td><td class="good">自然，像"作品落款"</td><td>弱一些</td><td>无</td></tr>
    <tr><td><b>打扰感</b></td><td class="good">无</td><td>轻微（可做小一点）</td><td class="good">无（只在失败时）</td></tr>
  </table>

  <div class="note">
    <b>我的建议：B 为主，A 的署名 merged 进 B 的名片里，C 的失败引导无论如何都加上。</b><br>
    理由：① 工作台是全屏无滚动布局，页脚会实实在在吃掉一行编辑区高度；② 反馈这事"出事的时刻"才重要，悬浮球永远在手边，还带「复制诊断报告」—— 你收到的是能定位问题的数据，不是一句"发不了"；③ 署名可以放在 B 的名片和「关于」里，微信 exposed 得反而更优雅。<br>
    如果你更在意"作品落款"的感觉，那就 <b>A + C 组合</b>（页脚署名兜底 + 失败弹窗带诊断），跳过悬浮球。
  </div>
</div>

<div class="toast" id="toast"></div>
<script>
  function toggleB() { document.getElementById('bcard').classList.toggle('show'); }
  function copyDiag(e) {
    e.stopPropagation();
    const text = '【发帖工作台诊断报告】\\n时间: ' + new Date().toLocaleString()
      + '\\n体检: 标题输入框 #subject 找不到 —— 官方发帖页可能改版'
      + '\\n账号: 示例用户 · 版本 1.0.0';
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => toast('已复制诊断报告，去微信粘贴发给作者即可'))
      .catch(() => toast('样板环境不支持剪贴板，实际版可以'));
  }
  let tt;
  function toast(s) {
    const t = document.getElementById('toast');
    t.textContent = s; t.classList.add('show');
    clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2200);
  }
  document.addEventListener('click', e => {
    const c = document.getElementById('bcard');
    if (c.classList.contains('show') && !c.contains(e.target) && !e.target.closest('.b-fab')) c.classList.remove('show');
  });
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html.replace(/__QR__/g, qrB64), 'utf8');
console.log('[OK] ' + OUT);
console.log('     体积 ' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB（含内嵌二维码）');
