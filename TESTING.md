# Testing tunneld-relay

Standalone and fully copyable.

## Prerequisites

- Node.js 20+
- Express (`npm install`)
- `wg` and `ip` commands available (or run inside the Docker container)

## Stage 1 — curl

Start the relay with test values:

```bash
RELAY_ENDPOINT=1.2.3.4:51820 \
TOKEN=secret-test-token \
PORT=4000 \
HEARTBEAT_TTL=60 \
node index.js
```

In another terminal, run these commands in order.

### 1. Health check

```bash
curl -s http://localhost:4000/health | jq .
```

Expected:
```json
{ "status": "ok", "nodes": 0 }
```

### 2. Register a node

```bash
curl -s -X POST http://localhost:4000/register \
  -H "Authorization: Bearer secret-test-token" \
  -H "Content-Type: application/json" \
  -d '{
    "node_id": "node-one",
    "pubkey": "c1PubkeyBase64=",
    "name": "Node One",
    "allowed_ips": ["192.168.1.50/32"]
  }' | jq .
```

Expected:
```json
{ "ok": true, "mesh_ip": "10.0.0.2" }
```

### 3. Register a second node

```bash
curl -s -X POST http://localhost:4000/register \
  -H "Authorization: Bearer secret-test-token" \
  -H "Content-Type: application/json" \
  -d '{
    "node_id": "node-two",
    "pubkey": "c2PubkeyBase64=",
    "name": "Node Two",
    "allowed_ips": ["192.168.2.10/32"]
  }' | jq .
```

Expected:
```json
{ "ok": true, "mesh_ip": "10.0.0.3" }
```

### 4. GET /hub from node one's perspective

```bash
curl -s http://localhost:4000/hub \
  -H "Authorization: Bearer secret-test-token" \
  -H "X-Node-ID: node-one" | jq .
```

Expected shape:
```json
{
  "relay_pubkey": "...",
  "relay_endpoint": "1.2.3.4:51820",
  "mesh_ip": "10.0.0.2"
}
```

### 5. GET /peers from node one

```bash
curl -s http://localhost:4000/peers \
  -H "Authorization: Bearer secret-test-token" \
  -H "X-Node-ID: node-one" | jq .
```

Expected: an array with one entry for `node-two`. `node-one` must not appear.

### 6. GET /peers from node two

```bash
curl -s http://localhost:4000/peers \
  -H "Authorization: Bearer secret-test-token" \
  -H "X-Node-ID: node-two" | jq .
```

Expected: an array with one entry for `node-one`. `node-two` must not appear.

### 7. Heartbeat

```bash
curl -s -X POST http://localhost:4000/heartbeat \
  -H "Authorization: Bearer secret-test-token" \
  -H "Content-Type: application/json" \
  -d '{"node_id": "node-one"}' | jq .
```

Expected:
```json
{ "ok": true }
```

A 404 response means the node is not in the registry.

### 8. Auth failure

```bash
curl -s -w "\n%{http_code}" http://localhost:4000/peers \
  -H "Authorization: Bearer wrong-token" \
  -H "X-Node-ID: node-one"
```

Expected: HTTP 401 with body `{"error":"unauthorized"}`.

### 9. Node expiry

Stop the relay. Restart with:

```bash
RELAY_ENDPOINT=1.2.3.4:51820 \
TOKEN=secret-test-token \
PORT=4000 \
HEARTBEAT_TTL=10 \
node index.js
```

Register `node-one`, then wait 15 seconds without sending a heartbeat.

```bash
curl -s http://localhost:4000/health | jq .
curl -s http://localhost:4000/peers \
  -H "Authorization: Bearer secret-test-token" \
  -H "X-Node-ID: node-one" | jq .
```

Expected: `health` shows `nodes: 0`. `/peers` returns an empty array `[]`.

### 10. Full two-node lifecycle

```bash
curl -s -X POST http://localhost:4000/register \
  -H "Authorization: Bearer secret-test-token" \
  -H "Content-Type: application/json" \
  -d '{"node_id":"a","pubkey":"aPub=","name":"A","allowed_ips":["10.0.0.99/32"]}'
# Expected: {"ok":true,"mesh_ip":"10.0.0.2"}

curl -s -X POST http://localhost:4000/register \
  -H "Authorization: Bearer secret-test-token" \
  -H "Content-Type: application/json" \
  -d '{"node_id":"b","pubkey":"bPub=","name":"B","allowed_ips":["10.0.0.98/32"]}'
# Expected: {"ok":true,"mesh_ip":"10.0.0.3"}

curl -s http://localhost:4000/peers -H "Authorization: Bearer secret-test-token" -H "X-Node-ID: a"
# Expected: array with node b

curl -s -X POST http://localhost:4000/heartbeat \
  -H "Authorization: Bearer secret-test-token" \
  -H "Content-Type: application/json" \
  -d '{"node_id":"a"}'
# Expected: {"ok":true}

curl -s http://localhost:4000/hub -H "Authorization: Bearer secret-test-token" -H "X-Node-ID: a"
# Expected: {"relay_pubkey":"...","relay_endpoint":"1.2.3.4:51820","mesh_ip":"10.0.0.2"}
```

## Stage 2 — Multiple tunneld Instances

After curl tests pass:

- Connect a second tunneld instance to the same relay
- Confirm both appear in `/peers` from each node's perspective
- Confirm nodes can reach each other over the mesh via their `mesh_ip` addresses

## Stage 3 — Full Lifecycle

- Stop one node, verify it drops from `/peers` after `HEARTBEAT_TTL`
- Restart the node, confirm it re-registers and reappears in `/peers`
