# -*- coding: utf-8 -*-
"""
md2post.py — 把 Markdown (.md) 或 Word (.docx) 文章转换成绿联社区发帖工具可用的 post.json
只依赖 Python 标准库，无需 pip install 任何包。

用法:
    python md2post.py 文章.md
    python md2post.py 文章.docx
    python md2post.py 文章.md -o 输出目录

输出 (默认与源文件同目录的 post.json):
    {
      "title":  "帖子标题",
      "html":   "正文HTML(图片位置为 [[IMG_n]] 占位符)",
      "images": ["图片绝对路径", ...],
      "source": "源文件"
    }

Markdown 规则:
    # 一级标题   -> 作为帖子标题(不在正文重复出现); 文中有多个则第一个当标题
    ##/### 标题  -> <h2>/<h3>
    **粗体** *斜体* `行内代码`
    ```代码块``` -> [code]...[/code] (Discuz 原生代码框)
    > 引用       -> [quote]...[/quote] (Discuz 原生引用框)
    - / 1. 列表 -> <ul>/<ol>
    | 表格 |     -> <table>
    ![图](路径)  -> [[IMG_n]] 占位符 + 收集图片(路径相对 md 文件所在目录)
    [字](链接)   -> <a>
    ---          -> <hr>

docx 规则:
    Heading 1/2/3 样式 -> 标题(h2/h3); 第一个 Heading1 作为帖子标题
    加粗/斜体 run -> <strong>/<em>
    嵌入式图片 -> 按出现顺序提取为 [[IMG_n]]
    表格 -> <table>
"""
import argparse
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


# ---------- 工具函数 ----------

def esc(s):
    """HTML 转义"""
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def esc_attr(s):
    return esc(s).replace('"', '&quot;')


# ---------- Markdown 解析 ----------

def md_inline(text):
    """处理行内 Markdown 语法 -> HTML"""
    # 行内代码
    parts = re.split(r'(`[^`]+`)', text)
    for i, p in enumerate(parts):
        if p.startswith('`') and p.endswith('`') and len(p) > 2:
            parts[i] = '<code>%s</code>' % esc(p[1:-1])
        else:
            p = esc(p)
            p = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', p)
            p = re.sub(r'(?<!\*)\*([^*\n]+)\*(?!\*)', r'<em>\1</em>', p)
            p = re.sub(r'(?<!_)_([^_\n]+)_(?!_)', r'<em>\1</em>', p)
            p = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', p)
            parts[i] = p
    return ''.join(parts)


