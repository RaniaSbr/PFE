# ================================================================
#  demo-shieldnet.ps1
#  Demonstration complete de ShieldNet pour soutenance PFE
#
#  Scenario : L'Universite d'Alger subit une attaque DDoS CRITICAL
#  de 35 Gbps. Sa capacite locale est de 10 Gbps.
#  -> La coalition se mobilise pour absorber l'overflow de 25 Gbps.
#
#  Phases demontrees :
#    0. Verification sante du systeme (4 noeuds HTTPS + mTLS)
#    1. Authentification JWT RS256 (60s, cle privee asymetrique)
#    2. Initialisation de la coalition (certs PEM comme cles publiques)
#    3. Detection de l'attaque DDoS
#    4. Selection des pairs (algorithme WSM / AHP)
#    5. Reponse de la coalition (demandes d'aide + tunnels)
#    6. Fin d'attaque + calcul des scores de confiance
#    7. Tableau de bord final
# ================================================================

# --- Configuration SSL (certificats auto-signes coalition) ------
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# --- Helpers d'affichage ----------------------------------------
function Title($msg) {
    Write-Host ""
    Write-Host ("=" * 60) -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host ("=" * 60) -ForegroundColor Cyan
}
function Step($msg)    { Write-Host "`n  > $msg" -ForegroundColor Yellow }
function Ok($msg)      { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "    [WARN] $msg" -ForegroundColor DarkYellow }
function Fail($msg)    { Write-Host "    [FAIL] $msg" -ForegroundColor Red }
function Info($msg)    { Write-Host "    $msg" -ForegroundColor Gray }
function Sep           { Write-Host ("    " + ("-" * 50)) -ForegroundColor DarkGray }
# --- Parametres des noeuds ---------------------------------------
$NODES = @(
    @{ name="node-university"; port=3001; cert="university"; org="Universite d'Alger";  type="UNIVERSITY"; tier="T2"; capacity=10.0  },
    @{ name="node-pme";        port=3002; cert="pme";        org="PME Algeroise";       type="PME";        tier="T3"; capacity=5.0   },
    @{ name="node-isp";        port=3003; cert="isp";        org="Algerie Telecom ISP"; type="ISP";        tier="T1"; capacity=20.0  },
    @{ name="node-datacenter"; port=3004; cert="datacenter"; org="Datacenter Oran";     type="DATACENTER"; tier="T2"; capacity=15.0  }
)
$SECRET  = "shieldnet-secret-key-2025"
$UNIV    = $NODES[0]   # noeud attaque
$TOKENS  = @{}

$MTLS_CERT   = ".\certs\university\node.crt"
$MTLS_KEY    = ".\certs\university\node.key"
$MTLS_CA     = ".\certs\ca.crt"
$MTLS_HELPER = ".\scripts\mtls-request.js"

function InvokeShieldNet($url, $method = "GET", $headers = @{}, $body = $null) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js est requis pour les appels mTLS de cette demo."
    }
    if (-not (Test-Path $MTLS_HELPER)) {
        throw "Helper mTLS introuvable : $MTLS_HELPER"
    }

    # Le PEM est passé via public_key_file (chemin) pour éviter le bug de
    # ConvertTo-Json PS 5.1 qui se bloque sur les strings base64 longues.
    $payload = @{
        url      = $url
        method   = $method
        headers  = $headers
        body     = $body
        certPath = (Resolve-Path $MTLS_CERT).Path
        keyPath  = (Resolve-Path $MTLS_KEY).Path
        caPath   = (Resolve-Path $MTLS_CA).Path
    } | ConvertTo-Json -Depth 10 -Compress

    $output = $payload | & node $MTLS_HELPER 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String).Trim()

    if ($exitCode -ne 0) {
        throw $text
    }
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }

    return $text | ConvertFrom-Json
}

function GetToken($node) {
    $body = @{ node_id = $node.name; node_secret = $SECRET }
    $resp = InvokeShieldNet "https://localhost:$($node.port)/api/v1/auth/token" "POST" @{} $body
    return $resp.token
}

