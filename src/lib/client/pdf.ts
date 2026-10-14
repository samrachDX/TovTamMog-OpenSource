/**
 * Wraps one JPEG in a single-page PDF, filling the page. Enough for a printable poster
 * without a PDF library: the JPEG is embedded as-is (DCTDecode), so nothing is re-encoded.
 * Page size is in points (1/72 inch).
 */
export function jpegToPdf(jpeg: Uint8Array, px: { width: number; height: number }, page: { width: number; height: number }): Uint8Array {
  const enc = new TextEncoder();
  const w = page.width.toFixed(2);
  const h = page.height.toFixed(2);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  const objects: (string | Uint8Array)[][] = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`],
    [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
    [
      `<< /Type /XObject /Subtype /Image /Width ${px.width} /Height ${px.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      '\nendstream',
    ],
  ];

  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (p: string | Uint8Array) => {
    const bytes = typeof p === 'string' ? enc.encode(p) : p;
    parts.push(bytes);
    length += bytes.length;
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(length);
    push(`${i + 1} 0 obj\n`);
    obj.forEach(push);
    push('\nendobj\n');
  });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const o of offsets) push(`${String(o).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
