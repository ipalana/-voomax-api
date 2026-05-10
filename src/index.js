// api/index.js
// Vercel Node.js Serverless Function

export default async function handler(req, res) {
  const path = new URL(req.url, "https://x").pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // ── Health check ──────────────────────────────────────────
  if (path === "/api/health" || path === "/health") {
    res.status(200).json({ ok: true, ts: new Date().toISOString() });
    return;
  }

  // ── Search ────────────────────────────────────────────────
  if (path === "/api/search" || path === "/search") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    let body = "";
    for await (const chunk of req) body += chunk;
    const { origin, destination, departureDate, returnDate, adults = 1 } = JSON.parse(body);

    if (!origin || !destination || !departureDate) {
      res.status(400).json({ error: "origin, destination e departureDate são obrigatórios" });
      return;
    }

    const [duffelResults, seatsResults] = await Promise.allSettled([
      searchDuffel({ origin, destination, departureDate, returnDate, adults }),
      searchSeatsAero({ origin, destination, departureDate }),
    ]);

    const results = [
      ...(duffelResults.status === "fulfilled" ? duffelResults.value : []),
      ...(seatsResults.status  === "fulfilled" ? seatsResults.value  : []),
    ];

    if (!results.length) { res.status(404).json({ error: "Nenhum resultado encontrado." }); return; }

    const ranked = rankResults(deduplicateResults(results));
    savePriceHistory(origin, destination, ranked).catch(() => {});
    res.status(200).json({ source: "live", results: ranked });
    return;
  }

  // ── Alerts GET ───────────────────────────────────────────
  if ((path === "/api/alerts" || path === "/alerts") && req.method === "GET") {
    const userId = new URL(req.url, "https://x").searchParams.get("user_id") || "anonymous";
    const r = await supabaseFetch(`price_alerts?user_id=eq.${userId}&order=created_at.desc`);
    const data = await r.json();
    res.status(200).json({ alerts: data });
    return;
  }

  // ── Alerts POST ──────────────────────────────────────────
  if ((path === "/api/alerts" || path === "/alerts") && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { user_id = "anonymous", origin, destination, target_price } = JSON.parse(body);
    const r = await supabaseFetch("price_alerts", {
      method: "POST",
      body: JSON.stringify({ user_id, origin, destination, target_price }),
      headers: { "Prefer": "return=representation" },
    });
    const data = await r.json();
    res.status(201).json({ alert: data[0] });
    return;
  }

  res.status(404).json({ error: "Not found" });
}

