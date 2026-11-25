/* static-shim.js — cho bản tĩnh (GitHub Pages, không có máy chủ).
 * Cung cấp window.claude.use("db" | "sample" | "assets") giống claude.ai:
 *  - db: lưu trong IndexedDB của trình duyệt (mỗi máy / trình duyệt một sổ riêng)
 *  - sample: gọi thẳng Claude API bằng API key người dùng tự nhập (chỉ lưu trong trình duyệt này)
 *  - assets: ảnh gốc thu nhỏ, lưu dạng data URL ngay trong job
 * Có nút "Cài đặt" để nhập key, sao lưu / khôi phục dữ liệu ra file JSON. */
(function () {
  "use strict";
  if (window.claude && window.claude.use) return;
  window.SOJOB_BLOB_BASE = ""; // id ảnh chính là data URL

  const KEY_LS = "sojob.anthropicKey";
  const MODEL = "claude-opus-5-5";
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const onReady = fn => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn();
  const getKey = () => { try { return localStorage.getItem(KEY_LS) || ""; } catch (e) { return ""; } };

  /* ---------- IndexedDB ---------- */
  const idb = new Promise((res, rej) => {
    const r = indexedDB.open("sojob", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("docs");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  async function tx(mode, fn) {
    const d = await idb;
    return new Promise((res, rej) => {
      const t = d.transaction("docs", mode), s = t.objectStore("docs");
      const out = fn(s);
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("Giao dịch bị huỷ"));
    });
  }
  async function allDocs() {
    const d = await idb;
    return new Promise((res, rej) => {
      const out = [], c = d.transaction("docs").objectStore("docs").openCursor();
      c.onsuccess = () => { const k = c.result; if (!k) return res(out); out.push([k.key, k.value]); k.continue(); };
      c.onerror = () => rej(c.error);
    });
  }

  /* ---------- db: giả lập kiểu Firestore ---------- */
  const cols = {};
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("sojob") : null;
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const loaded = allDocs().then(rows => {
    for (const [k, v] of rows) { const i = k.lastIndexOf("/"); colState(k.slice(0, i)).docs.set(k.slice(i + 1), v); }
  });
  function colState(name) { return cols[name] || (cols[name] = { docs: new Map(), listeners: new Set() }); }
  const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => clone(data), metadata: { fromCache: false, hasPendingWrites: false } });
  function buildSnap(st) {
    const docs = [...st.docs.keys()].sort().map(id => docSnap(id, st.docs.get(id)));
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false },
      docChanges: () => docs.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i })) };
  }
  function emit(st) { const s = buildSnap(st); st.listeners.forEach(l => { try { l.next(s); } catch (e) { console.error(e); } }); }
  // Tab khác cùng trình duyệt sửa dữ liệu: cập nhật theo
  if (bc) bc.onmessage = ev => {
    const { col, id, data } = ev.data || {}; if (!col) return;
    const st = colState(col);
    data === null ? st.docs.delete(id) : st.docs.set(id, data);
    emit(st);
  };
  const wrapErr = e => ({ code: e && e.name === "QuotaExceededError" ? "quota_exceeded" : "unavailable", message: "Không lưu được vào trình duyệt: " + (e && e.message || e) });

  function docRef(col, id) {
    const st = colState(col), k = col + "/" + id;
    return {
      id, path: k,
      async set(data) {
        await loaded;
        const v = clone(data);
        st.docs.set(id, v); emit(st);
        await tx("readwrite", s => { s.put(v, k); }).catch(e => { throw wrapErr(e); });
        bc && bc.postMessage({ col, id, data: v });
      },
      async update(data) {
        await loaded;
        if (!st.docs.has(id)) throw { code: "invalid_argument", message: "Tài liệu không tồn tại." };
        return this.set(Object.assign({}, st.docs.get(id), clone(data)));
      },
      async delete() {
        await loaded;
        st.docs.delete(id); emit(st);
        await tx("readwrite", s => { s.delete(k); }).catch(e => { throw wrapErr(e); });
        bc && bc.postMessage({ col, id, data: null });
      },
      async get() { await loaded; return docSnap(id, st.docs.get(id)); },
      onSnapshot(next, error) {
        const l = { next: () => next(docSnap(id, st.docs.get(id))), error };
        st.listeners.add(l);
        loaded.then(() => st.listeners.has(l) && l.next(), e => error && error({ code: "unavailable", message: String(e) }));
        return () => st.listeners.delete(l);
      },
      collection: name => colRef(k + "/" + name),
    };
  }
  function colRef(name, filt) {
    const st = colState(name);
    const pick = s => { if (!filt) return s; const docs = s.docs.filter(d => { const v = d.data(); return v && v[filt[0]] === filt[1]; }); return Object.assign({}, s, { docs, size: docs.length, empty: !docs.length }); };
    return {
      path: name,
      where: (f, op, v) => colRef(name, [f, v]),
      orderBy: () => colRef(name, filt),
      limit: () => colRef(name, filt),
      doc: id => docRef(name, id || rid()),
      async add(data) { const r = docRef(name, rid()); await r.set(data); return r; },
      async get() { await loaded; return pick(buildSnap(st)); },
      onSnapshot(next0, error) {
        const next = s => next0(pick(s));
        const l = { next, error };
        st.listeners.add(l);
        loaded.then(() => st.listeners.has(l) && next(buildSnap(st)), e => error && error({ code: "unavailable", message: String(e) }));
        return () => st.listeners.delete(l);
      },
    };
  }
  const db = {
    collection: p => colRef(p),
    doc(p) { const i = p.lastIndexOf("/"); return docRef(p.slice(0, i), p.slice(i + 1)); },
  };

  /* ---------- ảnh ---------- */
  async function shrink(blob, maxSide, quality) {
    try {
      if (!blob || !/^image\/(jpeg|png|webp)$/.test(blob.type) || typeof createImageBitmap !== "function") return blob;
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      if (k === 1 && blob.size < 1.5e6) { bmp.close && bmp.close(); return blob; }
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return (await new Promise(r => c.toBlob(r, "image/jpeg", quality))) || blob;
    } catch (e) { return blob; }
  }
  const toDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
  const asList = v => !v ? [] : (v instanceof Blob ? [v] : Array.from(v));

  /* ---------- sample: gọi Claude API trực tiếp ---------- */
  function parseLoose(text) {
    const t = String(text || "").trim();
    try { return JSON.parse(t); } catch (e) {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (f) { try { return JSON.parse(f[1]); } catch (e) {} }
    const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    throw { code: "invalid_json", message: "Câu trả lời không phải JSON.", text: t };
  }
  async function sample(input, opts) {
    opts = opts || {};
    const key = getKey();
    if (!key && FB && fuser) return sampleServer(input, opts); // không có key Claude: dùng AI miễn phí (Gemini) qua máy chủ của sổ
    if (!key) throw { code: "sampling_disabled", message: "Chưa có API key Claude. Bấm “Đọc chữ (miễn phí)” để đọc chữ trong ảnh không cần key, hoặc nhập key trong “Cài đặt” để Claude tự tách thông tin." };
    const prompt = typeof input === "string" ? input : (input || []).map(m => m.content).join("\n\n");
    const content = [];
    for (const doc of asList(opts.documents).slice(0, 5)) { // PDF: gửi nguyên văn cho Claude đọc
      const url = await toDataURL(doc);
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: url.slice(url.indexOf(",") + 1) } });
    }
    for (const img of asList(opts.images).slice(0, Math.min(opts.maxImages || 5, 12))) {
      const b = await shrink(img, 2000, 0.88);
      const url = await toDataURL(b);
      content.push({ type: "image", source: { type: "base64", media_type: b.type || "image/jpeg", data: url.slice(url.indexOf(",") + 1) } });
    }
    content.push({ type: "text", text: prompt });
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: opts.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 16000, messages: [{ role: "user", content }],
          output_config: { effort: "medium" }, fallbacks: "default" }),
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw { code: "cancelled", message: "Đã dừng." };
      throw { code: "unavailable", message: "Không kết nối được tới Claude API. Kiểm tra mạng rồi thử lại." };
    }
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const m = j && j.error && j.error.message || "";
      if (r.status === 401 || r.status === 403) throw { code: "sampling_disabled", message: "API key Claude không hợp lệ hoặc không có quyền. Bấm “Cài đặt” để nhập lại." };
      if (r.status === 429) throw { code: "rate_limited", message: "Tài khoản API chạm giới hạn hoặc hết tiền. Thử lại sau, hoặc nạp thêm ở console.anthropic.com." };
      if (r.status === 529 || r.status === 503) throw { code: "rate_limited", message: "Claude đang quá tải. Thử lại sau ít phút." };
      if (r.status === 400) throw { code: "invalid_request", message: "Claude không nhận yêu cầu: " + m };
      throw { code: "upstream_error", message: "Lỗi từ Claude API (" + r.status + "). Thử lại." };
    }
    if (j.stop_reason === "refusal") throw { code: "refused", message: "Claude không xử lý được nội dung này." };
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (!text.trim()) throw { code: "empty_completion", message: "Claude không trả về nội dung." };
    if (typeof opts.onText === "function") { try { opts.onText({ text, delta: text }); } catch (e) {} }
    return { text, truncated: j.stop_reason === "max_tokens", modelTierApplied: "default" };
  }
  /* AI miễn phí: máy chủ Apps Script của sổ gọi Google Gemini (key giấu ở máy chủ), chỉ thành viên sổ dùng được */
  const AI_URL = "https://script.google.com/macros/s/AKfycbybwZjSrdEh0xrt0MFKtbwh6dEfCCJuldpqVrQSAgP4e14RwZZs04FB_fPUZ7vKRFP2XQ/exec";
  async function sampleServer(input, opts) {
    opts = opts || {};
    const prompt = typeof input === "string" ? input : (input || []).map(m => m.content).join("\n\n");
    const files = [];
    for (const doc of asList(opts.documents).slice(0, 3)) { const u = await toDataURL(doc); files.push({ mime: "application/pdf", data: u.slice(u.indexOf(",") + 1) }); }
    for (const img of asList(opts.images).slice(0, Math.min(opts.maxImages || 5, 8))) { const b = await shrink(img, 1600, 0.85); const u = await toDataURL(b); files.push({ mime: b.type || "image/jpeg", data: u.slice(u.indexOf(",") + 1) }); }
    let token = ""; try { token = await window.firebase.auth().currentUser.getIdToken(); } catch (e) {}
    let r, j = null;
    try { r = await fetch(AI_URL, { method: "POST", signal: opts.signal, headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ ai: { prompt, files, json: !!opts.json }, token }) }); j = await r.json(); }
    catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled", message: "Đã dừng." }; throw { code: "unavailable", message: "Không kết nối được máy chủ AI. Kiểm tra mạng rồi thử lại." }; }
    if (!j || !j.ok) throw { code: (j && j.code) || "upstream_error", message: (j && j.msg) || "AI chưa trả lời được. Thử lại sau." };
    if (typeof opts.onText === "function") { try { opts.onText({ text: j.text, delta: j.text }); } catch (e) {} }
    return { text: j.text, truncated: !!j.truncated, modelTierApplied: "gemini" };
  }
  sample.json = async (input, opts) => {
    const r = await sample(input, Object.assign({}, opts, { json: true }));
    if (r.truncated) throw { code: "invalid_json", message: "Câu trả lời bị cắt ngắn.", text: r.text };
    return parseLoose(r.text);
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 10 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"] } });

  /* ---------- assets: ảnh gốc thu nhỏ, lưu thẳng trong job ---------- */
  /* Nén ảnh chụp màn hình nhỏ nhất mà chữ vẫn đọc được: rộng tối đa 1000px (ảnh dài thì cao tối đa 4000px),
   * WebP (Safari cũ không có thì JPEG), giảm chất lượng dần cho tới khi dưới ~120 KB. */
  async function compactForStore(blob) {
    try {
      if (!blob || !/^image\//.test(blob.type) || typeof createImageBitmap !== "function") return blob;
      const bmp = await createImageBitmap(blob);
      const W = bmp.width, H = bmp.height, TARGET = 120 * 1024;
      let k = Math.min(1, 1000 / W, 4000 / H), out = null;
      for (let round = 0; round < 3; round++) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
        for (const q of [0.6, 0.48, 0.38]) {
          let b = await new Promise(r => c.toBlob(r, "image/webp", q));
          if (!b || b.type !== "image/webp") b = await new Promise(r => c.toBlob(r, "image/jpeg", q + 0.05));
          if (b) out = b;
          if (b && b.size <= TARGET) { bmp.close && bmp.close(); return b; }
        }
        k *= 0.8; // vẫn nặng: thu nhỏ thêm một chút
      }
      bmp.close && bmp.close();
      return out && out.size < blob.size ? out : blob;
    } catch (e) { return blob; }
  }
  const assets = {
    async upload(blob) {
      const b = await compactForStore(blob);
      const url = await toDataURL(b);
      return { id: url, url, sizeBytes: b.size, contentType: b.type };
    },
    async list() { return { assets: [], usage: {} }; },
    async delete() { throw { code: "not_supported", message: "Chưa hỗ trợ xoá ảnh." }; },
  };

  /* ---------- Cài đặt: API key, sao lưu, khôi phục ---------- */
  function overlay(html) {
    const d = document.createElement("div");
    d.className = "modal";
    d.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(d);
    return d;
  }
  let settingsOpen = false;
  function openSettings(reason) {
    if (settingsOpen) return; settingsOpen = true;
    const k = getKey(), showKey = !FB || !!k || reason === "nokey"; // bản online đã có AI miễn phí qua máy chủ: chỉ hiện ô key Claude khi còn key cũ (để xoá) hoặc bản thử
    const d = overlay(`<h2>Cài đặt</h2>
      ${reason === "nokey" ? `<div class="banner">Muốn Claude đọc ảnh thì cần API key Claude của bạn (tính phí theo lượt dùng ở console.anthropic.com). Chưa có key: bấm <b>Đóng</b>, rồi bấm <b>Tạo job trống</b> hoặc <b>+ Tạo job</b> để gõ tay.</div>` : ""}
      ${FB ? `<p class="note">Đang đăng nhập <b>${esc(fuser && fuser.email || "")}</b>${ROLE === "owner" ? " (chủ sổ)" : " (nhân viên)"}.</p>${ROLE === "owner" ? `
      <div class="mrow" style="justify-content:flex-start;align-items:flex-end;flex-wrap:wrap"><label class="fld" style="flex:1;min-width:160px;margin:0"><span>Tên hiển thị của bạn (cả nhóm thấy)</span><input id="sj-myn" autocomplete="off" value="${esc(window.SOJOB_USER || "")}" placeholder="VD: Đức"></label><button class="primary" id="sj-mysave">Lưu tên</button></div>` : ""}`
        : `<p>Bản dùng thử trên GitHub Pages. Dữ liệu chỉ nằm <b>trong trình duyệt này</b>: máy khác, trình duyệt khác sẽ thấy sổ trống. Nhớ sao lưu thường xuyên.</p>`}
      ${showKey ? `<label class="fld"><span>API key Claude (lấy ở console.anthropic.com → API keys)</span>
        <input id="sj-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(k)}"></label>
      <p class="note">Key chỉ lưu trong trình duyệt này và chỉ gửi tới api.anthropic.com. Đừng nhập key trên máy dùng chung. Không có key vẫn tạo job trống và nhập tay được.</p>
      <div class="mrow">${k ? '<button class="ghost danger" id="sj-clear">Xoá key</button>' : ""}
        <button class="primary" id="sj-save">Lưu key</button></div>` : ""}
      ${FB ? `<h2 style="margin-top:14px">Zalo</h2><div id="sj-zalo" class="note"></div>` : ""}
      ${FB && ROLE === "owner" ? `<h2 style="margin-top:14px">Thành viên</h2>
      <p class="note">Nhân viên đăng nhập bằng Google của họ tại link này. Họ thấy job họ tạo và job bạn bấm “🔒 Chỉ mình tôi” → “👥 Đã chia sẻ”. Họ được xem tiền, sửa job, nhưng không xoá job và không vào được mục này.</p>
      <div id="sj-mem" class="note">Đang tải…</div>
      <div class="mrow" style="justify-content:flex-start;flex-wrap:wrap;align-items:flex-end">
        <label class="fld" style="flex:2;min-width:180px;margin:0"><span>Email Google của nhân viên</span><input id="sj-me" type="email" autocomplete="off" spellcheck="false" placeholder="ten@gmail.com"></label>
        <label class="fld" style="flex:1;min-width:120px;margin:0"><span>Tên gọi</span><input id="sj-mn" autocomplete="off" placeholder="VD: Hạnh"></label>
        <button class="primary" id="sj-madd">Thêm</button></div>` : ""}
      ${FB && ROLE === "owner" ? `<h2 style="margin-top:14px">Dung lượng</h2><div id="sj-dung" class="note">Đang tải…</div>` : ""}
      ${FB && ROLE !== "owner" ? "" : `<h2 style="margin-top:14px">Dữ liệu</h2>
      ${FB ? '<p class="note">Máy chủ tự sao lưu mỗi đêm vào Google Drive (thư mục “So Job - Sao luu”, giữ 30 bản).</p>' : ""}
      <div class="mrow" style="justify-content:flex-start;flex-wrap:wrap">
        <button id="sj-exp">Tải file sao lưu (.json)</button>
        <button id="sj-imp">Khôi phục từ file…</button>
        <input id="sj-file" type="file" accept="application/json,.json" hidden>
      </div>`}
      <div class="mrow"><span id="sj-msg" class="note"></span><button id="sj-close">Đóng</button></div>`);
    const msg = (t, err) => { const n = $("#sj-msg", d); n.textContent = t; n.className = "note" + (err ? " err" : ""); };
    const close = () => { d.remove(); settingsOpen = false; };
    $("#sj-close", d).onclick = close;
    const sv = $("#sj-save", d); if (sv) sv.onclick = () => {
      const v = $("#sj-key", d).value.trim();
      if (!/^sk-ant-[\w-]{20,}$/.test(v)) { msg("Key phải bắt đầu bằng sk-ant-…", true); return; }
      try { localStorage.setItem(KEY_LS, v); msg("Đã lưu key."); } catch (e) { msg("Trình duyệt chặn lưu (chế độ ẩn danh?).", true); }
    };
    const clr = $("#sj-clear", d);
    if (clr) clr.onclick = () => { try { localStorage.removeItem(KEY_LS); } catch (e) {} $("#sj-key", d).value = ""; msg("Đã xoá key."); };
    const mys = $("#sj-mysave", d);
    if (mys) mys.onclick = async () => {
      const n = $("#sj-myn", d).value.trim().slice(0, 40), mail = String(fuser && fuser.email || "").toLowerCase();
      if (!n) { msg("Nhập tên hiển thị.", true); return; }
      mys.disabled = true;
      try {
        await fdb.doc("meta/people").set({ p: { [mail]: { n: n, at: Date.now(), set: "owner" } } }, { merge: true });
        window.SOJOB_USER = n; try { localStorage.setItem("sojob.myName." + mail, n); } catch (e) {}
        msg("Đã lưu tên: " + n + ". Tin nhắn và job mới sẽ ghi tên này.");
      } catch (e) { msg("Chưa lưu được: " + (e.message || e.code), true); }
      mys.disabled = false;
    };
    const zl = $("#sj-zalo", d); if (zl && window.sojobZalo) window.sojobZalo(zl); else if (zl) zl.remove();
    const dg = $("#sj-dung", d);
    if (dg) { if (window.sojobDung) window.sojobDung(dg); else dg.textContent = "Chưa xem được dung lượng."; }
    const memBox = $("#sj-mem", d);
    if (memBox) {
      const draw = async () => {
        try {
          const s = await fdb.collection("members").get();
          memBox.innerHTML = s.empty ? "Chưa có nhân viên nào." : s.docs.map(x => `<div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--line)"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis"><b>${esc(x.data().name || "")}</b> ${esc(x.id)}</span><button class="ghost sm danger" data-rm="${esc(x.id)}">Bỏ</button></div>`).join("");
          memBox.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => {
            if (!confirm("Bỏ quyền của " + b.dataset.rm + "? Người này sẽ không mở được sổ nữa.")) return;
            try { await fdb.doc("members/" + b.dataset.rm).delete(); draw(); } catch (e) { msg("Chưa bỏ được: " + (e.message || e.code), true); }
          });
        } catch (e) { memBox.textContent = "Chưa đọc được danh sách: " + (e.message || e.code); }
      };
      draw();
      $("#sj-madd", d).onclick = async () => {
        const em = $("#sj-me", d).value.trim().toLowerCase(), nm = $("#sj-mn", d).value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { msg("Email chưa đúng.", true); return; }
        if (fuser && em === (fuser.email || "").toLowerCase()) { msg("Đây là email của chủ sổ.", true); return; }
        try { await fdb.doc("members/" + em).set({ name: nm, role: "staff", addedAt: Date.now() }); $("#sj-me", d).value = ""; $("#sj-mn", d).value = ""; msg("Đã thêm " + em + "."); draw(); }
        catch (e) { msg("Chưa thêm được: " + (e.message || e.code), true); }
      };
    }
    const exp = $("#sj-exp", d); if (exp) exp.onclick = async () => {
      const rows = FB ? await cloudAll() : await allDocs();
      const blob = new Blob([JSON.stringify({ app: "so-job", version: 1, exportedAt: new Date().toISOString(), docs: rows.map(([k, v]) => ({ path: k, data: v })) })], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "so-job-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    if (!exp) return;
    $("#sj-imp", d).onclick = () => $("#sj-file", d).click();
    $("#sj-file", d).onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!j || j.app !== "so-job" || !Array.isArray(j.docs)) throw new Error("File không phải bản sao lưu Sổ Job.");
        const good = j.docs.filter(x => x && typeof x.path === "string" && /^[a-z]+\/.+/.test(x.path) && x.data && typeof x.data === "object");
        if (FB) { msg("Đang ghi lên kho online…"); const n = await cloudPut(good.map(x => [x.path, x.data]), false); msg("Đã khôi phục " + n + " mục lên kho online."); return; }
        await tx("readwrite", s => { good.forEach(x => s.put(x.data, x.path)); });
        msg("Đã khôi phục " + good.length + " mục. Đang tải lại…");
        setTimeout(() => location.reload(), 800);
      } catch (err) { msg(err.message || "Không đọc được file.", true); }
    };
  }
  onReady(() => {
    const top = $(".top"); if (!top) return;
    const b = document.createElement("button");
    b.className = "ghost sm"; b.textContent = "Cài đặt"; b.onclick = () => openSettings();
    top.appendChild(b);
  });

  /* ---------- đọc chữ trong ảnh miễn phí (Tesseract, chạy ngay trên máy) ---------- */
  let ocrWorker = null;
  function loadScript(src) {
    return new Promise((res, rej) => { if (window.Tesseract) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Không tải được bộ đọc chữ. Kiểm tra mạng.")); document.head.appendChild(s); });
  }
  let ocrProgress = null;
  window.SOJOB_OCR = async (files, onProgress, signal) => {
    ocrProgress = onProgress;
    if (!ocrWorker) ocrWorker = (async () => {
      await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
      return window.Tesseract.createWorker("vie", 1, { logger: m => { if (ocrProgress) try { ocrProgress(m.status, m.progress || 0); } catch (e) {} } });
    })().catch(e => { ocrWorker = null; throw e; });
    const w = await ocrWorker;
    const out = [];
    for (const f of asList(files)) {
      if (signal && signal.aborted) throw { code: "cancelled", message: "Đã dừng." };
      const { data } = await w.recognize(f);
      out.push((data && data.text || "").trim());
    }
    if (signal && signal.aborted) throw { code: "cancelled", message: "Đã dừng." };
    return out.filter(Boolean).join("\n\n");
  };

  /* ---------- kho online (Firebase): bật khi có firebase-config.js ---------- */
  const FB = window.SOJOB_FIREBASE && window.SOJOB_FIREBASE.apiKey ? window.SOJOB_FIREBASE : null;
  const COLS = ["jobs", "meta", "partners", "todos", "members", "mypartners"];
  const FBV = "10.12.2";
  const GSI_CLIENT = "873642807388-5o6iava8425nmu0bnn9mv0aqdfth1885.apps.googleusercontent.com"; // mã OAuth web công khai của dự án Firebase
  function addScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Không tải được " + src.split("/").pop() + ". Kiểm tra mạng.")); document.head.appendChild(s); });
  }
  let fdb = null, fauth = null, fuser = null, ROLE = "owner";
  const ROLE_LS = "sojob.role";
  async function cloudAll() {
    const rows = [];
    for (const c of COLS) { const s = await fdb.collection(c).get(); s.docs.forEach(d => rows.push([c + "/" + d.id, d.data()])); }
    return rows;
  }
  async function cloudPut(rows, onlyMissing) {
    let n = 0;
    for (let i = 0; i < rows.length; i += 400) {
      const part = rows.slice(i, i + 400);
      let todo = part;
      if (onlyMissing) {
        todo = [];
        for (const [p, v] of part) { const s = await fdb.doc(p).get(); if (!s.exists) todo.push([p, v]); }
      }
      if (!todo.length) continue;
      const b = fdb.batch();
      todo.forEach(([p, v]) => b.set(fdb.doc(p), JSON.parse(JSON.stringify(v))));
      await b.commit(); n += todo.length;
    }
    return n;
  }
  function loginScreen(err) {
    onReady(() => {
      let d = document.getElementById("sj-login");
      if (!d) { d = overlay(""); d.id = "sj-login"; }
      const sheet = d.querySelector(".sheet");
      sheet.style.maxWidth = "420px"; sheet.style.marginTop = "14vh";
      sheet.innerHTML = `<h2>Đăng nhập · Theo dõi làm hàng</h2>
        <p>Dữ liệu lưu online. Đăng nhập cùng tài khoản Google trên điện thoại và máy tính để thấy chung một sổ.</p>
        ${err ? `<div class="banner">${esc(err)}</div>` : ""}
        <div id="sj-gsi" style="display:flex;justify-content:center;min-height:46px;margin:12px 0 4px"></div>
        <div class="mrow" style="justify-content:center"><button class="ghost sm" id="sj-g">Không thấy nút? Đăng nhập cách khác</button></div>
        ${fuser ? `<div class="mrow"><button class="ghost" id="sj-out2">Đăng xuất ${esc(fuser.email || "")}</button></div>` : ""}`;
      sheet.querySelector("#sj-g").onclick = async () => {
        const p = new firebase.auth.GoogleAuthProvider();
        p.setCustomParameters({ prompt: "select_account" });
        try { await fauth.signInWithPopup(p); }
        catch (e) {
          if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) { try { await fauth.signInWithRedirect(p); return; } catch (e2) { e = e2; } }
          if (e && e.code === "auth/popup-closed-by-user") return;
          loginScreen("Không đăng nhập được: " + (e && (e.message || e.code)));
        }
      };
      const o = sheet.querySelector("#sj-out2"); if (o) o.onclick = () => fauth.signOut();
      // Đăng nhập bằng cửa sổ của Google (không đi vòng qua firebaseapp.com → chạy được trên Safari / iPhone / app ngoài màn hình chính)
      addScript("https://accounts.google.com/gsi/client").then(() => {
        const box = sheet.querySelector("#sj-gsi"); if (!box || !window.google || !google.accounts) throw new Error("gsi");
        google.accounts.id.initialize({
          client_id: GSI_CLIENT, ux_mode: "popup", auto_select: false, itp_support: true, use_fedcm_for_prompt: true,
          callback: async r => {
            try { await fauth.signInWithCredential(firebase.auth.GoogleAuthProvider.credential(r.credential)); }
            catch (e) { loginScreen("Không đăng nhập được: " + (e && (e.message || e.code))); }
          }
        });
        google.accounts.id.renderButton(box, { theme: "filled_blue", size: "large", shape: "pill", text: "signin_with", locale: "vi", width: 280 });
      }).catch(() => { const g = sheet.querySelector("#sj-g"); if (g) { g.className = "primary"; g.style.padding = "10px"; g.textContent = "Đăng nhập bằng Google"; } });
    });
  }
  function userBar() {
    onReady(() => {
      const top = $(".top"); if (!top || $("#sj-user")) return;
      const s = document.createElement("button");
      s.id = "sj-user"; s.className = "ghost sm"; s.title = "Đăng xuất " + (fuser.email || "");
      s.textContent = "Đăng xuất"; s.onclick = () => { if (confirm("Đăng xuất " + (fuser.email || "") + "?")) fauth.signOut(); };
      top.appendChild(s);
    });
  }
  const cloudReady = !FB ? null : (async () => {
    for (const f of ["app", "auth", "firestore"]) await addScript(`https://www.gstatic.com/firebasejs/${FBV}/firebase-${f}-compat.js`);
    firebase.initializeApp(FB);
    fauth = firebase.auth();
    fdb = firebase.firestore();
    fdb.settings({ ignoreUndefinedProperties: true, merge: true });
    try { await fdb.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* trình duyệt không hỗ trợ: vẫn chạy online */ }
    let first = true;
    return new Promise(res => {
      fauth.onAuthStateChanged(async u => {
        if (!u) { if (!first) { location.reload(); return; } first = false; fuser = null; loginScreen(); return; }
        first = false; fuser = u;
        const mail = (u.email || "").toLowerCase();
        // Chưa có trong members/: nếu vẫn đọc được sổ thì là quy tắc Firestore cũ (chỉ chủ sổ vào được) → chủ sổ
        const legacyOwner = async () => { try { await fdb.doc("meta/templates").get({ source: "server" }); return true; } catch (e) { return false; } };
        const denied = () => loginScreen(`Tài khoản ${u.email} chưa được cấp quyền dùng sổ này. Gửi email này cho chủ sổ để được thêm vào (Cài đặt → Thành viên), hoặc đăng xuất để chọn tài khoản khác.`);
        // Chủ sổ: đọc được cả danh sách thành viên. Nhân viên: chỉ có hồ sơ của mình trong members/.
        let memName = "";
        try { await fdb.collection("members").limit(1).get({ source: "server" }); ROLE = "owner"; }
        catch (e) {
          if (e && e.code === "permission-denied") {
            try { const m = await fdb.doc("members/" + mail).get({ source: "server" }); if (m.exists) { ROLE = "staff"; memName = String((m.data() || {}).name || "").trim(); } else if (await legacyOwner()) ROLE = "owner"; else { denied(); return; } }
            catch (e2) { if (e2 && e2.code === "permission-denied") { if (await legacyOwner()) ROLE = "owner"; else { denied(); return; } } else ROLE = (localStorage.getItem(ROLE_LS + "." + mail) || "staff"); }
          } else ROLE = (localStorage.getItem(ROLE_LS + "." + mail) || "staff"); // mất mạng: dùng vai trò lần trước
        }
        try { localStorage.setItem(ROLE_LS + "." + mail, ROLE); } catch (e) {}
        window.SOJOB_ROLE = ROLE; window.SOJOB_EMAIL = mail;
        if (memName) try { localStorage.setItem("sojob.memName." + mail, memName); } catch (e) {}
        if (!memName && ROLE === "staff") try { memName = localStorage.getItem("sojob.memName." + mail) || ""; } catch (e) {}
        if (!memName && ROLE === "owner") try { memName = localStorage.getItem("sojob.myName." + mail) || ""; } catch (e) {} // tên chủ sổ tự đặt (Cài đặt → Tên hiển thị)
        window.SOJOB_USER = memName || u.displayName || u.email || ""; // tên chủ sổ đặt cho nhân viên được ưu tiên
        const l = document.getElementById("sj-login"); if (l) l.remove();
        userBar();
        res(fdb);
      });
    });
  })().catch(e => { onReady(() => { const b = $("#banner"); if (b) b.innerHTML = `<div class="banner">Không kết nối được kho online: ${esc(e.message || e)}</div>`; }); return null; });

  const caps = { db, sample, assets };
  window.claude = Object.freeze({ use: async name => {
    if (cloudReady && name === "db") return await cloudReady;
    if (cloudReady) await cloudReady;
    return caps[name] || null;
  } });
})();
