// voomax-api/src/jobs/priceMonitor.js
// Roda a cada 6h via Supabase Edge Function ou cron externo (cron-job.org — gratuito)
// Verifica todos os alertas ativos, busca preço atual, notifica se atingiu meta

export async function runPriceMonitor() {
  console.log(`[PriceMonitor] Iniciando às ${new Date().toISOString()}`);

  // 1. Busca todos alertas ativos
  const alertsRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/price_alerts?active=eq.true&select=*`,
    { headers: { "apikey": process.env.SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } }
  );
  const alerts = await alertsRes.json();

  if (!alerts?.length) {
    console.log("[PriceMonitor] Nenhum alerta ativo.");
    return;
  }

  console.log(`[PriceMonitor] Verificando ${alerts.length} alertas...`);

  // 2. Agrupa por rota para não bater na API em duplicata
  const routes = {};
  for (const alert of alerts) {
    const key = `${alert.origin}:${alert.destination}`;
    if (!routes[key]) routes[key] = { origin: alert.origin, destination: alert.destination, alerts: [] };
    routes[key].alerts.push(alert);
  }

  // 3. Para cada rota, busca preço mais barato atual
  for (const [routeKey, route] of Object.entries(routes)) {
    try {
      const today = new Date().toISOString().slice(0, 10);

      // Busca Amadeus
      let lowestPrice = null;
      try {
        const { searchAmadeus } = await import("../index.js");
        const results = await searchAmadeus({
          origin:        route.origin,
          destination:   route.destination,
          departureDate: today,
          adults:        1,
        });
        if (results.length) {
          lowestPrice = Math.min(...results.map(r => r.price).filter(p => p > 0));
        }
      } catch (e) {
        console.warn(`[PriceMonitor] Amadeus falhou para ${routeKey}:`, e.message);
      }

      if (!lowestPrice) continue;

      console.log(`[PriceMonitor] ${routeKey} → preço atual: R$${lowestPrice}`);

      // 4. Salva no histórico
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/price_history`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": process.env.SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          origin:      route.origin,
          destination: route.destination,
          price:       lowestPrice,
          source:      "monitor-cron",
        }),
      });

      // 5. Verifica cada alerta desta rota
      for (const alert of route.alerts) {
        const hitTarget = alert.target_price && lowestPrice <= alert.target_price;

        // Atualiza last_price
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/price_alerts?id=eq.${alert.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": process.env.SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          },
          body: JSON.stringify({
            last_price:  lowestPrice,
            notified_at: hitTarget ? new Date().toISOString() : alert.notified_at,
          }),
        });

        if (hitTarget) {
          console.log(`[PriceMonitor] 🔔 ALERTA DISPARADO: ${routeKey} → R$${lowestPrice} (meta: R$${alert.target_price})`);
          // TODO Fase 4: enviar email/push/WhatsApp via Resend ou OneSignal
          await sendNotification(alert, lowestPrice);
        }
      }

    } catch (err) {
      console.error(`[PriceMonitor] Erro em ${routeKey}:`, err);
    }
  }

  console.log("[PriceMonitor] Concluído.");
}

// Placeholder — implementar na Fase 4 com Resend (email) ou OneSignal (push)
async function sendNotification(alert, currentPrice) {
  console.log(`[Notify] user=${alert.user_id} | ${alert.origin}→${alert.destination} | R$${currentPrice}`);
  // Exemplo com Resend:
  // await fetch("https://api.resend.com/emails", {
  //   method: "POST",
  //   headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
  //   body: JSON.stringify({
  //     from: "alertas@voomax.com.br",
  //     to:   alert.user_email,
  //     subject: `✈ Preço abaixou! ${alert.origin} → ${alert.destination} por R$${currentPrice}`,
  //     html: `<p>Sua meta era R$${alert.target_price}. O preço caiu para <strong>R$${currentPrice}</strong>.</p>`,
  //   }),
  // });
}

// Entry point direto (para testar: node src/jobs/priceMonitor.js)
if (process.argv[1].includes("priceMonitor")) {
  runPriceMonitor().catch(console.error);
}
