// 通知用LINE公式アカウントの Webhook
// 管理画面に出ている6けたのコードがトークで送られたら、そのLINEを通知先として登録する。
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SECRET = Deno.env.get("LINE_CHANNEL_SECRET") || "";
const TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
const HOWTO = "予約の通知を受け取るには、管理画面の「設定」（トレーナーは「自分のシフト」）の「予約の通知」に出ている6けたの数字を、このトークに送ってください。";

async function validSignature(body: string, sig: string | null) {
  if (!SECRET || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function reply(token: string, text: string) {
  if (!TOKEN || !token) return;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ replyToken: token, messages: [{ type: "text", text }] }),
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const body = await req.text();
  if (!(await validSignature(body, req.headers.get("x-line-signature")))) return new Response("bad signature", { status: 401 });

  let events: any[] = [];
  try { events = JSON.parse(body).events || []; } catch { return new Response("bad", { status: 400 }); }

  for (const ev of events) {
    const userId = ev.source?.type === "user" ? ev.source.userId : null;
    if (!userId) continue;
    if (ev.type === "follow") { await reply(ev.replyToken, "友だち追加ありがとうございます。\n" + HOWTO); continue; }
    if (ev.type !== "message" || ev.message?.type !== "text") continue;

    const code = String(ev.message.text).normalize("NFKC").replace(/\D/g, "");
    if (code.length !== 6) { await reply(ev.replyToken, HOWTO); continue; }

    const { data, error } = await sb.rpc("link_line", { p_line_user: userId, p_code: code });
    if (error) { await reply(ev.replyToken, "登録できませんでした。少し待ってからもう一度送ってください。"); continue; }
    await reply(ev.replyToken,
      data === "OK" ? "登録できました。これから予約が入ったら、このトークでお知らせします。\n管理画面を開き直すと「つながっています」と表示されます。"
      : data === "LOCKED" ? "間違いが続いたので、1時間ほど待ってからもう一度送ってください。"
      : "その数字は見つかりませんでした。管理画面を開き直して、いま出ている6けたの数字を送ってください（数字は30分で変わります）。");
  }
  return new Response("ok");
});
