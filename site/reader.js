/* Archive contents never enter the parent DOM. Only this sandbox bridge is added. */
(function () {
  'use strict';
  const { resolve } = ArchiveCore;
  const mime = path => ({ css:'text/css', js:'text/javascript', svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', avif:'image/avif', pdf:'application/pdf', woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', json:'application/json', txt:'text/plain' }[path.split('.').pop().toLowerCase()] || 'application/octet-stream');
  const isHTML = path => /\.html?$/i.test(path);
  function bridge(nonce, hash, restore) {
    let lastAnchor = null;
    const capture = anchor => {
      const focus=anchor || document.activeElement, focusKey=focus?.getAttribute?.('data-archive-key') || null;
      return {x:window.scrollX,y:window.scrollY,details:[...document.querySelectorAll('details')].map(el=>el.open),
        focusKey,focusOffset:focusKey ? focus.getBoundingClientRect().top : null};
    };
    const scrollToHash = hash => {
      let id; try { id=decodeURIComponent(hash.slice(1)); } catch { return; }
      if(!id) { window.scrollTo(0,0); return; }
      const target=document.getElementById(id) || document.getElementsByName(id)[0];
      if(!target) return;
      for(let el=target;el;el=el.parentElement) if(el.tagName==='DETAILS') el.open=true;
      if(!target.hasAttribute('tabindex')) target.setAttribute('tabindex','-1');
      target.focus({preventScroll:true}); target.scrollIntoView({block:'start'});
    };
    window.addEventListener('message', event => {
      if(event.source!==parent || event.data?.nonce!==nonce) return;
      if(event.data.type==='archive-capture' && typeof event.data.requestId==='string' && /^[a-f0-9-]{36}$/.test(event.data.requestId)) parent.postMessage({type:'archive-state',nonce,requestId:event.data.requestId,state:capture()},'*');
      if(event.data.type==='archive-restore-focus' && typeof event.data.key==='string') requestAnimationFrame(()=>{
        if(document.activeElement!==document.body) return;
        const link=[...document.querySelectorAll('[data-archive-key]')].find(el=>el.getAttribute('data-archive-key')===event.data.key);
        link?.focus({preventScroll:true});
      });
      if(event.data.type==='archive-scroll' && typeof event.data.hash==='string') scrollToHash(event.data.hash);
      if(event.data.type==='archive-focus' && lastAnchor?.isConnected) lastAnchor.focus({preventScroll:true});
    });
    document.addEventListener('DOMContentLoaded', async () => {
      if(restore) {
        const details=[...document.querySelectorAll('details')];
        restore.details.forEach((open,i)=>{if(details[i]) details[i].open=open;});
        const images=[...document.images].filter(img=>img.src.startsWith('data:'));
        images.forEach(img=>{img.loading='eager';});
        await Promise.race([Promise.all(images.map(img=>img.decode?.().catch(()=>{}))),new Promise(r=>setTimeout(r,1500))]);
        await new Promise(r=>requestAnimationFrame(r));
        const focus=restore.focusKey && [...document.querySelectorAll('[data-archive-key]')].find(el=>el.getAttribute('data-archive-key')===restore.focusKey);
        if(focus) focus.focus({preventScroll:true});
        const y=focus && Number.isFinite(restore.focusOffset) ? window.scrollY+focus.getBoundingClientRect().top-restore.focusOffset : restore.y;
        window.scrollTo(restore.x,Math.max(0,y));
      } else if (hash) scrollToHash(hash);
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
    const send = (ref,anchor) => parent.postMessage({ type:'archive-nav', nonce, ref, state:capture(anchor) }, '*');
    document.addEventListener('click', event => {
      const a = event.target.closest?.('a');
      if (!a) return;
      const ref = a.getAttribute('data-archive-ref') || a.getAttribute('href') || a.getAttribute('xlink:href');
      if (!ref) { event.preventDefault(); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      const command=a.getAttribute('data-archive-command');
      if(command==='back' || command==='home') { send('archive-'+command+':',a); return; }
      if (ref.startsWith('#')) { scrollToHash(ref); return; }
      lastAnchor=a; send(ref,a);
    }, true);
    document.addEventListener('submit', event => event.preventDefault(), true);
    window.print = () => send('archive-print:');
  }
  class Reader {
    constructor(files, host, options = {}) {
      this.onNavigate=options.onNavigate; this.ready=false; this.cursor=-1; this.stateRequests=new Map();
      this.assets = options.assets || {}; this.loader = options.load; this.inflight = new Map(); this.assetNodes = new Map(); this.destroyed = false;
      this.files = files; this.host = host; this.urls = new Set(); this.dataUrls = new Set(); this.cache = new Map(); this.history = []; this.nonce = ''; this.frame = null; this.loadTimer = null;
      this.onReady = event => {
        if(event.source !== this.frame?.contentWindow || event.origin !== 'null' || event.data?.nonce !== this.nonce) return;
        if(event.data.type==='archive-state' && this.stateRequests.has(event.data.requestId)) {
          const pending=this.stateRequests.get(event.data.requestId);clearTimeout(pending.timer);this.stateRequests.delete(event.data.requestId);
          this.saveState(event.data.state);pending.resolve();
        } else if(event.data.type === 'archive-ready') {
          this.ready=true;if(this.frame) this.frame.style.pointerEvents='';clearTimeout(this.loadTimer);this.notice?.remove();
          const key=this.history[this.cursor]?.state?.focusKey;
          if(key) this.frame.contentWindow.postMessage({type:'archive-restore-focus',nonce:this.nonce,key},'*');
        }
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
    saveState(state) {
      if(this.cursor<0 || !state || !Number.isFinite(state.x) || !Number.isFinite(state.y)
        || state.x<0 || state.y<0 || state.x>1e7 || state.y>1e7 || !Array.isArray(state.details)
        || state.details.length>2000 || state.details.some(x=>typeof x!=='boolean')
        || (state.focusOffset!=null && (!Number.isFinite(state.focusOffset) || Math.abs(state.focusOffset)>1e7))
        || (state.focusKey!==null && (typeof state.focusKey!=='string' || state.focusKey.length>32 || !/^link-\d+$/.test(state.focusKey)))) return;
      this.history[this.cursor].state={x:state.x,y:state.y,details:state.details.slice(),focusKey:state.focusKey,focusOffset:state.focusOffset ?? null};
    }
    capture() {
      if(!this.frame || this.destroyed || !this.ready) return Promise.resolve();
      const requestId=crypto.randomUUID();
      return new Promise(resolve=>{
        const timer=setTimeout(()=>{this.stateRequests.delete(requestId);resolve();},800);
        this.stateRequests.set(requestId,{resolve,timer});
        this.frame.contentWindow.postMessage({type:'archive-capture',nonce:this.nonce,requestId},'*');
      });
    }
    go(index) {
      if(!Number.isInteger(index) || index<0 || index>=this.history.length || index===this.cursor) return;
      this.cursor=index;const page=this.history[index];this.render(page.path,page.hash,false,page.state);
    }
    home() {
      const path=this.entry();
      if(this.current===path) { this.frame?.contentWindow.postMessage({type:'archive-scroll',nonce:this.nonce,hash:'#'},'*');return; }
      this.render(path);
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
    render(path, hash = '', push = true, restore = null) {
      if (!isHTML(path) || !this.files.has(path)) throw Error('missing');
      if(push) { this.history.splice(this.cursor+1);this.history.push({path,hash,state:null,title:''});this.cursor=this.history.length-1; }
      this.ready=false;
      this.assetNodes.clear();
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(this.files.get(path)), 'text/html');
      doc.querySelectorAll('base,iframe,object,embed,meta[http-equiv],link[rel="preload"],link[rel="prefetch"],link[rel="modulepreload"]').forEach(el => el.remove());
      const title=(doc.querySelector('h1')?.textContent || doc.title || '资料阅读').trim().slice(0,100);
      if(this.history[this.cursor]) this.history[this.cursor].title=title;
      // The outer shell stays minimal. Every private HTML receives its own return route.
      if(path!==this.entry()) {
        const nav=doc.createElement('nav');nav.setAttribute('aria-label','档案返回导航');nav.className='archive-return-nav';
        if(this.cursor>0) {
          const back=doc.createElement('a');back.href='#';back.setAttribute('data-archive-command','back');
          back.textContent='← 返回上一页';back.setAttribute('aria-label','返回：'+(this.history[this.cursor-1].title || '上一页'));nav.append(back);
        }
        const home=doc.createElement('a');home.href='#';home.setAttribute('data-archive-command','home');home.textContent='个人概览';nav.append(home);
        const current=doc.createElement('span');current.setAttribute('aria-current','page');current.textContent=title;nav.append(current);
        (doc.querySelector('main') || doc.body).prepend(nav);
        const style=doc.createElement('style');style.textContent='.archive-return-nav{position:sticky;top:0;z-index:1000;display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 0;margin:0 0 18px;background:#f5f8f8;border-bottom:1px solid #d7e2e5;font:14px/1.5 system-ui,-apple-system,sans-serif}.archive-return-nav a{color:#126660;text-decoration:underline;text-underline-offset:3px;padding:4px 2px;min-height:44px;display:inline-flex;align-items:center;box-sizing:border-box;white-space:nowrap}.archive-return-nav span{color:#506873;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.archive-return-nav a:focus-visible{outline:3px solid #a34b00;outline-offset:3px}';doc.head.append(style);
      }
      let linkNumber=0;

      for (const el of doc.querySelectorAll('*')) {
        if(el.localName==='a' && !el.hasAttribute('data-archive-command')) el.setAttribute('data-archive-key','link-'+linkNumber++);
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
      const script = doc.createElement('script'); script.textContent = `(${bridge.toString()})(${JSON.stringify(this.nonce)},${JSON.stringify(hash)},${JSON.stringify(restore)});`;
      doc.head.prepend(script); doc.head.prepend(policy);
      const frame = document.createElement('iframe');
      frame.style.pointerEvents='none';
      frame.title = '私人资料阅读区'; frame.setAttribute('sandbox','allow-scripts allow-downloads'); frame.referrerPolicy = 'no-referrer';
      clearTimeout(this.loadTimer);
      // srcdoc avoids Blob-document navigation failures in iOS embedded browsers.
      // The sandbox retains an opaque origin; no private document URL is published.
      frame.srcdoc = '<!doctype html>\n'+doc.documentElement.outerHTML;
      this.notice = document.createElement('p'); this.notice.setAttribute('role','status');
      this.notice.textContent = '正在显示档案内容…';
      this.host.replaceChildren(this.notice,frame); this.frame = frame; this.current = path;
      this.loadTimer = setTimeout(() => {
        this.notice.textContent = '档案内容未能显示。请刷新后重新登录；若仍为空白，请用手机自带的 Safari 浏览器打开本站。';
      },15000);
      this.onNavigate?.({index:this.cursor,push});
      frame.focus();
    }
    back() {
      if(this.cursor>0) this.go(this.cursor-1); else this.home();
    }
    destroy() {
      for(const pending of this.stateRequests.values()) {clearTimeout(pending.timer);pending.resolve();}this.stateRequests.clear();
      this.destroyed = true; this.ready=false; this.assetNodes.clear(); this.inflight.clear(); this.assets = {}; this.loader = null;
      clearTimeout(this.loadTimer); window.removeEventListener('message',this.onReady);
      this.nonce = ''; this.frame?.remove(); this.frame = null; this.host.replaceChildren();
      for (const url of this.urls) URL.revokeObjectURL(url);
      this.urls.clear(); this.dataUrls.clear(); this.cache.clear();
      for (const bytes of this.files.values()) bytes.fill(0);
      this.files.clear(); this.history.length = 0; this.cursor=-1;this.onNavigate=null; this.current = ''; this.documentURL = '';
    }
  }
  window.ArchiveReader = Reader;
})();
