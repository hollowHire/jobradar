/*
 * resume-io.js —— 简历文件读取（不依赖任何第三方库）
 *
 * 支持：.txt / .md / .docx / 直接粘贴文本
 * 不支持：.pdf（中文 PDF 多是子集字体 + CID 编码，没有 pdf.js 抽出来是乱码，
 *          与其给你一堆乱码，不如明确提示"另存为 docx 或直接粘贴"）
 *
 * docx 本质是 zip，正文在 word/document.xml。
 * Chromium 自带 DecompressionStream，所以解 deflate 不需要 JSZip 那一套。
 */
(function (global) {
  'use strict';

  async function inflateRaw(bytes) {
    var ds = new DecompressionStream('deflate-raw');
    var writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    var reader = ds.readable.getReader();
    var chunks = [], len = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      len += r.value.length;
    }
    var out = new Uint8Array(len), p = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], p); p += chunks[i].length; }
    return new TextDecoder('utf-8').decode(out);
  }

  /* 在 zip 里找出指定文件名的原始字节（只支持 stored / deflate 两种方式，docx 只会用这两种） */
  async function readZipEntry(buf, wantName) {
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    var eocd = -1;
    var min = Math.max(0, buf.length - 66000);
    for (var i = buf.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 docx / zip 文件');

    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);

    for (var n = 0; n < count && off + 46 <= buf.length; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var method = dv.getUint16(off + 10, true);
      var compSize = dv.getUint32(off + 20, true);
      var nameLen = dv.getUint16(off + 28, true);
      var extraLen = dv.getUint16(off + 30, true);
      var cmtLen = dv.getUint16(off + 32, true);
      var localOff = dv.getUint32(off + 42, true);
      var name = new TextDecoder('utf-8').decode(buf.subarray(off + 46, off + 46 + nameLen));

      if (name === wantName) {
        var lNameLen = dv.getUint16(localOff + 26, true);
        var lExtraLen = dv.getUint16(localOff + 28, true);
        var start = localOff + 30 + lNameLen + lExtraLen;
        var data = buf.subarray(start, start + compSize);
        return method === 0 ? new TextDecoder('utf-8').decode(data) : await inflateRaw(data);
      }
      off += 46 + nameLen + extraLen + cmtLen;
    }
    throw new Error('docx 里没有找到 word/document.xml');
  }

  function xmlToText(xml) {
    return xml
      .replace(/<w:tab[^>]*\/>/g, ' ')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function docxToText(arrayBuffer) {
    var buf = new Uint8Array(arrayBuffer);
    var xml = await readZipEntry(buf, 'word/document.xml');
    return xmlToText(xml);
  }

  /* 统一入口：给一个 File/Blob，回一段纯文本 */
  async function readResumeFile(file) {
    var name = String(file.name || '').toLowerCase();
    if (/\.(txt|md|markdown|text)$/.test(name)) {
      return await file.text();
    }
    if (/\.docx$/.test(name)) {
      return await docxToText(await file.arrayBuffer());
    }
    if (/\.doc$/.test(name)) {
      throw new Error('老版 .doc 打不开，请另存为 .docx，或直接把文字复制粘贴到左边');
    }
    if (/\.pdf$/.test(name)) {
      throw new Error('PDF 不解析（中文 PDF 抽出来多是乱码）。请在 Word/预览里全选复制，粘贴到左边；或直接上传 docx');
    }
    throw new Error('只认识 .docx / .txt / .md，其他格式请粘贴文本');
  }

  var API = { readResumeFile: readResumeFile, docxToText: docxToText, xmlToText: xmlToText };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.JRResumeIO = API;
})(typeof window !== 'undefined' ? window : globalThis);