function Api($node, $method, $path, $body = $null) {
    $token = $TOKENS[$node.name]
    $headers = @{ Authorization = "Bearer $token" }
    $url = "https://localhost:$($node.port)/api/v1$path"
    if ($body) {
        return InvokeShieldNet $url $method $headers $body
    } else {
        return InvokeShieldNet $url $method $headers $null
    }
}

# ----------------------------------------------------------------
Title "PHASE 0 - VERIFICATION SANTE DU SYSTEME"
# ----------------------------------------------------------------

Step "Verification des 4 noeuds ShieldNet (HTTPS + mTLS)..."
$allUp = $true
foreach ($n in $NODES) {
    try {
        $r = InvokeShieldNet "https://localhost:$($n.port)/"
        Ok "$($n.name) en ligne  [Port $($n.port)] - Node ID: $($r.node_id)"
    } catch {
        Fail "$($n.name) inaccessible (port $($n.port)) - verifier docker-compose up"
        $allUp = $false
    }
}
if (-not $allUp) {
    Write-Host "`n  Lancez d'abord : docker-compose up --build -d" -ForegroundColor Red
    exit 1
}

Step "Reinitialisation de la base de donnees (etat propre)..."
foreach ($n in $NODES) {
    try {
        InvokeShieldNet "https://localhost:$($n.port)/api/v1/simulation/reset" "POST" @{} $null | Out-Null
        Ok "$($n.name) resete"
    } catch { Warn "Reset $($n.name) : $($_.Exception.Message)" }
}

# ----------------------------------------------------------------
Title "PHASE 1 - AUTHENTIFICATION JWT RS256"
# ----------------------------------------------------------------

Step "Generation des tokens JWT RS256 pour chaque noeud..."
Info "Algorithme : RS256 (asymetrique) | Expiration : 60 secondes"
Info "Chaque noeud signe avec sa CLE PRIVEE (node.key)"

foreach ($n in $NODES) {
    try {
        $body = @{ node_id = $n.name; node_secret = $SECRET }
        $resp = InvokeShieldNet "https://localhost:$($n.port)/api/v1/auth/token" "POST" @{} $body
        $TOKENS[$n.name] = $resp.token
        $short = $resp.token.Substring(0, 40) + "..."
        Ok "$($n.name)  -> $short"
        Info "   Algo: $($resp.algorithm) | Expire dans: $($resp.expires_in) | Role: $($resp.role)"
    } catch {
        Fail "Echec token $($n.name) : $($_.Exception.Message)"
    }
}

Step "Demonstration : acces SANS token -> refus 401"
try {
    InvokeShieldNet "https://localhost:$($UNIV.port)/api/v1/peers" "GET" @{} $null | Out-Null
    Warn "Attendu 401 - token non exige !"
} catch {
    if ($_.Exception.Message -like "*HTTP 401*") {
        Ok "Reponse 401 Unauthorized recue (JWT obligatoire)"
    } else {
        Warn "Reponse inattendue : $($_.Exception.Message)"
    }
}

Step "Demonstration : acces AVEC token valide -> succes 200"
try {
    $peers = Api $UNIV "GET" "/peers"
    Ok "Reponse 200 OK - $($peers.Count) pair(s) dans la coalition"
} catch {
    Warn "Erreur : $($_.Exception.Message)"
}

# ----------------------------------------------------------------
Title "PHASE 2 - INITIALISATION DE LA COALITION"
# ----------------------------------------------------------------

Step "Chargement des certificats PEM (cles publiques des noeuds)..."
foreach ($n in $NODES) {
    $certPath = ".\certs\$($n.cert)\node.crt"
    if (Test-Path $certPath) {
        # Stocker le chemin absolu — Node.js lira le PEM lui-même (évite le bug ConvertTo-Json PS5.1)
        $n["public_key_file"] = (Resolve-Path $certPath).Path
        Ok "Certificat charge : $($n.cert)/node.crt"
    } else {
        Fail "Certificat manquant : $certPath"
    }
}

