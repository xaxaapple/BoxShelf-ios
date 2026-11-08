// Folder listings shared for one pass over the library: a manual or spreads pass over a few thousand games used to
// list the same big ROM / art folder once per game. Each run makes its own lister (nothing is kept between runs);
// forget(dir) after writing into a folder so the next look sees the new files.
const fs = require('fs');
const path = require('path');

function lister() {
  const m = new Map(), x = new Map(), key = d => path.resolve(d).toLowerCase();
  return {
    // the folder's entry names as on disk; [] when it's missing or unreadable
    names(dir) { const k = key(dir); let v = m.get(k); if (!v) { try { v = fs.readdirSync(dir); } catch { v = []; } m.set(k, v); } return v; },
    // (beta.10) build(names) worked out once per folder and kept with its listing (e.g. the manuals index: one pass over a
    // big covers folder instead of one per game); forget(dir) drops it too
    derived(dir, tag, build) { const k = key(dir); let o = x.get(k); if (!o) x.set(k, o = {}); if (!(tag in o)) o[tag] = build(this.names(dir)); return o[tag]; },
    forget(dir) { if (dir) { m.delete(key(dir)); x.delete(key(dir)); } }
  };
}
// outside a run: a plain listing every time
const fresh = { names(dir) { try { return fs.readdirSync(dir); } catch { return []; } }, derived(dir, tag, build) { return build(this.names(dir)); }, forget() {} };

module.exports = { lister, fresh };
