/* Maktabah - offline Islamic study library. All data lives in IndexedDB on this device. */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ============ IndexedDB ============ */
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('maktabah', 2);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('books', { keyPath: 'id' });     // {id,title,author,status,hasPdf,pageCount,tags,addedAt}
        d.createObjectStore('pdfText', { keyPath: 'bookId' }); // {bookId, pages:[string]}
        d.createObjectStore('pdfBlob', { keyPath: 'bookId' }); // {bookId, blob}
        d.createObjectStore('notes', { keyPath: 'id' });     // {id,title,body,updatedAt}
        d.createObjectStore('aqwal', { keyPath: 'id' });     // {id,type,text,source,memorize,addedAt}
      }
      if (e.oldVersion < 2) {
        d.createObjectStore('annots', { keyPath: 'key' });    // {key:"type:docId:page", docId, page, items:[]}
        d.createObjectStore('notebooks', { keyPath: 'id' });  // {id,title,template,bg,pageCount,addedAt}
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const put = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- toast & confirm dialog (replace native alert/confirm) ---------- */
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function appConfirm(msg, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    $('dialog-msg').textContent = msg;
    $('dialog-ok').textContent = okLabel;
    $('dialog').classList.remove('hidden');
    const done = (val) => {
      $('dialog').classList.add('hidden');
      $('dialog-ok').onclick = $('dialog-cancel').onclick = $('dialog').onclick = null;
      resolve(val);
    };
    $('dialog-ok').onclick = () => done(true);
    $('dialog-cancel').onclick = () => done(false);
    $('dialog').onclick = (e) => { if (e.target === $('dialog')) done(false); };
  });
}

/* Normalize for search: lowercase, strip Arabic diacritics/tatweel, unify alef and ya forms */
function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[ً-ْٰـۖ-ۭ]/g, '')
    .replace(/[آأإ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}
const isArabic = (s) => /[؀-ۿ]/.test(s || '');

/* ============ Tabs ============ */
const TITLES = { vault: 'Vault', library: 'Library', books: 'My Books', aqwal: 'Aqwal & Ahadith' };
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('view-' + tab.dataset.view).classList.add('active');
    $('topbar-title').textContent = TITLES[tab.dataset.view];
  });
});

/* ============ VAULT (notes) ============ */
let currentNoteId = null;

async function renderNotes() {
  const notes = (await getAll('notes')).sort((a, b) => b.updatedAt - a.updatedAt);
  const q = norm($('notes-filter').value);
  const shown = q ? notes.filter((n) => norm(n.title + ' ' + n.body).includes(q)) : notes;
  $('notes-empty').classList.toggle('hidden', notes.length > 0);
  $('notes-list').innerHTML = shown.map((n) => `
    <li class="card tappable" data-id="${n.id}">
      <div class="c-title">${esc(n.title || 'Untitled')}</div>
      <div class="c-sub">${esc(n.body.replace(/[#*\[\]]/g, '').slice(0, 80))}</div>
    </li>`).join('');
  $('notes-list').querySelectorAll('.card').forEach((c) =>
    c.addEventListener('click', () => openNote(c.dataset.id)));
}

async function openNote(id) {
  currentNoteId = id;
  const n = (await get('notes', id)) || { id, title: '', body: '' };
  $('note-title').value = n.title;
  $('note-body').value = n.body;
  $('notes-list-screen').classList.add('hidden');
  $('note-editor-screen').classList.remove('hidden');
  $('note-preview').classList.add('hidden');
  $('note-body').classList.remove('hidden');
  $('btn-note-preview').textContent = 'Preview';
}

async function saveCurrentNote() {
  if (!currentNoteId) return;
  const title = $('note-title').value.trim();
  const body = $('note-body').value;
  if (!title && !body) return;
  await put('notes', { id: currentNoteId, title, body, updatedAt: Date.now() });
}

