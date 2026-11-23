(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let token = null, reader = null, controller = null, expiry = null, generation = 0;
  let busy = false, imagePreview = '';
  function closePreview() {
    $('original-image').removeAttribute('src'); $('image-preview').hidden = true;
  }
  const status = message => { $('status').textContent = message; };
  function error(message) { $('error').textContent = message; if (message) $('error').focus(); }
  function clear(message = '') {
    generation++; delete window.__archiveDiagnostic; controller?.abort(); controller = null; clearTimeout(expiry); expiry = null;
    closePreview(); imagePreview = '';
    token = null; reader?.destroy(); reader = null;
    $('frame-host').replaceChildren(); $('workspace').hidden = true; $('login').hidden = false;
    $('file-link').removeAttribute('href'); $('download-link').removeAttribute('href'); $('download-link').removeAttribute('download'); $('open-file').hidden = true;
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
      const object = [config.bucket,...config.archive_path.split('/')].map(encodeURIComponent).join('/');
      const objectUrl=config.url+'/storage/v1/object/authenticated/'+object;
      if (Number.isInteger(config.archiveBytes) && config.archiveBytes>0 && config.archiveBytes<=96*1024*1024) {
        // Bounded range requests avoid large-response proxy timeouts and show progress.
        zip=new ArrayBuffer(config.archiveBytes); const output=new Uint8Array(zip);
        const chunk=512*1024; let next=0,received=0;
        const worker=async()=>{
          while(next<config.archiveBytes){
            const start=next;next+=chunk;const end=Math.min(start+chunk,config.archiveBytes)-1;
            let bytes;
            for(let attempt=0;attempt<4;attempt++){
              try{
                const response=await request(objectUrl,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{apikey:config.anonkey,Authorization:'Bearer '+token,Range:'bytes='+start+'-'+end}});
                if(response.status!==206)throw Error('archive');
                const range=response.headers.get('Content-Range');
                if(range && range!=='bytes '+start+'-'+end+'/'+config.archiveBytes)throw Error('archive');
                bytes=new Uint8Array(await response.arrayBuffer());
                if(bytes.length!==end-start+1){bytes.fill(0);throw Error('archive');}
                break;
              }catch(e){
                if(signal.aborted||run!==generation||attempt===3||e.message==='archive'||(e.status&&e.status<500&&e.status!==429))throw e;
                await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
              }
            }
            if(run!==generation){bytes.fill(0);return;}
            output.set(bytes,start);received+=bytes.length;bytes.fill(0);
            status('正在下载私有资料… '+Math.floor(received/config.archiveBytes*100)+'%');
          }
        };
        await Promise.all([worker(),worker(),worker()]);
      } else {
        const response=await request(objectUrl,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{apikey:config.anonkey,Authorization:'Bearer '+token}});
        if(Number(response.headers.get('Content-Length'))>96*1024*1024)throw Error('archive');
        zip=await response.arrayBuffer();
      }
      if(zip.byteLength>96*1024*1024)throw Error('archive');
      if(config.archiveSha256){
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',zip))).map(x=>x.toString(16).padStart(2,'0')).join('');
        if(digest!==config.archiveSha256)throw Error('archive');
      }
      if (run !== generation) return;
      status('正在内存中解压…'); await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve,0)));
      if (run !== generation) return;
      files = unpack(zip); new Uint8Array(zip).fill(0); zip = null;
      reader = new ArchiveReader(files,$('frame-host')); files = null;
      reader.render(reader.entry());
      $('login').hidden = true; $('cancel').hidden = true; $('workspace').hidden = false; status('资料已就绪，仅保留在当前页面内存中。');
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
  $('home').addEventListener('click', () => { try { reader?.render(reader.entry()); } catch { error('无法打开入口。'); } });
  $('back').addEventListener('click', () => reader?.back());
  $('close-preview').addEventListener('click', () => { closePreview(); $('file-link').focus(); });
  $('file-link').addEventListener('click', event => {
    if (!imagePreview) return;
    event.preventDefault(); $('original-image').src = imagePreview; $('image-preview').hidden = false;
    $('close-preview').focus(); $('image-preview').scrollIntoView({block:'start'});
  });
  $('print').addEventListener('click', () => window.print());
  window.addEventListener('message', event => {
    if (!reader || !ArchiveCore.validMessage(event,reader.frame?.contentWindow,reader.nonce)) return;
    if (event.data.ref === 'archive-print:') { window.print(); return; }
    const target = ArchiveCore.resolve(event.data.ref, reader.current);
    if (!target) { error('该链接不可用。'); return; }
    try {
      closePreview(); imagePreview = '';
      if (target.kind === 'local' && /\.html?$/i.test(target.path)) {
        reader.render(target.path,target.hash); $('open-file').hidden = true; error('');
      } else if (target.kind === 'external' || target.kind === 'local') {
        if (target.kind === 'local' && !reader.files.has(target.path)) throw Error('missing');
        let url = target.kind === 'external' ? target.url : reader.asset(target.path)+target.hash;
        if (target.kind === 'local' && /^data:image\//.test(url)) {
          imagePreview = url;
          const type = url.slice(5,url.indexOf(';'));
          // Image data URLs work as img sources but browsers block opening them as documents.
          url = reader.blob(reader.files.get(target.path),type);
        }
        $('file-link').textContent = imagePreview ? '在本页查看原图' : target.kind === 'external' ? '打开外部链接' : '打开原件';
        $('file-link').href = url; $('open-file').hidden = false;
        $('download-link').hidden = target.kind === 'external';
        if (target.kind === 'local') { $('download-link').href = url; $('download-link').download = target.path.split('/').pop(); }
        // Explicit user click avoids sandbox popup restrictions and popup blockers.
        $('file-link').focus(); status('链接已准备好，请选择打开或下载。');
      }
    } catch { error('链接目标不存在，或无法读取。'); }
  });
  window.addEventListener('pagehide', () => clear());
  window.addEventListener('pageshow', event => { if (event.persisted) clear('请重新登录。'); });
})();
