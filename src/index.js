import * as StellarSdk from "@stellar/stellar-sdk";
const HORIZON = "https://horizon.stellar.org";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC = new StellarSdk.Asset("USDC", USDC_ISSUER);
const AQUA_ISSUER = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const AQUA = new StellarSdk.Asset("AQUA", AQUA_ISSUER);

const NAIK_POINT = 3;
const TICK = 0.0000001;

function n7(v) { return Number(v).toFixed(7); }

async function kirim(env, text) {
  return
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try { await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${env.TELEGRAM_CHAT_ID}&text=${encodeURIComponent(text + " SCN")}`); } catch {}
}

// BARU: 1x GET aja, gantiin order_book + accounts/offers
async function getOffersAQUA_USDC() {
  const url = `${HORIZON}/offers?selling_asset_type=credit_alphanum4&selling_asset_code=AQUA&selling_asset_issuer=${AQUA_ISSUER}&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=${USDC_ISSUER}&limit=200&order=asc`;
  const r = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error("horizon error " + r.status);
  const j = await r.json();
  let offers = j?._embedded?.records || [];
  // PENTING: /offers order=asc itu urut ID, bukan harga. Harus di-sort biar depth bener
  offers.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  return offers;
}

async function hitungPosisi(offers, myPrice, batasBawah, batasAtas) {
  if (!offers.length) throw new Error("offers kosong");
  const targetDepth = batasBawah;
  let depth = 0;
  let depthAtMyPrice = null;
  let pnewAtTarget = null;
  let top_ask = n7(parseFloat(offers[0].price));
  let last_ask_price = top_ask;

  for (const o of offers) {
    const askPrice = parseFloat(o.price);
    last_ask_price = n7(askPrice);
    // depth dalam USDC = amount AQUA * price
    const singleValue = parseFloat(o.amount) * askPrice;
    depth += singleValue;
    if (depthAtMyPrice === null && askPrice >= parseFloat(myPrice)) depthAtMyPrice = depth;
    if (pnewAtTarget === null && depth >= targetDepth) {
      pnewAtTarget = n7(askPrice + (NAIK_POINT * TICK));
      break;
    }
  }
  if (depthAtMyPrice === null) depthAtMyPrice = 999999999;
  if (!pnewAtTarget) pnewAtTarget = n7(parseFloat(last_ask_price) + (NAIK_POINT * TICK));

  return {
    depthTotal: Math.floor(depth),
    depthAtMyPrice: Math.floor(depthAtMyPrice),
    pnewAtTarget, top_ask, last_ask_price,
    ketemu: depthAtMyPrice !== 999999999,
    batas_bawah_eff: batasBawah, batas_atas_eff: batasAtas, target: Math.floor(targetDepth)
  };
}

async function doGeser(env, batasBawah, batasAtas) {
  const server = new StellarSdk.Horizon.Server(HORIZON);
  const kp = StellarSdk.Keypair.fromSecret(env.SECRET_KEY);
  const pub = kp.publicKey();

  // 1x GET DOANG DI SINI, gak ada GET kedua lagi
  const offers = await getOffersAQUA_USDC();

  // Cari offer lu dari data yang sama, filter seller == pub
  let my = null;
  for (const o of offers) {
    if (o.seller === pub && o.selling.asset_code === "AQUA" && o.buying.asset_code === "USDC") { my = o; break; }
  }
  if (!my) return { ok: true, geser: false, reason: "tidak ada offer AQUA->USDC" };
  const myPrice = n7(my.price);
  const amount = my.amount;
  const offerId = Number(my.id);

  const { depthTotal, depthAtMyPrice, pnewAtTarget, top_ask, batas_bawah_eff, batas_atas_eff, target } = await hitungPosisi(offers, myPrice, batasBawah, batasAtas);

  if (depthAtMyPrice >= batas_bawah_eff && depthAtMyPrice <= batas_atas_eff) {
    return { ok: true, geser: false, reason: `ok depth ${depthAtMyPrice}, masih aman, diem`, my_price: myPrice, depth_di_posisi_saya: depthAtMyPrice, depth_total: depthTotal, top_ask, batas_bawah: batas_bawah_eff, batas_atas: batas_atas_eff, target };
  }

  let pnew = pnewAtTarget;
  if (parseFloat(pnew) < 0.00021) {
    return { ok: true, geser: false, reason: "batas aman 0.00021", from: myPrice, pnew, amount, depth_di_posisi_saya: depthAtMyPrice, target };
  }
  if (pnew === myPrice) return { ok: true, geser: false, reason: "harga sama", pnew, my_price: myPrice, depth_di_posisi_saya: depthAtMyPrice };
  const selisih = Math.abs(parseFloat(pnew) - parseFloat(myPrice));
  if (selisih < 0.0000010) return { ok: true, geser: false, reason: `selisih cuma ${selisih.toFixed(7)}, kekecilan`, pnew, my_price: myPrice, depth_di_posisi_saya: depthAtMyPrice };

  try {
    const sourceAccount = await server.loadAccount(pub);
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, { fee: "10000", networkPassphrase: StellarSdk.Networks.PUBLIC }).addOperation(StellarSdk.Operation.manageSellOffer({ selling: AQUA, buying: USDC, amount: amount, price: pnew, offerId: offerId })).addMemo(StellarSdk.Memo.text("stellar.my.id")).setTimeout(100).build();
    tx.sign(kp);
    const res = await server.submitTransaction(tx);
    await kirim(env, `GESER AQUA/USDC ${myPrice} -> ${pnew} | depth saya ${depthAtMyPrice} -> target ${target} | ${amount} | ${res.hash}`);
    return { ok: true, geser: true, from: myPrice, pnew, amount, hash: res.hash, depth_di_posisi_saya: depthAtMyPrice, target };
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
    if (url.pathname === "/" || url.pathname === "/health") return new Response(JSON.stringify({ ok: true, service: "stellar-geser-worker", pair: "AQUA-USDC" }), { headers });
    if (url.pathname === "/rate") {
      try {
        const batasBawah = parseFloat(url.searchParams.get("bawah") || env.BAWAH || "100000");
        const batasAtas = parseFloat(url.searchParams.get("atas") || url.searchParams.get("depth") || env.ATAS || "300000");
        const offers = await getOffersAQUA_USDC(); // 1x GET juga di sini
        const d = await hitungPosisi(offers, "999999", batasBawah, batasAtas);
        return new Response(JSON.stringify({ ok: true, pair: "AQUA-USDC", batas_bawah: batasBawah, batas_atas: batasAtas, target: d.target, top_ask: d.top_ask, depth_total: d.depthTotal, pnew_di_target: d.pnewAtTarget }), { headers });
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