function mdRender(src) {
  let h = esc(src);
  h = h.replace(/\[\[([^\]]+)\]\]/g, '<a class="wikilink" data-link="$1">$1</a>');
  h = h.replace(/^### (.*)$/gm, '<h3>$1</h3>')
       .replace(/^## (.*)$/gm, '<h2>$1</h2>')
       .replace(/^# (.*)$/gm, '<h1>$1</h1>')
       .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
       .replace(/\*([^*]+)\*/g, '<em>$1</em>')
       .replace(/^- (.*)$/gm, '<li>$1</li>');
  return h.split(/\n{2,}/).map((p) =>
    /^<(h\d|li)/.test(p.trim()) ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
}

$('btn-new-note').addEventListener('click', () => openNote(uid()));
$('btn-note-back').addEventListener('click', async () => {
  await saveCurrentNote();
  currentNoteId = null;
  $('note-editor-screen').classList.add('hidden');
  $('notes-list-screen').classList.remove('hidden');
  renderNotes();
});
$('btn-note-delete').addEventListener('click', async () => {
  if (currentNoteId && await appConfirm('Delete this note?', 'Delete')) {
    await del('notes', currentNoteId);
    currentNoteId = null;
    $('note-editor-screen').classList.add('hidden');
    $('notes-list-screen').classList.remove('hidden');
    renderNotes();
  }
});
$('btn-note-preview').addEventListener('click', async () => {
  const previewing = !$('note-preview').classList.contains('hidden');
  if (previewing) {
    $('note-preview').classList.add('hidden');
    $('note-body').classList.remove('hidden');
    $('btn-note-preview').textContent = 'Preview';
  } else {
    await saveCurrentNote();
    $('note-preview').innerHTML = mdRender($('note-body').value);
    $('note-preview').querySelectorAll('.wikilink').forEach((a) =>
      a.addEventListener('click', () => openNoteByTitle(a.dataset.link)));
    $('note-body').classList.add('hidden');
    $('note-preview').classList.remove('hidden');
    $('btn-note-preview').textContent = 'Edit';
  }
});
async function openNoteByTitle(title) {
  await saveCurrentNote();
  const notes = await getAll('notes');
  const found = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
  if (found) return openNote(found.id);
  const id = uid();
  await put('notes', { id, title, body: '', updatedAt: Date.now() });
  openNote(id);
}
$('notes-filter').addEventListener('input', renderNotes);
let autosave;
$('note-body').addEventListener('input', () => { clearTimeout(autosave); autosave = setTimeout(saveCurrentNote, 800); });
$('note-title').addEventListener('input', () => { clearTimeout(autosave); autosave = setTimeout(saveCurrentNote, 800); });

/* ============ LIBRARY: upload & extract ============ */
$('pdf-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) await ingestPdf(file);
  renderLibrary();
});

async function ingestPdf(file) {
  const prog = $('upload-progress');
  prog.classList.remove('hidden');
  prog.textContent = `Reading ${file.name}...`;
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.map((it) => it.str).join(' '));
      if (i % 10 === 0 || i === pdf.numPages)
        prog.textContent = `Extracting ${file.name}: page ${i} / ${pdf.numPages}`;
    }
    const id = uid();
    const title = file.name.replace(/\.pdf$/i, '');
    await put('books', { id, title, author: '', status: null, hasPdf: true, pageCount: pdf.numPages, addedAt: Date.now() });
    await put('pdfText', { bookId: id, pages });
    await put('pdfBlob', { bookId: id, blob: new Blob([buf], { type: 'application/pdf' }) });
    const extracted = pages.filter((p) => p.trim().length > 20).length;
    prog.textContent = extracted === 0
      ? `${title}: saved, but no text found (scanned images are not searchable)`
      : `${title}: saved, ${pdf.numPages} pages indexed. Alhamdulillah.`;
  } catch (err) {
    prog.textContent = `Could not read ${file.name}: ${err.message}`;
  }
}

/* ---------- subject tags ---------- */
const PRESET_TAGS = ['Aqeedah', 'Fiqh', 'Usul al-Fiqh', 'Hadith', 'Mustalah al-Hadith', 'Tafsir',
  'Uloom al-Quran', 'Seerah', 'Arabic', 'Tazkiyah', 'Adab', 'Tarikh', 'Fatawa'];
let libTagFilter = null;

function renderTagFilter(books) {
  const inUse = [...new Set(books.flatMap((b) => b.tags || []))];
  const bar = $('tag-filter');
  if (!inUse.length) { bar.classList.add('hidden'); libTagFilter = null; return; }
  if (libTagFilter && !inUse.includes(libTagFilter)) libTagFilter = null;
  bar.classList.remove('hidden');
  bar.innerHTML = ['All', ...inUse].map((t) =>
    `<button class="pill ${(t === 'All' ? !libTagFilter : libTagFilter === t) ? 'active' : ''}"
       data-tagf="${esc(t)}">${esc(t)}</button>`).join('');
  bar.querySelectorAll('[data-tagf]').forEach((p) =>
    p.addEventListener('click', () => {
      libTagFilter = p.dataset.tagf === 'All' ? null : p.dataset.tagf;
      renderLibrary();
    }));
}

function openTagSheet(bookId) {
  return new Promise(async (resolve) => {
    const book = await get('books', bookId);
    const sel = new Set(book.tags || []);
    const drawChips = () => {
      const all = [...new Set([...PRESET_TAGS, ...sel])];
      $('tagsheet-chips').innerHTML = all.map((t) =>
        `<button class="pill ${sel.has(t) ? 'active' : ''}" data-chip="${esc(t)}">${esc(t)}</button>`).join('');
      $('tagsheet-chips').querySelectorAll('[data-chip]').forEach((c) =>
        c.addEventListener('click', () => {
          sel.has(c.dataset.chip) ? sel.delete(c.dataset.chip) : sel.add(c.dataset.chip);
          drawChips();
        }));
    };
    drawChips();
    $('tag-custom').value = '';
    $('tagsheet').classList.remove('hidden');
    const addCustom = () => {
      const t = $('tag-custom').value.trim();
      if (t) { sel.add(t); $('tag-custom').value = ''; drawChips(); }
    };
    $('tag-add').onclick = addCustom;
    $('tag-custom').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } };
    $('tagsheet-done').onclick = async () => {
      book.tags = [...sel];
      await put('books', book);
      $('tagsheet').classList.add('hidden');
      $('tagsheet-done').onclick = $('tag-add').onclick = $('tag-custom').onkeydown = null;
      resolve();
    };
  });
}

