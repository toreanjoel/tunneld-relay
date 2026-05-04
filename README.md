# tunneld-relay

A single Docker container that solves the "no public IP" problem for Tunneld nodes.

Every tunneld node connects to the relay over WireGuard. The relay exposes one public IP and UDP port. Traffic between nodes that cannot reach each other directly flows through the relay. No port forwarding is required on any home router.

The container runs two things:

- A WireGuard interface (`wg0`) — the mesh anchor and traffic relay
- An HTTP coordinator API — peer registry and key exchange

## What It Does Not Do

- It does not provide a web dashboard — that lives on each tunneld node
- It does not store persistent registry state — restarting clears the in-memory registry. Nodes re-register automatically
- It does not terminate TLS for HTTP — run the API behind a reverse proxy in production
- It does not generate configs for end devices (phones, laptops) — each tunneld node handles its own clients independently

## How It Works

A tunneld node calls `POST /register` with its public key, name, and `allowed_ips`. The relay assigns it a mesh IP from `10.0.0.0/8`, adds it as a WireGuard peer on `wg0`, and returns the assigned IP.

The node then calls `GET /hub` to learn the relay's public key, endpoint, and its own mesh IP. It configures the relay as its sole WireGuard peer and begins polling `GET /peers` every 25 seconds to discover other nodes.

Traffic flow between two tunneld nodes:

1. Node A sends packet to relay's public endpoint
2. Relay decrypts and inspects the destination IP
3. If the IP matches another node's `allowed_ips` or `mesh_ip`, the relay forwards it through the WireGuard tunnel to that node
4. Node B receives and handles the packet

## Requirements

- Docker and docker-compose
- A VPS with a public IPv4 address
- UDP port 51820 open in the VPS firewall

## Deploying on a VPS

1. Clone this repository onto your VPS
2. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
3. Edit `.env` and set at minimum:
   - `RELAY_ENDPOINT` — your VPS public IP and port, e.g. `1.2.3.4:51820`
   - `TOKEN` — a long random string shared with all tunneld nodes
4. Open UDP port 51820 in your VPS firewall
5. Start the container:
   ```
   docker-compose up -d
   ```
6. Verify the health endpoint:
   ```
   curl http://localhost:4000/health
   ```

## Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `RELAY_ENDPOINT` | — | Yes | Public IP and port of this relay, e.g. `1.2.3.4:51820` |
| `TOKEN` | — | Yes | Shared passphrase all nodes must present as a Bearer token |
| `PORT` | `4000` | No | HTTP API port |
| `HEARTBEAT_TTL` | `60` | No | Seconds before a node is considered dead |
| `WG_PORT` | `51820` | No | WireGuard listen port |

## Connecting a tunneld Node

Set these config keys on the tunneld node:

- `coordinator_url` — the full URL of this relay's HTTP API, e.g. `http://1.2.3.4:4000`
- `token` — the same `TOKEN` value set above
- `node_name` — a human-readable name for this node

Once connected, the tunneld node uses the relay as its mesh hub for inter-node traffic.

## Security

- `TOKEN` is the only credential — make it long and random
- The HTTP API should run behind a reverse proxy with HTTPS in production
- The WireGuard port (UDP 51820) must be open directly to the host — it cannot go through a reverse proxy
- The registry is in-memory only — restarting the container clears it. Nodes re-register automatically
