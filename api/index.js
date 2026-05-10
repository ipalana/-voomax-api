// api/index.js — Vercel Serverless Function
// Stack:  SerpAPI (Google Flights) + Supabase

export default async function handler(req, res) {
  const url = new URL(req.url, "https://x");
  const path = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json");
  
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // ── Health ────────────────────────────────────────────────
  if (path === "/api/health" || path === "/health") {
    res.status(200).json({ ok: true, ts: new Date().toISOString(), source: "serpapi" });
    return;
  }

  // ── Search ────────────────────────────────────────────────
  if ((path === "/api/search" || path === "/search") && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { origin, destination, departureDate, returnDate, adults = 1 } = JSON.parse(body);

    if (!origin || !destination || !departureDate) {
      res.status(400).json({ error: "origin, destination e departureDate são obrigatórios" });
      return;
    }

    try {
      const tripType = returnDate ? 1 : 2; // 1=roundtrip 2=oneway
      const flights = await searchGoogleFlights({ origin, destination, date: departureDate, returnDate, adults, tripType });

      if (!flights.length) {
        res.status(404).json({ error: "Nenhum voo encontrado para esta rota e data." });
        return;
      }

      const ranked = rankResults(flights);
      savePriceHistory(origin, destination, ranked).catch(() => {});
      res.status(200).json({ source: "google_flights", results: ranked });

    } catch (err) {
      console.error("Search error:", err.message);
      res.status(500).json({ error: "Erro ao buscar voos: " + err.message });
    }
    return;
  }

  // ── Alerts GET ───────────────────────────────────────────
  if ((path === "/api/alerts" || path === "/alerts") && req.method === "GET") {
    const userId = url.searchParams.get("user_id") || "anonymous";
    try {
      const r = await supabaseFetch(`price_alerts?user_id=eq.${userId}&order=created_at.desc`);
      const data = await r.json();
      res.status(200).json({ alerts: data });
    } catch { res.status(200).json({ alerts: [] }); }
    return;
  }

  // ── Alerts POST ──────────────────────────────────────────
  if ((path === "/api/alerts" || path === "/alerts") && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { user_id = "anonymous", origin, destination, target_price } = JSON.parse(body);
    try {
      const r = await supabaseFetch("price_alerts", {
        method: "POST",
        body: JSON.stringify({ user_id, origin, destination, target_price }),
        headers: { "Prefer": "return=representation" },
      });
      const data = await r.json();
      res.status(201).json({ alert: data[0] });
    } catch { res.status(500).json({ error: "Erro ao criar alerta" }); }
    return;
  }

  res.status(404).json({ error: "Not found" });
}

// ═══════════════════════════════════════════════════════════
// SERPAPI — GOOGLE FLIGHTS
// Docs: https://serpapi.com/google-flights-api
// ═══════════════════════════════════════════════════════════

async function searchGoogleFlights({ origin, destination, date, returnDate, adults, tripType }) {
  const SERP_KEY = process.env.SERPAPI_KEY;
  if (!SERP_KEY) throw new Error("SERPAPI_KEY não configurada");

  const params = new URLSearchParams({
    engine:        "google_flights",
    departure_id:  origin,
    arrival_id:    destination,
    outbound_date: date,
    currency:      "BRL",
    hl:            "pt",
    gl:            "br",
    adults:        String(adults),
    type:          String(tripType || 2),
    api_key:       SERP_KEY,
  });

  if (returnDate && tripType === 1) params.set("return_date", returnDate);

  const res = await fetch(`https://serpapi.com/search.json?${params}`);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SerpAPI ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();

  // Log para debug
  console.log("SerpAPI status:", data.search_metadata?.status);
  console.log("Best flights:", data.best_flights?.length || 0);
  console.log("Other flights:", data.other_flights?.length || 0);
  if (data.error) console.log("SerpAPI error:", data.error);

  const allFlights = [
    ...(data.best_flights || []),
    ...(data.other_flights || []),
  ];

  return allFlights.map((flight, i) => normalizeGoogleFlight(flight, i));
}

