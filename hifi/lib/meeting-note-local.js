/* global window */
/**
 * Meeting note helpers —100% local, no LLM / bot.
 * Transcript templates, rule-based summary, minutes markdown, todo extraction.
 */
(function initMeetingNoteLocal(global) {
  const STORAGE_KEY = "shogun.granolaMeetingNotes.v1";

  function safeParse(json, fallback) {
    try {
      return JSON.parse(json);
    } catch (_e) {
      return fallback;
    }
  }

  function loadAll() {
    return safeParse(global.localStorage.getItem(STORAGE_KEY), {});
  }

  function saveAll(obj) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (_e) {
      /* quota or private mode */
    }
  }

  function loadNote(id) {
    if (!id) return null;
    const a = loadAll();
    return a[id] || null;
  }

  function saveNote(id, patch) {
    if (!id) return;
    const a = loadAll();
    const prev = a[id] || {};
    a[id] = {
      ...prev,
      ...patch,
      updatedAt: Date.now(),
    };
    saveAll(a);
  }

  /** FNV-1a-ish hash for stable storage ids */
  function storageHash(parts) {
    const s = typeof parts === "string" ? parts : JSON.stringify(parts);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return "g-" + (h >>> 0).toString(16);
  }

  /**
   * @param {object} meta — title, authorLabel, dateLabel, time, tag
   */
  function buildStubTranscript(meta) {
    const title = meta.title || "（無題）";
    const who = meta.authorLabel || "参加者";
    const tm = meta.time || "--:--";
    const lines = [];
    lines.push("[" + tm + "] 司会: それでは「" + title + "」について議論を始めます。");
    lines.push("[" + tm + "] " + who + ": \u524d\u63d0\u3068\u30b4\u30fc\u30eb\u306e\u78ba\u8a8d\u304b\u3089\u304a\u9858\u3044\u3057\u307e\u3059\u3002");
    if (meta.tag) {
      lines.push("[" + tm + "] ノート: カテゴリは " + meta.tag + " として記録します。");
    }
    lines.push("決定: 次回までに論点を整理し、関係者へ共有する。");
    lines.push("TODO: フォローアップのメールを送る。");
    lines.push("");
    lines.push("（上記はローカル・テンプレートです。実際の発言に置き換えてください。）");
    return lines.join("\n");
  }

  function splitSentences(text) {
    if (!text || !String(text).trim()) return [];
    const t = String(text).replace(/\r/g, "");
    return t
      .split(/(?<=[。．.!?？])\s+|(?<=[。．.!?？])\n+|\n{2,}/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  /**
   * Rule-based summary: lead sentences + keyword / line-pattern bullets.
   */
  function summarizeLocal(text, meta) {
    const title = (meta && meta.title) || "";
    const sents = splitSentences(text);
    const head = sents.slice(0, 4);
    const bullets = [];
    const rawLines = String(text || "").split("\n");
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (/^(決定[:：]|TODO[:：]|アクション[:：]|宿題[:：]|■)/i.test(line)) {
        bullets.push("- " + line.replace(/^■\s*/, ""));
      }
    }
    if (bullets.length < 2) {
      for (let j = 0; j < sents.length; j++) {
        const s = sents[j];
        if (s.length > 220) continue;
        if (/決定|TODO|フォロー|次回|議題/i.test(s)) {
          bullets.push("- " + s);
        }
      }
    }
    const uniq = [];
    const seen = {};
    for (let k = 0; k < bullets.length; k++) {
      if (!seen[bullets[k]]) {
        seen[bullets[k]] = 1;
        uniq.push(bullets[k]);
      }
    }
    const out = [];
    out.push("## 要約（ルールベース・ボット未使用）");
    out.push("");
    if (head.length) {
      head.forEach(function (s, idx) {
        out.push(String(idx + 1) + ". " + s);
      });
      out.push("");
    } else {
      out.push("（文字起こし・メモが空のため要約できません）");
      out.push("");
    }
    if (uniq.length) {
      out.push("## 拾い出し");
      uniq.slice(0, 12).forEach(function (b) {
        out.push(b);
      });
      out.push("");
    }
    out.push("*参照タイトル: " + title + "*");
    return out.join("\n");
  }

  function buildMinutesMarkdown(meta, transcript, body, summary) {
    const m = meta || {};
    const dt = [m.dateLabel, m.time].filter(Boolean).join(" ");
    const source = [transcript || "", body || ""].join("\n");
    const sum =
      summary ||
      summarizeLocal(source, m);
    const sumLines = sum.split("\n").slice(0, 20);
    const txLines = (transcript || "").split("\n").filter(Boolean).slice(0, 16);
    return [
      "# 議事録: " + (m.title || "（無題）"),
      "",
      "- **日時**: " + (dt || "—"),
      "- **タグ**: " + (m.tag || "—"),
      "- **参加者（代表）**: " + (m.authorLabel || "—"),
      "",
      "## 要約",
      sumLines.join("\n"),
      "",
      "## \u6587\u5b57\u8d77\u3053\u3057\uff08\u62ec\u7c9b\uff09",
      txLines.length ? txLines.join("\n") : "（なし）",
      "",
      "## 自由メモ",
      body || "（なし）",
      "",
    ].join("\n");
  }

  function extractTodos(text) {
    const out = [];
    const lines = String(text || "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      let m = t.match(/^\[[ xX]\]\s*(.+)$/);
      if (m) {
        out.push(m[1]);
        continue;
      }
      m = t.match(/^-\s*\[[ xX]\]\s*(.+)$/);
      if (m) {
        out.push(m[1]);
        continue;
      }
      m = t.match(/^TODO[:：]\s*(.+)$/i);
      if (m) {
        out.push(m[1]);
        continue;
      }
      m = t.match(/^・\s*TODO[:：]?\s*(.+)$/i);
      if (m) {
        out.push(m[1]);
      }
    }
    const uniq = [];
    const seen = {};
    for (let j = 0; j < out.length; j++) {
      if (!seen[out[j]]) {
        seen[out[j]] = 1;
        uniq.push(out[j]);
      }
    }
    return uniq;
  }

  const USER_MTG_LOG_KEY = "shogun.meetings.userSessionLog.v1";

  function loadUserMeetingLog() {
    return safeParse(global.localStorage.getItem(USER_MTG_LOG_KEY), { items: [] });
  }

  function prependMeetingLogEntry(entry) {
    const log = loadUserMeetingLog();
    log.items = Array.isArray(log.items) ? log.items : [];
    const row = typeof entry === "object" && entry ? { ...entry } : {};
    row.loggedAt = Date.now();
    log.items.unshift(row);
    if (log.items.length > 80) log.items.length = 80;
    try {
      global.localStorage.setItem(USER_MTG_LOG_KEY, JSON.stringify(log));
    } catch (_e) {
      /* ignore */
    }
  }

  /** 4-pane completion for list badges (memo / transcript / summary / minutes). */
  function noteProgress(saved) {
    if (!saved || typeof saved !== "object") {
      return {
        filled: 0,
        total: 4,
        pct: 0,
        memo: false,
        transcript: false,
        summary: false,
        minutes: false,
      };
    }
    const memo = !!(saved.body && String(saved.body).trim());
    const transcript = !!(saved.transcript && String(saved.transcript).trim());
    const summary = !!(saved.summary && String(saved.summary).trim());
    const minutes = !!(saved.minutes && String(saved.minutes).trim());
    const filled = [memo, transcript, summary, minutes].filter(Boolean).length;
    return {
      filled: filled,
      total: 4,
      pct: Math.round((filled / 4) * 100),
      memo: memo,
      transcript: transcript,
      summary: summary,
      minutes: minutes,
    };
  }

  function countOccurrences(haystack, needle) {
    if (!needle || !String(needle).trim()) return 0;
    const h = String(haystack).toLowerCase();
    const n = String(needle).toLowerCase().trim();
    if (!n) return 0;
    let c = 0;
    let pos = 0;
    while (true) {
      const i = h.indexOf(n, pos);
      if (i < 0) break;
      c++;
      pos = i + n.length;
    }
    return c;
  }

  global.MeetingNoteLocal = {
    STORAGE_KEY: STORAGE_KEY,
    USER_MTG_LOG_KEY: USER_MTG_LOG_KEY,
    loadNote: loadNote,
    saveNote: saveNote,
    storageHash: storageHash,
    buildStubTranscript: buildStubTranscript,
    summarizeLocal: summarizeLocal,
    buildMinutesMarkdown: buildMinutesMarkdown,
    extractTodos: extractTodos,
    countOccurrences: countOccurrences,
    splitSentences: splitSentences,
    loadUserMeetingLog: loadUserMeetingLog,
    prependMeetingLogEntry: prependMeetingLogEntry,
    noteProgress: noteProgress,
  };
})(window);
