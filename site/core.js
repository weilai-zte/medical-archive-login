/* Pure path and configuration rules, shared with the regression tests. */
(function (root) {
  'use strict';
  function resolve(ref, base = '') {
    ref = String(ref).trim();
    if (!ref || /[\x00-\x1f\\]/.test(ref)) return null;
    if (ref.startsWith('#')) return { kind: 'fragment', hash: ref };
    if (/^https:\/\//i.test(ref)) {
      try {
        const u = new URL(ref);
        if (u.username || u.password || /^(localhost|.*\.localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])$/i.test(u.hostname)) return null;
        return { kind: 'external', url: u.href };
      } catch { return null; }
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(ref)) return null;
    const hashAt = ref.indexOf('#');
    const hash = hashAt < 0 ? '' : ref.slice(hashAt);
    const raw = (hashAt < 0 ? ref : ref.slice(0, hashAt)).split('?')[0];
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { return null; }
    if (/[\x00-\x1f\\]/.test(decoded) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(decoded)) return null;
    const parts = raw.startsWith('/') ? [] : base.split('/').slice(0, -1);
    for (const part of decoded.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return null; parts.pop(); }
      else parts.push(part);
    }
    return { kind: 'local', path: parts.join('/'), hash };
  }
  function config(c) {
    if (c) c = { ...c, url:c.supabaseUrl ?? c.url, anonkey:c.supabaseKey ?? c.anonkey, archive_path:c.archivePath ?? c.archive_path };
    if (!c || !['url','anonkey','bucket','archive_path'].every(k => typeof c[k] === 'string' && c[k])) throw Error('config');
    if(c.archiveSha256!==undefined&&!/^[a-f0-9]{64}$/.test(c.archiveSha256))throw Error('config');
    const u = new URL(c.url);
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || !resolve(u.href) || /sb_secret_/i.test(c.anonkey)) throw Error('config');
    if (c.anonkey.startsWith('eyJ')) {
      try {
        const payload = JSON.parse(atob(c.anonkey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
        if (payload.role !== 'anon') throw Error();
      } catch { throw Error('config'); }
    } else if (!/^sb_publishable_[\w-]+$/.test(c.anonkey)) throw Error('config');
    if (!/^[\w-]+$/.test(c.bucket) || c.archive_path.split('/').some(p => !p || p === '.' || p === '..') || /[\\\x00-\x1f?#]/.test(c.archive_path)) throw Error('config');
    if (c.username !== undefined && c.username !== 'weilai') throw Error('config');
    if (c.loginEmail !== undefined && c.loginEmail !== 'owner@medical-archive.invalid') throw Error('config');
    return { ...c, url: u.origin, username:'weilai', loginEmail:'owner@medical-archive.invalid' };
  }
  function validMessage(event, source, nonce) {
    return !!source && event.source === source && event.origin === 'null' && event.data?.type === 'archive-nav' && event.data.nonce === nonce && typeof event.data.ref === 'string' && event.data.ref.length < 8192;
  }
  const api = { resolve, config, validMessage };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ArchiveCore = api;
})(globalThis);