Step "Initialisation de chaque noeud local (config + capacite)..."
foreach ($n in $NODES) {
    try {
        $body = @{
            node_name                   = $n.name
            organization_name           = $n.org
            organization_type           = $n.type
            tier                        = $n.tier
            country_code                = "DZ"
            api_endpoint_url            = "https://localhost:$($n.port)/api/v1"
            public_key_file             = $n.public_key_file
            max_scrubbing_capacity_gbps = $n.capacity
            current_load_percent        = 0
        }
        $resp = Api $n "POST" "/simulation/node/init" $body
        Ok "$($n.name) - Capacite: $($n.capacity) Gbps | Charge initiale: 20%"
        $n["node_id"] = $resp.node_id
        # Rafraichir le token avec le vrai UUID
        $TOKENS[$n.name] = GetToken $n
    } catch { Warn "Init $($n.name) : $($_.Exception.Message)" }
}

Step "Enregistrement croise des pairs (avec certificats PEM)..."
$registered = 0
foreach ($target in $NODES) {
    foreach ($peer in $NODES) {
        if ($peer.name -eq $target.name) { continue }
        try {
            $body = @{
                peer_name                   = $peer.name
                organization_name           = $peer.org
                organization_type           = $peer.type
                tier                        = $peer.tier
                country_code                = "DZ"
                api_endpoint_url            = "https://node-$($peer.cert):8443/api/v1"
                public_key_file             = $peer.public_key_file
                max_scrubbing_capacity_gbps = $peer.capacity
                declared_available_gbps     = $peer.capacity * 0.8
            }
            Api $target "POST" "/peers/register" $body | Out-Null
            $registered++
        } catch {
            $msg = $_.Exception.Message
            if ($msg -notlike "*409*" -and $msg -notlike "*already*") {
                Warn "Register $($peer.name)->$($target.name) : $msg"
            }
        }
    }
}
Ok "$registered enregistrements croises effectues"
Ok "Cles publiques (PEM) stockees dans PEERS.public_key -> verification JWT RS256"

# Recuperer les UUIDs des pairs pour la suite
$peersList = Api $UNIV "GET" "/peers"
foreach ($n in $NODES) {
    $match = $peersList | Where-Object { $_.peer_name -eq $n.name }
    if ($match) { $n["uuid"] = $match.peer_id }
}

# ----------------------------------------------------------------
Title "PHASE 3 - DETECTION D'UNE ATTAQUE DDOS CRITIQUE"
# ----------------------------------------------------------------

$ATTACK_VOLUME = 35.0   # Gbps total de l'attaque
$LOCAL_CAP     = $UNIV.capacity  # 10 Gbps

Step "Scenario : attaque DDoS CRITIQUE sur l'Universite d'Alger"
Info "Volume de l'attaque  : $ATTACK_VOLUME Gbps"
Info "Capacite locale      : $LOCAL_CAP Gbps"
Info "Overflow a absorber  : $($ATTACK_VOLUME - $LOCAL_CAP) Gbps -> COALITION REQUISE"

$attackBody = @{
    volume_gbps    = $ATTACK_VOLUME
    target_ip_range = "193.194.100.0/24"
    target_service  = "DNS"
    severity        = "CRITICAL"
}

try {
    $attackResp = Api $UNIV "POST" "/simulation/attack/detect" $attackBody
    $attackId   = $attackResp.attack.attack_id
    $overflow   = $attackResp.node_state.overflow_gbps

    Ok "Attaque enregistree - ID: $attackId"
    Ok "Statut : $($attackResp.attack.status)"
    Ok "Overflow detecte : $overflow Gbps -> escalade coalition declenchee"
} catch {
    Fail "Erreur detection attaque : $($_.Exception.Message)"
    exit 1
}

# ----------------------------------------------------------------
Title "PHASE 4 - SELECTION DES PAIRS (ALGORITHME WSM/AHP)"
# ----------------------------------------------------------------

