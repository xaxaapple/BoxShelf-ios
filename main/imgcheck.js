// (beta.10) Is this download a picture? PNG, JPEG, WebP, GIF, BMP or AVIF/HEIF, by its first bytes. A 200 that isn't one
// (a Wi-Fi sign-in page, a CDN error page) is never saved as a cover or poster: a cached picture is trusted for good.
// No dependencies (covers.js, stremio.js, archive.js and pccovers.js share it; the Node tests load it without Electron).
const isImageBuf = buf => !!buf && buf.length >= 12 && ((buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xff && buf[1] === 0xd8) || (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') || buf.toString('latin1', 0, 3) === 'GIF' || buf.toString('latin1', 0, 2) === 'BM' || buf.toString('latin1', 4, 8) === 'ftyp');
module.exports = { isImageBuf };
