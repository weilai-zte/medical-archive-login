/* Private, local report preview. App owns all supplied URLs and revokes them.
 * Load as a classic script; PDF.js is imported only when displaying a PDF.
 */
(() => {
  'use strict';
  const scriptURL = document.currentScript?.src || new URL('preview.js', document.baseURI).href;
  const PDF_MODULE = new URL('./vendor/pdfjs-6.5.438/pdf.mjs', scriptURL).href;
  const PDF_WORKER = new URL('./vendor/pdfjs-6.5.438/pdf.worker.mjs', scriptURL).href;
  const MAX_PIXELS = 4 * 1024 * 1024;
  const MAX_EDGE = 4096;

  class ArchivePreview {
    constructor({onClose} = {}) {
      this.onClose = onClose;
      this.nodes = {};
      for (const id of ['report-preview', 'preview-title', 'preview-status', 'preview-content',
        'original-image', 'pdf-pages', 'preview-unsupported', 'preview-retry',
        'download-link', 'zoom-out', 'zoom-in', 'zoom-label', 'close-preview']) {
        const node = document.getElementById(id);
        if (!node) throw new Error(`Missing preview element: ${id}`);
        this.nodes[id] = node;
      }
      this.dialog = this.nodes['report-preview'];
      this.ticket = 0;
      this.tasks = new Set();
      this.zoom = 1;
      this.dialog.setAttribute('aria-labelledby', 'preview-title');
      this.nodes['preview-status'].setAttribute('role', 'status');
      this.nodes['preview-status'].setAttribute('aria-live', 'polite');
      this.nodes['close-preview'].addEventListener('click', () => this.close());
      this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
      // Also clean up if a host closes the native dialog directly.
      this.dialog.addEventListener('close', () => { if (this.session && !this.dialog.open) this.close(); });
      this.dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
        if (event.key !== 'Tab') return;
        const items = [...this.dialog.querySelectorAll('button,a[href],[tabindex]')]
          .filter(node => !node.disabled && !node.hidden && node.tabIndex >= 0 && node.getClientRects().length);
        const first = items[0], last = items[items.length - 1];
        if (!first) { event.preventDefault(); this.nodes['close-preview'].focus({preventScroll: true}); }
        else if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) {
          event.preventDefault(); last.focus({preventScroll: true});
        } else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) {
          event.preventDefault(); first.focus({preventScroll: true});
        }
      });
      this.nodes['zoom-in'].addEventListener('click', () => this.setZoom(this.zoom + 0.25));
      this.nodes['zoom-out'].addEventListener('click', () => this.setZoom(this.zoom - 0.25));
      this.nodes['preview-content'].style.overflow = 'auto';
      this.nodes['preview-content'].style.overscrollBehavior = 'contain';
      this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        const width = this.nodes['preview-content'].clientWidth;
        if (width !== this.lastWidth) {
          this.lastWidth = width;
          if (this.pdf && this.dialog.open) this.renderPDF(this.ticket);
        }
      }) : null;
      this.resizeObserver?.observe(this.nodes['preview-content']);
    }

    current(ticket) { return ticket === this.ticket && this.dialog.open; }

    cleanup() {
      this.renderEpoch = (this.renderEpoch || 0) + 1;
      this.observer?.disconnect(); this.observer = null;
      for (const task of this.tasks) { try { task.cancel(); } catch (_) { /* already finished */ } }
      this.tasks.clear();
      const loading = this.loading;
      this.loading = null; this.pdf = null;
      if (loading) { try { Promise.resolve(loading.destroy()).catch(() => {}); } catch (_) { /* disposed */ } }
      const image = this.nodes['original-image'];
      image.onload = image.onerror = null;
      image.removeAttribute('src'); image.hidden = true;
      for (const canvas of this.nodes['pdf-pages'].querySelectorAll('canvas')) {
        canvas.width = canvas.height = 0;
      }
      this.nodes['pdf-pages'].replaceChildren();
      this.nodes['pdf-pages'].hidden = true;
      const download = this.nodes['download-link'];
      download.removeAttribute('href'); download.removeAttribute('download');
      download.removeAttribute('target'); download.removeAttribute('rel'); download.hidden = true;
      this.nodes['preview-retry'].onclick = null;
      this.nodes['preview-retry'].hidden = true;
      this.nodes['preview-unsupported'].hidden = true;
      this.kind = null;
    }

    show(title) {
      if (!this.session) {
        const active = document.activeElement;
        const scroll = [];
        for (let node = active; node; node = node.parentElement) {
          scroll.push([node, node.scrollLeft, node.scrollTop]);
        }
        this.session = {active, scroll, x: window.scrollX, y: window.scrollY};
      }
      ++this.ticket;
      this.cleanup();
      this.zoom = 1;
      this.updateZoom();
      this.nodes['preview-title'].textContent = String(title || '原报告');
      this.nodes['preview-status'].textContent = '正在加载原件…';
      this.nodes['preview-content'].setAttribute('aria-busy', 'true');
      if (!this.dialog.open) this.dialog.showModal();
      this.nodes['preview-content'].scrollTop = 0;
      this.nodes['close-preview'].focus({preventScroll: true});
      return this.ticket;
    }

    async display({kind, url, bytes, filename, downloadUrl, downloadLabel}, ticket) {
      if (!this.current(ticket)) return;
      // A second display on the same ticket supersedes earlier work as well.
      this.cleanup();
      const epoch = this.renderEpoch;
      const valid = () => this.current(ticket) && epoch === this.renderEpoch;
      this.kind = kind;
      const download = this.nodes['download-link'];
      if (downloadUrl) {
        download.href = downloadUrl;
        if (kind === 'other' && /^https?:\/\//i.test(downloadUrl)) {
          download.target = '_blank';
          download.rel = 'noopener noreferrer';
        } else download.download = filename || '原件';
        download.textContent = downloadLabel || '下载原件';
        download.hidden = false;
      }
      try {
        if (kind === 'image') {
          if (typeof url !== 'string' || !/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(url)) {
            throw new Error('Unsupported image URL');
          }
          const image = this.nodes['original-image'];
          image.alt = `${this.nodes['preview-title'].textContent}（原报告图片）`;
          image.onload = () => { if (valid()) this.ready('原图已加载，可缩放查看。'); };
          image.onerror = () => { if (valid()) this.fail('原图暂时无法显示，请下载原件查看。', ticket); };
          image.hidden = false;
          image.style.height = 'auto';
          this.applyImageZoom();
          image.src = url;
        } else if (kind === 'pdf') {
          const pdfjs = await import(PDF_MODULE);
          if (!valid()) return;
          pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
          // Copy before passing to PDF.js: its worker may transfer the buffer.
          const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes.slice(0)) : bytes.slice();
          const loading = pdfjs.getDocument({data, isEvalSupported: false, useWasm: false, disableFontFace: true, disableWorkerRendering: true});
          this.loading = loading;
          const pdf = await loading.promise;
          if (!valid()) return; // cleanup already destroyed this loading task
          this.pdf = pdf;
          this.nodes['pdf-pages'].hidden = false;
          await this.renderPDF(ticket);
        } else {
          const external = download.target === '_blank';
          this.nodes['preview-unsupported'].textContent = external
            ? '外部资料请通过下方链接打开。' : '此格式暂不支持在线预览，请下载原件查看。';
          this.nodes['preview-unsupported'].hidden = false;
          this.ready(external ? '可打开外部资料。' : '可下载原件查看。');
        }
      } catch (_) {
        if (valid()) this.fail('原件暂时无法预览，请下载原件查看或重试。', ticket);
      }
    }

    ready(message) {
      this.nodes['preview-status'].textContent = message;
      this.nodes['preview-content'].setAttribute('aria-busy', 'false');
    }

    fail(message, ticket, retryCallback) {
      if (!this.current(ticket)) return;
      this.ready(String(message || '暂时无法预览，请下载原件查看。'));
      const retry = this.nodes['preview-retry'];
      retry.hidden = typeof retryCallback !== 'function';
      retry.onclick = retry.hidden ? null : () => {
        if (!this.current(ticket)) return;
        retry.hidden = true;
        Promise.resolve().then(() => { if (this.current(ticket)) return retryCallback(); })
          .catch(() => { if (this.current(ticket)) this.fail('重试失败，请再次重试或下载原件。', ticket, retryCallback); });
      };
    }

    updateZoom() {
      this.nodes['zoom-label'].textContent = `${Math.round(this.zoom * 100)}%`;
      this.nodes['zoom-out'].disabled = this.zoom <= 0.5;
      this.nodes['zoom-in'].disabled = this.zoom >= 3;
    }

    applyImageZoom() {
      const image = this.nodes['original-image'];
      image.style.width = `${this.zoom * 100}%`;
      image.style.maxWidth = 'none';
    }

    setZoom(value) {
      if (!this.dialog.open) return;
      this.zoom = Math.min(3, Math.max(0.5, value));
      this.updateZoom();
      if (this.kind === 'image') this.applyImageZoom();
      if (this.pdf) this.renderPDF(this.ticket);
    }

    async renderPDF(ticket) {
      const pdf = this.pdf;
      if (!pdf || !this.current(ticket)) return;
      const epoch = ++this.renderEpoch;
      const valid = () => this.current(ticket) && epoch === this.renderEpoch && this.pdf === pdf;
      this.observer?.disconnect();
      for (const task of this.tasks) { try { task.cancel(); } catch (_) { /* finished */ } }
      this.tasks.clear();
      const host = this.nodes['pdf-pages'];
      for (const canvas of host.querySelectorAll('canvas')) canvas.width = canvas.height = 0;
      host.replaceChildren();
      const width = Math.max(160, this.nodes['preview-content'].clientWidth - 24) * this.zoom;
      const jobs = [];
      let renderFailed = false;
      // Serial rendering bounds concurrent allocation, even when many pages enter view.
      let queue = Promise.resolve();
      const enqueue = (holder, number) => {
        queue = queue.then(async () => {
          if (!valid() || holder.dataset.started) return;
          holder.dataset.started = 'true';
          const page = await pdf.getPage(number);
          if (!valid()) return;
          const unit = page.getViewport({scale: 1});
          const cssScale = width / unit.width;
          const ratio = Math.min(window.devicePixelRatio || 1, 2);
          const scale = Math.min(cssScale * ratio, MAX_EDGE / unit.width, MAX_EDGE / unit.height,
            Math.sqrt(MAX_PIXELS / (unit.width * unit.height)));
          const viewport = page.getViewport({scale});
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          canvas.style.width = `${width}px`;
          canvas.style.height = `${unit.height * cssScale}px`;
          canvas.style.maxWidth = 'none';
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `PDF 第 ${number} 页；文字内容请下载原件阅读`);
          holder.replaceChildren(canvas);
          const task = page.render({canvasContext: canvas.getContext('2d'), viewport});
          this.tasks.add(task);
          try { await task.promise; } finally { this.tasks.delete(task); }
          if (valid() && !renderFailed) this.ready(`PDF 共 ${pdf.numPages} 页，可上下浏览及缩放；文字内容可下载阅读。`);
        }).catch(() => {
          if (valid()) { renderFailed = true; this.fail('部分 PDF 页面无法显示，请下载原件查看。', ticket); }
        });
        return queue;
      };
      if (typeof IntersectionObserver === 'function') {
        this.observer = new IntersectionObserver(entries => {
          for (const entry of entries) if (entry.isIntersecting && valid()) {
            this.observer.unobserve(entry.target);
            enqueue(entry.target, Number(entry.target.dataset.page));
          }
        }, {root: this.nodes['preview-content'], rootMargin: '300px'});
      } else this.observer = null;
      for (let number = 1; number <= pdf.numPages; number++) {
        const holder = document.createElement('div');
        holder.dataset.page = String(number);
        holder.style.minHeight = '240px';
        holder.style.marginBottom = '16px';
        holder.textContent = `第 ${number} 页`;
        host.append(holder);
        if (this.observer) this.observer.observe(holder);
        else jobs.push(enqueue(holder, number));
      }
      await Promise.all(jobs);
    }

    close({restore = true} = {}) {
      const session = this.session;
      this.session = null;
      ++this.ticket;
      this.cleanup();
      this.nodes['preview-title'].textContent = '原报告预览';
      this.nodes['original-image'].alt = '所选原报告图片';
      this.nodes['preview-status'].textContent = '';
      this.nodes['preview-content'].setAttribute('aria-busy', 'false');
      if (this.dialog.open) this.dialog.close();
      if (restore && session) {
        if (session.active?.isConnected) session.active.focus({preventScroll: true});
        for (const [node, x, y] of session.scroll) { node.scrollLeft = x; node.scrollTop = y; }
        window.scrollTo({left: session.x, top: session.y, behavior: 'instant'});
        this.onClose?.();
      }
    }
  }
  window.ArchivePreview = ArchivePreview;
})();
