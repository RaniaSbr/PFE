/**
 * utils/trafficDistributor.js
 *
 * Algorithme de redistribution Weighted Round-Robin (WRR)
 *
 * Principe (cf. schéma §4.x mémoire) :
 *   - Le nœud victime Nv dispose de n paquets (P1, P2, ..., Pn)
 *   - m nœuds pairs (Np1, ..., Npm) sont prêts à absorber le trafic
 *   - Chaque pair Npi possède un quota alloc_i (paquets par cycle)
 *     dérivé de l'allocation WSM : alloc_i = allocation_pct_i
 *
 * Déroulement d'un cycle :
 *   Np1 reçoit P_1 .. P_alloc1
 *   Np2 reçoit P_alloc1+1 .. P_alloc1+alloc2
 *   ...
 *   Npm reçoit P_(1+Σj<m alloc_j) .. P_(Σj alloc_j)
 *   → retour à Np1 pour le cycle suivant
 *
 * Le processus s'arrête dès que Pn est distribué,
 * indépendamment de Σ alloc_i (indicateur, pas contrainte d'égalité).
 *
 * @param {number}   nPackets  Nombre total de paquets à distribuer
 * @param {{ peer_id: string, peer_name: string, alloc_i: number }[]} peers
 *   Pairs triés dans l'ordre de priorité WSM (Np1 en premier)
 *
 * @returns {{
 *   total_packets:  number,
 *   total_peers:    number,
 *   cycle_size:     number,
 *   total_cycles:   number,
 *   distribution:   Array
 * }}
 */
function weightedRoundRobin(nPackets, peers) {
  if (!peers || peers.length === 0 || nPackets <= 0) {
    return { total_packets: nPackets, total_peers: 0, cycle_size: 0, total_cycles: 0, distribution: [] };
  }

  const m = peers.length;
  const cycleSize = peers.reduce((sum, p) => sum + p.alloc_i, 0);

  const distribution = peers.map((p) => ({
    peer_id:          p.peer_id,
    peer_name:        p.peer_name,
    alloc_per_cycle:  p.alloc_i,
    packets_received: 0,
    cycles_partial:   0,
    packet_ranges:    [],
  }));

  let packetIdx = 0;
  let cycle     = 0;

  while (packetIdx < nPackets) {
    cycle++;
    let fullCycle = true;

    for (let i = 0; i < m; i++) {
      if (packetIdx >= nPackets) { fullCycle = false; break; }

      const quota   = peers[i].alloc_i;
      const first   = packetIdx + 1;   // indice 1-based (P1, P2, …)
      let   assigned = 0;

      for (let k = 0; k < quota && packetIdx < nPackets; k++) {
        packetIdx++;
        assigned++;
        distribution[i].packets_received++;
      }

      if (assigned > 0) {
        distribution[i].packet_ranges.push({
          cycle,
          P_first: first,
          P_last:  packetIdx,
          count:   assigned,
        });
        if (assigned < quota) {
          distribution[i].cycles_partial++;
        }
      }
    }

    if (!fullCycle) break;
  }

  return {
    total_packets: nPackets,
    total_peers:   m,
    cycle_size:    cycleSize,
    total_cycles:  cycle,
    distribution,
  };
}

module.exports = { weightedRoundRobin };
