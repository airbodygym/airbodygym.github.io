// 予約・キャンセル・チケットの申し込みを LINE とメールで知らせる
// データベース（notify_enqueue）から { id } が届く。同じ通知は1回しか送らない。
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import nodemailer from "npm:nodemailer@6.9.14";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
const GMAIL_USER = Deno.env.get("GMAIL_USER") || "";
const GMAIL_PASS = (Deno.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
const ADMIN_URL = "https://airbodygym.github.io/admin.html";
const WD = ["日", "月", "火", "水", "木", "金", "土"];

type Target = { email?: string | null; line?: string | null };
type P = Record<string, any> & { targets?: Target[] };

const yen = (n: number) => (n || 0).toLocaleString("ja-JP") + "円";
function day(d: string) {
  const [y, m, dd] = d.split("-").map(Number);
  return `${m}/${dd}(${WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]})`;
}
function pay(p: P) {
  if (p.pay_type === "pass") return p.pass_label || "チケット";
  if (p.pay_type === "trial") return `初回体験 ${yen(p.price)}`;
  if (p.pay_type === "free") return "サービス（無料）";
  return `都度払い ${yen(p.price)}`;
}

function compose(kind: string, p: P): { subject: string; text: string } {
  if (kind === "test") {
    return { subject: "【テスト】予約の通知", text: "【テスト】\n予約の通知はここに届きます。\nこのメッセージが見えていれば設定は完了です。" };
  }
  if (kind === "apply") {
    const text = [`【チケットの申し込み】`, `${p.customer} 様（${p.contact}）`, `${p.plan} ${yen(p.price)}`, "",
      "お支払いを確認したら、管理画面の「お客さん」で有効にしてください。", ADMIN_URL].join("\n");
    return { subject: `【申し込み】${p.customer} 様 ${p.plan}`, text };
  }
  const head = kind === "cancel" ? "【キャンセル】" : "【新しい予約】";
  const when = `${day(p.on_date)} ${p.start_time}〜${p.end_time === "00:00" ? "24:00" : p.end_time}`;
  const lines = [head, when, `トレーナー：${p.trainer || "—"}${p.nominated ? "（指名）" : "（おまかせ）"}`,
    `お客さん：${p.customer} 様（${p.contact}）`, `お支払い：${pay(p)}`];
  if (p.note) lines.push(`メモ：${p.note}`);
  lines.push("", ADMIN_URL);
  return { subject: `${head}${when} ${p.customer} 様`, text: lines.join("\n") };
}

async function sendLine(to: string, text: string) {
  if (!LINE_TOKEN) return "LINE未設定";
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  return r.ok ? "ok" : `LINE ${r.status} ${(await r.text()).slice(0, 200)}`;
}

let mailer: any = null;
async function sendMail(to: string, subject: string, text: string) {
  if (!GMAIL_USER || !GMAIL_PASS) return "メール未設定";
  mailer ??= nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  try {
    await mailer.sendMail({ from: `"AIR BODY GYM 予約通知" <${GMAIL_USER}>`, to, subject, text });
    return "ok";
  } catch (e) {
    return `メール ${(e as Error).message}`.slice(0, 200);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  let id: number;
  try { id = Number((await req.json()).id); } catch { return new Response("bad", { status: 400 }); }
  if (!Number.isInteger(id)) return new Response("bad", { status: 400 });

  // まだ送っていない通知だけを取る（同時に2回呼ばれても1回だけ送る）
  const { data, error } = await sb.from("notify_queue").update({ sent_at: new Date().toISOString() })
    .eq("id", id).is("sent_at", null).select("kind,payload").maybeSingle();
  if (error) return new Response(error.message, { status: 500 });
  if (!data) return new Response("already");

  const p = data.payload as P;
  const { subject, text } = compose(data.kind, p);
  const seenLine = new Set<string>(), seenMail = new Set<string>();
  const jobs: Promise<string[]>[] = [];
  for (const t of p.targets || []) {
    if (t.line && !seenLine.has(t.line)) { seenLine.add(t.line); jobs.push(sendLine(t.line, text).then((r) => ["line:" + t.line!.slice(-4), r])); }
    const m = (t.email || "").toLowerCase();
    if (m && !seenMail.has(m)) { seenMail.add(m); jobs.push(sendMail(m, subject, text).then((r) => ["mail:" + m, r])); }
  }
  const result = Object.fromEntries(await Promise.all(jobs));
  await sb.from("notify_queue").update({ result }).eq("id", id);
  return Response.json(result);
});
