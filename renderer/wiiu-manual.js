// Draws a Wii U e-manual (page model from main/wiiumanual.js) into book pages: a Contents page, then every manual
// page split at the given cut lines, each with a running header (chapter + title) and a page number.
// Runs in a hidden window; pages go back to the main process as JPEG data URLs.
(() => {
  const S = 2;                 // render scale: pages are 1376 px wide
  const HEAD = 84, FOOT = 46;  // header / footer bands (page px)
  const FONT = '"Segoe UI", "Helvetica Neue", "Noto Sans", "DejaVu Sans", Arial, sans-serif';

  // ---------- images ----------
  const imgs = new Map(), cache = new Map();
  async function loadImages(model) {
    await Promise.all(Object.entries(model.images).map(async ([k, url]) => {
      const im = new Image(); im.src = url; try { await im.decode(); imgs.set(k, im); } catch {}
    }));
  }
  const white = c => !c || (c[0] === 255 && c[1] === 255 && c[2] === 255 && c[3] === 255);
  // material colors: out = black + tex × (white − black), then × vertex color; flips are baked into cached copies
  function variant(key, tint, vc, flipH, flipV) {
    const id = `${key}|${tint ? tint.join() : ''}|${Array.isArray(vc) && !white(vc) ? vc.join() : ''}|${flipH ? 1 : 0}${flipV ? 1 : 0}`;
    if (cache.has(id)) return cache.get(id);
    const im = imgs.get(key); if (!im) return null;
    let out = im;
    const plainVc = Array.isArray(vc) && typeof vc[0] === 'number' && !white(vc) ? vc : null;
    if (tint || plainVc || flipH || flipV) {
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.setTransform(flipH ? -1 : 1, 0, 0, flipV ? -1 : 1, flipH ? c.width : 0, flipV ? c.height : 0); g.drawImage(im, 0, 0);
      if (tint || plainVc) {
        const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
        const [bk, wh] = tint || [[0, 0, 0, 0], [255, 255, 255, 255]], v = plainVc || [255, 255, 255, 255];
        for (let i = 0; i < p.length; i += 4) for (let k = 0; k < 4; k++) p[i + k] = (bk[k] + p[i + k] * (wh[k] - bk[k]) / 255) * v[k] / 255;
        g.putImageData(d, 0, 0);
      }
      out = c;
    }
    cache.set(id, out); return out;
  }

  // one axis of a quad: texture coordinate a→b over dest d0..d0+len, clamped (edge texels stretch past 0 and 1)
  function segs(a, b, d0, len, size) {
    const out = [], at = u => d0 + (u - a) / (b - a) * len;
    if (a < 0) out.push([0, 1, d0, at(Math.min(0, b))]);
    const lo = Math.max(a, 0), hi = Math.min(b, 1);
    if (hi > lo) out.push([lo * size, hi * size, at(lo), at(hi)]);
    if (b > 1) out.push([size - 1, size, at(Math.max(1, a)), d0 + len]);
    return out;
  }
  function drawImg(g, op) {
    let { u0, u1, v0, v1 } = op;
    const flipH = u0 > u1, flipV = v0 > v1;
    if (flipH) { u0 = 1 - u0; u1 = 1 - u1; } if (flipV) { v0 = 1 - v0; v1 = 1 - v1; }
    const src = variant(op.img, op.tint, op.c, flipH, flipV); if (!src) return;
    const iw = src.width || src.naturalWidth, ih = src.height || src.naturalHeight;
    g.globalAlpha = op.a;
    const outside = u0 < -1e-4 || u1 > 1.0001 || v0 < -1e-4 || v1 > 1.0001;
    if (outside && (op.ws === 1 || op.wt === 1)) {
      const pat = g.createPattern(src, 'repeat'), sx = op.w / ((u1 - u0) * iw), sy = op.h / ((v1 - v0) * ih);
      pat.setTransform(new DOMMatrix([sx, 0, 0, sy, op.x - u0 * iw * sx, op.y - v0 * ih * sy]));
      g.fillStyle = pat; g.fillRect(op.x, op.y, op.w, op.h);
    } else {
      for (const [sx0, sx1, dx0, dx1] of segs(u0, u1, op.x, op.w, iw)) for (const [sy0, sy1, dy0, dy1] of segs(v0, v1, op.y, op.h, ih)) {
        if (dx1 - dx0 < 0.01 || dy1 - dy0 < 0.01) continue;
        g.drawImage(src, sx0, sy0, Math.max(0.01, sx1 - sx0), Math.max(0.01, sy1 - sy0), dx0, dy0, dx1 - dx0 + 0.05, dy1 - dy0 + 0.05);
      }
    }
    g.globalAlpha = 1;
  }
  const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${((c[3] == null ? 255 : c[3]) / 255) * a})`;
  function drawRect(g, op) {
    const mul = (c) => { const w = op.tint ? op.tint[1] : null; return w ? c.map((v, i) => v * w[i] / 255) : c; };
    if (Array.isArray(op.c[0])) { const gr = g.createLinearGradient(0, op.y, 0, op.y + op.h); gr.addColorStop(0, css(mul(op.c[0]), op.a)); gr.addColorStop(1, css(mul(op.c[2]), op.a)); g.fillStyle = gr; }
    else g.fillStyle = css(mul(op.c), op.a);
    g.fillRect(op.x, op.y, op.w, op.h);
  }

  // ---------- text ----------
  // Wii U system-font icons (private-use characters) → small badges
  const ICON = {
    0xE000: ['btn', 'A'], 0xE001: ['btn', 'B'], 0xE002: ['btn', 'X'], 0xE003: ['btn', 'Y'], 0xE004: ['pill', 'L'], 0xE005: ['pill', 'R'], 0xE006: ['pad', ''],
    0xE045: ['btn', '+'], 0xE046: ['btn', '−'], 0xE047: ['btn', '1'], 0xE048: ['btn', '2'], 0xE073: ['btn', '⌂'],
    0xE079: ['pad', 'u'], 0xE07A: ['pad', 'd'], 0xE07B: ['pad', 'l'], 0xE07C: ['pad', 'r'], 0xE07D: ['pad', 'ud'], 0xE07E: ['pad', 'lr'],
    0xE080: ['stick', ''], 0xE081: ['stick', 'L'], 0xE082: ['stick', 'R'], 0xE08C: ['arrow', 'lr'], 0xE08D: ['arrow', 'ud'], 0xE092: ['arrow', 'u'], 0xE093: ['arrow', 'd'], 0xE094: ['arrow', 'l'], 0xE095: ['arrow', 'r'],
    0xE099: ['nfc', 'NFC']
  };
  const isIcon = ch => { const k = ch.codePointAt(0); return k >= 0xE000 && k <= 0xF8FF; };
  function runs(s) { const out = []; let cur = ''; for (const ch of s) { if (isIcon(ch)) { if (cur) out.push(cur); cur = ''; out.push({ icon: ch.codePointAt(0) }); } else cur += ch; } if (cur) out.push(cur); return out; }
  const iconW = (k, px) => { const t = (ICON[k] || ['btn'])[0]; return t === 'nfc' ? px * 1.9 : t === 'pill' ? px * 1.35 : px * 1.02; };
  function drawIcon(g, k, x, base, px, color) {
    const [t, label] = ICON[k] || ['btn', '•']; const r = px * 0.46, cx = x + iconW(k, px) / 2, cy = base - px * 0.34;
    const dark = color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11 < 140, fg = css(color), inv = dark ? '#fff' : '#3a2a1a';
    g.save(); g.fillStyle = fg; g.strokeStyle = fg; g.lineWidth = px * 0.09;
    const text = (s, size) => { g.fillStyle = inv; g.font = `700 ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, cx, cy + px * 0.03); };
    if (t === 'btn') { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); text(label, px * 0.62); }
    else if (t === 'pill') { const w = iconW(k, px) * 0.92, h = r * 1.7; g.beginPath(); g.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2); g.fill(); text(label, px * 0.58); }
    else if (t === 'nfc') { const w = iconW(k, px) * 0.94, h = r * 1.7; g.beginPath(); g.roundRect(cx - w / 2, cy - h / 2, w, h, h * 0.3); g.stroke(); g.fillStyle = fg; g.font = `700 ${px * 0.5}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, cx, cy + px * 0.03); }
    else if (t === 'pad') {
      const a = r * 0.36, L = r;
      g.beginPath(); g.rect(cx - a, cy - L, a * 2, L * 2); g.rect(cx - L, cy - a, L * 2, a * 2); g.fill();
      g.fillStyle = inv; const tri = (dx, dy) => { g.beginPath(); const tx = cx + dx * L * 0.62, ty = cy + dy * L * 0.62, s = a * 0.75; if (dx) { g.moveTo(tx + dx * s, ty); g.lineTo(tx - dx * s * 0.4, ty - s); g.lineTo(tx - dx * s * 0.4, ty + s); } else { g.moveTo(tx, ty + dy * s); g.lineTo(tx - s, ty - dy * s * 0.4); g.lineTo(tx + s, ty - dy * s * 0.4); } g.fill(); };
      if (label.includes('u')) tri(0, -1); if (label.includes('d')) tri(0, 1); if (label.includes('l')) tri(-1, 0); if (label.includes('r')) tri(1, 0);
    }
    else if (t === 'stick') { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(cx, cy, r * 0.55, 0, Math.PI * 2); g.fill(); if (label) text(label, px * 0.42); }
    else if (t === 'arrow') {
      const L = r * 0.95, h = r * 0.42; g.lineWidth = px * 0.1; g.lineCap = 'round'; g.lineJoin = 'round';
      const arrow = (dx, dy) => { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + dx * L, cy + dy * L); g.stroke(); g.beginPath(); if (dx) { g.moveTo(cx + dx * L - dx * h, cy - h); g.lineTo(cx + dx * L, cy); g.lineTo(cx + dx * L - dx * h, cy + h); } else { g.moveTo(cx - h, cy + dy * L - dy * h); g.lineTo(cx, cy + dy * L); g.lineTo(cx + h, cy + dy * L - dy * h); } g.stroke(); };
      if (label.includes('u')) arrow(0, -1); if (label.includes('d')) arrow(0, 1); if (label.includes('l')) arrow(-1, 0); if (label.includes('r')) arrow(1, 0);
    }
    g.restore();
  }
  const fontPx = l => l.sy * 0.8;
  function measure(g, l, spacing) {
    const px = fontPx(l); g.font = `500 ${px}px ${FONT}`; g.letterSpacing = spacing ? spacing + 'px' : '0px';
    let w = 0; for (const r of runs(l.s)) w += typeof r === 'string' ? g.measureText(r).width : iconW(r.icon, px) + (spacing || 0);
    return w;
  }
  // where the line has to stop: the box's right edge, or a picture/frame sitting to its right
  function limitFor(l, obst, pageW) {
    let right = Math.min(pageW - 8, l.bx + l.bw);
    for (const o of obst) if (o.x > l.x + 30 && o.y < l.y + l.sy && o.y + o.h > l.y) right = Math.min(right, o.x - 8);
    return right - l.x;
  }
  function drawText(g, page, obst) {
    // justified lines (spacing > 0, not the last of a paragraph) fill the paragraph's width, measured in our font
    // (lines beside a picture are a group of their own: they justify to the space next to the picture)
    const widest = new Map(), key = (l, max) => l.box + '|' + Math.round(max / 24);
    for (const l of page.text) { l._max = limitFor(l, obst, page.width); l._w = measure(g, l, 0); const k = key(l, l._max); widest.set(k, Math.max(widest.get(k) || 0, Math.min(l._w, l._max))); }
    for (const l of page.text) {
      if (!l.s.trim()) continue;
      const px = fontPx(l), max = l._max, chars = [...l.s].length;
      let w = l._w, spacing = 0;
      const target = Math.min(widest.get(key(l, max)) || w, max);
      if (!l.last && l.sp > 0.05 && target > w && chars > 1 && (target - w) / (chars - 1) < px * 0.14) { spacing = (target - w) / (chars - 1); w = measure(g, l, spacing); }
      const squeeze = w > max && max > 20 ? max / w : 1;
      g.save(); g.translate(l.x, 0); g.scale(squeeze, 1);
      g.font = `500 ${px}px ${FONT}`; g.letterSpacing = spacing + 'px'; g.fillStyle = css(l.color); g.textBaseline = 'alphabetic'; g.textAlign = 'left';
      const base = l.y + l.sy * 0.8; let x = 0;
      for (const r of runs(l.s)) { if (typeof r === 'string') { g.fillText(r, x, base); x += g.measureText(r).width; } else { drawIcon(g, r.icon, x, base, px, l.color); x += iconW(r.icon, px) + spacing; } }
      g.restore();
    }
    g.letterSpacing = '0px';
  }

  // ---------- pages ----------
  function drawPage(page) {
    const c = document.createElement('canvas'); c.width = Math.round(page.width * S); c.height = Math.round(page.height * S);
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.scale(S, S);
    g.fillStyle = '#fff'; g.fillRect(0, 0, page.width, page.height);
    for (const op of page.ops) op.k === 'img' ? drawImg(g, op) : drawRect(g, op);
    // only photos push text aside (frames, banners and decorations are drawn around/behind text); allow for the photo's frame
    const obst = page.ops.filter(o => o.layer === 'c' && o.photo && o.w < page.width * 0.7).map(o => ({ x: o.x - 10, y: o.y - 10, w: o.w + 20, h: o.h + 20 }));
    drawText(g, page, obst);
    return c;
  }
  // average color of a band of the drawn page (for the header/footer so they blend with the page's own paper)
  function bandColor(c, y, h) {
    const g = c.getContext('2d', { willReadFrequently: true }), yy = Math.max(0, Math.min(c.height - 1, Math.round(y * S))), hh = Math.max(1, Math.min(c.height - yy, Math.round(h * S)));
    const d = g.getImageData(0, yy, c.width, hh).data; let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    return [r / n, gg / n, b / n];
  }
  // the manual's paper: average of the repeating background texture
  function paperOf(page) {
    const op = page.ops.find(o => o.layer === 'bg' && o.k === 'img' && o.ws === 1 && o.wt === 1) ; const im = op && imgs.get(op.img); if (!im) return null;
    const c = document.createElement('canvas'); c.width = c.height = 8; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data; let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; } return [r / 64, gg / 64, b / 64];
  }
  const lum = c => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  function frame(w, h, paper) {
    const c = document.createElement('canvas'); c.width = Math.round(w * S); c.height = Math.round(h * S);
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.scale(S, S); g.fillStyle = css(paper); g.fillRect(0, 0, w, h); return { c, g };
  }
  function header(g, w, paper, chapter, title, cont) {
    const ink = lum(paper) > 140 ? [48, 44, 52] : [245, 245, 250], soft = mix(ink, paper, 0.45);
    g.fillStyle = css(mix(paper, ink, 0.035)); g.fillRect(0, 0, w, HEAD);
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    if (chapter) { g.font = `600 15px ${FONT}`; g.letterSpacing = '2.2px'; g.fillStyle = css(soft); g.fillText(chapter.toUpperCase(), 32, 30); g.letterSpacing = '0px'; }
    g.font = `700 ${cont ? 25 : 30}px ${FONT}`; g.fillStyle = css(ink); g.fillText(title + (cont ? '  ·  continued' : ''), 32, chapter ? 66 : 54);
    g.fillStyle = css(mix(paper, ink, 0.16)); g.fillRect(32, HEAD - 1.5, w - 64, 1.5);
  }
  function footer(g, w, y, paper, n) {
    const ink = lum(paper) > 140 ? [60, 56, 64] : [235, 235, 240];
    g.fillStyle = css(paper); g.fillRect(0, y, w, FOOT);
    g.font = `600 17px ${FONT}`; g.textAlign = 'center'; g.fillStyle = css(mix(ink, paper, 0.3)); g.textBaseline = 'middle'; g.fillText(String(n), w / 2, y + FOOT / 2 + 1); g.textAlign = 'left';
  }

  function contents(model, startPages, paper, art) {
    const w = model.width, entries = [];
    for (const ch of model.toc) { entries.push({ chapter: ch.name || 'More' }); for (const i of ch.pages) entries.push({ title: model.pages[i].title, page: startPages[i] }); }
    const lineH = 38, chapH = 52, top = 150;
    let h = top + entries.reduce((s, e) => s + (e.chapter ? chapH : lineH), 0) + 40;
    const artH = art ? Math.min(art.h, 300) : 0; h = Math.max(h + artH, 980);
    const { c, g } = frame(w, h, paper);
    const ink = lum(paper) > 140 ? [48, 44, 52] : [245, 245, 250], soft = mix(ink, paper, 0.45);
    if (art) g.drawImage(art.canvas, 0, art.y * S, art.canvas.width, art.h * S, 0, h - art.h, w, art.h);
    g.textBaseline = 'alphabetic';
    g.font = `600 15px ${FONT}`; g.letterSpacing = '2.2px'; g.fillStyle = css(soft); g.fillText('INSTRUCTION MANUAL', 40, 58); g.letterSpacing = '0px';
    g.font = `700 34px ${FONT}`; g.fillStyle = css(ink); let t = model.title || 'Contents'; while (g.measureText(t).width > w - 80 && t.length > 4) t = t.slice(0, -2).trimEnd() + '…'; g.fillText(t, 40, 102);
    g.fillStyle = css(mix(paper, ink, 0.18)); g.fillRect(40, 124, w - 80, 2);
    let y = top;
    for (const e of entries) {
      if (e.chapter) { y += chapH; g.font = `700 21px ${FONT}`; g.fillStyle = css(ink); g.fillText(e.chapter, 40, y - 12); continue; }
      y += lineH; g.font = `500 19px ${FONT}`; g.fillStyle = css(mix(ink, paper, 0.12));
      const num = String(e.page), nw = g.measureText(num).width, tw = g.measureText(e.title).width;
      g.fillText(e.title, 62, y - 12); g.fillText(num, w - 40 - nw, y - 12);
      g.fillStyle = css(mix(ink, paper, 0.6)); for (let x = 62 + tw + 10; x < w - 52 - nw; x += 7) g.fillRect(x, y - 16, 2, 2);
    }
    return c;
  }

  async function renderManual(model, onPage) {
    imgs.clear(); cache.clear(); // this window is reused game after game: never draw another manual's texture of the same name
    await loadImages(model);
    const out = []; let n = 2; const starts = [];
    let art = null, paperAll = null;
    const drawn = [];
    for (const page of model.pages) { starts.push(n); n += page.parts.length; }
    let num = 2;
    for (let i = 0; i < model.pages.length; i++) {
      const page = model.pages[i], c = drawPage(page);
      // the page's closing artwork (bottom background picture), reused on the Contents page
      if (!art) { const b = page.ops.find(o => o.layer === 'bg' && o.k === 'img' && Math.abs(o.y + o.h - page.height) < 2 && o.h > 150 && o.h < 520 && o.w > page.width * 0.9); if (b) art = { canvas: c, y: b.y, h: b.h }; }
      // one paper color for every header of a themed manual (sampled once from a plain stretch of background)
      const themed = page.ops.some(o => o.layer === 'bg' && o.k === 'img');
      if (!paperAll && themed) paperAll = paperOf(page) || bandColor(c, Math.min(page.height - 10, page.height * 0.45), 6);
      for (const [y0, y1] of page.parts) {
        const first = y0 === 0, paperTop = themed && paperAll ? paperAll : bandColor(c, y0 + 2, 6), paperBot = bandColor(c, y1 - 8, 6);
        const H = HEAD + (y1 - y0) + FOOT, { c: pc, g } = frame(page.width, H, paperTop);
        g.drawImage(c, 0, y0 * S, c.width, (y1 - y0) * S, 0, HEAD, page.width, y1 - y0);
        header(g, page.width, paperTop, page.chapter, page.title, !first);
        footer(g, page.width, HEAD + (y1 - y0), paperBot, num++);
        out.push(pc.toDataURL('image/jpeg', 0.93));
        if (onPage) onPage(out.length);
      }
      if (art && art.canvas !== c) c.width = c.height = 0; // free big canvases except the one holding the art
      drawn.push(i);
    }
    const toc = contents(model, starts, paperAll || [250, 249, 246], art);
    out.unshift(toc.toDataURL('image/jpeg', 0.93));
    return out;
  }

  window.renderManual = renderManual;
  if (window.wum) window.wum.onModel(async model => {
    try { const pages = await renderManual(model); window.wum.done(null, pages); }
    catch (e) { window.wum.done(String(e && e.stack || e), []); }
  });
})();
