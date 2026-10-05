import QRCode from 'qrcode';
import { t } from '@/lib/i18n';
import { jpegToPdf } from './pdf';

/** A6 portrait: 105 × 148 mm. Drawn at 300 dpi so the print is sharp. */
const W = 1240;
const H = 1748;
const A6_PT = { width: (105 / 25.4) * 72, height: (148 / 25.4) * 72 };

const INK = '#243b53';
const MUTED = '#627d98';
const PALE = '#eaf5ff';
const KM = '"Kantumruy Pro Variable", "Kantumruy Pro", "Khmer OS Battambang", sans-serif';
const LATIN = '"Lexend Variable", "Lexend", sans-serif';

export type PosterInput = { payload: string; nameKm: string; nameEn: string; code: string };

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Centered text, shrunk until it fits `maxWidth`. */
function fitText(ctx: CanvasRenderingContext2D, text: string, y: number, maxWidth: number, size: number, weight: number, family: string, color: string) {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    s -= 2;
  } while (s > 18);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, W / 2, y);
}

/**
 * Draws the branch's attendance QR code as an A6 poster: brand gradient, a white card with
 * the logo, a bilingual "scan to clock in" heading, the code and the branch name.
 * The code itself stays plain dark-on-white squares with a quiet zone, so every phone reads it.
 */
export async function renderQrPoster(input: PosterInput): Promise<HTMLCanvasElement> {
  // Canvas only uses fonts the page has already loaded.
  await Promise.all([
    document.fonts.load(`700 60px ${KM}`, 'ស្កេន'),
    document.fonts.load(`400 40px ${KM}`, 'ស្កេន'),
    document.fonts.load(`600 40px ${LATIN}`, 'Scan'),
  ]).catch(() => {});
  const logo = await loadImage('/brand/logo-long.png');

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Background: brand blue gradient with soft rings.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#7fbcf3');
  bg.addColorStop(0.55, '#65a9ed');
  bg.addColorStop(1, '#3f86d4');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  for (const [cx, cy, r, lw] of [[W + 60, -40, 420, 70], [-80, H + 30, 460, 80], [W - 40, H - 260, 160, 36], [90, 300, 110, 26]]) {
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // White card.
  const M = 72;
  const cardX = M, cardY = M, cardW = W - M * 2, cardH = H - M * 2 - 56;
  ctx.save();
  ctx.shadowColor = 'rgba(16, 42, 67, 0.25)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, cardX, cardY, cardW, cardH, 56);
  ctx.fill();
  ctx.restore();
  const inner = cardW - 120;

  // Logo.
  let y = cardY + 72;
  if (logo) {
    const lw = 460;
    const lh = (logo.height / logo.width) * lw;
    ctx.drawImage(logo, (W - lw) / 2, y, lw, lh);
    y += lh + 70;
  } else {
    y += 90;
  }

  // Heading, Khmer first.
  fitText(ctx, t('km-KH', 'qrPoster.title'), y + 40, inner, 64, 700, KM, INK);
  fitText(ctx, t('en', 'qrPoster.title'), y + 100, inner, 38, 500, LATIN, MUTED);
  y += 150;

  // QR code on a pale frame.
  const qr = QRCode.create(input.payload, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const frame = 780;
  const frameX = (W - frame) / 2;
  ctx.fillStyle = PALE;
  roundRect(ctx, frameX, y, frame, frame, 44);
  ctx.fill();
  const box = frame - 56;
  const cell = Math.floor(box / (n + quiet * 2));
  const qrSize = cell * (n + quiet * 2);
  const qx = Math.round((W - qrSize) / 2);
  const qy = Math.round(y + (frame - qrSize) / 2);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, qx, qy, qrSize, qrSize, 24);
  ctx.fill();
  ctx.fillStyle = INK;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) ctx.fillRect(qx + (c + quiet) * cell, qy + (r + quiet) * cell, cell, cell);
    }
  }
  y += frame + 90;

  // Branch.
  fitText(ctx, input.nameKm, y, inner, 60, 700, KM, INK);
  if (input.nameEn) fitText(ctx, input.nameEn, y + 60, inner, 40, 500, LATIN, MUTED);

  // Branch code pill at the card's foot.
  const label = t('en', 'qrPoster.code', { code: input.code });
  ctx.font = `600 30px ${LATIN}`;
  const pw = ctx.measureText(label).width + 64;
  const py = cardY + cardH - 110;
  ctx.fillStyle = PALE;
  roundRect(ctx, (W - pw) / 2, py, pw, 62, 31);
  ctx.fill();
  ctx.fillStyle = '#4a94e0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, W / 2, py + 33);

  // Footer on the gradient.
  ctx.font = `500 30px ${KM}`;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillText(`${t('km-KH', 'qrPoster.footer')} · ${t('en', 'qrPoster.footer')}`, W / 2, H - M / 2 - 28);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), type, quality));
}

function save(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadQrPoster(input: PosterInput, format: 'png' | 'pdf') {
  const canvas = await renderQrPoster(input);
  const base = `attendance-qr-${input.code}-A6`;
  if (format === 'png') {
    save(await toBlob(canvas, 'image/png'), `${base}.png`);
    return;
  }
  const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.95)).arrayBuffer());
  const pdf = jpegToPdf(jpeg, { width: W, height: H }, A6_PT);
  save(new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${base}.pdf`);
}
