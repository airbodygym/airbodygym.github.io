// 共通設定と小さな道具。公開キー（anon）はブラウザに置いてよいキーです。データはデータベース側のアクセス制限で守られています。
window.APP = (function () {
  const SUPABASE_URL = "https://xqxcsmwtwhcwzabjlzzo.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxeGNzbXd0d2hjd3phYmpsenpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4MjczMjcsImV4cCI6MjEwODQwMzMyN30.1p3MFFYyIMnxxX1l9cnuvDi42LzwrYUgWdXJpj6BANk";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const yen = (n) => Number(n || 0).toLocaleString("ja-JP") + "円";
  // 日付は日本時間で扱う
  function jstNow() { const d = new Date(); return new Date(d.getTime() + (d.getTimezoneOffset() + 540) * 60000); }
  const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const today = () => ymd(jstNow());
  const parseYmd = (s) => { const [a, b, c] = String(s).split("-").map(Number); return new Date(a, b - 1, c); };
  const fmtDate = (s) => { const d = parseYmd(s); return (d.getMonth() + 1) + "月" + d.getDate() + "日（" + WD[d.getDay()] + "）"; };
  const fmtShort = (s) => { const d = parseYmd(s); return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate(); };
  const hm = (t) => String(t).slice(0, 5); // "10:00:00" -> "10:00"
  const startOf = (date, time) => { const d = parseYmd(date); const [h, m] = hm(time).split(":").map(Number); d.setHours(h, m); return d; };
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 3600); }
  function banner(msg, warn) { const b = $("banner"); if (!msg) { b.hidden = true; return; } b.textContent = msg; b.className = "note" + (warn ? " warn" : ""); b.hidden = false; }
  async function copy(text, input) {
    try { await navigator.clipboard.writeText(text); toast("コピーしました"); }
    catch (e) { if (input) { input.focus(); input.select(); } toast("選択された文字をコピーしてください"); }
  }
  function siteBase() { return location.origin + location.pathname.replace(/(admin\.html|index\.html)$/, ""); }
  const myPageUrl = (token) => siteBase() + "?me=" + token;

  const ERR = {
    NAME_REQUIRED: "お名前と連絡先を入力してください。",
    CUSTOMER_NOT_FOUND: "マイページの情報が見つかりません。マイページURLを確認してください。",
    OUT_OF_RANGE: "この日はまだ予約を受け付けていません。",
    CLOSED: "この日は休業日です。",
    BAD_TIME: "この時間は予約枠ではありません。",
    PAST: "この時間はすでに過ぎています。",
    TOO_MANY: "受付できる件数の上限に達しています。ジムに直接ご連絡ください。",
    ALREADY: "同じ時間にすでに予約があります。",
    PASS_INVALID: "このチケットは使えません。",
    PASS_EXPIRED: "チケットの有効期限外の日付です。",
    PASS_EMPTY: "チケットの残り回数がありません。",
    TRIAL_USED: "初回体験はすでにご利用済みです。",
    BAD_PAY: "お支払い方法を選んでください。",
    SLOT_TAKEN: "この時間はちょうど埋まりました。別の時間を選んでください。",
    CANNOT_CANCEL: "この予約はここからはキャンセルできません。当日のキャンセルはジムへ直接ご連絡ください。",
    BAD_PLAN: "このプランは申し込めません。",
    ALREADY_APPLIED: "このプランはすでに申し込み済みです。",
    NOT_ADMIN: "管理者としてログインしてください。",
  };
  function errText(error, fallback) {
    const m = error && (error.message || "");
    for (const k of Object.keys(ERR)) if (m.includes(k)) return ERR[k];
    return fallback || "うまく保存できませんでした。通信状況を確認してもう一度お試しください。";
  }
  return { sb, WD, $, esc, pad, yen, jstNow, ymd, today, parseYmd, fmtDate, fmtShort, hm, startOf, toast, banner, copy, myPageUrl, errText };
})();
