/**
 * Markdown -> 论坛 HTML（纯 JS 实现，零外部依赖）
 *
 * 背景: 原实现依赖 md2post.py + 外部 Python，而分发包里曾硬编码了作者本机的
 *       Python 绝对路径，导致"导入 Markdown"在别人电脑上必然失败。
 *       这里用 JS 1:1 复刻 md2post.py 的转换规则，彻底去掉 Python 依赖。
 *
 * 行为与 md2post.py 保持一致:
 *   - 首个 # 一级标题 提取为帖子标题，后续一级标题降级为 h2
 *   - ## -> h2, ### 及以上 -> h3
 *   - 代码块 -> div.blockcode > blockquote（Discuz 官方结构，换行用 <br>，可避免 URL 被自动链接）
 *   - 引用   -> div.quote > blockquote
 *   - 网络图片直接保留 URL；本地图片收集到 images[] 并输出 [[IMG_n]] 占位
 */
const path = require('path');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

function mdInline(text) {
  const parts = String(text).split(/(`[^`]+`)/);
  return parts.map(p => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      return '<code>' + esc(p.slice(1, -1)) + '</code>';
    }
    let s = esc(p);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return s;
  }).join('');
}

function mdToHtml(mdText, baseDir) {
  const lines = String(mdText).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let title = null;
  const images = [];
  const out = [];
  let para = [];
  let i = 0;
  const n = lines.length;

  const flushPara = () => {
    if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; }
  };

  const cells = row => {
    let r = row.trim();
    if (r.startsWith('|')) r = r.slice(1);
    if (r.endsWith('|')) r = r.slice(0, -1);
    return r.split('|').map(c => c.trim());
  };

  while (i < n) {
    const stripped = lines[i].trim();

    if (!stripped) { flushPara(); i++; continue; }

    if (stripped.startsWith('```')) {
      flushPara();
      const codeLines = [];
      i++;
      while (i < n && !lines[i].trim().startsWith('```')) { codeLines.push(lines[i]); i++; }
      i++;
      out.push('<div class="blockcode"><blockquote>' +
        esc(codeLines.join('\n')).replace(/\n/g, '<br>') + '</blockquote></div>');
      continue;
    }

    if (stripped.startsWith('>')) {
      flushPara();
      const ql = [];
      while (i < n && lines[i].trim().startsWith('>')) {
        ql.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push('<div class="quote"><blockquote>' +
        esc(ql.join('\n')).replace(/\n/g, '<br>') + '</blockquote></div>');
      continue;
    }

    if (/^-{3,}$|^\*{3,}$|^_{3,}$/.test(stripped)) { flushPara(); out.push('<hr>'); i++; continue; }

    let m = /^(#{1,6})\s+(.*)$/.exec(stripped);
    if (m) {
      flushPara();
      const level = m[1].length;
      const text = m[2].trim();
      if (level === 1) {
        if (title === null) title = mdInline(text);
        else out.push('<h2>' + mdInline(text) + '</h2>');
      } else if (level === 2) {
        out.push('<h2>' + mdInline(text) + '</h2>');
      } else {
        out.push('<h3>' + mdInline(text) + '</h3>');
      }
      i++;
      continue;
    }

    m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(stripped);
    if (m) {
      flushPara();
      const alt = m[1], src = m[2].trim();
      if (/^https?:\/\//.test(src)) {
        out.push('<p><img src="' + escAttr(src) + '" alt="' + escAttr(alt) + '"></p>');
      } else {
        images.push(path.resolve(baseDir || '.', src));
        out.push('<p>[[IMG_' + images.length + ']]</p>');
      }
      i++;
      continue;
    }

    if (stripped.startsWith('|') && i + 1 < n && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      flushPara();
      const header = cells(stripped);
      i += 2;
      const rows = [];
      while (i < n && lines[i].trim().startsWith('|')) { rows.push(cells(lines[i].trim())); i++; }
      let t = '<table><tbody>';
      t += '<tr>' + header.map(c => '<td><strong>' + mdInline(c) + '</strong></td>').join('') + '</tr>';
      rows.forEach(r => { t += '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>'; });
      t += '</tbody></table>';
      out.push(t);
      continue;
    }

    if (/^[-*+]\s+/.test(stripped)) {
      flushPara();
      const items = [];
      while (i < n && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map(x => '<li>' + mdInline(x) + '</li>').join('') + '</ul>');
      continue;
    }

    if (/^\d+[.、]\s+/.test(stripped)) {
      flushPara();
      const items = [];
      while (i < n && /^\d+[.、]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.、]\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map(x => '<li>' + mdInline(x) + '</li>').join('') + '</ol>');
      continue;
    }

    para.push(stripped);
    i++;
  }

  flushPara();

  if (title === null) {
    for (const l of lines) {
      if (l.trim()) { title = l.trim().replace(/[#*`>\[\]()]/g, '').slice(0, 40); break; }
    }
    title = title || '未命名帖子';
  }
  title = title.replace(/<[^>]+>/g, '');

  return { title, html: out.join('\n'), images };
}

module.exports = { mdToHtml, mdInline, esc, escAttr };
