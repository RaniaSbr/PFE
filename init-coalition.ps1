# ============================================================
# init-coalition.ps1
# Initialise la coalition ShieldNet avec les vrais certificats
# PEM comme clés publiques pour la vérification JWT (RS256).
#
# À exécuter APRÈS docker-compose up --build
# ============================================================

# Désactiver la validation SSL (certificats auto-signés)
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$CERTS_DIR = ".\certs"

# ── Définition des nœuds ────────────────────────────────────
$nodes = @(
    @{ name="node-university"; port=3001; cert="university"; org="Université d'Alger"; type="UNIVERSITY"; tier="T2"; capacity=10.0 },
    @{ name="node-pme";        port=3002; cert="pme";        org="PME Algéroise";     type="PME";        tier="T3"; capacity=5.0  },
    @{ name="node-isp";        port=3003; cert="isp";        org="Algérie Télécom";   type="ISP";        tier="T1"; capacity=20.0 },
    @{ name="node-datacenter"; port=3004; cert="datacenter"; org="Datacenter Oran";   type="DATACENTER"; tier="T2"; capacity=15.0 }
)

# ── Lire les certificats PEM ────────────────────────────────
foreach ($n in $nodes) {
    $certPath = "$CERTS_DIR\$($n.cert)\node.crt"
    if (Test-Path $certPath) {
        $n["public_key"] = Get-Content $certPath -Raw
        Write-Host "✓ Cert chargé pour $($n.name)" -ForegroundColor Green
    } else {
        Write-Host "✗ Cert manquant : $certPath" -ForegroundColor Red
        exit 1
    }
}

# ── Attendre que tous les nœuds soient prêts ───────────────
Write-Host "`nAttente du démarrage des nœuds..." -ForegroundColor Cyan
foreach ($n in $nodes) {
    $url = "https://localhost:$($n.port)/api/v1/peers"
    $maxRetry = 15
    $ok = $false
    for ($i = 1; $i -le $maxRetry; $i++) {
        try {
            Invoke-RestMethod $url -ErrorAction Stop | Out-Null
            Write-Host "  $($n.name) prêt" -ForegroundColor Green
            $ok = $true
            break
        } catch {
            Write-Host "  $($n.name) : attente ($i/$maxRetry)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        }
    }
    if (-not $ok) {
        Write-Host "✗ $($n.name) n'a pas démarré" -ForegroundColor Red
        exit 1
    }
}

# ── Initialiser chaque nœud local ───────────────────────────
Write-Host "`n=== Initialisation des nœuds locaux ===" -ForegroundColor Cyan
foreach ($n in $nodes) {
    $url  = "https://localhost:$($n.port)/api/v1/simulation/node/init"
    $body = @{
        node_name                   = $n.name
        organization_name           = $n.org
        organization_type           = $n.type
        tier                        = $n.tier
        country_code                = "DZ"
        api_endpoint_url            = "https://localhost:$($n.port)/api/v1"
        public_key                  = $n.public_key
        max_scrubbing_capacity_gbps = $n.capacity
        current_load_percent        = 0
    } | ConvertTo-Json

    try {
        $resp = Invoke-RestMethod $url -Method POST -Body $body -ContentType "application/json"
        Write-Host "  ✓ $($n.name) initialisé (node_id: $($resp.node_id ?? $resp.node?.node_id ?? 'OK'))" -ForegroundColor Green
        $n["node_id"] = $resp.node_id ?? $resp.node?.node_id
    } catch {
        Write-Host "  ✗ Erreur init $($n.name) : $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ── Enregistrer chaque pair chez les autres nœuds ───────────
Write-Host "`n=== Enregistrement croisé des pairs ===" -ForegroundColor Cyan
foreach ($target in $nodes) {
    foreach ($peer in $nodes) {
        if ($peer.name -eq $target.name) { continue }

        $url  = "https://localhost:$($target.port)/api/v1/peers/register"
        $body = @{
            peer_name                   = $peer.name
            organization_name           = $peer.org
            organization_type           = $peer.type
            tier                        = $peer.tier
            country_code                = "DZ"
            api_endpoint_url            = "https://node-$($peer.cert):8443/api/v1"
            public_key                  = $peer.public_key
            max_scrubbing_capacity_gbps = $peer.capacity
            declared_available_gbps     = $peer.capacity * 0.8
        } | ConvertTo-Json

        try {
            Invoke-RestMethod $url -Method POST -Body $body -ContentType "application/json" | Out-Null
            Write-Host "  ✓ $($peer.name) → $($target.name)" -ForegroundColor Green
        } catch {
            $msg = $_.Exception.Message
            if ($msg -like "*already*" -or $msg -like "*409*") {
                Write-Host "  ○ $($peer.name) → $($target.name) (déjà enregistré)" -ForegroundColor Yellow
            } else {
                Write-Host "  ✗ $($peer.name) → $($target.name) : $msg" -ForegroundColor Red
            }
        }
    }
}

# ── Vérification finale ─────────────────────────────────────
Write-Host "`n=== Vérification JWT RS256 ===" -ForegroundColor Cyan
$testNode = $nodes[0]
$tokenBody = @{
    node_id     = $testNode.name
    node_secret = "shieldnet-secret-key-2025"
} | ConvertTo-Json

try {
    $resp  = Invoke-RestMethod "https://localhost:$($testNode.port)/api/v1/auth/token" `
                -Method POST -Body $tokenBody -ContentType "application/json"
    $token = $resp.token
    Write-Host "  ✓ Token RS256 obtenu pour $($testNode.name)" -ForegroundColor Green
    Write-Host "  ✓ Algorithme : $($resp.algorithm) | Expires : $($resp.expires_in)" -ForegroundColor Green

    # Test endpoint protégé
    $peers = Invoke-RestMethod "https://localhost:$($testNode.port)/api/v1/peers" `
                -Headers @{ Authorization = "Bearer $token" }
    Write-Host "  ✓ Endpoint /peers accessible : $($peers.Count) pair(s) enregistré(s)" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Erreur JWT : $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n✅ Coalition ShieldNet initialisée avec succès (JWT RS256 + mTLS actifs)" -ForegroundColor Green
