import * as StellarSdk from "@stellar/stellar-sdk";
const HORIZON = "https://horizon.stellar.org";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC = new StellarSdk.Asset("USDC", USDC_ISSUER);
const XLM = StellarSdk.Asset.native();
function n7(v) { return Number(v).toFixed(7); }
async function kirim(env, text) {
  return
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try { await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${env.TELEGRAM_CHAT_ID}&text=${encodeURIComponent(text + " SCN")}`); } catch {}
}
async function hitungPosisi(env, myPrice, targetDepth) {
  const url = `${HORIZON}/order_book?selling_asset_type=credit_alphanum4&selling_asset_code=USDC&selling_asset_issuer=${USDC_ISSUER}&buying_asset_type=native&limit=200`;
  const r = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error("horizon error " + r.status);
  const book = await r.json();
  const asks = book?.asks || [];
  if (!asks.length) throw new Error("asks kosong");
  let depth = 0;
  let depthAtMyPrice = null;
  let pnewAtTarget = null;
  let top_ask = n7(parseFloat(asks[0].price_r.n) / parseFloat(asks[0].price_r.d));
  let last_ask_price = top_ask;
  for (const v of asks) {
    const askPrice = parseFloat(v.price_r.n) / parseFloat(v.price_r.d);
    last_ask_price = n7(askPrice);
    const amountUSDC = parseFloat(v.amount);
    // FIX: depth = amount * price, sama kayak spreadsheet lu
    // amount USDC * harga XLM per USDC = depth dalam XLM
    depth += amountUSDC * askPrice;
    if (depthAtMyPrice === null && askPrice >= parseFloat(myPrice)) depthAtMyPrice = depth;
    if (pnewAtTarget === null && depth > targetDepth) pnewAtTarget = n7(askPrice - 0.0000003);
  }
  if (depthAtMyPrice === null) depthAtMyPrice = 999999999;
  if (!pnewAtTarget) pnewAtTarget = top_ask;
  return { depthTotal: Math.floor(depth), depthAtMyPrice: Math.floor(depthAtMyPrice), pnewAtTarget, top_ask, last_ask_price, ketemu: depthAtMyPrice !== 999999999 };
}
async function doGeser(env, batasBawah, batasAtas) {
  const server = new StellarSdk.Horizon.Server(HORIZON);
  const kp = StellarSdk.Keypair.fromSecret(env.SECRET_KEY);
  const pub = kp.publicKey();
  const accRes = await fetch(`${HORIZON}/accounts/${pub}/offers`);
  const acc = await accRes.json();
  const offers = acc?._embedded?.records || [];
  let my = null;
  for (const o of offers) {
    const s = o.selling.asset_code || "XLM";
    const b = o.buying.asset_code || "XLM";
    if (s === "USDC" && b === "XLM") { my = o; break; }
  }
  if (!my) return { ok: true, geser: false, reason: "tidak ada offer USDC->XLM" };
  const myPrice = n7(my.price);
  const amount = my.amount;
  const offerId = Number(my.id);
  const targetDepth = (batasBawah + batasAtas) / 2;
  const { depthTotal, depthAtMyPrice, pnewAtTarget, top_ask, last_ask_price, ketemu } = await hitungPosisi(env, myPrice, targetDepth);
  if (depthAtMyPrice >= batasBawah && depthAtMyPrice <= batasAtas) {
    return { ok: true, geser: false, reason: `posisi udah pas di depth ${depthAtMyPrice}, masih di antara ${batasBawah}-${batasAtas}, diem`, my_price: myPrice, depth_di_posisi_saya: depthAtMyPrice, depth_total: depthTotal, top_ask, last_ask_price, ketemu, batas_bawah: batasBawah, batas_atas: batasAtas, target: targetDepth };
  }
  const pnew = pnewAtTarget;
  if (pnew === myPrice) return { ok: true, geser: false, reason: "harga sama", pnew, my_price: myPrice, depth_di_posisi_saya: depthAtMyPrice };
  const selisih = Math.abs(parseFloat(pnew) - parseFloat(myPrice));
  if (selisih < 0.0000010) return { ok: true, geser: false, reason: `selisih cuma ${selisih.toFixed(7)}, kekecilan`, pnew, my_price: myPrice, depth_di_posisi_saya: depthAtMyPrice };
  try {
    const sourceAccount = await server.loadAccount(pub);
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, { fee: "10000", networkPassphrase: StellarSdk.Networks.PUBLIC }).addOperation(StellarSdk.Operation.manageSellOffer({ selling: USDC, buying: XLM, amount: amount, price: pnew, offerId: offerId })).addMemo(StellarSdk.Memo.text("stellar.my.id")).setTimeout(100).build();
    tx.sign(kp);
    const res = await server.submitTransaction(tx);
    await kirim(env, `GESER ${myPrice} -> ${pnew} | depth saya ${depthAtMyPrice} -> target ${targetDepth} | ${amount} | ${res.hash}`);
    return { ok: true, geser: true, from: myPrice, pnew, amount, hash: res.hash, depth_di_posisi_saya: depthAtMyPrice, target: targetDepth };
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
        const batasBawah = parseFloat(url.searchParams.get("bawah") || env.BAWAH || "100000");
        const batasAtas = parseFloat(url.searchParams.get("atas") || url.searchParams.get("depth") || env.ATAS || "300000");
        const targetDepth = (batasBawah + batasAtas) / 2;
        const { depthTotal, pnewAtTarget, top_ask } = await hitungPosisi(env, "999999", targetDepth);
        return new Response(JSON.stringify({ ok: true, pair: "USDC-XLM", batas_bawah: batasBawah, batas_atas: batasAtas, target: targetDepth, top_ask, depth_total: depthTotal, pnew_di_target: pnewAtTarget }), { headers });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers }); }
    }
    if (url.pathname === "/geser") {
      if (env.WORKER_KEY && key !== env.WORKER_KEY) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers });
      try {
        const batasBawah = parseFloat(url.searchParams.get("bawah") || env.BAWAH || "100000");
        const batasAtas = parseFloat(url.searchParams.get("atas") || url.searchParams.get("depth") || env.ATAS || "300000");
        const result = await doGeser(env, batasBawah, batasAtas);
        return new Response(JSON.stringify(result), { headers });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers }); }
    }
    return new Response(JSON.stringify({ ok: false, error: "use /rate atau /geser" }), { status: 404, headers });
  },
};
