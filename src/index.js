import * as StellarSdk from "@stellar/stellar-sdk";
const HORIZON = "https://horizon.stellar.org";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC = new StellarSdk.Asset("USDC", USDC_ISSUER);
const XLM = StellarSdk.Asset.native();
function n7(v) { return Number(v).toFixed(7); }
async function kirim(env, text) {
  return;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try { await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${env.TELEGRAM_CHAT_ID}&text=${encodeURIComponent(text + " SCN")}`); } catch {}
}
async function hitungPnew(env, batasDepth) {
  const url = `${HORIZON}/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=${USDC_ISSUER}&limit=200`;
  const r = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error("horizon error " + r.status);
  const book = await r.json();
  const bids = book?.bids || [];
  if (!bids.length) throw new Error("bids kosong");
  let depth = 0; let found = null;
  for (const v of bids) {
    const bid = parseFloat(v.price_r.d) / parseFloat(v.price_r.n);
    const bam = parseFloat(v.amount);
    depth += bam * bid;
    if (depth > batasDepth) { found = { bid: n7(bid), pnew: n7(bid + 0.0000003), depth_at_hit: depth }; break; }
  }
  return { depth, found, top_bid: n7(parseFloat(bids[0].price_r.d) / parseFloat(bids[0].price_r.n)) };
}
async function doGeser(env, batasDepth) {
  const server = new StellarSdk.Horizon.Server(HORIZON);
  const kp = StellarSdk.Keypair.fromSecret(env.SECRET_KEY);
  const pub = kp.publicKey();
  const { depth, found, top_bid } = await hitungPnew(env, batasDepth);
  if (!found) return { ok: true, geser: false, reason: "depth belum tembus", depth, top_bid };
  const pnew = found.pnew;
  const accRes = await fetch(`${HORIZON}/accounts/${pub}/offers`);
  const acc = await accRes.json();
  const offers = acc?._embedded?.records || [];
  let my = null;
  for (const o of offers) {
    const s = o.selling.asset_code || "XLM";
    const b = o.buying.asset_code || "XLM";
    if (s === "USDC" && b === "XLM") { my = o; break; }
  }
  if (!my) return { ok: true, geser: false, reason: "tidak ada offer USDC->XLM", pnew, depth };
  const myPrice = n7(my.price);
  const amount = my.amount;
  const offerId = Number(my.id);
  if (pnew === myPrice) return { ok: true, geser: false, reason: "harga sama", pnew, my_price: myPrice, depth };
  try {
    const sourceAccount = await server.loadAccount(pub);
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, { fee: "10000", networkPassphrase: StellarSdk.Networks.PUBLIC })
      .addOperation(StellarSdk.Operation.manageSellOffer({ selling: USDC, buying: XLM, amount: amount, price: pnew, offerId: offerId }))
      .addMemo(StellarSdk.Memo.text("stellar.my.id")).setTimeout(100).build();
    tx.sign(kp);
    const res = await server.submitTransaction(tx);
    await kirim(env, `GESER ${myPrice} -> ${pnew} | ${amount} | ${res.hash}`);
    return { ok: true, geser: true, from: myPrice, pnew, amount, hash: res.hash, depth };
  } catch (e) {
    await kirim(env, "gagal update posisi");
    return { ok: false, geser: false, error: String(e), pnew, my_price: myPrice };
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    const key = url.searchParams.get("key") || request.headers.get("x-worker-key");
    if (url.pathname === "/" || url.pathname === "/health") return new Response(JSON.stringify({ ok: true, service: "stellar-geser-worker", pair: "USDC-XLM" }), { headers });
    if (url.pathname === "/rate") {
      try {
        const depth = parseFloat(url.searchParams.get("depth") || env.BAWAH || "25000000");
        const { depth: d, found, top_bid } = await hitungPnew(env, depth);
        return new Response(JSON.stringify({ ok: true, pair: "USDC-XLM", batas_depth: depth, top_bid, depth_total: d, target: found }), { headers });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers }); }
    }
    if (url.pathname === "/geser") {
      if (env.WORKER_KEY && key !== env.WORKER_KEY) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers });
      try {
        const depth = parseFloat(url.searchParams.get("depth") || env.BAWAH || "25000000");
        const result = await doGeser(env, depth);
        return new Response(JSON.stringify(result), { headers });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers }); }
    }
    return new Response(JSON.stringify({ ok: false, error: "use /rate atau /geser" }), { status: 404, headers });
  },
};
