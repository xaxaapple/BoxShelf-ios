// Hidden window: turns one downloaded PDF manual into JPEG pages (same size rule as the reader's own converter).
/* global pdfjsLib, wum */
wum.onModel(async job => {
  let doc = null;
  try {
    if (!window.pdfjsLib) throw new Error('PDF support not loaded');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    // a cover job names the file (bsfile://) instead of sending it: pdf.js then reads only the parts it needs with range
    // requests, so a 795 MB magazine costs a few hundred KB, not a copy of the whole file over IPC
    doc = await pdfjsLib.getDocument(job.url ? { url: job.url, disableAutoFetch: true, disableStream: true, rangeChunkSize: 262144, isEvalSupported: false } : { data: job.data, isEvalSupported: false }).promise;
    const n = Math.min(doc.numPages, job.max || 80), pages = [], from = job.last ? doc.numPages - n + 1 : 1; /* last: the back cover */
    for (let i = from; i < from + n; i++) {
      const page = await doc.getPage(i), v0 = page.getViewport({ scale: 1 });
      const scale = (job.size || 1100) / Math.max(v0.width, v0.height * 0.75), v = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height);
      const x = c.getContext('2d', { willReadFrequently: true }); /* drawn on the CPU: leaves the graphics card to the shelf */ x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: x, viewport: v }).promise;
      pages.push(c.toDataURL('image/jpeg', 0.86)); c.width = c.height = 0; /* frees the page's pixels now, not at the next GC */ page.cleanup();
    }
    wum.done(null, pages);
  } catch (e) { wum.done(String(e && e.message || e), []); }
  finally { if (doc) try { doc.destroy(); } catch {} }
});
