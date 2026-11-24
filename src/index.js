// Worker: Rate Calculator by Depth - USDC/XLM
// GET /rate?depth=25000000&pair=USDC-XLM

const HORIZON = "https://horizon.stellar.org";

// PAIR UTAMA SEKARANG USDC-XLM
const PAIRS = {
  "USDC-XLM": {
    // Offer lu: selling USDC, buying XLM
    offer_selling: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    offer_buying: { code: "XLM", issuer: null }, // native
    // Orderbook yang dibaca: selling XLM, buying USDC (bids = yang beli XLM pake USDC)
    book_selling: { type: "native", code: null, issuer: null },
    book_buying: { type: "credit_alphanum4", code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    depth_unit: "XLM",
  },
  // Simpan yang lama biar masih bisa dipake kalo mau balik
  "USDC-AQUA": {
    offer_selling: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    offer_buying: { code: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
    book_selling: { type: "credit_alphanum4", code: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
    book_buying: { type: "credit_alphanum4", code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    depth_unit: "AQUA",
  },
};

function n7(v) { return Number(v).toFixed(7); }

function buildOrderBookUrl(pair) {
  const s = pair.book_selling;
  const b = pair.book_buying;
  let q = `selling_asset_type=${s.type}`;
  if (s.code) q += `&selling_asset_code=${s.code}&selling_asset_issuer=${s.issuer}`;
  q += `&buying_asset_type=${b.type}`;
  if (b.code) q += `&buying_asset_code=${b.code}&buying_asset_issuer=${b.issuer}`;
  return `${HORIZON}/order_book?${q}&limit=200`;
}

async function getMyOffer(env, pairKey) {
  if (!env.PUBLIC_KEY) return null;
  try {
    const r = await fetch(`${HORIZON}/accounts/${env.PUBLIC_KEY}/offers`);
    const j = await r.json();
    const recs = j?._embedded?.records || [];
    const pair = PAIRS[pairKey];
    for (const o of recs) {
      const sCode = o.selling.asset_code || "XLM"; // kalo native, asset_code gak ada
      const bCode = o.buying.asset_code || "XLM";
      if (sCode === pair.offer_selling.code && bCode === pair.offer_buying.code) {
        return { id: Number(o.id), amount: o.amount, price: parseFloat(o.price) };
      }
    }
  } catch {}
  return null;
}

async function calcRate(env, pairKey, batasDepth) {
  const pair = PAIRS[pairKey] || PAIRS["USDC-XLM"];
  const url = buildOrderBookUrl(pair);

  const r = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error("horizon error " + r.status);
  const book = await r.json();
  const bids = book?.bids || [];
  if (!bids.length) throw new Error("orderbook bids kosong");

  let depth = 0;
  let found = null;

  for (const v of bids) {
    const bn = parseFloat(v.price_r.n);
    const bd = parseFloat(v.price_r.d);
    const bam = parseFloat(v.amount);
    const bid = bd / bn; // harga XLM dalam USDC, rumus lu yang lama
    const xlmValue = bam * bid; // depth dalam XLM
    depth += xlmValue;

    if (depth > batasDepth) {
      found = {
        bid_raw: bid,
        bid: n7(bid),
        pnew: n7(bid + 0.0000003),
        depth_at_hit: depth,
      };
      break;
    }
  }

  const my = await getMyOffer(env, pairKey);
  let should_geser = false;
  if (found) {
    if (!my) should_geser = true;
    else if (found.pnew !== n7(my.price)) should_geser = true;
  }

  return {
    ok: true,
    pair: pairKey,
    batas_depth: batasDepth,
    depth_unit: pair.depth_unit,
    top_bid: n7(parseFloat(bids[0].price_r.d) / parseFloat(bids[0].price_r.n)),
    depth_total_checked: depth,
    depth_hit: !!found,
    target: found,
    my_offer: my,
    should_geser,
    timestamp: new Date().toISOString(),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "stellar-rate-worker", default_pair: "USDC-XLM" }), { headers });
    }

    if (url.pathname === "/rate") {
      try {
        const depthParam = parseFloat(url.searchParams.get("depth") || env.BAWAH || "25000000");
        const pair = url.searchParams.get("pair") || "USDC-XLM";
        const result = await calcRate(env, pair, depthParam);
        return new Response(JSON.stringify(result), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers });
      }
    }

    return new Response(JSON.stringify({ ok: false, error: "not found, use /rate" }), { status: 404, headers });
  },
};
