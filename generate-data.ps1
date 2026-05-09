$BASE_URL = "http://localhost:3001/api/v1"
$severities = @("LOW", "MEDIUM", "HIGH", "CRITICAL")
$tunnel_types = @("GRE", "VXLAN", "IPSEC")

$peers = Invoke-RestMethod "$BASE_URL/peers"
Write-Host "Peers disponibles : $($peers.Count)"

if ($peers.Count -eq 0) {
    Write-Host "Aucun peer trouve ! Enregistre les peers dabord." -ForegroundColor Red
    exit
}

for ($i = 1; $i -le 100; $i++) {
    Write-Host "=== Simulation $i/100 ===" -ForegroundColor Cyan
    $volume = [math]::Round((Get-Random -Minimum 5 -Maximum 30), 1)
    $severity = $severities | Get-Random
    try {
        $attack = Invoke-RestMethod "$BASE_URL/simulation/attack/detect" -Method POST -ContentType "application/json" -Body (@{ volume_gbps = $volume; target_ip_range = "193.194.$(Get-Random -Min 1 -Max 255).0/24"; target_service = (@("web","dns","mail") | Get-Random); severity = $severity } | ConvertTo-Json)
        Write-Host "Attaque : $volume Gbps ($severity)" -ForegroundColor Yellow
        $nb_peers = Get-Random -Minimum 1 -Maximum ($peers.Count + 1)
        $selected_peers = $peers | Get-Random -Count $nb_peers
        $sessions = @()
        foreach ($peer in @($selected_peers)) {
            $requested = [math]::Round($volume / $nb_peers, 1)
            try {
                $session = Invoke-RestMethod "$BASE_URL/help/request" -Method POST -ContentType "application/json" -Body (@{ attack_id = $attack.attack.attack_id; helping_peer_id = $peer.peer_id; requested_volume_gbps = $requested } | ConvertTo-Json)
                $sessions += $session
                Write-Host "  Demande -> $($peer.peer_name) : $requested Gbps"
            } catch { Write-Host "  Erreur demande $($peer.peer_name)" -ForegroundColor Red }
        }
        Start-Sleep -Milliseconds 200
        $active_sessions = @()
        foreach ($session in $sessions) {
            $accept = (Get-Random -Minimum 1 -Maximum 10) -le 8
            if ($accept) {
                try {
                    Invoke-RestMethod "$BASE_URL/help/$($session.session_id)/accept" -Method PUT -ContentType "application/json" -Body (@{ accepted_volume_gbps = $session.requested_volume_gbps } | ConvertTo-Json) | Out-Null
                    $tunnel = $tunnel_types | Get-Random
                    Invoke-RestMethod "$BASE_URL/traffic/redirect" -Method POST -ContentType "application/json" -Body (@{ session_id = $session.session_id; tunnel_type = $tunnel } | ConvertTo-Json) | Out-Null
                    $active_sessions += $session
                    Write-Host "  ACTIVE (tunnel $tunnel)" -ForegroundColor Green
                } catch { Write-Host "  Erreur activation" -ForegroundColor Red }
            } else { Write-Host "  REJETE" -ForegroundColor Yellow }
        }
        Start-Sleep -Milliseconds 200
        try {
            Invoke-RestMethod "$BASE_URL/attack/over" -Method POST -ContentType "application/json" -Body (@{ attack_id = $attack.attack.attack_id; session_ids = @($active_sessions | ForEach-Object { $_.session_id }); attack_duration_seconds = Get-Random -Minimum 30 -Maximum 300 } | ConvertTo-Json) | Out-Null
            Write-Host "  Attaque terminee" -ForegroundColor Green
        } catch { Write-Host "  Erreur fin attaque" -ForegroundColor Red }
    } catch { Write-Host "Erreur simulation $i : $_" -ForegroundColor Red }
    Start-Sleep -Milliseconds 100
}
Write-Host "=== 100 simulations terminees ===" -ForegroundColor Green