function normalizeGoogleFlight(flight, index) {
  const leg     = flight.flights?.[0] || {};
  const lastLeg = flight.flights?.[flight.flights.length - 1] || leg;
  const airline = leg.airline || "—";
  const code    = leg.airline_logo
    ? (leg.airline_logo.match(/\/([A-Z0-9]{2})[_\.]/) || [])[1] || "??"
    : "??";

  const stops      = (flight.flights?.length || 1) - 1;
  const stopCities = flight.layovers?.map(l => l.name || "") || [];
  const price      = flight.price || 0;
  const duration   = formatMinutes(flight.total_duration);

  const tags = [];
  if (flight.type === "Best flights") tags.push("Melhor opção");
  if (stops === 0) tags.push("Direto");
  if (price > 0 && index === 0) tags.push("Recomendado");

  return {
    id:           `gf-${index}-${code}`,
    source:       "google_flights",
    airline,
    airlineCode:  code,
    origin:       leg.departure_airport?.id || "",
    destination:  lastLeg.arrival_airport?.id || "",
    departure:    parseTime(leg.departure_airport?.time),
    arrival:      parseTime(lastLeg.arrival_airport?.time),
    departureDate: date,
    duration,
    stops,
    stopCities,
    stopCity:     stopCities[0] || "",
    price,
    miles:        0,
    program:      null,
    currency:     "BRL",
    cabin:        formatCabin(flight.travel_class),
    baggage:      formatBaggage(flight),
    logo:         code.slice(0, 2).toUpperCase(),
    color:        airlineColor(airline),
    buyUrl:       `https://www.google.com/flights?hl=pt#search;f=${leg.departure_airport?.id};t=${lastLeg.arrival_airport?.id}`,
    tags,
    score:        0,
    tip:          buildTip(airline, stops, price),
    cashback:     false,
    history:      [price],
  };
}

function parseTime(timeStr) {
  if (!timeStr) return "—";
  // SerpAPI returns "YYYY-MM-DD HH:MM" format
  if (timeStr.includes(" ")) return timeStr.split(" ")[1];
  // Fallback: already "HH:MM"
  return timeStr.slice(0, 5);
}

function formatMinutes(mins) {
  if (!mins) return "—";
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
}

function formatCabin(cabin) {
  return { "Economy":"Econômica", "Premium economy":"Premium Economy", "Business":"Executiva", "First":"Primeira Classe" }[cabin] || "Econômica";
}

function formatBaggage(flight) {
  const ext = flight.flights?.[0]?.extensions || [];
  const bag = ext.find(e => /bag|mala|bagagem/i.test(e));
  return bag || "Verificar na companhia";
}

function airlineColor(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("latam"))     return "#e31837";
  if (n.includes("gol"))       return "#f47920";
  if (n.includes("azul"))      return "#1c3f94";
  if (n.includes("american"))  return "#0078d2";
  if (n.includes("united"))    return "#003580";
  if (n.includes("delta"))     return "#c01933";
  if (n.includes("emirates"))  return "#c0392b";
  if (n.includes("tap"))       return "#0e7a50";
  if (n.includes("air france")) return "#002395";
  if (n.includes("lufthansa")) return "#002d6e";
  if (n.includes("iberia"))    return "#e10d0d";
  return "#4a7ab5";
}

function buildTip(airline, stops, price) {
  if (stops === 0) return `Voo direto operado por ${airline}. Reserve com antecedência para garantir este preço.`;
  if (price > 0 && price < 1500) return `Ótimo preço com ${stops} escala. Compare com voos diretos para avaliar custo-benefício.`;
  return `Voo operado por ${airline}. Confira a política de bagagem antes de comprar.`;
}

// ═══════════════════════════════════════════════════════════
// RANKER
// ═══════════════════════════════════════════════════════════

function rankResults(results) {
  const prices   = results.filter(r => r.price > 0).map(r => r.price);
  const minPrice = prices.length ? Math.min(...prices) : 1;
  return results
    .map(r => ({ ...r, score: calcScore(r, minPrice) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function calcScore(r, minPrice) {
  let s = 70;
  if (r.price > 0) s += Math.round((minPrice / r.price) * 20);
  if (r.stops === 0) s += 15;
  else if (r.stops === 1) s -= 5;
  else s -= 15;
  const h = parseInt((r.duration.match(/(\d+)h/) || [])[1] || "0");
  if (h > 0 && h <= 4) s += 10;
  else if (h <= 8) s += 5;
  else if (h > 18) s -= 10;
  return Math.min(Math.max(Math.round(s), 0), 100);
}

// ═══════════════════════════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════════════════════════

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

async function savePriceHistory(origin, destination, results) {
  const rows = results.filter(r => r.price > 0)
    .map(r => ({ origin, destination, price: r.price, source: r.source }));
  if (!rows.length) return;
  await supabaseFetch("price_history", { method: "POST", body: JSON.stringify(rows) });
}
