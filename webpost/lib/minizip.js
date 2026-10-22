/* 绿联社区发帖工作台 — Copyright (c) 2026 很多问题的小明同学（GitHub @gulugulupao）
 * 授权：MIT License + 附加保护条款（保留署名 / 禁止冒名 / 禁止商用冒用），完整文本见 LICENSE.txt
 */
/**
 * minizip.js —— 极简 ZIP 打包（store 模式，不压缩）
 *
 * 为什么自己写：只想把几份文本诊断信息打成一个 .zip 方便用户当附件发过来，
 * 不值得为此引入一个第三方依赖（分发包里每加一个库都要多背一份体积和风险）。
 * 用 store 模式（不压缩）实现起来很短，对几 KB 的文本来说体积差别无所谓。
 *
 * 用法: zipStore([{name:'diag.txt', data:Buffer}]) -> Buffer
 */

// CRC32：zip 头部必须带，没有就别想解压
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 时间/日期打包成 DOS 格式（zip 的老格式要求）
function dosTime(d) {
  const t = d || new Date();
  const time = (t.getHours() << 11) | (t.getMinutes() << 5) | Math.floor(t.getSeconds() / 2);
  const date = ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate();
  return { time, date };
}

function zipStore(files) {
  const now = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);

    // 本地文件头
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // 签名
    lh.writeUInt16LE(20, 4);           // 解压所需版本
    lh.writeUInt16LE(0x0800, 6);        // 通用标志：文件名用 UTF-8
    lh.writeUInt16LE(0, 8);             // 压缩方法 0 = store
    lh.writeUInt16LE(now.time, 10);
    lh.writeUInt16LE(now.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);  // 压缩后大小
    lh.writeUInt32LE(data.length, 22);  // 原始大小
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);            // 扩展字段长度

    // 中央目录项
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // 生成版本
    ch.writeUInt16LE(20, 6);            // 解压所需版本
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(now.time, 12);
    ch.writeUInt16LE(now.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);            // 扩展
    ch.writeUInt16LE(0, 32);            // 注释
    ch.writeUInt16LE(0, 34);            // 磁盘号
    ch.writeUInt16LE(0, 36);            // 内部属性
    ch.writeUInt32LE(0, 38);            // 外部属性
    ch.writeUInt32LE(offset, 42);       // 本地头偏移

    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);

  // 结束记录
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16); // 中央目录相对整体起始的偏移
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

module.exports = { zipStore, crc32 };
