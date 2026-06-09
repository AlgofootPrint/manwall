const base = process.env.MANWALL_BASE_URL ?? "http://localhost:8787";
for (const path of ["/api/health", "/api/ready", "/api/capabilities"]) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  console.log(`${path} ${response.status}`);
}
