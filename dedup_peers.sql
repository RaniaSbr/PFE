-- Supprimer les doublons de PEERS en gardant le plus recent par peer_name
DELETE FROM "PEERS"
WHERE peer_id NOT IN (
  SELECT DISTINCT ON (peer_name) peer_id
  FROM "PEERS"
  ORDER BY peer_name, updated_at DESC NULLS LAST
);
