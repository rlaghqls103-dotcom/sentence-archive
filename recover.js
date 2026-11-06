/* 감상문 되살리기 — 크롬·엣지의 localStorage 저장 파일(LevelDB)을 직접 읽어서,
   지금은 덮어써진 옛 값까지 모두 꺼내요. 파일은 브라우저 안에서만 읽고 어디에도 보내지 않아요. */
(function () {
  "use strict";

  // ---------- 작은 도구 ----------
  function varint(buf, pos) {
    let result = 0, shift = 0, b;
    do {
      b = buf[pos.i++];
      result += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (b & 0x80 && pos.i < buf.length);
    return result;
  }

  // Snappy 풀기 (LevelDB 표 파일이 이 방식으로 줄여 저장해요)
  function snappy(src) {
    const pos = { i: 0 };
    const len = varint(src, pos);
    const out = new Uint8Array(len);
    let o = 0;
    while (pos.i < src.length && o < len) {
      const tag = src[pos.i++];
      const t = tag & 3;
      if (t === 0) {
        let n = tag >> 2;
        if (n >= 60) { const bytes = n - 59; n = 0; for (let k = 0; k < bytes; k++) n |= src[pos.i++] << (8 * k); }
        n += 1;
        out.set(src.subarray(pos.i, pos.i + n), o); o += n; pos.i += n;
      } else {
        let length, offset;
        if (t === 1) { length = ((tag >> 2) & 7) + 4; offset = ((tag >> 5) << 8) | src[pos.i++]; }
        else if (t === 2) { length = (tag >> 2) + 1; offset = src[pos.i] | (src[pos.i + 1] << 8); pos.i += 2; }
        else { length = (tag >> 2) + 1; offset = (src[pos.i] | (src[pos.i + 1] << 8) | (src[pos.i + 2] << 16) | (src[pos.i + 3] << 24)) >>> 0; pos.i += 4; }
        if (!offset || offset > o) throw new Error("snappy offset");
        for (let k = 0; k < length; k++) { out[o] = out[o - offset]; o++; }
      }
    }
    return out.subarray(0, o);
  }

  // ---------- LevelDB 기록 파일(.log): 쓰기 묶음을 차례로 ----------
  function readLog(buf, emit) {
    const BLOCK = 32768;
    let i = 0, parts = [];
    while (i + 7 <= buf.length) {
      const blockLeft = BLOCK - (i % BLOCK);
      if (blockLeft < 7) { i += blockLeft; continue; }
      const len = buf[i + 4] | (buf[i + 5] << 8);
      const type = buf[i + 6];
      if (type === 0 && len === 0) { i += blockLeft; continue; }
      const data = buf.subarray(i + 7, i + 7 + len);
      i += 7 + len;
      if (type === 1) batch(data);
      else if (type === 2) parts = [data];
      else if (type === 3) parts.push(data);
      else if (type === 4) { parts.push(data); batch(concat(parts)); parts = []; }
    }
    function batch(b) {
      try {
        const pos = { i: 12 };
        const count = b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24);
        for (let n = 0; n < count && pos.i < b.length; n++) {
          const tag = b[pos.i++];
          const kl = varint(b, pos); const key = b.subarray(pos.i, pos.i + kl); pos.i += kl;
          if (tag === 1) { const vl = varint(b, pos); const val = b.subarray(pos.i, pos.i + vl); pos.i += vl; emit(key, val); }
        }
      } catch { /* 깨진 묶음은 건너뛰어요 */ }
    }
  }
  function concat(list) {
    const out = new Uint8Array(list.reduce((s, a) => s + a.length, 0));
    let o = 0; for (const a of list) { out.set(a, o); o += a.length; }
    return out;
  }

  // ---------- LevelDB 표 파일(.ldb): 모든 블록의 모든 값(옛 값 포함) ----------
  function readBlock(buf, off, size) {
    const raw = buf.subarray(off, off + size);
    const type = buf[off + size];
    return type === 1 ? snappy(raw) : raw;
  }
  function blockEntries(block, emit) {
    const numRestarts = (block[block.length - 4] | (block[block.length - 3] << 8) | (block[block.length - 2] << 16) | (block[block.length - 1] << 24)) >>> 0;
    const end = block.length - 4 - numRestarts * 4;
    const pos = { i: 0 };
    let last = new Uint8Array(0);
    while (pos.i < end) {
      const shared = varint(block, pos), nonShared = varint(block, pos), vl = varint(block, pos);
      const key = new Uint8Array(shared + nonShared);
      key.set(last.subarray(0, shared), 0);
      key.set(block.subarray(pos.i, pos.i + nonShared), shared);
      pos.i += nonShared;
      const val = block.subarray(pos.i, pos.i + vl); pos.i += vl;
      last = key;
      emit(key, val);
    }
  }
  function readTable(buf, emit) {
    const footer = buf.subarray(buf.length - 48);
    const pos = { i: 0 };
    varint(footer, pos); varint(footer, pos); // metaindex
    const idxOff = varint(footer, pos), idxSize = varint(footer, pos);
    const index = readBlock(buf, idxOff, idxSize);
    blockEntries(index, (_k, handle) => {
      try {
        const hp = { i: 0 };
        const off = varint(handle, hp), size = varint(handle, hp);
        blockEntries(readBlock(buf, off, size), (ikey, val) => {
          if (ikey.length < 8) return;
          const type = ikey[ikey.length - 8];
          if (type === 1) emit(ikey.subarray(0, ikey.length - 8), val);
        });
      } catch { /* 깨진 블록은 건너뛰어요 */ }
    });
  }

  // ---------- 크롬 localStorage 키·값 해석 ----------
  // 키: "_" + 주소 + 0x00 + (0x01 Latin-1 | 0x00 UTF-16) + 이름,  값: (0x01 Latin-1 | 0x00 UTF-16) + 내용
  function decodeStr(b) {
    if (!b.length) return "";
    const body = b.subarray(1);
    if (b[0] === 0) return new TextDecoder("utf-16le").decode(body);
    return Array.from(body, (c) => String.fromCharCode(c)).join("");
  }
  function parseKey(k) {
    if (k[0] !== 0x5f) return null; // "_"
    const z = k.indexOf(0, 1);
    if (z < 0) return null;
    const origin = Array.from(k.subarray(1, z), (c) => String.fromCharCode(c)).join("");
    return { origin, name: decodeStr(k.subarray(z + 1)) };
  }

  // 파일 목록 → 찾은 감상문 후보
  function extract(files) {
    const found = []; // { origin, name, value }
    const emit = (k, v) => {
      const pk = parseKey(k);
      if (!pk || !/^(notes:|noteDraft:)/.test(pk.name)) return;
      found.push({ origin: pk.origin, name: pk.name, value: decodeStr(v) });
    };
    for (const f of files) {
      try {
        if (/\.log$/i.test(f.name)) readLog(f.data, emit);
        else if (/\.(ldb|sst)$/i.test(f.name)) readTable(f.data, emit);
      } catch { /* 읽을 수 없는 파일은 건너뛰어요 */ }
    }
    // 감상문 하나하나로 펼치기
    const notes = new Map();
    const add = (o) => {
      if (!o.body || !o.body.trim()) return;
      const k = o.title + "\u0000" + o.body;
      const prev = notes.get(k);
      if (!prev || (o.updated_at || "") > (prev.updated_at || "")) notes.set(k, o);
    };
    for (const r of found) {
      let v; try { v = JSON.parse(r.value); } catch { continue; }
      if (r.name.startsWith("notes:") && Array.isArray(v)) {
        for (const n of v) if (n && typeof n.body === "string") add({ title: n.book_title || "", body: n.body, finished_on: n.finished_on || "", updated_at: n.updated_at || "", origin: r.origin, from: "저장된 감상문" });
      } else if (r.name.startsWith("noteDraft:") && Array.isArray(v)) {
        add({ title: r.name.slice(10) || v[0] || "", body: String(v[3] || ""), finished_on: v[2] || "", updated_at: "", origin: r.origin, from: "쓰다 만 글" });
      }
    }
    return [...notes.values()].sort((a, b) => (a.title === b.title ? ((b.updated_at || "") > (a.updated_at || "") ? 1 : -1) : a.title.localeCompare(b.title, "ko")));
  }

  if (typeof module !== "undefined") { module.exports = { extract }; return; }

  // ---------- 화면 ----------
  const $ = (id) => document.getElementById(id);
  async function run(fileList) {
    const files = [...fileList].filter((f) => /\.(log|ldb|sst)$/i.test(f.name));
    if (!files.length) { $("status").textContent = "leveldb 폴더 안의 .log / .ldb 파일을 찾지 못했어요. 폴더를 다시 골라 주세요."; return; }
    $("status").textContent = `파일 ${files.length}개를 읽는 중…`;
    const loaded = [];
    for (const f of files) loaded.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    const list = extract(loaded);
    const out = $("out");
    out.replaceChildren();
    if (!list.length) { $("status").textContent = "남아 있는 감상문을 찾지 못했어요. 다른 브라우저나 다른 프로필 폴더(Profile 1 등)도 확인해 보세요."; return; }
    $("status").textContent = `감상문 ${list.length}편을 찾았어요. 같은 책의 여러 버전이 있으면 최근 것이 위에 있어요.`;
    for (const n of list) {
      const card = document.createElement("div"); card.className = "card";
      const h = document.createElement("h3"); h.textContent = n.title ? `『${n.title}』` : "(제목 없음)";
      const meta = document.createElement("div"); meta.className = "meta";
      meta.textContent = [n.from, n.updated_at ? "저장 " + n.updated_at.replace("T", " ").slice(0, 16) : "", n.finished_on ? "다 읽은 날 " + n.finished_on : "", n.origin].filter(Boolean).join(" · ");
      const pre = document.createElement("pre"); pre.textContent = n.body;
      const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "글 복사하기";
      btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(n.body); btn.textContent = "복사했어요"; }
        catch { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = "선택했어요 — Ctrl+C 로 복사"; }
      });
      card.append(h, meta, pre, btn);
      out.append(card);
    }
  }
  $("dir").addEventListener("change", (e) => run(e.target.files));
  $("files").addEventListener("change", (e) => run(e.target.files));
})();
