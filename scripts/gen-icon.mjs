/**
 * 生成应用图标：
 *  - build/icon.png（256x256，electron-builder 自动派生 ico/icns）
 *  - assets/icon.png（32x32，系统托盘）
 * 纯 Node 实现（zlib），无第三方依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeCatIcon(SIZE) {
  // RGBA 像素缓冲
  const px = Buffer.alloc(SIZE * SIZE * 4, 0);
  const u = SIZE / 32; // 以 32 网格为设计坐标的缩放单位

  function set(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  }

  function circle(cx, cy, radius, r, g, b) {
    cx *= u; cy *= u; radius *= u;
    const minX = Math.max(0, Math.floor(cx - radius - 1));
    const maxX = Math.min(SIZE - 1, Math.ceil(cx + radius + 1));
    const minY = Math.max(0, Math.floor(cy - radius - 1));
    const maxY = Math.min(SIZE - 1, Math.ceil(cy + radius + 1));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (d <= radius) set(x, y, r, g, b, 255);
        else if (d <= radius + 1) set(x, y, r, g, b, Math.round((radius + 1 - d) * 255));
      }
    }
  }

  function triangle(p1, p2, p3, r, g, b) {
    const pts = [p1, p2, p3].map((p) => [p[0] * u, p[1] * u]);
    const minX = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]))));
    const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(...pts.map((p) => p[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
    const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
    const sign = (a, bb, c) => (a[0] - c[0]) * (bb[1] - c[1]) - (bb[0] - c[0]) * (a[1] - c[1]);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d1 = sign([x, y], pts[0], pts[1]);
        const d2 = sign([x, y], pts[1], pts[2]);
        const d3 = sign([x, y], pts[2], pts[0]);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(hasNeg && hasPos)) set(x, y, r, g, b, 255);
      }
    }
  }

  // 圆角方形背景（靛蓝渐变感：主体 + 高光）
  const R = 6 * u;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // 圆角矩形判定
      const rx = Math.min(Math.max(x, R), SIZE - 1 - R);
      const ry = Math.min(Math.max(y, R), SIZE - 1 - R);
      if ((x - rx) ** 2 + (y - ry) ** 2 <= R * R) {
        const t = (x + y) / (2 * SIZE);
        set(x, y, Math.round(79 - t * 20), Math.round(70 - t * 15), Math.round(229 - t * 40), 255);
      }
    }
  }

  // 猫脸：白色圆 + 耳朵三角 + 眼睛
  circle(16, 18.5, 9.5, 255, 255, 255); // 脸
  triangle([8.5, 13], [6, 4.5], [13.5, 9], 255, 255, 255); // 左耳
  triangle([23.5, 13], [26, 4.5], [18.5, 9], 255, 255, 255); // 右耳
  circle(12.5, 17.5, 1.6, 67, 56, 202); // 左眼
  circle(19.5, 17.5, 1.6, 67, 56, 202); // 右眼
  triangle([15, 20.5], [17, 20.5], [16, 22], 244, 114, 182); // 鼻子
  // 嘴（两条短线）
  for (let i = 0; i < Math.round(2 * u); i++) {
    set(Math.round(14.5 * u) - i, Math.round(22.5 * u) + Math.round(i * 0.5), 67, 56, 202, 255);
    set(Math.round(17.5 * u) + i, Math.round(22.5 * u) + Math.round(i * 0.5), 67, 56, 202, 255);
  }
  return px;
}

// 编码 PNG
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(SIZE, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter none
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 生成 256x256 应用图标（electron-builder 用）
const appIcon = makeCatIcon(256);
const appIconPath = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(appIconPath), { recursive: true });
fs.writeFileSync(appIconPath, encodePng(256, appIcon));
console.log('[gen-icon] 已生成', appIconPath);

// 生成 32x32 托盘图标
const trayIcon = makeCatIcon(32);
const trayIconPath = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(trayIconPath, encodePng(32, trayIcon));
console.log('[gen-icon] 已生成', trayIconPath);
