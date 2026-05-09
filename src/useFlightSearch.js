// voomax-frontend/src/hooks/useFlightSearch.js
// Substitui os dados mock do voomax-final.jsx por chamadas reais à API

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3000";

/**
 * Busca passagens reais.
 * Retorna { results, loading, error }
 */
export async function searchFlights({ origin, destination, departureDate, returnDate, adults = 1 }) {
  const res = await fetch(`${API_BASE}/api/search`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, destination, departureDate, returnDate, adults }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erro ${res.status}`);
  }

  const data = await res.json();
  return data.results; // Array normalizado, já rankeado
}

/**
 * Busca histórico de preços de uma rota.
 * Retorna array de { price, source, captured_at }
 */
export async function fetchPriceHistory(origin, destination, days = 30) {
  const params = new URLSearchParams({ origin, destination, days });
  const res = await fetch(`${API_BASE}/api/prices/history?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.history || [];
}

/**
 * Cria alerta de preço para uma rota.
 */
export async function createPriceAlert({ origin, destination, targetPrice, userId = "anonymous" }) {
  const res = await fetch(`${API_BASE}/api/alerts`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id:      userId,
      origin,
      destination,
      target_price: targetPrice,
    }),
  });

  if (!res.ok) throw new Error("Erro ao criar alerta");
  return res.json();
}

// ─── Mapeamento de resultado da API → formato dos cards ──────
// Os cards do voomax-final.jsx esperam este formato:
export function adaptApiResult(r) {
  return {
    id:        r.id,
    airline:   r.airline,
    logo:      r.airlineCode?.slice(0, 2).toUpperCase() || "??",
    color:     airlineColor(r.airlineCode),
    origin:    r.origin,
    destination: r.destination,
    departure: r.departure,
    arrival:   r.arrival,
    duration:  r.duration,
    stops:     r.stops,
    stopCity:  r.stopCities?.[0] || "",
    price:     r.price,
    miles:     r.miles || 0,
    program:   r.program || r.source,
    score:     r.score,
    tags:      buildTags(r),
    cabin:     formatCabin(r.cabin),
    aircraft:  "—",
    baggage:   r.baggage,
    cashback:  false,
    history:   [], // preenchido separadamente via fetchPriceHistory
    tip:       buildTip(r),
    buyUrl:    airlineBuyUrl(r.airlineCode),
  };
}

function buildTags(r) {
  const tags = [];
  if (r.stops === 0)              tags.push("Direto");
  if (r.price < 2500)             tags.push("Menor preço");
  if (r.score >= 95)              tags.push("Melhor custo-benefício");
  if (r.source === "seats.aero")  tags.push("Disponível em milhas");
  return tags;
}

function buildTip(r) {
  if (r.source === "seats.aero") {
    return `Disponível via ${r.program}. Verifique a disponibilidade de assentos prêmio e transfira pontos com antecedência.`;
  }
  return `Voo operado por ${r.airline}. Reserve com antecedência para garantir este preço.`;
}

function formatCabin(cabin) {
  const map = { ECONOMY:"Econômica", PREMIUM_ECONOMY:"Premium Economy", BUSINESS:"Executiva", FIRST:"Primeira Classe" };
  return map[cabin] || cabin || "Econômica";
}

function airlineColor(code) {
  const colors = {
    LA:"#c0392b", TP:"#0e7a50", EK:"#b45309", G3:"#e63946",
    AD:"#0066cc", AA:"#0078d2", LH:"#002d6e", AF:"#002395",
    KL:"#00a1de", IB:"#e10d0d", UA:"#003580",
  };
  return colors[code] || "#4a5e42";
}

function airlineBuyUrl(code) {
  const urls = {
    LA:"https://www.latam.com", TP:"https://www.tap.pt",
    G3:"https://www.voegol.com.br", AD:"https://www.voeazul.com.br",
    EK:"https://www.emirates.com", AA:"https://www.aa.com",
  };
  return urls[code] || "https://www.google.com/flights";
}
