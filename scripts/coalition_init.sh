#!/bin/sh
# coalition_init.sh — Réinitialise et initialise la coalition ShieldNet sans browser
# Usage: bash scripts/coalition_init.sh

set -e

echo "=== [1/3] Reset de toutes les bases ==="
for C in shieldnet-university shieldnet-pme shieldnet-isp shieldnet-datacenter; do
  R=$(docker exec "$C" wget -qO- --no-check-certificate \
    --post-data="" --header="Content-Type: application/json" \
    "https://0.0.0.0:8443/api/v1/simulation/reset" 2>&1)
  echo "  $C: $R"
done

echo ""
echo "=== [2/3] Initialisation de chaque nœud ==="

WGET="wget -qO- --no-check-certificate --header=Content-Type: application/json"

UNI_RESP=$(docker exec shieldnet-university wget -qO- --no-check-certificate \
  --post-data='{"node_name":"node-university","organization_name":"Universite d Alger","organization_type":"UNIVERSITY","country_code":"DZ","api_endpoint_url":"https://node-university:8443/api/v1","public_key":"DEMO_KEY_university","max_scrubbing_capacity_gbps":10,"current_load_percent":20}' \
  --header="Content-Type: application/json" "https://0.0.0.0:8443/api/v1/simulation/node/init" 2>&1)

PME_RESP=$(docker exec shieldnet-pme wget -qO- --no-check-certificate \
  --post-data='{"node_name":"node-pme","organization_name":"PME Algeroise","organization_type":"PME","country_code":"DZ","api_endpoint_url":"https://node-pme:8443/api/v1","public_key":"DEMO_KEY_pme","max_scrubbing_capacity_gbps":5,"current_load_percent":20}' \
  --header="Content-Type: application/json" "https://0.0.0.0:8443/api/v1/simulation/node/init" 2>&1)

ISP_RESP=$(docker exec shieldnet-isp wget -qO- --no-check-certificate \
  --post-data='{"node_name":"node-isp","organization_name":"Algerie Telecom ISP","organization_type":"ISP","country_code":"DZ","api_endpoint_url":"https://node-isp:8443/api/v1","public_key":"DEMO_KEY_isp","max_scrubbing_capacity_gbps":20,"current_load_percent":20}' \
  --header="Content-Type: application/json" "https://0.0.0.0:8443/api/v1/simulation/node/init" 2>&1)

DC_RESP=$(docker exec shieldnet-datacenter wget -qO- --no-check-certificate \
  --post-data='{"node_name":"node-datacenter","organization_name":"Datacenter Oran","organization_type":"DATACENTER","country_code":"DZ","api_endpoint_url":"https://node-datacenter:8443/api/v1","public_key":"DEMO_KEY_datacenter","max_scrubbing_capacity_gbps":15,"current_load_percent":20}' \
  --header="Content-Type: application/json" "https://0.0.0.0:8443/api/v1/simulation/node/init" 2>&1)

# Extraire les node_id avec grep (portable, pas de python ni jq requis)
UNI=$(echo "$UNI_RESP" | grep -o '"node_id":"[^"]*"' | head -1 | cut -d'"' -f4)
PME=$(echo "$PME_RESP" | grep -o '"node_id":"[^"]*"' | head -1 | cut -d'"' -f4)
ISP=$(echo "$ISP_RESP" | grep -o '"node_id":"[^"]*"' | head -1 | cut -d'"' -f4)
DC=$(echo  "$DC_RESP"  | grep -o '"node_id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo "  University : $UNI"
echo "  PME        : $PME"
echo "  ISP        : $ISP"
echo "  Datacenter : $DC"

echo ""
echo "=== [3/3] Cross-registration ==="

reg() {
  CONTAINER=$1; PEER_ID=$2; PEER_NAME=$3; PEER_ORG=$4; PEER_TYPE=$5; CAPACITY=$6; AVAIL=$7
  docker exec "$CONTAINER" wget -qO- --no-check-certificate \
    --post-data="{\"peer_id\":\"$PEER_ID\",\"peer_name\":\"$PEER_NAME\",\"organization_name\":\"$PEER_ORG\",\"organization_type\":\"$PEER_TYPE\",\"country_code\":\"DZ\",\"api_endpoint_url\":\"https://$PEER_NAME:8443/api/v1\",\"public_key\":\"DEMO_KEY\",\"max_scrubbing_capacity_gbps\":$CAPACITY,\"declared_available_gbps\":$AVAIL}" \
    --header="Content-Type: application/json" \
    "https://0.0.0.0:8443/api/v1/peers/register" 2>&1 | head -c 40
  echo ""
}

# University ← PME, ISP, Datacenter
reg shieldnet-university "$PME" node-pme       "PME Algeroise"      PME        5  4
reg shieldnet-university "$ISP" node-isp       "Algerie Telecom"    ISP        20 16
reg shieldnet-university "$DC"  node-datacenter "Datacenter Oran"   DATACENTER 15 12

# PME ← University, ISP, Datacenter
reg shieldnet-pme "$UNI" node-university "Universite d Alger" UNIVERSITY 10 8
reg shieldnet-pme "$ISP" node-isp        "Algerie Telecom"    ISP        20 16
reg shieldnet-pme "$DC"  node-datacenter  "Datacenter Oran"   DATACENTER 15 12

# ISP ← University, PME, Datacenter
reg shieldnet-isp "$UNI" node-university "Universite d Alger" UNIVERSITY 10 8
reg shieldnet-isp "$PME" node-pme        "PME Algeroise"      PME        5  4
reg shieldnet-isp "$DC"  node-datacenter  "Datacenter Oran"   DATACENTER 15 12

# Datacenter ← University, PME, ISP
reg shieldnet-datacenter "$UNI" node-university "Universite d Alger" UNIVERSITY 10 8
reg shieldnet-datacenter "$PME" node-pme        "PME Algeroise"      PME        5  4
reg shieldnet-datacenter "$ISP" node-isp        "Algerie Telecom"    ISP        20 16

echo ""
echo "=== Coalition prête. Heartbeats en cours (interval 30s) ==="