def md_to_html(md_text, base_dir, images):
    """Markdown -> (title, html)"""
    lines = md_text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    title = None
    out = []
    i = 0
    n = len(lines)

    def flush_para(buf):
        if buf:
            out.append('<p>%s</p>' % md_inline(' '.join(buf)))
            buf.clear()

    para = []

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # 空行 -> 段落结束
        if not stripped:
            flush_para(para)
            i += 1
            continue

        # 代码块
        if stripped.startswith('```'):
            flush_para(para)
            lang = stripped[3:].strip()
            code_lines = []
            i += 1
            while i < n and not lines[i].strip().startswith('```'):
                code_lines.append(lines[i])
                i += 1
            i += 1  # 跳过结束 ```
            code = '\n'.join(code_lines)
            # Discuz 官方代码块结构: div.blockcode > blockquote, 可防 URL 被自动链接, 换行用 <br> 保留
            out.append('<div class="blockcode"><blockquote>%s</blockquote></div>' % esc(code).replace('\n', '<br>'))
            continue

        # 引用块
        if stripped.startswith('>'):
            flush_para(para)
            quote_lines = []
            while i < n and lines[i].strip().startswith('>'):
                quote_lines.append(re.sub(r'^\s*>\s?', '', lines[i]))
                i += 1
            out.append('<div class="quote"><blockquote>%s</blockquote></div>' % esc('\n'.join(quote_lines)).replace('\n', '<br>'))
            continue

        # 分隔线
        if re.match(r'^-{3,}$|^\*{3,}$|^_{3,}$', stripped):
            flush_para(para)
            out.append('<hr>')
            i += 1
            continue

        # 标题
        m = re.match(r'^(#{1,6})\s+(.*)$', stripped)
        if m:
            flush_para(para)
            level = len(m.group(1))
            text = m.group(2).strip()
            if level == 1:
                if title is None:
                    title = md_inline(text)
                else:
                    out.append('<h2>%s</h2>' % md_inline(text))
            elif level == 2:
                out.append('<h2>%s</h2>' % md_inline(text))
            else:
                out.append('<h3>%s</h3>' % md_inline(text))
            i += 1
            continue

        # 图片(独占行)
        m = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)$', stripped)
        if m:
            flush_para(para)
            alt, src = m.group(1), m.group(2).strip()
            if re.match(r'^https?://', src):
                # 网络图片: 直接保留URL(发布后可用论坛"下载远程图片"转本地)
                out.append('<p><img src="%s" alt="%s"></p>' % (esc_attr(src), esc_attr(alt)))
            else:
                img_path = src if os.path.isabs(src) else os.path.join(base_dir, src)
                images.append(os.path.abspath(img_path))
                out.append('<p>[[IMG_%d]]</p>' % len(images))
            i += 1
            continue

        # 表格
        if stripped.startswith('|') and i + 1 < n and re.match(r'^\|[\s:|-]+\|?$', lines[i + 1].strip()):
            flush_para(para)
            def cells(row):
                row = row.strip()
                if row.startswith('|'):
                    row = row[1:]
                if row.endswith('|'):
                    row = row[:-1]
                return [c.strip() for c in row.split('|')]
            header = cells(stripped)
            i += 2  # 跳过表头+分隔行
            rows = []
            while i < n and lines[i].strip().startswith('|'):
                rows.append(cells(lines[i].strip()))
                i += 1
            t = ['<table><tbody>']
            t.append('<tr>' + ''.join('<td><strong>%s</strong></td>' % md_inline(c) for c in header) + '</tr>')
            for r in rows:
                t.append('<tr>' + ''.join('<td>%s</td>' % md_inline(c) for c in r) + '</tr>')
            t.append('</tbody></table>')
            out.append(''.join(t))
            continue

        # 无序列表
        if re.match(r'^[-*+]\s+', stripped):
            flush_para(para)
            items = []
            while i < n and re.match(r'^[-*+]\s+', lines[i].strip()):
                items.append(re.sub(r'^[-*+]\s+', '', lines[i].strip()))
                i += 1
            out.append('<ul>' + ''.join('<li>%s</li>' % md_inline(x) for x in items) + '</ul>')
            continue

        # 有序列表
        if re.match(r'^\d+[.、]\s+', stripped):
            flush_para(para)
            items = []
            while i < n and re.match(r'^\d+[.、]\s+', lines[i].strip()):
                items.append(re.sub(r'^\d+[.、]\s+', '', lines[i].strip()))
                i += 1
            out.append('<ol>' + ''.join('<li>%s</li>' % md_inline(x) for x in items) + '</ol>')
            continue

        # 普通段落行(累积)
        para.append(stripped)
        i += 1

    flush_para(para)
    html = '\n'.join(out)
    if title is None:
        # 没有一级标题: 用第一行非空文字当前提, 取前40字
        for l in lines:
            if l.strip():
                title = re.sub(r'[#*`>\[\]()]', '', l.strip())[:40]
                break
        title = title or '未命名帖子'
    # 标题去掉可能的行内标签
    title = re.sub(r'<[^>]+>', '', title)
    return title, html


# ---------- DOCX 解析 ----------

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'


