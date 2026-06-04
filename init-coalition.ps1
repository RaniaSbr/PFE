# ============================================================
# init-coalition.ps1  (compatible PowerShell 5.1)
# Initialise la coalition ShieldNet
# A executer APRES : docker compose up -d
# ============================================================

# Bypass SSL complet pour PowerShell 5.1 (certificats auto-signes)
Add-Type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class TrustAll : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint sp, X509Certificate cert,
        WebRequest req, int problem) { return true; }
}
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAll
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$CERTS_DIR = ".\certs"

$nodes = @(
    @{ name="node-university"; port=3001; cert="university"; org="Universite d Alger"; type="UNIVERSITY"; tier="T2"; capacity=10.0 },
    @{ name="node-pme";        port=3002; cert="pme";        org="PME Algeroise";      type="PME";        tier="T3"; capacity=5.0  },
    @{ name="node-isp";        port=3003; cert="isp";        org="Algerie Telecom";    type="ISP";        tier="T1"; capacity=20.0 },
    @{ name="node-datacenter"; port=3004; cert="datacenter"; org="Datacenter Oran";    type="DATACENTER"; tier="T2"; capacity=15.0 }
)

# ── Lire les certificats PEM ────────────────────────────────
foreach ($n in $nodes) {
    $certPath = "$CERTS_DIR\$($n.cert)\node.crt"
    if (Test-Path $certPath) {
        $n["public_key"] = Get-Content $certPath -Raw
        Write-Host "[OK] Cert charge pour $($n.name)" -ForegroundColor Green
    } else {
        Write-Host "[ERREUR] Cert manquant : $certPath" -ForegroundColor Red
        exit 1
    }
}

# ── Attendre que tous les noeuds soient prets ───────────────
Write-Host "`nAttente des noeuds..." -ForegroundColor Cyan
foreach ($n in $nodes) {
    $url = "https://localhost:$($n.port)/"
    $maxRetry = 15
    $ok = $false
    for ($i = 1; $i -le $maxRetry; $i++) {
        $tcpClient = New-Object System.Net.Sockets.TcpClient
        try {
            $tcpClient.Connect("localhost", $n.port)
            Write-Host "  $($n.name) pret (TCP OK)" -ForegroundColor Green
            $ok = $true
            $tcpClient.Close()
            break
        } catch {
            Write-Host "  $($n.name) : attente ($i/$maxRetry)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 2
        } finally {
            $tcpClient.Dispose()
        }
    }
    if (-not $ok) {
        Write-Host "[ERREUR] $($n.name) n a pas demarre" -ForegroundColor Red
        exit 1
    }
}

# ── Initialiser chaque noeud local ──────────────────────────
Write-Host "`n=== Initialisation des noeuds locaux ===" -ForegroundColor Cyan
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
    } | ConvertTo-Json -Depth 5

    try {
        $resp = Invoke-RestMethod $url -Method POST -Body $body -ContentType "application/json"
        $nid = if ($resp.node_id) { $resp.node_id } elseif ($resp.node) { $resp.node.node_id } else { "OK" }
        Write-Host "  [OK] $($n.name) initialise (node_id: $nid)" -ForegroundColor Green
        $n["node_id"] = $nid
    } catch {
        Write-Host "  [WARN] Init $($n.name) : $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ── Enregistrement croise des pairs ─────────────────────────
Write-Host "`n=== Enregistrement croise des pairs ===" -ForegroundColor Cyan
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
        } | ConvertTo-Json -Depth 5

        try {
            Invoke-RestMethod $url -Method POST -Body $body -ContentType "application/json" | Out-Null
            Write-Host "  [OK] $($peer.name) -> $($target.name)" -ForegroundColor Green
        } catch {
            $msg = $_.Exception.Message
            if ($msg -like "*already*" -or $msg -like "*409*") {
                Write-Host "  [--] $($peer.name) -> $($target.name) (deja enregistre)" -ForegroundColor Yellow
            } else {
                Write-Host "  [WARN] $($peer.name) -> $($target.name) : $msg" -ForegroundColor DarkYellow
            }
        }
    }
}

# ── Verification JWT ─────────────────────────────────────────
Write-Host "`n=== Verification JWT RS256 ===" -ForegroundColor Cyan
$testNode  = $nodes[0]
$tokenBody = @{ node_id = $testNode.name; node_secret = "shieldnet-secret-key-2025" } | ConvertTo-Json

try {
    $resp  = Invoke-RestMethod "https://localhost:$($testNode.port)/api/v1/auth/token" `
                -Method POST -Body $tokenBody -ContentType "application/json"
    $token = $resp.token
    Write-Host "  [OK] Token RS256 obtenu | Algo: $($resp.algorithm) | Expire: $($resp.expires_in)" -ForegroundColor Green

    $peers = Invoke-RestMethod "https://localhost:$($testNode.port)/api/v1/peers" `
                -Headers @{ Authorization = "Bearer $token" }
    $count = if ($peers -is [array]) { $peers.Count } else { 1 }
    Write-Host "  [OK] /peers accessible : $count pair(s) enregistre(s)" -ForegroundColor Green
} catch {
    Write-Host "  [ERREUR] JWT : $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n[SUCCES] Coalition ShieldNet initialisee !" -ForegroundColor Green
Write-Host "Ouvre https://localhost:3001/dashboard dans Chrome" -ForegroundColor Cyan
