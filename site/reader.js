/* Archive contents never enter the parent DOM. Only this sandbox bridge is added. */
(function () {
  'use strict';
  const { resolve } = ArchiveCore;
  const mime = path => ({ css:'text/css', js:'text/javascript', svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', avif:'image/avif', pdf:'application/pdf', woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', json:'application/json', txt:'text/plain' }[path.split('.').pop().toLowerCase()] || 'application/octet-stream');
  const isHTML = path => /\.html?$/i.test(path);
  function bridge(nonce, hash) {
    document.addEventListener('DOMContentLoaded', () => {
      if (hash) { try { document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView(); } catch {} }
      parent.postMessage({type:'archive-ready',nonce},'*');
      const nodes = new Map();
      const load = img => parent.postMessage({type:'archive-load',nonce,id:img.dataset.privateAsset},'*');
      const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        for(const entry of entries) if(entry.isIntersecting) { observer.unobserve(entry.target); load(entry.target); }
      },{rootMargin:'160px'}) : null;
      for(const img of document.querySelectorAll('img[data-private-asset]')) {
        nodes.set(img.dataset.privateAsset,img);
        if(observer) observer.observe(img); else load(img);
      }
      window.addEventListener('message',event => {
        if(event.source !== parent || event.data?.type !== 'archive-loaded' || event.data.nonce !== nonce) return;
        const img = nodes.get(event.data.id); if(!img) return;
        if(event.data.error) {
          if(img.nextElementSibling?.dataset.retryFor === event.data.id) return;
          const retry = document.createElement('button'); retry.type='button'; retry.dataset.retryFor=event.data.id;
          retry.textContent='图片暂未加载，点击重试';
          retry.addEventListener('click',()=>{retry.remove();load(img);}); img.after(retry);
        } else if(typeof event.data.url === 'string' && /^data:image\//.test(event.data.url)) {
          img.src=event.data.url; img.style.minHeight=''; nodes.delete(event.data.id);
        }
      });
    }, {once:true});
    const send = ref => parent.postMessage({ type:'archive-nav', nonce, ref }, '*');
    document.addEventListener('click', event => {
      const a = event.target.closest?.('a');
      if (!a) return;
      const ref = a.getAttribute('data-archive-ref') || a.getAttribute('href') || a.getAttribute('xlink:href');
      if (!ref) { event.preventDefault(); return; }
      if (ref.startsWith('#')) return;
      event.preventDefault(); event.stopImmediatePropagation(); send(ref);
    }, true);
    document.addEventListener('submit', event => event.preventDefault(), true);
    window.print = () => send('archive-print:');
  }
  class Reader {
    constructor(files, host, options = {}) {
      this.assets = options.assets || {}; this.loader = options.load; this.inflight = new Map(); this.assetNodes = new Map(); this.destroyed = false;
      this.files = files; this.host = host; this.urls = new Set(); this.dataUrls = new Set(); this.cache = new Map(); this.history = []; this.nonce = ''; this.frame = null; this.loadTimer = null;
      this.onReady = event => {
        if(event.source !== this.frame?.contentWindow || event.origin !== 'null' || event.data?.nonce !== this.nonce) return;
        if(event.data.type === 'archive-ready') { clearTimeout(this.loadTimer); this.notice?.remove(); }
        else if(event.data.type === 'archive-load' && this.assetNodes.has(event.data.id)) {
          const frame=this.frame, nonce=this.nonce, id=event.data.id, path=this.assetNodes.get(id);
          this.ensure(path).then(()=>{
            if(this.destroyed || frame!==this.frame || nonce!==this.nonce) return;
            frame.contentWindow.postMessage({type:'archive-loaded',nonce,id,url:this.asset(path)},'*');
          }).catch(()=>{
            if(this.destroyed || frame!==this.frame || nonce!==this.nonce) return;
            frame.contentWindow.postMessage({type:'archive-loaded',nonce,id,error:true},'*');
          });
        }
      };
      window.addEventListener('message',this.onReady);
    }
    has(path) { return this.files.has(path) || Object.hasOwn(this.assets,path); }
    async ensure(path) {
      if(this.destroyed) throw Error('cancelled');
      if(this.files.has(path)) return;
      if(!Object.hasOwn(this.assets,path) || !this.loader) throw Error('missing');
      if(!this.inflight.has(path)) {
        const pending=this.loader(this.assets[path]).then(bytes=>{
          if(this.destroyed) { bytes.fill(0); throw Error('cancelled'); }
          this.files.set(path,bytes);
        }).finally(()=>this.inflight.delete(path));
        this.inflight.set(path,pending);
      }
      await this.inflight.get(path);
    }
    blob(data, type) {
      const url = URL.createObjectURL(new Blob([data], { type })); this.urls.add(url); return url;
    }
    inline(data,type) {
      const bytes=typeof data==='string'?new TextEncoder().encode(data):data;
      const chunks=[];
      for(let i=0;i<bytes.length;i+=32768)chunks.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
      const url='data:'+type+';base64,'+btoa(chunks.join(''));this.dataUrls.add(url);return url;
    }
    local(ref, base, stack = new Set()) {
      const target = resolve(ref, base);
      if (target?.kind === 'fragment') return target.hash;
      // External loads are disabled: external HTTPS is supported only as an explicit link.
      if (target?.kind !== 'local' || !this.files.has(target.path)) return '';
      return this.asset(target.path, stack) + target.hash;
    }
    css(text, base, stack) {
      // Local CSS references incl. quoted imports, fonts, Unicode paths, url(#SVG-id).
      text = text.replace(/@import\s+(['"])(.*?)\1\s*([^;]*);/gi, (_, q, ref, media) => {
        const url = this.local(ref, base, stack);
        return url ? `@import url("${url}") ${media};` : '';
      });
      return text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_, a,b,c) => {
        const ref = (a ?? b ?? c).trim();
        if ((/^blob:/.test(ref) && this.urls.has(ref)) || this.dataUrls.has(ref)) return `url("${ref}")`;
        if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(ref)) return `url("${ref}")`;
        return `url("${this.local(ref, base, stack)}")`;
      });
    }
    asset(path, stack = new Set()) {
      if (this.cache.has(path)) return this.cache.get(path);
      if (stack.has(path)) return ''; // Cyclic CSS imports cannot be represented by immutable blobs.
      stack = new Set(stack); stack.add(path);
      let data = this.files.get(path); const type = mime(path);
      if (type === 'text/css') data = this.css(new TextDecoder().decode(data), path, stack);
      if (type === 'image/svg+xml') {
        const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), 'image/svg+xml');
        doc.querySelectorAll('script,foreignObject').forEach(el => el.remove());
        for (const el of doc.querySelectorAll('*')) {
          for (const attr of [...el.attributes]) {
            if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
            else if (attr.localName === 'href') el.setAttribute(attr.name, this.local(attr.value, path, stack));
            else if (attr.name === 'style' || /url\(/i.test(attr.value)) el.setAttribute(attr.name, this.css(attr.value, path, stack));
          }
          if (el.localName === 'style') el.textContent = this.css(el.textContent, path, stack);
        }
        data = new XMLSerializer().serializeToString(doc);
      }
      const url = /^(text\/(css|javascript)|image\/|font\/)/.test(type) ? this.inline(data,type) : this.blob(data,type); this.cache.set(path, url); return url;
    }
    entry() {
      // ZIP root index is the original entry. No patient-specific paths in the public shell.
      const candidates = [...this.files.keys()].filter(p => /(^|\/)index\.html?$/i.test(p)).sort((a,b) => a.split('/').length-b.split('/').length || a.localeCompare(b));
      if (candidates.length) {
        const first=candidates[0];
        const doc=new DOMParser().parseFromString(new TextDecoder().decode(this.files.get(first)),'text/html');
        const refresh=doc.querySelector('meta[http-equiv="refresh" i]')?.getAttribute('content');
        const ref=refresh?.match(/;\s*url\s*=\s*(.+)$/i)?.[1]?.replace(/^['"]|['"]$/g,'');
        const target=ref ? resolve(ref,first) : null;
        if(target?.kind==='local' && isHTML(target.path) && this.files.has(target.path)) return target.path;
        return first;
      }
      const html = [...this.files.keys()].filter(isHTML);
      if (html.length === 1) return html[0];
      throw Error('entry');
    }
    render(path, hash = '', push = true) {
      if (!isHTML(path) || !this.files.has(path)) throw Error('missing');
      this.assetNodes.clear();
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(this.files.get(path)), 'text/html');
      doc.querySelectorAll('base,iframe,object,embed,meta[http-equiv],link[rel="preload"],link[rel="prefetch"],link[rel="modulepreload"]').forEach(el => el.remove());
      for (const el of doc.querySelectorAll('*')) {
        for (const attr of [...el.attributes]) {
          if (['src','poster'].includes(attr.name)) {
            const target=resolve(attr.value,path);
            if(el.localName==='img' && target?.kind==='local' && this.has(target.path) && !this.files.has(target.path)) {
              const id='asset-'+this.assetNodes.size; this.assetNodes.set(id,target.path); el.setAttribute('data-private-asset',id);
              el.removeAttribute('src'); el.style.minHeight='120px';
            } else el.setAttribute(attr.name,this.local(attr.value,path));
          }
          else if (attr.name === 'srcset') {
            el.setAttribute('srcset', attr.value.split(',').map(item => {
              const [ref, ...descriptor] = item.trim().split(/\s+/); const url = this.local(ref,path);
              return url ? `${url} ${descriptor.join(' ')}` : '';
            }).filter(Boolean).join(','));
          } else if (attr.localName === 'href') {
            if (el.localName === 'a') {
              const target = resolve(attr.value,path);
              if (target?.kind === 'fragment') el.setAttribute(attr.name,target.hash);
              else if (target && ['local','external'].includes(target.kind)) {
                el.setAttribute('data-archive-ref',attr.value);
                el.setAttribute(attr.name, target.kind === 'external' ? target.url : '#');
                if (target.kind === 'external') { el.setAttribute('target','_blank'); el.setAttribute('rel','noopener noreferrer'); }
              } else el.removeAttribute(attr.name);
            } else el.setAttribute(attr.name,this.local(attr.value,path));
          } else if (attr.name === 'style' || /url\(/i.test(attr.value)) el.setAttribute(attr.name,this.css(attr.value,path,new Set()));
          else if (['action','formaction','ping','srcdoc'].includes(attr.name)) el.removeAttribute(attr.name);
        }
        if (el.localName === 'style') el.textContent = this.css(el.textContent,path,new Set());
        if (el.localName === 'script') { el.removeAttribute('integrity'); el.removeAttribute('crossorigin'); }
      }
      this.nonce = crypto.randomUUID();
      const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
      policy.content = "default-src 'none'; script-src blob: data: 'unsafe-inline'; style-src blob: data: 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
      const script = doc.createElement('script'); script.textContent = `(${bridge.toString()})(${JSON.stringify(this.nonce)},${JSON.stringify(hash)});`;
      doc.head.prepend(script); doc.head.prepend(policy);
      const frame = document.createElement('iframe');
      frame.title = '私人资料阅读区'; frame.setAttribute('sandbox','allow-scripts allow-downloads'); frame.referrerPolicy = 'no-referrer';
      clearTimeout(this.loadTimer);
      // srcdoc avoids Blob-document navigation failures in iOS embedded browsers.
      // The sandbox retains an opaque origin; no private document URL is published.
      frame.srcdoc = '<!doctype html>\n'+doc.documentElement.outerHTML;
      this.notice = document.createElement('p'); this.notice.setAttribute('role','status');
      this.notice.textContent = '正在显示档案内容…';
      this.host.replaceChildren(this.notice,frame); this.frame = frame; this.current = path;
      this.loadTimer = setTimeout(() => {
        this.notice.textContent = '档案内容未能显示。请点“返回入口”重试；仍为空白时，请用手机自带的 Safari 浏览器打开本站。';
      },15000);
      if (push) this.history.push({path,hash});
      frame.focus();
    }
    back() {
      if (this.history.length < 2) return;
      this.history.pop(); const {path,hash} = this.history.at(-1); this.render(path,hash,false);
    }
    destroy() {
      this.destroyed = true; this.assetNodes.clear(); this.inflight.clear(); this.assets = {}; this.loader = null;
      clearTimeout(this.loadTimer); window.removeEventListener('message',this.onReady);
      this.nonce = ''; this.frame?.remove(); this.frame = null; this.host.replaceChildren();
      for (const url of this.urls) URL.revokeObjectURL(url);
      this.urls.clear(); this.dataUrls.clear(); this.cache.clear();
      for (const bytes of this.files.values()) bytes.fill(0);
      this.files.clear(); this.history.length = 0; this.current = ''; this.documentURL = '';
    }
  }
  window.ArchiveReader = Reader;
})();