def docx_to_html(docx_path, images):
    """docx -> (title, html), 图片提取到源文件目录的 post_images/"""
    out_dir = os.path.join(os.path.dirname(os.path.abspath(docx_path)), 'post_images')
    os.makedirs(out_dir, exist_ok=True)
    z = zipfile.ZipFile(docx_path)

    # rId -> media 文件
    rels = {}
    try:
        rels_root = ET.fromstring(z.read('word/_rels/document.xml.rels'))
        for rel in rels_root:
            rels[rel.get('Id')] = rel.get('Target')
    except KeyError:
        pass

    root = ET.fromstring(z.read('word/document.xml'))
    body = root.find('{%s}body' % W)
    title = None
    out = []

    def run_text(r, p_style):
        """提取 run 文本, 处理加粗斜体"""
        segs = []
        bold = False
        italic = False
        rpr = r.find('{%s}rPr' % W)
        if rpr is not None:
            bold = rpr.find('{%s}b' % W) is not None
            italic = rpr.find('{%s}i' % W) is not None
        for node in r.iter():
            tag = node.tag
            if tag == '{%s}t' % W:
                segs.append(esc(node.text or ''))
            elif tag == '{%s}br' % W:
                segs.append('<br>')
            elif tag == '{%s}tab' % W:
                segs.append(' ')
        text = ''.join(segs)
        if not text:
            return ''
        if bold:
            text = '<strong>%s</strong>' % text
        if italic:
            text = '<em>%s</em>' % text
        return text

    def para_html(p):
        style = ''
        pstyle = p.find('{%s}pPr' % W)
        if pstyle is not None:
            ps = pstyle.find('{%s}pStyle' % W)
            if ps is not None:
                style = ps.get('{%s}val' % W) or ''
        # 段落里的图片
        imgs = []
        text_parts = []
        for child in p.iter():
            if child.tag == '{%s}blip' % A:
                embed = child.get('{%s}embed' % R)
                if embed and embed in rels:
                    target = rels[embed]
                    media = 'word/' + target.lstrip('/')
                    ext = os.path.splitext(media)[1] or '.png'
                    idx = len(images) + 1
                    fname = 'img_%03d%s' % (idx, ext)
                    fpath = os.path.join(out_dir, fname)
                    with open(fpath, 'wb') as f:
                        f.write(z.read(media))
                    images.append(os.path.abspath(fpath))
                    imgs.append('[[IMG_%d]]' % idx)
        for r in p.findall('{%s}r' % W):
            text_parts.append(run_text(r, style))
        text = ''.join(text_parts).strip()
        low = style.lower()
        if low.startswith('heading') or low.startswith('标题'):
            lvl = re.sub(r'\D', '', low) or '1'
            tag = 'h2' if lvl in ('1', '2') else 'h3'
            if lvl == '1':
                return 'TITLE:' + text if text else ''
            return '<%s>%s</%s>' % (tag, text, tag)
        content = text + ('<br>'.join(imgs) if imgs else '')
        if not content:
            return ''
        return '<p>%s</p>' % content

    for el in body:
        tag = el.tag.split('}')[-1]
        if tag == 'p':
            h = para_html(el)
            if h.startswith('TITLE:'):
                t = h[6:]
                if title is None:
                    title = t
                else:
                    out.append('<h2>%s</h2>' % t)
            elif h:
                out.append(h)
        elif tag == 'tbl':
            # 表格
            trs = []
            for tr in el.findall('{%s}tr' % W):
                tds = []
                for tc in tr.findall('{%s}tc' % W):
                    cell = ''.join(para_html(p) for p in tc.findall('{%s}p' % W))
                    cell = re.sub(r'</?p>', '', cell)
                    tds.append('<td>%s</td>' % (cell or ' '))
                trs.append('<tr>%s</tr>' % ''.join(tds))
            out.append('<table><tbody>%s</tbody></table>' % ''.join(trs))

    z.close()
    html = '\n'.join(out)
    if title is None:
        title = os.path.splitext(os.path.basename(docx_path))[0]
    title = re.sub(r'<[^>]+>', '', title)[:80]
    return title, html


# ---------- 主流程 ----------

def main():
    ap = argparse.ArgumentParser(description='Markdown/DOCX -> 绿联社区发帖 post.json')
    ap.add_argument('input', help='源文件 (.md 或 .docx)')
    ap.add_argument('-o', '--out', default=None, help='输出目录(默认源文件所在目录)')
    args = ap.parse_args()

    src = os.path.abspath(args.input)
    if not os.path.exists(src):
        print('错误: 文件不存在:', src)
        sys.exit(1)
    out_dir = args.out or os.path.dirname(src)
    os.makedirs(out_dir, exist_ok=True)

    images = []
    ext = os.path.splitext(src)[1].lower()
    if ext in ('.md', '.markdown', '.txt'):
        with open(src, 'r', encoding='utf-8') as f:
            text = f.read()
        title, html = md_to_html(text, os.path.dirname(src), images)
    elif ext == '.docx':
        title, html = docx_to_html(src, images)
    else:
        print('错误: 只支持 .md/.markdown/.txt/.docx, 收到:', ext)
        sys.exit(1)

    # 检查图片存在性
    missing = [p for p in images if not os.path.exists(p)]
    if missing:
        print('警告: %d 张图片找不到:' % len(missing))
        for m in missing:
            print('   ', m)

    result = {
        'title': title,
        'html': html,
        'images': images,
        'source': src,
    }
    out_path = os.path.join(out_dir, 'post.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print('OK 标题:', title)
    print('OK 图片:', len(images), '张')
    print('OK 输出:', out_path)
    print()
    print('下一步:  node autopost.js "%s"' % out_path)


if __name__ == '__main__':
    main()
