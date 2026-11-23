(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let token = null, reader = null, controller = null, expiry = null, generation = 0;
  let selection = 0;
  let busy = false;
  const preview = new ArchivePreview({onClose:()=>{
    selection++; status('');
    if(reader?.frame) {
      reader.frame.focus();
      reader.frame.contentWindow.postMessage({type:'archive-focus',nonce:reader.nonce},'*');
    }
  }});
  const status = message => { $('status').textContent = message; };
  function error(message) { $('error').textContent = message; if (message) $('error').focus(); }
  function clear(message = '') {
    generation++; selection++; delete window.__archiveDiagnostic; controller?.abort(); controller = null; clearTimeout(expiry); expiry = null;
    preview.close({restore:false});
    token = null; reader?.destroy(); reader = null;
    $('frame-host').replaceChildren(); $('workspace').hidden = true; $('login').hidden = false;

    $('password').value = ''; busy = false; $('submit').disabled = false; $('login-form').removeAttribute('aria-busy');
    $('cancel').hidden = true; status(message); error(''); $('username').focus();
  }
  async function request(url, options) {
    const response = await fetch(url, { cache:'no-store', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', ...options });
    if (!response.ok) {
      const e = Error('request'); e.status = response.status;
      try { const body = await response.json(); e.code = body.error_code; } catch {}
      throw e;
    }
    return response;
  }
  function unpack(buffer) {
    // Check central-directory original sizes before decompressing (ZIP-bomb guard).
    const files = new Map(); let size = 0, count = 0;
    const result = fflate.unzipSync(new Uint8Array(buffer), { filter(entry) {
      if (++count > 4096 || (size += entry.originalSize) > 512 * 1024 * 1024 || entry.originalSize > 128 * 1024 * 1024) throw Error('archive');
      return !entry.name.endsWith('/');
    }});
    for (const [name, data] of Object.entries(result)) {
      // Keep Unicode byte-for-byte; reject traversal, aliases and absolute names.
      if (name.startsWith('/') || name.includes('\\') || name.split('/').some(s => !s || s === '.' || s === '..') || /[\x00-\x1f]/.test(name)) throw Error('archive');
      files.set(name,data);
    }
    return files;
  }
  async function download(config,signal,run,progress) {
    let zip = null;
    const transfer=new AbortController(), abortTransfer=()=>transfer.abort();
    if(signal.aborted) transfer.abort(); else signal.addEventListener('abort',abortTransfer,{once:true});
    try {
      const object = [config.bucket,...config.archive_path.split('/')].map(encodeURIComponent).join('/');
      const objectUrl=config.url+'/storage/v1/object/authenticated/'+object;
      if (Number.isInteger(config.archiveBytes) && config.archiveBytes>0 && config.archiveBytes<=96*1024*1024) {
        // Bounded range requests avoid large-response proxy timeouts and show progress.
        zip=new ArrayBuffer(config.archiveBytes); const output=new Uint8Array(zip);
        const chunk=512*1024; let next=0,received=0;
        const worker=async()=>{
          while(next<config.archiveBytes){
            if(transfer.signal.aborted || signal.aborted || run!==generation) return;
            const start=next;next+=chunk;const end=Math.min(start+chunk,config.archiveBytes)-1;
            let bytes;
            for(let attempt=0;attempt<4;attempt++){
              try{
                const response=await request(objectUrl,{signal:AbortSignal.any([transfer.signal,AbortSignal.timeout(20000)]),headers:{apikey:config.anonkey,Authorization:'Bearer '+token,Range:'bytes='+start+'-'+end}});
                if(response.status!==206)throw Error('archive');
                const range=response.headers.get('Content-Range');
                if(range && range!=='bytes '+start+'-'+end+'/'+config.archiveBytes)throw Error('archive');
                bytes=new Uint8Array(await response.arrayBuffer());
                if(bytes.length!==end-start+1){bytes.fill(0);throw Error('archive');}
                break;
              }catch(e){
                if(signal.aborted||transfer.signal.aborted||run!==generation||attempt===3||e.message==='archive'||(e.status&&e.status<500&&e.status!==429))throw e;
                await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
              }
            }
            if(transfer.signal.aborted || run!==generation){bytes.fill(0);return;}
            output.set(bytes,start);received+=bytes.length;bytes.fill(0);
            progress?.(Math.floor(received/config.archiveBytes*100));
          }
        };
        const workers=[worker(),worker(),worker()];
        try { await Promise.all(workers); } catch(e) { transfer.abort(); await Promise.allSettled(workers); throw e; }
      } else {
        const response=await request(objectUrl,{signal:AbortSignal.any([transfer.signal,AbortSignal.timeout(20000)]),headers:{apikey:config.anonkey,Authorization:'Bearer '+token}});
        if(Number(response.headers.get('Content-Length'))>96*1024*1024)throw Error('archive');
        zip=await response.arrayBuffer();
      }
      if(zip.byteLength>96*1024*1024)throw Error('archive');
      if(config.archiveSha256){
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',zip))).map(x=>x.toString(16).padStart(2,'0')).join('');
        if(digest!==config.archiveSha256)throw Error('archive');
      }

      return zip;
    } catch(e) { transfer.abort(); if(zip) new Uint8Array(zip).fill(0); throw e; }
    finally { signal.removeEventListener('abort',abortTransfer); }
  }
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    error('');
    if ($('username').value.trim() !== 'weilai') { $('password').value = ''; error('用户名或密码不正确。'); return; }
    busy = true; $('cancel').hidden = false; $('submit').disabled = true; $('login-form').setAttribute('aria-busy','true');
    controller = new AbortController(); const signal = controller.signal; const run = ++generation;
    let password = $('password').value; $('password').value = '';
    let zip = null, files = null, auth = null, phase = 'config';
    try {
      status('正在登录…');
      const config = ArchiveCore.config(await (await request('config.json',{signal})).json());
      phase = 'auth';
      auth = await (await request(config.url+'/auth/v1/token?grant_type=password', { method:'POST', signal, headers:{apikey:config.anonkey,'Content-Type':'application/json'}, body:JSON.stringify({email:config.loginEmail,password}) })).json();
      password = '';
      if (run !== generation) return;
      if (typeof auth.access_token !== 'string' || !Number.isFinite(auth.expires_in) || auth.expires_in <= 0) throw Error('auth');
      token = auth.access_token; const lifetime = auth.expires_in; auth = null;
      expiry = setTimeout(() => clear('登录已到期，请重新登录。'), Math.min(lifetime * 1000,2147483647));
      phase = 'archive';
      status('登录成功，正在下载私有资料，请稍候…');
      zip = await download(config,signal,run,p=>status('正在下载档案页面… '+p+'%'));
      if (run !== generation) return;
      status('正在内存中解压…'); await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve,0)));
      if (run !== generation) return;
      files = unpack(zip); new Uint8Array(zip).fill(0); zip = null;
      let assets = {};
      if(files.has('__asset_manifest__.json')) {
        const manifest=JSON.parse(new TextDecoder().decode(files.get('__asset_manifest__.json')));
        if(manifest.version !== 1 || !manifest.assets || Array.isArray(manifest.assets) || Object.keys(manifest.assets).length>4096) throw Error('archive');
        assets=manifest.assets;
        let total=0;
        for(const [path,item] of Object.entries(assets)) {
          if(!item || typeof item!=='object' || files.has(path) || ArchiveCore.resolve('/'+path)?.path!==path || !/^releases\/lazy-[\w-]+\/assets\/[a-f0-9]{64}\.zip$/.test(item.objectPath)
            || !/^[a-f0-9]{64}$/.test(item.sha256) || !/^[a-f0-9]{64}$/.test(item.originalSha256)
            || !Number.isInteger(item.bytes) || item.bytes<=0 || item.bytes>96*1024*1024
            || !Number.isInteger(item.originalBytes) || item.originalBytes<=0 || item.originalBytes>128*1024*1024 || (total+=item.originalBytes)>512*1024*1024
            || !item.objectPath.endsWith('/'+item.originalSha256+'.zip')) throw Error('archive');
        }
      }
      const load = async item => {
        let bundle=null, contents=null, bytes=null;
        try {
          bundle=await download({...config,archive_path:item.objectPath,archiveBytes:item.bytes,archiveSha256:item.sha256},signal,run);
          if(signal.aborted || run!==generation) throw Error('cancelled');
          contents=unpack(bundle); new Uint8Array(bundle).fill(0); bundle=null;
          if(contents.size!==1 || !contents.has('asset')) throw Error('archive');
          bytes=contents.get('asset');
          if(bytes.length!==item.originalBytes) throw Error('archive');
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
          if(hash!==item.originalSha256 || signal.aborted || run!==generation) throw Error('archive');
          contents.delete('asset'); const result=bytes; bytes=null; return result;
        } finally {
          if(bundle) new Uint8Array(bundle).fill(0);
          if(bytes) bytes.fill(0);
          if(contents) for(const data of contents.values()) data.fill(0);
        }
      };
      reader = new ArchiveReader(files,$('frame-host'),{assets,load}); files = null;
      reader.render(reader.entry());
      $('login').hidden = true; $('cancel').hidden = true; $('workspace').hidden = false; status('');
    } catch (e) {
      if (run !== generation) return;
      const message = e.status === 429 ? '请求过于频繁，请稍后再试。'
        : phase === 'auth' && e.code === 'invalid_credentials' ? '用户名或密码不正确。密码未因页面更新而更改，请核对保存的登录信息。'
        : phase === 'auth' ? '登录服务暂未完成验证，请检查网络后重试。'
        : phase === 'archive' ? '账号验证已通过，但私有资料读取失败。请检查网络后重试；若持续失败，请反馈此提示，无需修改密码。'
        : '登录配置未能加载，请检查网络后重新打开本站。';
      clear(); error(message);
    } finally {
      password = ''; auth = null;
      if (zip) new Uint8Array(zip).fill(0);
      if (files) { for (const bytes of files.values()) bytes.fill(0); files.clear(); }
      if (run === generation) { busy = false; $('submit').disabled = false; $('login-form').removeAttribute('aria-busy'); }
    }
  });
  $('cancel').addEventListener('click', () => clear('已取消，当前页面资料已清空。'));
  $('logout').addEventListener('click', () => clear('已退出，当前页面资料已清空。'));
  window.addEventListener('message', async event => {
    if (!reader || !ArchiveCore.validMessage(event,reader.frame?.contentWindow,reader.nonce)) return;
    if (event.data.ref === 'archive-print:') { window.print(); return; }
    const target = ArchiveCore.resolve(event.data.ref, reader.current);
    if (!target) { error('该链接不可用。'); return; }
    if(target.kind==='fragment' || (target.kind==='local' && target.path===reader.current && target.hash)) {
      reader.frame.contentWindow.postMessage({type:'archive-scroll',nonce:reader.nonce,hash:target.hash},'*'); return;
    }
    const activeReader=reader, activeNonce=reader.nonce, activeRun=generation, ticket=++selection;
    let modalTicket;
    const stillCurrent=()=>reader===activeReader && generation===activeRun && reader.nonce===activeNonce && ticket===selection;
    try {
      if (target.kind === 'local' && /\.html?$/i.test(target.path)) {
        preview.close({restore:false}); reader.render(target.path,target.hash); error(''); status('');
      } else if(target.kind==='external') {
        modalTicket=preview.show('外部资料');
        await preview.display({kind:'other',filename:'外部资料',url:target.url,downloadUrl:target.url,downloadLabel:'打开外部资料'},modalTicket);
      } else if (target.kind === 'local') {
        const filename=target.path.split('/').pop();
        const showReport=async()=>{
          modalTicket=preview.show(filename);
          try {
            await activeReader.ensure(target.path);
            if(!stillCurrent()) return;
            const url=activeReader.asset(target.path);
            const isImage=/^data:image\//.test(url), isPDF=/\.pdf$/i.test(target.path);
            let downloadUrl=url;
            if(isImage) {
              const type=url.slice(5,url.indexOf(';'));
              const bytes=type==='image/svg+xml' ? Uint8Array.from(atob(url.slice(url.indexOf(',')+1)),c=>c.charCodeAt(0)) : activeReader.files.get(target.path);
              downloadUrl=activeReader.blob(bytes,type);
            }
            await preview.display({kind:isImage?'image':isPDF?'pdf':'other',url,bytes:isPDF?activeReader.files.get(target.path):undefined,filename,downloadUrl,downloadLabel:url.startsWith('data:image/svg+xml;')?'下载净化后的图示':'下载原件'},modalTicket);
          } catch {
            if(stillCurrent()) preview.fail('所选原件暂未读取成功，请重试。',modalTicket,showReport);
          }
        };
        await showReport();
      }
    } catch {
      if(stillCurrent()) error('所选链接暂未打开，请重试。');
    }
  });
  window.addEventListener('pagehide', () => clear());
  window.addEventListener('pageshow', event => { if (event.persisted) clear('请重新登录。'); });
})();
