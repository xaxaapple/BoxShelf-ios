// Turns a game's file name into a clean shelf title, shared by every platform (Windows main process and the Android
// build's renderer). Pure string logic: give it the file NAME (no folders), get { title, region, disc, rev, … }.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BSTitles = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const REGIONS = /^(usa|europe|japan|world|canada|australia|korea|china|asia|germany|france|spain|italy|uk|brazil|netherlands|sweden|en|ja|fr|de|es|it)([,\s].*)?$/i;
  const SKIP_NAME = /\b(update|dlc)\b|\[(upd|dlc)\]/i;
  const baseName = s => String(s).split(/[\\/]/).pop();

  // opts.updateWords: the bare words update / dlc / patch / booster / pass mark an update package (Switch, where those sit
  // beside the games). (beta.10) Off for every other console: "Hall Pass" or a "Booster" game was hidden there. Bracket
  // tags ("(Update)", "[DLC]") count everywhere. Left out: on (as before) for callers that don't say
  function cleanTitle(fileName, opts) {
    const words = !opts || opts.updateWords !== false;
    const name = baseName(fileName);
    let base = name.replace(/\.[^.]+$/, '').replace(/\.?\s*\b(nkit|wia|rvz|gcz|ciso|iso|wbfs|part\d+)\s*$/i, '').replace(/\s*\((nkit|wbfs|iso)\)/gi, '');
    const meta = { region: '', disc: 0, rev: '' };
    if (/(^|[^a-z0-9])v\d{5,}(?![0-9])/i.test(base)) meta.bigVersion = true; // Switch update packages carry versions like v65536
    // Pull out bracketed tags
    base = base.replace(/\s*[\(\[]([^\)\]]*)[\)\]]/g, (m, inner) => {
      const t = inner.trim();
      if (/^[0-9A-F]{16}$/i.test(t)) meta.titleId = t.toUpperCase();   // Switch title id
      if (/^(upd|update|dlc|patch)$/i.test(t)) meta.tagExtra = true;     // "(UPD)" / "(DLC)" packages next to the base game
      const disc = t.match(/^(?:dis[ck]|dvd|cd)\s*(\d+)/i); // (Disc 2), [DVD2], [CD 2]
      if (disc) meta.disc = +disc[1];
      else if (/^rev\s*\w+/i.test(t)) meta.rev = t;
      else if (!meta.region && REGIONS.test(t) && !/^(en|ja|fr|de|es|it)\b/i.test(t)) meta.region = t.split(',')[0].trim();
      return ' ';
    });
    base = base
      .replace(/[_]+/g, ' ')
      .replace(/\s+-\s+copy(\s*\(\d+\))?\s*$/i, '')     // "Game - Copy", "Game - Copy (2)" (the tag pass leaves a trailing space)
      .replace(/\b(www\.)?[\w-]+\.(com|net|org|io|to|cc)\b/gi, '') // website names
      .replace(/\bv\d+(\.\d+)*\b/gi, ' ')                       // v1.0.0, v65536
      .replace(/\b(switch|xci|nsp|nsz|base game|eshop|repack|multi\d*)\b/gi, ' ') // dump-site words
      .replace(/\bsxs-/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .replace(/[\s-]+$/, '');
    // "Legend of Zelda, The - Wind Waker" -> "The Legend of Zelda - Wind Waker"
    base = base.replace(/^(.+?),\s+(The|A|An)(\s+-\s+.*)?$/i, (m, a, art, rest) => `${art} ${a}${rest || ''}`);
    meta.extra = !!((words && /\b(update|dlc|patch|booster|pass)\b/i.test(base)) || (meta.titleId && !/000$/.test(meta.titleId)) || meta.bigVersion || meta.tagExtra);
    if (meta.extra && words) base = base.replace(/\b(update|dlc|patch)\b.*$/i, '').trim();
    return { title: base || name, ...meta };
  }

  // Folders a scan never goes into, and files that are never games
  const SKIP_DIR = /^(dlc|updates?|patches|mods|sce_sys|sce_module)$/i;
  const skipFile = n => SKIP_NAME.test(n);
  return { cleanTitle, SKIP_DIR, SKIP_NAME, skipFile };
});
