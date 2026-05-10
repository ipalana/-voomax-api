// voomax-api/src/index.js
// Stack: Hono + Duffel + Seats.aero + Supabase
// Deploy: Vercel Serverless Functions

import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

// ─── CORS ────────────────────────────────────────────────────
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
}));

// ─── Health check ────────────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// ─── POST /api/search ────────────────────────────────────────
// Body: { origin, destination, departureDate, returnDate?, adults? }
app.post("/search", async (c) => {
  const body = await c.req.json();
  const { origin, destination, departureDate, returnDate, adults = 1 } = body;

  if (!origin || !destination || !departureDate) {
    return c.json({ error: "origin, destination e departureDate são obrigatórios" }, 400);
  }

  const cacheKey = `search:${origin}:${destination}:${departureDate}:${returnDate || ""}:${adults}`;

  // 1. Cache Supabase (TTL 30 min)
  const cached = await getCached(cacheKey);
  if (cached) return c.json({ source: "cache", results: cached });

  // 2. Busca paralela: Duffel + Seats.aero
  const [duffelResults, seatsResults] = await Promise.allSettled([
    searchDuffel({ origin, destination, departureDate, returnDate, adults }),
    searchSeatsAero({ origin, destination, departureDate }),
  ]);

  const results = [
    ...(duffelResults.status === "fulfilled" ? duffelResults.value : []),
    ...(seatsResults.status  === "fulfilled" ? seatsResults.value  : []),
  ];

  if (results.length === 0) {
    return c.json({ error: "Nenhum resultado encontrado. Tente datas ou rotas diferentes." }, 404);
  }

  // 3. Normaliza, deduplica, rankeia
  const ranked = rankResults(deduplicateResults(results));

  // 4. Cache + histórico
  await setCached(cacheKey, ranked, 30);
  await savePriceHistory(origin, destination, ranked);

  return c.json({ source: "live", results: ranked });
});

// ─── GET /api/alerts ─────────────────────────────────────────
app.get("/alerts", async (c) => {
  const userId = c.req.query("user_id") || "anonymous";
  const res = await supabaseFetch(
    `price_alerts?user_id=eq.${userId}&order=created_at.desc`
  );
  const data = await res.json();
  return c.json({ alerts: data });
});

// ─── POST /api/alerts ────────────────────────────────────────
app.post("/alerts", async (c) => {
  const body = await c.req.json();
  const { user_id = "anonymous", origin, destination, target_price } = body;

  const res = await supabaseFetch("price_alerts", {
    method: "POST",
    body: JSON.stringify({ user_id, origin, destination, target_price }),
    headers: { "Prefer": "return=representation" },
  });

  if (!res.ok) return c.json({ error: "Erro ao criar alerta" }, 500);
  const data = await res.json();
  return c.json({ alert: data[0] }, 201);
});

// ─── GET /api/prices/history ─────────────────────────────────
app.get("/prices/history", async (c) => {
  const { origin, destination, days = "30" } = c.req.query();
  const since = new Date(Date.now() - Number(days) * 86400000).toISOString();

  const res = await supabaseFetch(
    `price_history?origin=eq.${origin}&destination=eq.${destination}&captured_at=gte.${since}&order=captured_at.asc&select=price,source,captured_at`
  );
  const data = await res.json();
  return c.json({ history: data });
});

export default app;

// ═══════════════════════════════════════════════════════════════
// DUFFEL SERVICE
// Docs: https://duffel.com/docs/api
// ═══════════════════════════════════════════════════════════════

const DUFFEL_BASE = "https://api.duffel.com";

