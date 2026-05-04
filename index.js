const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const RELAY_ENDPOINT = process.env.RELAY_ENDPOINT;
const TOKEN = process.env.TOKEN;
const PORT = parseInt(process.env.PORT || "4000", 10);
const HEARTBEAT_TTL = parseInt(process.env.HEARTBEAT_TTL || "60", 10);
const WG_INTERFACE = process.env.WG_INTERFACE || "wg0";
const WG_ADDRESS = process.env.WG_ADDRESS || "10.0.0.1/8";
const WG_PORT = parseInt(process.env.WG_PORT || "51820", 10);
const MESH_IP_START = process.env.MESH_IP_START || "10.0.0.2";

if (!RELAY_ENDPOINT || !TOKEN) {
  console.error("RELAY_ENDPOINT and TOKEN are required");
  process.exit(1);
}

const keyDir = "/app/keys";
const privateKeyPath = path.join(keyDir, "private.key");
const publicKeyPath = path.join(keyDir, "public.key");

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts });
}

function generateKeypair() {
  if (!fs.existsSync(keyDir)) {
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  }
  const priv = exec("wg genkey").trim();
  fs.writeFileSync(privateKeyPath, priv, { mode: 0o600 });
  const pub = exec("wg pubkey", { input: priv + "\n" }).trim();
  fs.writeFileSync(publicKeyPath, pub, { mode: 0o600 });
  return { privateKey: priv, publicKey: pub };
}

function loadOrGenerateKeypair() {
  if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    const priv = fs.readFileSync(privateKeyPath, "utf-8").trim();
    const pub = fs.readFileSync(publicKeyPath, "utf-8").trim();
    if (priv && pub) return { privateKey: priv, publicKey: pub };
  }
  return generateKeypair();
}

const relayKeys = loadOrGenerateKeypair();

function setupWg() {
  const tmpKeyPath = `/tmp/wg-priv-${process.pid}`;
  try {
    try { exec(`ip link del ${WG_INTERFACE}`); } catch (_) {}
    try { exec("modprobe wireguard"); } catch (_) {}
    exec(`ip link add ${WG_INTERFACE} type wireguard`);

    fs.writeFileSync(tmpKeyPath, relayKeys.privateKey + "\n", { mode: 0o600 });
    try {
      exec(`wg set ${WG_INTERFACE} private-key ${tmpKeyPath} listen-port ${WG_PORT}`);
    } finally {
      try { fs.unlinkSync(tmpKeyPath); } catch (_) {}
    }

    exec(`ip address add ${WG_ADDRESS} dev ${WG_INTERFACE}`);
    exec(`ip link set ${WG_INTERFACE} mtu 1280`);
    exec(`ip link set ${WG_INTERFACE} up`);
    console.log(`WireGuard ${WG_INTERFACE} up on ${WG_ADDRESS}:${WG_PORT}`);
  } catch (e) {
    try { fs.unlinkSync(tmpKeyPath); } catch (_) {}
    console.error(`Failed to bring up ${WG_INTERFACE}:`, e.stderr?.trim() || e.message);
    console.error("Hint: ensure WireGuard kernel module is loaded (modprobe wireguard)");
    process.exit(1);
  }
}

setupWg();

const nodes = new Map();
const meshIpCounter = { current: ipToInt(MESH_IP_START) };

function ipToInt(ip) {
  return ip.split(".").reduce((a, b) => (a << 8) | parseInt(b, 10), 0) >>> 0;
}

function intToIp(int) {
  return [(int >>> 24) & 0xff, (int >>> 16) & 0xff, (int >>> 8) & 0xff, int & 0xff].join(".");
}

