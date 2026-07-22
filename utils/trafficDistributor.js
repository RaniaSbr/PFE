/**
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
