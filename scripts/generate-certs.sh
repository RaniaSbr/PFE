#!/bin/bash
# ==============================================================================
# Génération des certificats mTLS pour ShieldNet
#
# Génère :
#   certs/ca.key + ca.crt       — Autorité de certification coalition
#   certs/<node>/node.key + node.crt — Certificat de chaque nœud
#
# Usage : bash scripts/generate-certs.sh
# ==============================================================================

set -e

CERTS_DIR="./certs"
DAYS_CA=3650    # 10 ans pour la CA
DAYS_NODE=365   # 1 an pour les nœuds

NODES=("university" "pme" "isp" "datacenter")

mkdir -p "$CERTS_DIR"

echo "======================================"
echo "  Génération CA ShieldNet Coalition"
echo "======================================"

# --- CA (Autorité de Certification de la coalition) ---
openssl genrsa -out "$CERTS_DIR/ca.key" 4096

openssl req -new -x509 \
  -key "$CERTS_DIR/ca.key" \
  -out "$CERTS_DIR/ca.crt" \
  -days $DAYS_CA \
  -subj "/C=DZ/O=ShieldNet Coalition/CN=ShieldNet-CA"

echo "✓ CA générée : $CERTS_DIR/ca.crt"

# --- Certificat par nœud ---
for NODE in "${NODES[@]}"; do
  NODE_DIR="$CERTS_DIR/$NODE"
  mkdir -p "$NODE_DIR"

  echo ""
  echo "--- Certificat nœud : $NODE ---"

  # Clé privée du nœud
  openssl genrsa -out "$NODE_DIR/node.key" 2048

  # CSR (Certificate Signing Request)
  openssl req -new \
    -key "$NODE_DIR/node.key" \
    -out "$NODE_DIR/node.csr" \
    -subj "/C=DZ/O=ShieldNet Coalition/CN=node-$NODE"

  # Certificat signé par la CA
  openssl x509 -req \
    -in "$NODE_DIR/node.csr" \
    -CA "$CERTS_DIR/ca.crt" \
    -CAkey "$CERTS_DIR/ca.key" \
    -CAcreateserial \
    -out "$NODE_DIR/node.crt" \
    -days $DAYS_NODE

  # Copier la CA dans le répertoire du nœud (pour vérification des pairs)
  cp "$CERTS_DIR/ca.crt" "$NODE_DIR/ca.crt"

  # Nettoyer le CSR
  rm "$NODE_DIR/node.csr"

  echo "✓ $NODE : $NODE_DIR/node.key + node.crt"
done

echo ""
echo "======================================"
echo "  Certificats générés avec succès"
echo "======================================"
echo ""
echo "Pour activer mTLS, ajoutez dans votre .env :"
echo "  MTLS_ENABLED=true"
echo "  MTLS_STRICT=false"
echo "  TLS_CERT=./certs/<node>/node.crt"
echo "  TLS_KEY=./certs/<node>/node.key"
echo "  TLS_CA=./certs/ca.crt"