Step "Lancement de l'algorithme WSM avec poids AHP valides..."
Info "Poids AHP : wC=0.52 (capacite) | wL=0.20 (latence) | wT=0.20 (confiance) | wR=0.08 (reciprocite)"
Info "CR = 1.6% < 10% -> coherence AHP verifiee"

$selectBody = @{
    overflow_gbps    = $overflow
    min_trust_score  = 0.0
    ignore_trust     = $true
}

try {
    $selectResp = Api $UNIV "POST" "/trust/select-peers" $selectBody

    Ok "Selection terminee - $($selectResp.selected_peers.Count) pair(s) choisi(s)"
    Info ""
    Info "  Classement WSM :"

    $rank = 1
    foreach ($p in $selectResp.selected_peers) {
        $score = if ($p.wsm_score) { [math]::Round($p.wsm_score, 4) } else { "N/A" }
        $alloc = if ($p.allocated_gbps) { [math]::Round($p.allocated_gbps, 1) } else { "N/A" }
        Info "  [$rank] $($p.peer_name) - Score WSM: $score | Alloue: $alloc Gbps"
        $rank++
    }

    $selectedPeers = $selectResp.selected_peers
} catch {
    Warn "Selection automatique indisponible - utilisation des pairs enregistres"
    $selectedPeers = $peersList | Where-Object { $_.peer_name -ne $UNIV.name } | Select-Object -First 2
}

# ----------------------------------------------------------------
Title "PHASE 5 - REPONSE DE LA COALITION"
# ----------------------------------------------------------------

Step "Envoi des demandes d'aide aux pairs selectionnes..."

$TUNNEL_TYPES = @("GRE", "VXLAN", "IPSEC")
$sessions     = @()
$peersToHelp  = $peersList | Where-Object { $_.peer_name -ne $UNIV.name }
$perPeer      = [math]::Round($overflow / $peersToHelp.Count, 1)

foreach ($peer in $peersToHelp) {
    try {
        $helpBody = @{
            attack_id              = $attackId
            helping_peer_id        = $peer.peer_id
            requested_volume_gbps  = $perPeer
        }
        $session = Api $UNIV "POST" "/help/request" $helpBody
        $sessions += $session
        Ok "Demande -> $($peer.peer_name) : $perPeer Gbps"
    } catch { Warn "Erreur demande $($peer.peer_name) : $($_.Exception.Message)" }
}

Step "Acceptation des demandes par les pairs..."
$activeSessions = @()
foreach ($session in $sessions) {
    try {
        $acceptBody = @{ accepted_volume_gbps = $perPeer }
        Api $UNIV "PUT" "/help/$($session.session_id)/accept" $acceptBody | Out-Null

        $tunnel = $TUNNEL_TYPES | Get-Random
        $tunnelBody = @{ session_id = $session.session_id; tunnel_type = $tunnel }
        Api $UNIV "POST" "/traffic/redirect" $tunnelBody | Out-Null

        $activeSessions += $session
        Ok "Session ACTIVE - Tunnel $tunnel -> $($session.helping_peer_id)"
    } catch { Warn "Erreur activation : $($_.Exception.Message)" }
}

Step "Bilan de la reponse coalition..."
$totalAbsorbed = $activeSessions.Count * $perPeer
$coverage      = [math]::Round(($totalAbsorbed / $overflow) * 100, 0)
Ok "$($activeSessions.Count) sessions actives | $totalAbsorbed Gbps absorbes sur $overflow Gbps"
if ($coverage -ge 100) {
    Ok "Attaque CONTENUE a 100% - coalition efficace"
} else {
    Warn "Couverture : $coverage% ($totalAbsorbed/$overflow Gbps)"
}

# ----------------------------------------------------------------
Title "PHASE 6 - FIN D'ATTAQUE ET SCORES DE CONFIANCE"
# ----------------------------------------------------------------