function assignMeshIp(nodeId) {
  for (const [_, n] of nodes) {
    if (n.node_id === nodeId) return n.mesh_ip;
  }
  const ip = intToIp(meshIpCounter.current);
  meshIpCounter.current++;
  return ip;
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const match = h.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function addWgPeer(pubkey, allowedIps) {
  const ips = allowedIps.join(",");
  try {
    exec(`wg set ${WG_INTERFACE} peer ${pubkey} allowed-ips ${ips} persistent-keepalive 25`);
    console.log(`Peer added to ${WG_INTERFACE}: ${pubkey} allowed-ips ${ips}`);
    return true;
  } catch (e) {
    console.error(`Failed to add peer ${pubkey}:`, e.stderr?.trim() || e.message);
    return false;
  }
}

function removeWgPeer(pubkey) {
  try {
    exec(`wg set ${WG_INTERFACE} peer ${pubkey} remove`);
    console.log(`Peer removed from ${WG_INTERFACE}: ${pubkey}`);
    return true;
  } catch (e) {
    console.error(`Failed to remove peer ${pubkey}:`, e.stderr?.trim() || e.message);
    return false;
  }
}

app.get("/health", (_req, res) => {
  const active = Array.from(nodes.values()).filter(n => Date.now() - n.last_seen < HEARTBEAT_TTL * 1000).length;
  res.json({ status: "ok", nodes: active });
});

app.post("/register", auth, (req, res) => {
  const { node_id, pubkey, name, allowed_ips } = req.body;
  if (!node_id || !pubkey || !name || !Array.isArray(allowed_ips)) {
    return res.status(400).json({ error: "missing fields" });
  }
  const existing = Array.from(nodes.values()).find(n => n.node_id === node_id);
  const meshIp = existing ? existing.mesh_ip : assignMeshIp(node_id);
  const allIps = [meshIp + "/32", ...allowed_ips];

  nodes.set(pubkey, {
    node_id,
    pubkey,
    name,
    allowed_ips,
    mesh_ip: meshIp,
    last_seen: Date.now()
  });

  addWgPeer(pubkey, allIps);
  console.log(`Node registered: ${name} (${node_id}) mesh_ip=${meshIp}`);
  res.json({ ok: true, mesh_ip: meshIp });
});

app.get("/hub", auth, (req, res) => {
  const nodeId = req.headers["x-node-id"];
  const node = Array.from(nodes.values()).find(n => n.node_id === nodeId);
  if (!nodeId || !node) {
    return res.status(404).json({ error: "not found" });
  }
  res.json({
    relay_pubkey: relayKeys.publicKey,
    relay_endpoint: RELAY_ENDPOINT,
    mesh_ip: node.mesh_ip
  });
});

app.get("/peers", auth, (req, res) => {
  const excludeId = req.headers["x-node-id"];
  const now = Date.now();
  const active = Array.from(nodes.values())
    .filter(n => now - n.last_seen < HEARTBEAT_TTL * 1000)
    .filter(n => n.node_id !== excludeId)
    .map(n => ({
      node_id: n.node_id,
      pubkey: n.pubkey,
      name: n.name,
      allowed_ips: n.allowed_ips,
      mesh_ip: n.mesh_ip,
      last_seen: n.last_seen
    }));
  res.json(active);
});

app.post("/heartbeat", auth, (req, res) => {
  const { node_id } = req.body;
  if (!node_id) return res.status(400).json({ error: "missing fields" });
  const node = Array.from(nodes.values()).find(n => n.node_id === node_id);
  if (!node) return res.status(404).json({ error: "not found" });
  node.last_seen = Date.now();
  console.log(`Heartbeat received: ${node.name} (${node_id})`);
  res.json({ ok: true });
});

app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

function expireNodes() {
  const now = Date.now();
  for (const [pubkey, node] of nodes) {
    if (now - node.last_seen >= HEARTBEAT_TTL * 1000) {
      removeWgPeer(pubkey);
      nodes.delete(pubkey);
      console.log(`Node expired: ${node.name} (${node.node_id})`);
    }
  }
}

setInterval(expireNodes, 15000);

app.listen(PORT, () => {
  console.log(`Coordinator API listening on port ${PORT}`);
});