async function renderLibrary() {
  const all = (await getAll('books')).filter((b) => b.hasPdf).sort((a, b) => b.addedAt - a.addedAt);
  renderTagFilter(all);
  const books = libTagFilter ? all.filter((b) => (b.tags || []).includes(libTagFilter)) : all;
  $('pdf-empty').classList.toggle('hidden', all.length > 0);
  $('pdf-list').innerHTML = books.map((b) => `
    <li class="card">
      <div class="c-title">${esc(b.title)}</div>
      <div class="c-sub">${b.pageCount} pages</div>
      ${(b.tags || []).length ? `<div class="c-tags">${b.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="c-actions">
        <button class="mini gold" data-open="${b.id}">Open</button>
        <button class="mini" data-tags="${b.id}">Tags</button>
        <button class="mini" data-track="${b.id}">Track in My Books</button>
        <button class="mini danger" data-delpdf="${b.id}">Delete</button>
      </div>
    </li>`).join('');
  $('pdf-list').querySelectorAll('[data-tags]').forEach((btn) =>
    btn.addEventListener('click', async () => { await openTagSheet(btn.dataset.tags); renderLibrary(); }));
  $('pdf-list').querySelectorAll('[data-open]').forEach((btn) =>
    btn.addEventListener('click', () => openViewer(btn.dataset.open, 1)));
  $('pdf-list').querySelectorAll('[data-track]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const b = await get('books', btn.dataset.track);
      if (!b.status) { b.status = 'ongoing'; await put('books', b); }
      renderBooks();
      toast(`"${b.title}" added to Currently studying`);
    }));
  $('pdf-list').querySelectorAll('[data-delpdf]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const b = await get('books', btn.dataset.delpdf);
      if (!await appConfirm(`Delete "${b.title}" and its indexed text?`, 'Delete')) return;
      await del('books', b.id); await del('pdfText', b.id); await del('pdfBlob', b.id);
      await purgeAnnots('pdf', b.id);
      renderLibrary(); renderBooks();
    }));
}

/* ============ SEARCH ============ */
let searchTimer;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
});

async function runSearch() {
  const raw = $('search-input').value.trim();
  const q = norm(raw);
  const results = $('search-results');
  if (q.length < 2) {
    results.classList.add('hidden');
    $('library-home').classList.remove('hidden');
    return;
  }
  $('library-home').classList.add('hidden');
  results.classList.remove('hidden');
  results.innerHTML = '<p class="empty">Searching...</p>';

  const [books, texts, notes, aqwal] = await Promise.all([
    getAll('books'), getAll('pdfText'), getAll('notes'), getAll('aqwal'),
  ]);
  const byId = Object.fromEntries(books.map((b) => [b.id, b]));

  const bookHits = [];
  for (const t of texts) {
    const book = byId[t.bookId];
    if (!book) continue;
    for (let p = 0; p < t.pages.length && bookHits.length < 200; p++) {
      const pageNorm = norm(t.pages[p]);
      const idx = pageNorm.indexOf(q);
      if (idx === -1) continue;
      bookHits.push({ book, page: p + 1, snippet: makeSnippet(pageNorm, idx, q.length) });
    }
  }
  const noteHits = notes.filter((n) => norm(n.title + '\n' + n.body).includes(q));
  const qawlHits = aqwal.filter((a) => norm(a.text + '\n' + (a.source || '')).includes(q));

  let html = '';
  if (bookHits.length) {
    html += `<div class="result-group"><h3>IN YOUR BOOKS (${bookHits.length})</h3>` +
      bookHits.slice(0, 60).map((h, i) => `
        <div class="card tappable" data-hit="${i}" style="margin-bottom:8px">
          <div class="c-title">${esc(h.book.title)} <span class="c-sub">p. ${h.page}</span></div>
          <div class="snippet" ${isArabic(h.snippet) ? 'dir="rtl"' : ''}>${h.snippet}</div>
        </div>`).join('') + '</div>';
  }
  if (noteHits.length) {
    html += `<div class="result-group"><h3>IN YOUR NOTES (${noteHits.length})</h3>` +
      noteHits.map((n) => `
        <div class="card tappable" data-note="${n.id}" style="margin-bottom:8px">
          <div class="c-title">${esc(n.title || 'Untitled')}</div>
          <div class="snippet">${esc(n.body.slice(0, 100))}</div>
        </div>`).join('') + '</div>';
  }
  if (qawlHits.length) {
    html += `<div class="result-group"><h3>IN AQWAL &amp; AHADITH (${qawlHits.length})</h3>` +
      qawlHits.map((a) => `
        <div class="card" style="margin-bottom:8px">
          <div class="qawl-text" ${isArabic(a.text) ? 'dir="rtl"' : ''}>${esc(a.text)}</div>
          ${a.source ? `<div class="c-sub">${esc(a.source)}</div>` : ''}
        </div>`).join('') + '</div>';
  }
  results.innerHTML = html || '<p class="empty">No results found.</p>';

  results.querySelectorAll('[data-hit]').forEach((c) => {
    const h = bookHits[+c.dataset.hit];
    c.addEventListener('click', () => openViewer(h.book.id, h.page));
  });
  results.querySelectorAll('[data-note]').forEach((c) =>
    c.addEventListener('click', () => {
      document.querySelector('.tab[data-view="vault"]').click();
      openNote(c.dataset.note);
    }));
}

function makeSnippet(text, idx, len) {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + len + 90);
  const before = esc(text.slice(start, idx));
  const match = esc(text.slice(idx, idx + len));
  const after = esc(text.slice(idx + len, end));
  return (start > 0 ? '&hellip;' : '') + before + '<mark>' + match + '</mark>' + after +
         (end < text.length ? '&hellip;' : '');
}

/* ============ BOOKS (statuses) ============ */
$('book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await put('books', {
    id: uid(),
    title: $('book-title').value.trim(),
    author: $('book-author').value.trim(),
    status: $('book-status').value,
    hasPdf: false, pageCount: 0, addedAt: Date.now(),
  });
  $('book-form').reset();
  renderBooks();
});

async function renderBooks() {
  const books = (await getAll('books')).filter((b) => b.status);
  for (const status of ['ongoing', 'completed', 'future']) {
    const list = books.filter((b) => b.status === status).sort((a, b) => b.addedAt - a.addedAt);
    const other = { ongoing: ['completed', 'future'], completed: ['ongoing', 'future'], future: ['ongoing', 'completed'] }[status];
    const label = { ongoing: 'Studying', completed: 'Completed', future: 'Future' };
    $('list-' + status).innerHTML = list.length ? list.map((b) => `
      <li class="card">
        <div class="c-title">${esc(b.title)}</div>
        ${b.author ? `<div class="c-sub">${esc(b.author)}</div>` : ''}
        <div class="c-actions">
          ${b.hasPdf ? `<button class="mini gold" data-open="${b.id}">Open PDF</button>` : ''}
          <button class="mini" data-move="${b.id}" data-to="${other[0]}">&rarr; ${label[other[0]]}</button>
          <button class="mini" data-move="${b.id}" data-to="${other[1]}">&rarr; ${label[other[1]]}</button>
          <button class="mini danger" data-delbook="${b.id}">Remove</button>
        </div>
      </li>`).join('') : '<li class="c-sub" style="padding:4px 2px 10px;color:var(--muted)">Empty</li>';
  }
  const view = $('view-books');
  view.querySelectorAll('[data-move]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const b = await get('books', btn.dataset.move);
      b.status = btn.dataset.to;
      await put('books', b);
      renderBooks();
    }));
  view.querySelectorAll('[data-open]').forEach((btn) =>
    btn.addEventListener('click', () => openViewer(btn.dataset.open, 1)));
  view.querySelectorAll('[data-delbook]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const b = await get('books', btn.dataset.delbook);
      if (b.hasPdf) { b.status = null; await put('books', b); } // keep the PDF in Library
      else if (await appConfirm(`Remove "${b.title}"?`, 'Remove')) await del('books', b.id);
      renderBooks();
    }));
}

/* ============ AQWAL ============ */
let qawlFilter = 'all';
$('qawl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await put('aqwal', {
    id: uid(),
    type: $('qawl-type').value,
    text: $('qawl-text').value.trim(),
    source: $('qawl-source').value.trim(),
    memorize: $('qawl-memorize').checked,
    addedAt: Date.now(),
  });
  $('qawl-form').reset();
  renderAqwal();
});
document.querySelectorAll('[data-qfilter]').forEach((p) =>
  p.addEventListener('click', () => {
    qawlFilter = p.dataset.qfilter;
    document.querySelectorAll('[data-qfilter]').forEach((x) => x.classList.toggle('active', x === p));
    renderAqwal();
  }));

const TYPE_LABEL = { hadith: 'Hadith', qawl: 'Qawl of the Salaf', ayah: 'Ayah', other: 'Other' };
async function renderAqwal() {
  let items = (await getAll('aqwal')).sort((a, b) => b.addedAt - a.addedAt);
  if (qawlFilter === 'memorize') items = items.filter((a) => a.memorize);
  else if (qawlFilter !== 'all') items = items.filter((a) => a.type === qawlFilter);
  $('qawl-empty').classList.toggle('hidden', items.length > 0);
  $('qawl-list').innerHTML = items.map((a) => `
    <li class="card">
      <div class="qawl-text" ${isArabic(a.text) ? 'dir="rtl"' : ''}>${esc(a.text)}</div>
      <div class="c-sub" style="margin-top:8px">
        <span class="badge">${TYPE_LABEL[a.type] || a.type}</span>
        ${a.memorize ? '<span class="badge mem">To memorize</span>' : ''}
        ${a.source ? esc(a.source) : ''}
      </div>
      <div class="c-actions">
        <button class="mini" data-qmem="${a.id}">${a.memorize ? 'Unmark memorize' : 'Mark memorize'}</button>
        <button class="mini danger" data-qdel="${a.id}">Delete</button>
      </div>
    </li>`).join('');
  $('qawl-list').querySelectorAll('[data-qmem]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const a = await get('aqwal', btn.dataset.qmem);
      a.memorize = !a.memorize;
      await put('aqwal', a);
      renderAqwal();
    }));
  $('qawl-list').querySelectorAll('[data-qdel]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (await appConfirm('Delete this entry?', 'Delete')) { await del('aqwal', btn.dataset.qdel); renderAqwal(); }
    }));
}

/* ============ VIEWER & ANNOTATION ENGINE ============ */
const PEN_COLORS = ['#1a1a1a', '#c62828', '#1565c0', '#2e7d32', '#c9a227'];
const HL_COLORS = ['#ffe838', '#8be34a', '#ff8fc0', '#53ccff', '#ffb340'];
let vDoc = null, vPage = 1, vTool = 'pan', vItems = [], vUrl = null;
let penColor = PEN_COLORS[0], hlColor = HL_COLORS[0];
let pageW = 1, pageH = 1;
const dpr = () => window.devicePixelRatio || 1;
const vKey = (p) => `${vDoc.type}:${vDoc.id}:${p}`;
const imgCache = new Map();

async function openViewer(bookId, page) {
  const [book, rec] = await Promise.all([get('books', bookId), get('pdfBlob', bookId)]);
  if (!rec) { toast('PDF not found on this device'); return; }
  if (vUrl) URL.revokeObjectURL(vUrl);
  vUrl = URL.createObjectURL(rec.blob);
  const pdf = await pdfjsLib.getDocument(vUrl).promise;
  vDoc = { type: 'pdf', id: bookId, title: book.title, pageCount: pdf.numPages, pdf };
  showViewer(page);
}

async function openNotebook(nbId, page = 1) {
  const nb = await get('notebooks', nbId);
  if (!nb) { toast('Notebook not found'); return; }
  vDoc = { type: 'nb', id: nbId, title: nb.title, pageCount: nb.pageCount, nb };
  showViewer(page);
}

function showViewer(page) {
  $('viewer-title').textContent = vDoc.title;
  $('viewer-total').textContent = '/ ' + vDoc.pageCount;
  $('viewer-page').max = vDoc.pageCount;
  $('nb-addpage').classList.toggle('hidden', vDoc.type !== 'nb');
  setTool('pan');
  $('viewer').classList.remove('hidden');
  renderViewerPage(page);
}

function drawTemplate(ctx, w, h) {
  const nb = vDoc.nb;
  ctx.fillStyle = nb.bg || '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(40, 60, 120, .16)';
  ctx.lineWidth = Math.max(1, dpr() * .8);
  if (nb.template === 'ruled') {
    const gap = h / 26;
    for (let y = gap * 2; y < h - gap / 2; y += gap) {
      ctx.beginPath(); ctx.moveTo(w * .04, y); ctx.lineTo(w * .96, y); ctx.stroke();
    }
  } else if (nb.template === 'grid') {
    const gap = w / 18;
    for (let x = gap; x < w; x += gap) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = gap; y < h; y += gap) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }
}

let renderSeq = 0;
async function renderViewerPage(num) {
  if (!vDoc) return;
  const seq = ++renderSeq;
  vPage = Math.min(Math.max(1, num), vDoc.pageCount);
  $('viewer-page').value = vPage;
  const canvas = $('viewer-canvas'), overlay = $('annot-canvas');
  const cssW = Math.min($('viewer').clientWidth - 20, 700);
  let cssH;
  if (vDoc.type === 'pdf') {
    const page = await vDoc.pdf.getPage(vPage);
    if (seq !== renderSeq) return;
    const base = page.getViewport({ scale: 1 });
    cssH = (base.height / base.width) * cssW;
    const vp = page.getViewport({ scale: (cssW / base.width) * dpr() });
    canvas.width = vp.width; canvas.height = vp.height;
    sizeCanvases(cssW, cssH, overlay);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } else {
    cssH = cssW * 1.414;
    canvas.width = cssW * dpr(); canvas.height = cssH * dpr();
    sizeCanvases(cssW, cssH, overlay);
    drawTemplate(canvas.getContext('2d'), canvas.width, canvas.height);
  }
  if (seq !== renderSeq) return;
  pageW = cssW; pageH = cssH;
  const rec = await get('annots', vKey(vPage));
  if (seq !== renderSeq) return;
  vItems = rec ? rec.items : [];
  drawAnnots();
}
function sizeCanvases(cssW, cssH, overlay) {
  const canvas = $('viewer-canvas');
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  overlay.width = cssW * dpr(); overlay.height = cssH * dpr();
  overlay.style.width = cssW + 'px'; overlay.style.height = cssH + 'px';
  $('page-wrap').style.width = cssW + 'px';
}

function strokePath(ctx, it) {
  ctx.globalAlpha = it.mode === 'hl' ? .38 : 1;
  ctx.strokeStyle = it.color;
  ctx.lineWidth = it.w * pageW * dpr();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  it.pts.forEach(([x, y], i) => {
    const px = x * pageW * dpr(), py = y * pageH * dpr();
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  if (it.pts.length === 1) ctx.lineTo(it.pts[0][0] * pageW * dpr() + .1, it.pts[0][1] * pageH * dpr());
  ctx.stroke();
  ctx.globalAlpha = 1;
}
function drawAnnots() {
  const ctx = $('annot-canvas').getContext('2d');
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const it of vItems) {
    if (it.kind === 'stroke') strokePath(ctx, it);
    else if (it.kind === 'img') {
      let im = imgCache.get(it.b64);
      if (!im) {
        im = new Image();
        im.onload = () => drawAnnots();
        im.src = it.b64;
        imgCache.set(it.b64, im);
      }
      if (im.complete && im.naturalWidth) {
        ctx.drawImage(im, it.x * pageW * dpr(), it.y * pageH * dpr(), it.w * pageW * dpr(), it.h * pageH * dpr());
      }
    }
  }
}

let saveTimer;
function saveAnnots() {
  clearTimeout(saveTimer);
  const key = vKey(vPage), items = vItems;
  saveTimer = setTimeout(() => put('annots', { key, docId: vDoc.id, page: vPage, items }), 350);
}

/* ---- stylus-only mode (finger scrolls, pen edits) ---- */
let stylusOnly = localStorage.getItem('mk-stylus') === '1';
function updateStylusBtn() {
  $('tool-stylus').classList.toggle('active', stylusOnly);
}
$('tool-stylus').addEventListener('click', () => {
  stylusOnly = !stylusOnly;
  localStorage.setItem('mk-stylus', stylusOnly ? '1' : '0');
  updateStylusBtn();
  setTool(vTool);
  toast(stylusOnly ? 'Stylus only: pen edits, finger scrolls' : 'Finger drawing enabled');
});
const isBlockedTouch = (e) => stylusOnly && e.pointerType === 'touch';
function autoDetectStylus(e) {
  if (e.pointerType === 'pen' && !stylusOnly && localStorage.getItem('mk-stylus') === null) {
    stylusOnly = true;
    localStorage.setItem('mk-stylus', '1');
    updateStylusBtn();
    setTool(vTool);
    toast('Stylus detected: pen edits, finger scrolls');
  }
}

/* ---- tools ---- */
function setTool(t) {
  vTool = t;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('annot-canvas').style.pointerEvents = t === 'pan' ? 'none' : 'auto';
  $('annot-canvas').style.touchAction = (t === 'pan' || stylusOnly) ? 'auto' : 'none';
  updateStylusBtn();
  const pal = $('palette');
  if (t === 'pen' || t === 'hl') {
    const colors = t === 'pen' ? PEN_COLORS : HL_COLORS;
    const cur = t === 'pen' ? penColor : hlColor;
    pal.innerHTML = colors.map((c) =>
      `<button class="dot ${c === cur ? 'active' : ''}" style="background:${c}" data-c="${c}"></button>`).join('');
    pal.querySelectorAll('.dot').forEach((d) => d.addEventListener('click', () => {
      if (t === 'pen') penColor = d.dataset.c; else hlColor = d.dataset.c;
      setTool(t);
    }));
  } else pal.innerHTML = '';
}
document.querySelectorAll('.tool[data-tool]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.tool === 'img') $('img-input').click();
    setTool(b.dataset.tool);
  }));
$('tool-undo').addEventListener('click', () => {
  if (vItems.length) { vItems.pop(); drawAnnots(); saveAnnots(); }
});

/* ---- pointer drawing ---- */
let curStroke = null, dragImg = null, dragMode = null, dragStart = null;
const annotEl = () => $('annot-canvas');
function normPos(e) {
  const r = annotEl().getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}
function hitImage(nx, ny) {
  for (let i = vItems.length - 1; i >= 0; i--) {
    const it = vItems[i];
    if (it.kind !== 'img') continue;
    if (nx >= it.x && nx <= it.x + it.w && ny >= it.y && ny <= it.y + it.h) return it;
  }
  return null;
}
function eraseAt(nx, ny) {
  const rPx = 16;
  const before = vItems.length;
  vItems = vItems.filter((it) => {
    if (it.kind === 'stroke') {
      return !it.pts.some(([x, y]) => Math.hypot((x - nx) * pageW, (y - ny) * pageH) < rPx);
    }
    return !(nx >= it.x && nx <= it.x + it.w && ny >= it.y && ny <= it.y + it.h);
  });
  if (vItems.length !== before) { drawAnnots(); saveAnnots(); }
}

document.addEventListener('DOMContentLoaded', () => {
  const el = annotEl();
  el.addEventListener('pointerdown', (e) => {
    if (vTool === 'pan') return;
    autoDetectStylus(e);
    if (isBlockedTouch(e)) return;   // finger only scrolls in stylus mode
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const [nx, ny] = normPos(e);
    if (vTool === 'pen' || vTool === 'hl') {
      curStroke = {
        kind: 'stroke', mode: vTool,
        color: vTool === 'pen' ? penColor : hlColor,
        w: vTool === 'pen' ? .005 : .024,
        pts: [[nx, ny]],
      };
    } else if (vTool === 'erase') {
      eraseAt(nx, ny);
    } else if (vTool === 'img') {
      const it = hitImage(nx, ny);
      if (it) {
        const nearCorner = Math.hypot((nx - it.x - it.w) * pageW, (ny - it.y - it.h) * pageH) < 26;
        dragImg = it; dragMode = nearCorner ? 'resize' : 'move'; dragStart = [nx, ny, it.x, it.y, it.w, it.h];
      }
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (vTool === 'pan' || isBlockedTouch(e)) return;
    const [nx, ny] = normPos(e);
    if (curStroke) {
      const last = curStroke.pts[curStroke.pts.length - 1];
      curStroke.pts.push([nx, ny]);
      const ctx = el.getContext('2d');
      ctx.globalAlpha = curStroke.mode === 'hl' ? .38 : 1;
      ctx.strokeStyle = curStroke.color;
      ctx.lineWidth = curStroke.w * pageW * dpr();
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(last[0] * pageW * dpr(), last[1] * pageH * dpr());
      ctx.lineTo(nx * pageW * dpr(), ny * pageH * dpr());
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (vTool === 'erase' && e.buttons) {
      eraseAt(nx, ny);
    } else if (dragImg) {
      const [sx, sy, ox, oy, ow, oh] = dragStart;
      if (dragMode === 'move') { dragImg.x = ox + nx - sx; dragImg.y = oy + ny - sy; }
      else {
        dragImg.w = Math.max(.05, ow + nx - sx);
        dragImg.h = Math.max(.05, oh + ny - sy);
      }
      drawAnnots();
    }
  });
  const finish = () => {
    if (curStroke) {
      if (curStroke.pts.length > 1) { vItems.push(curStroke); saveAnnots(); }
      curStroke = null;
      drawAnnots();
    }
    if (dragImg) { saveAnnots(); dragImg = null; dragMode = null; }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
});

/* ---- image insert ---- */
$('img-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !vDoc) return;
  const b64 = await new Promise((res) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file);
  });
  const im = new Image();
  im.onload = () => {
    const w = .5;
    const h = (im.naturalHeight / im.naturalWidth) * (w * pageW) / pageH;
    vItems.push({ kind: 'img', b64, x: .25, y: .15, w, h });
    imgCache.set(b64, im);
    drawAnnots();
    saveAnnots();
    toast('Image added. Drag to move, drag its corner to resize');
  };
  im.src = b64;
});

/* ---- viewer chrome ---- */
$('viewer-close').addEventListener('click', () => {
  $('viewer').classList.add('hidden');
  if (vDoc && vDoc.pdf) vDoc.pdf.destroy();
  if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; }
  vDoc = null; vItems = [];
});
$('viewer-prev').addEventListener('click', () => renderViewerPage(vPage - 1));
$('viewer-next').addEventListener('click', () => renderViewerPage(vPage + 1));
$('viewer-page').addEventListener('change', () => renderViewerPage(+$('viewer-page').value));
$('nb-addpage').addEventListener('click', async () => {
  if (!vDoc || vDoc.type !== 'nb') return;
  vDoc.nb.pageCount++;
  vDoc.pageCount = vDoc.nb.pageCount;
  await put('notebooks', vDoc.nb);
  $('viewer-total').textContent = '/ ' + vDoc.pageCount;
  $('viewer-page').max = vDoc.pageCount;
  renderViewerPage(vDoc.pageCount);
  renderNotebooks();
});

/* ============ NOTEBOOKS ============ */
async function purgeAnnots(type, docId) {
  const all = await getAll('annots');
  for (const a of all) if (a.key.startsWith(type + ':' + docId + ':')) await del('annots', a.key);
}

async function renderNotebooks() {
  const nbs = (await getAll('notebooks')).sort((a, b) => b.addedAt - a.addedAt);
  $('nb-section').classList.toggle('hidden', !nbs.length);
  $('nb-list').innerHTML = nbs.map((n) => `
    <li class="card">
      <div class="c-title">${esc(n.title)}</div>
      <div class="c-sub">${n.pageCount} ${n.pageCount === 1 ? 'page' : 'pages'} &middot; ${n.template}</div>
      <div class="c-actions">
        <button class="mini gold" data-nbopen="${n.id}">Open</button>
        <button class="mini danger" data-nbdel="${n.id}">Delete</button>
      </div>
    </li>`).join('');
  $('nb-list').querySelectorAll('[data-nbopen]').forEach((btn) =>
    btn.addEventListener('click', () => openNotebook(btn.dataset.nbopen)));
  $('nb-list').querySelectorAll('[data-nbdel]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const n = await get('notebooks', btn.dataset.nbdel);
      if (!await appConfirm(`Delete notebook "${n.title}" and everything written in it?`, 'Delete')) return;
      await del('notebooks', n.id);
      await purgeAnnots('nb', n.id);
      renderNotebooks();
    }));
}

let nbTpl = 'plain', nbBg = '#ffffff';
$('btn-new-nb').addEventListener('click', () => {
  $('nb-title').value = '';
  $('nbsheet').classList.remove('hidden');
});
$('nb-cancel').addEventListener('click', () => $('nbsheet').classList.add('hidden'));
document.querySelectorAll('#nb-template [data-tpl]').forEach((p) =>
  p.addEventListener('click', () => {
    nbTpl = p.dataset.tpl;
    document.querySelectorAll('#nb-template [data-tpl]').forEach((x) => x.classList.toggle('active', x === p));
  }));
document.querySelectorAll('#nb-bg [data-bg]').forEach((s) =>
  s.addEventListener('click', () => {
    nbBg = s.dataset.bg;
    document.querySelectorAll('#nb-bg [data-bg]').forEach((x) => x.classList.toggle('active', x === s));
  }));
$('nb-create').addEventListener('click', async () => {
  const title = $('nb-title').value.trim() || 'Untitled notebook';
  const nb = { id: uid(), title, template: nbTpl, bg: nbBg, pageCount: 1, addedAt: Date.now() };
  await put('notebooks', nb);
  $('nbsheet').classList.add('hidden');
  renderNotebooks();
  openNotebook(nb.id);
});

/* ============ BACKUP ============ */
const blobToB64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});
function b64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
}
const backupStatus = (msg) => { $('backup-status').textContent = msg; };

$('btn-export').addEventListener('click', async () => {
  try {
    backupStatus('Preparing backup...');
    const [books, texts, notes, aqwal, blobs, annots, notebooks] = await Promise.all([
      getAll('books'), getAll('pdfText'), getAll('notes'), getAll('aqwal'), getAll('pdfBlob'),
      getAll('annots'), getAll('notebooks'),
    ]);
    const pdfs = [];
    for (let i = 0; i < blobs.length; i++) {
      backupStatus(`Packing PDF ${i + 1} / ${blobs.length}...`);
      pdfs.push({ bookId: blobs[i].bookId, b64: await blobToB64(blobs[i].blob) });
    }
    const payload = JSON.stringify({ app: 'maktabah', version: 2, exportedAt: new Date().toISOString(), books, texts, notes, aqwal, pdfs, annots, notebooks });
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'maktabah-backup-' + new Date().toISOString().slice(0, 10) + '.mktbh';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    backupStatus(`Backup exported: ${books.length} book records, ${pdfs.length} PDFs, ${notes.length} notes, ${aqwal.length} aqwal. Keep the file somewhere safe.`);
  } catch (err) {
    backupStatus('Export failed: ' + err.message);
  }
});

$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    backupStatus('Reading backup file...');
    const data = JSON.parse(await file.text());
    if (data.app !== 'maktabah') throw new Error('not a Maktabah backup file');
    if (!await appConfirm(`Restore backup from ${(data.exportedAt || '').slice(0, 10)}? Existing items are kept; matching items are overwritten.`, 'Restore')) {
      backupStatus('Restore cancelled.'); return;
    }
    for (const b of data.books || []) await put('books', b);
    for (const t of data.texts || []) await put('pdfText', t);
    for (const n of data.notes || []) await put('notes', n);
    for (const a of data.aqwal || []) await put('aqwal', a);
    for (const an of data.annots || []) await put('annots', an);
    for (const nb of data.notebooks || []) await put('notebooks', nb);
    const pdfs = data.pdfs || [];
    for (let i = 0; i < pdfs.length; i++) {
      backupStatus(`Restoring PDF ${i + 1} / ${pdfs.length}...`);
      await put('pdfBlob', { bookId: pdfs[i].bookId, blob: b64ToBlob(pdfs[i].b64) });
    }
    renderNotes(); renderLibrary(); renderBooks(); renderAqwal(); renderNotebooks();
    backupStatus('Backup restored, alhamdulillah.');
  } catch (err) {
    backupStatus('Restore failed: ' + err.message);
  }
});

/* ---------- PDFs shared in from other apps (Web Share Target) ---------- */
async function drainSharedPdfs() {
  try {
    const sdb = await new Promise((res, rej) => {
      const r = indexedDB.open('mk-share', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files', { autoIncrement: true });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const files = await new Promise((res, rej) => {
      const tx = sdb.transaction('files', 'readwrite');
      const req = tx.objectStore('files').getAll();
      req.onsuccess = () => { tx.objectStore('files').clear(); res(req.result || []); };
      tx.onerror = () => rej(tx.error);
    });
    if (!files.length) return;
    document.querySelector('.tab[data-view="library"]').click();
    for (const f of files) await ingestPdf(f);
    renderLibrary();
    if (location.search.includes('shared=1'))
      history.replaceState(null, '', location.pathname);
  } catch (err) { /* share inbox unavailable on this browser; normal upload still works */ }
}

/* ============ boot ============ */
(async () => {
  db = await openDB();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  renderNotes();
  renderLibrary();
  renderBooks();
  renderAqwal();
  renderNotebooks();
  drainSharedPdfs();
})();
