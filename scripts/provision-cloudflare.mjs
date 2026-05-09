#!/usr/bin/env node

const required = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "BUHE_LI_ZONE_ID",
  "NAS_TUNNEL_ID",
  "MYSQL_HOSTNAME",
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}`);
  }
}

const headers = {
  Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
  "Content-Type": "application/json",
};

async function cf(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const body = await response.json();
  if (!body.success) {
    throw new Error(`${path}: ${JSON.stringify(body.errors)}`);
  }
  return body.result;
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const zoneId = process.env.BUHE_LI_ZONE_ID;
const tunnelId = process.env.NAS_TUNNEL_ID;
const hostname = process.env.MYSQL_HOSTNAME;
const tunnelTarget = `${tunnelId}.cfargotunnel.com`;

const tunnelConfig = await cf(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`);
const config = tunnelConfig.config;
const fallback = config.ingress.find((rule) => typeof rule.service === "string" && rule.service.startsWith("http_status:"));
config.ingress = config.ingress.filter(
  (rule) => rule.hostname !== hostname && !(typeof rule.service === "string" && rule.service.startsWith("http_status:")),
);
config.ingress.push({ hostname, service: "tcp://127.0.0.1:3306", originRequest: {} });
if (fallback) {
  config.ingress.push(fallback);
}
await cf(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
  method: "PUT",
  body: JSON.stringify({ config }),
});

const dnsRecords = await cf(`/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`);
const dnsBody = {
  type: "CNAME",
  name: hostname,
  content: tunnelTarget,
  proxied: true,
  ttl: 1,
  comment: "Endstone Live Map MySQL tunnel for Cloudflare Hyperdrive",
};
if (dnsRecords.length > 0) {
  await cf(`/zones/${zoneId}/dns_records/${dnsRecords[0].id}`, {
    method: "PUT",
    body: JSON.stringify(dnsBody),
  });
} else {
  await cf(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(dnsBody),
  });
}

console.log(`Provisioned ${hostname} -> ${tunnelTarget}`);