// ═══════════════════════════════════════════════════════════
// DUFFEL
// ═══════════════════════════════════════════════════════════
async function duffelRequest(path, options = {}) {
  const res = await fetch(`https://api.duffel.com${path}`, {
    ...options,
    headers: {
      "Authorization":  `Bearer ${process.env.DUFFEL_API_KEY}`,
      "Duffel-Version": "v2",
      "Content-Type":   "application/json",
      "Accept":         "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Duffel ${res.status}: ${JSON.stringify(err.errors?.[0] || err)}`);
  }
  return res.json();
}

async function searchDuffel({ origin, destination, departureDate, returnDate, adults }) {
  const slices = [{ origin, destination, departure_date: departureDate }];
  if (returnDate) slices.push({ origin: destination, destination: origin, departure_date: returnDate });

  const offerRequest = await duffelRequest("/air/offer_requests", {
    method: "POST",
    body: JSON.stringify({
      data: {
        slices,
        passengers: Array.from({ length: Number(adults) }, () => ({ type: "adult" })),
        cabin_class: "economy",
      },
    }),
  });

  const offers = await duffelRequest(
    `/air/offers?offer_request_id=${offerRequest.data.id}&limit=20&sort=total_amount`
  );
  return (offers.data || []).map(normalizeDuffel);
}

function normalizeDuffel(offer) {
  const slice = offer.slices[0];
  const segs  = slice.segments;
  const first = segs[0], last = segs[segs.length - 1];
  const priceRaw = parseFloat(offer.total_amount);
  const priceBRL = offer.total_currency === "BRL" ? Math.round(priceRaw) : Math.round(priceRaw * 5.1);
  return {
    id: offer.id, source: "duffel",
    airline:     first.marketing_carrier?.name || first.operating_carrier?.name || "—",
    airlineCode: first.marketing_carrier?.iata_code || "??",
    origin:      first.origin.iata_code,
    destination: last.destination.iata_code,
    departure:   first.departing_at.slice(11, 16),
    arrival:     last.arriving_at.slice(11, 16),
    departureDate: first.departing_at.slice(0, 10),
    duration:    formatDuration(slice.duration),
    stops:       segs.length - 1,
    stopCities:  segs.slice(0, -1).map(s => s.destination.iata_code),
    price: priceBRL, miles: 0, program: null, currency: "BRL",
    cabin:   formatCabin(offer.cabin_class),
    baggage: formatBaggage(offer),
    bookingToken: offer.id,
  };
}

function formatDuration(iso) {
  if (!iso) return "—";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return `${m?.[1] || "0"}h${(m?.[2] || "0").padStart(2,"0")}`;
}

function formatCabin(c) {
  return { economy:"Econômica", premium_economy:"Premium Economy", business:"Executiva", first:"Primeira Classe" }[c] || "Econômica";
}

function formatBaggage(offer) {
  const bags = offer.slices?.[0]?.segments?.[0]?.passengers?.[0]?.baggages || [];
  const ch = bags.find(b => b.type === "checked");
  return (!ch || ch.quantity === 0) ? "Sem bagagem inclusa" : `${ch.quantity} vol. despachado`;
}

// ═══════════════════════════════════════════════════════════
// SEATS.AERO
// ═══════════════════════════════════════════════════════════
async function searchSeatsAero({ origin, destination, departureDate }) {
  if (!process.env.SEATS_AERO_API_KEY) return [];
  const res = await fetch(
    `https://seats.aero/partnerapi/search?origin_airport=${origin}&destination_airport=${destination}&cabin=Y&start_date=${departureDate}&end_date=${departureDate}`,
    { headers: { "Partner-Authorization": process.env.SEATS_AERO_API_KEY } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).flatMap(r => {
    const progs = [
      { key:"YLATAMPassAvailable", mk:"YLATAMPassMileageCost", p:"LATAM Pass" },
      { key:"YSMilesAvailable",    mk:"YSMilesMileageCost",    p:"Smiles" },
    ];
    return progs.filter(x => r[x.key] && r[x.mk]).map(x => ({
      id:`seats-${r.ID}-${x.p}`, source:"seats.aero",
      airline:r.Source, airlineCode:r.Source,
      origin:r.OriginAirport, destination:r.DestinationAirport,
      departure:"—", arrival:"—", departureDate:r.Date,
      duration:"—", stops:r.YDirect?0:1,
      price:0, miles:r[x.mk], program:x.p, currency:"MILES",
      cabin:"Econômica", baggage:"Verificar na cia",
    }));
  });
}

// ═══════════════════════════════════════════════════════════
// RANKER
// ═══════════════════════════════════════════════════════════
function deduplicateResults(results) {
  const seen = new Set();
  return results.filter(r => {
    const k = `${r.airlineCode}:${r.departure}:${r.price}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function rankResults(results) {
  const prices = results.filter(r => r.price > 0).map(r => r.price);
  const min = prices.length ? Math.min(...prices) : 1;
  return results.map(r => ({ ...r, score: calcScore(r, min) }))
    .sort((a,b) => b.score - a.score).slice(0, 10);
}

function calcScore(r, min) {
  let s = 70;
  if (r.price > 0) s += Math.round((min / r.price) * 20);
  else if (r.miles > 0) s += 10;
  if (r.stops === 0) s += 15;
  else if (r.stops === 1) s -= 5;
  else s -= 15;
  return Math.min(Math.max(s, 0), 100);
}

// ═══════════════════════════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════════════════════════
function supabaseFetch(path, options = {}) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": process.env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      ...(options.headers || {}),
    },
  });
}

async function savePriceHistory(origin, destination, results) {
  const rows = results.filter(r => r.price > 0)
    .map(r => ({ origin, destination, price: r.price, source: r.source }));
  if (!rows.length) return;
  await supabaseFetch("price_history", { method: "POST", body: JSON.stringify(rows) });
}