async function duffelRequest(path, options = {}) {
  const res = await fetch(`${DUFFEL_BASE}${path}`, {
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
  // Step 1: criar offer request
  const slices = [{ origin, destination, departure_date: departureDate }];
  if (returnDate) {
    slices.push({ origin: destination, destination: origin, departure_date: returnDate });
  }

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

  const requestId = offerRequest.data.id;

  // Step 2: listar offers
  const offers = await duffelRequest(
    `/air/offers?offer_request_id=${requestId}&limit=20&sort=total_amount`
  );

  return (offers.data || []).map(normalizeDuffel);
}

function normalizeDuffel(offer) {
  const slice    = offer.slices[0];
  const segments = slice.segments;
  const first    = segments[0];
  const last     = segments[segments.length - 1];

  const priceRaw = parseFloat(offer.total_amount);
  const currency = offer.total_currency;
  // Converte para BRL (simplificado — em produção usar endpoint de câmbio)
  const priceBRL = currency === "BRL" ? Math.round(priceRaw) : Math.round(priceRaw * 5.1);

  return {
    id:           offer.id,
    source:       "duffel",
    airline:      first.marketing_carrier?.name || first.operating_carrier?.name || "—",
    airlineCode:  first.marketing_carrier?.iata_code || first.operating_carrier?.iata_code || "??",
    origin:       first.origin.iata_code,
    destination:  last.destination.iata_code,
    departure:    first.departing_at.slice(11, 16),
    arrival:      last.arriving_at.slice(11, 16),
    departureDate: first.departing_at.slice(0, 10),
    duration:     formatISODuration(slice.duration),
    stops:        segments.length - 1,
    stopCities:   segments.slice(0, -1).map(s => s.destination.iata_code),
    price:        priceBRL,
    miles:        0,
    program:      null,
    currency:     "BRL",
    cabin:        formatCabin(offer.cabin_class),
    baggage:      formatBaggage(offer),
    seatsLeft:    null,
    bookingToken: offer.id,
    raw:          offer,
  };
}

function formatISODuration(iso) {
  if (!iso) return "—";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  const h   = m?.[1] || "0";
  const min = (m?.[2] || "0").padStart(2, "0");
  return `${h}h${min}`;
}

function formatCabin(cabin) {
  const map = {
    economy:          "Econômica",
    premium_economy:  "Premium Economy",
    business:         "Executiva",
    first:            "Primeira Classe",
  };
  return map[cabin] || "Econômica";
}

function formatBaggage(offer) {
  const bags = offer.slices?.[0]?.segments?.[0]?.passengers?.[0]?.baggages || [];
  const checked = bags.find(b => b.type === "checked");
  if (!checked || checked.quantity === 0) return "Sem bagagem inclusa";
  return `${checked.quantity} vol. despachado`;
}

// ═══════════════════════════════════════════════════════════════
// SEATS.AERO SERVICE
// ═══════════════════════════════════════════════════════════════

async function searchSeatsAero({ origin, destination, departureDate }) {
  if (!process.env.SEATS_AERO_API_KEY) return []; // aguardando aprovação

  const res = await fetch(
    `https://seats.aero/partnerapi/search?origin_airport=${origin}&destination_airport=${destination}&cabin=Y&start_date=${departureDate}&end_date=${departureDate}`,
    {
      headers: { "Partner-Authorization": process.env.SEATS_AERO_API_KEY },
    }
  );

  if (!res.ok) {
    console.warn(`Seats.aero ${res.status}`);
    return [];
  }

  const data = await res.json();
  return (data.data || []).flatMap(normalizeSeatsAero);
}

function normalizeSeatsAero(route) {
  const programs = [
    { key: "YLATAMPassAvailable", milesKey: "YLATAMPassMileageCost", program: "LATAM Pass" },
    { key: "YSMilesAvailable",    milesKey: "YSMilesMileageCost",    program: "Smiles" },
    { key: "YAAdvantageAvailable",milesKey: "YAAvantageMileageCost", program: "AAdvantage" },
    { key: "YTAPMilesAvailable",  milesKey: "YTAPMilesMileageCost",  program: "Miles&Go" },
  ];

  return programs
    .filter(p => route[p.key] && route[p.milesKey])
    .map(p => ({
      id:           `seats-${route.ID}-${p.program.replace(/\s/g, "")}`,
      source:       "seats.aero",
      airline:      route.Source,
      airlineCode:  route.Source,
      origin:       route.OriginAirport,
      destination:  route.DestinationAirport,
      departure:    "—",
      arrival:      "—",
      departureDate: route.Date,
      duration:     "—",
      stops:        route.YDirect ? 0 : 1,
      price:        0,
      miles:        route[p.milesKey],
      program:      p.program,
      currency:     "MILES",
      cabin:        "Econômica",
      baggage:      "Verificar na cia",
      raw:          route,
    }));
}

// ═══════════════════════════════════════════════════════════════
// RANKER
// ═══════════════════════════════════════════════════════════════

function deduplicateResults(results) {
  const seen = new Set();
  return results.filter(r => {
    const key = `${r.airlineCode}:${r.departure}:${r.price}:${r.miles}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankResults(results) {
  const prices  = results.filter(r => r.price > 0).map(r => r.price);
  const minPrice = prices.length ? Math.min(...prices) : 1;

  return results
    .map(r => ({ ...r, score: calcScore(r, minPrice) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function calcScore(r, minPrice) {
  let score = 70;

  if (r.price > 0) {
    score += Math.round((minPrice / r.price) * 20);
  } else if (r.miles > 0) {
    score += 10;
  }

  if (r.stops === 0)      score += 15;
  else if (r.stops === 1) score -= 5;
  else                    score -= 15;

  const hMatch = r.duration.match(/(\d+)h/);
  if (hMatch) {
    const h = parseInt(hMatch[1]);
    if (h <= 8)      score += 10;
    else if (h <= 12) score += 5;
    else if (h > 20)  score -= 10;
  }

  if (r.source === "duffel")     score += 5;
  if (r.source === "seats.aero") score += 3;

  return Math.min(Math.max(Math.round(score), 0), 100);
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE HELPERS
// ═══════════════════════════════════════════════════════════════

function supabaseFetch(path, options = {}) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type":  "application/json",
      "apikey":         process.env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      ...(options.headers || {}),
    },
  });
}

async function getCached(key) {
  const now = new Date().toISOString();
  const res = await supabaseFetch(
    `search_cache?cache_key=eq.${encodeURIComponent(key)}&expires_at=gt.${now}&select=payload&limit=1`
  );
  const rows = await res.json();
  return rows?.[0]?.payload || null;
}

async function setCached(key, payload, ttlMinutes) {
  const expires = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  await supabaseFetch("search_cache", {
    method: "POST",
    body: JSON.stringify({ cache_key: key, payload, expires_at: expires }),
    headers: { "Prefer": "resolution=merge-duplicates" },
  });
}

async function savePriceHistory(origin, destination, results) {
  const rows = results
    .filter(r => r.price > 0)
    .map(r => ({ origin, destination, price: r.price, source: r.source }));
  if (!rows.length) return;
  await supabaseFetch("price_history", {
    method: "POST",
    body: JSON.stringify(rows),
  });
}