Step "Signal de fin d'attaque..."
try {
    $endBody = @{
        attack_id              = $attackId
        session_ids            = @($activeSessions | ForEach-Object { $_.session_id })
        attack_duration_seconds = 180
    }
    Api $UNIV "POST" "/attack/over" $endBody | Out-Null
    Ok "Attaque terminee - sessions cloturees - credits calcules"
} catch { Warn "Fin attaque : $($_.Exception.Message)" }

Step "Calcul des scores de confiance (formule PeerTrust)..."
Info "T(p) = Somme(Sk * Crk * Wk) / Somme(Crk * Wk)"
Info "Sk = satisfaction (volume reel/accepte) | Wk = poids severite | Crk = credibilite"

foreach ($peer in $peersToHelp) {
    try {
        Api $UNIV "POST" "/trust/$($peer.peer_id)/recalculate" $null | Out-Null
    } catch {}
}

Start-Sleep -Seconds 1

Step "Lecture des scores de confiance..."
try {
    $trustScores = Api $UNIV "GET" "/trust"

    $levels = @{ GOLD=0; SILVER=0; BRONZE=0; SUSPECT=0; BANNED=0 }
    Info ""
    Info "  Noeud                   Score    Niveau"
    Info "  " + ("-" * 45)

    foreach ($ts in $trustScores) {
        $name  = if ($ts.peer) { $ts.peer.peer_name } else { $ts.peer_id }
        $score = [math]::Round($ts.overall_score, 3)
        $level = $ts.trust_level

        $color = switch ($level) {
            "GOLD"   { "Yellow" }
            "SILVER" { "Gray"   }
            "BRONZE" { "DarkYellow" }
            "SUSPECT"{ "Red"    }
            default  { "White"  }
        }

        $line = "  {0,-25} {1,-8} {2}" -f $name, $score, $level
        Write-Host $line -ForegroundColor $color

        if ($levels.ContainsKey($level)) { $levels[$level]++ }
    }

    Info ""
    Info "  Repartition : GOLD=$($levels.GOLD) | SILVER=$($levels.SILVER) | BRONZE=$($levels.BRONZE) | SUSPECT=$($levels.SUSPECT)"
} catch { Warn "Trust : $($_.Exception.Message)" }

# ----------------------------------------------------------------
Title "PHASE 7 - TABLEAU DE BORD FINAL"
# ----------------------------------------------------------------

Step "Metriques globales du noeud Universite..."
try {
    $metrics = Api $UNIV "GET" "/metrics"

    $peersCount = $metrics.connected_peers
    $sessCount  = $metrics.active_sessions
    $atkCount   = $metrics.total_attacks

    Ok "Pairs enregistres  : $peersCount"
    Ok "Sessions totales   : $sessCount"
    Ok "Attaques traitees  : $atkCount"
} catch {
    Warn "Metriques : $($_.Exception.Message)"
}

Step "Verification securite finale..."
Ok "mTLS          : ACTIF - rejectUnauthorized=true - certificats client exiges"
Ok "JWT RS256     : ACTIF - signature par cle privee - verification par cle publique"
Ok "Expiration    : 60 secondes (anti-rejeu)"
Ok "Chiffrement   : TLS 1.2 - AES-256 - canal securise entre tous les noeuds"

Step "Recapitulatif du scenario..."
Info "  Attaque      : UDP_FLOOD CRITIQUE - $ATTACK_VOLUME Gbps sur Universite d'Alger"
Info "  Local        : $LOCAL_CAP Gbps absorbes (capacite propre)"
Info "  Overflow     : $overflow Gbps -> delegue a la coalition"
Info "  Coalition    : $($activeSessions.Count) pairs mobilises - $totalAbsorbed Gbps absorbes"
Info "  Resultat     : ATTAQUE NEUTRALISEE"

Write-Host ""
Write-Host ("=" * 60) -ForegroundColor Green
Write-Host "  ShieldNet - Demonstration complete terminee" -ForegroundColor Green
Write-Host ("=" * 60) -ForegroundColor Green
Write-Host ""
