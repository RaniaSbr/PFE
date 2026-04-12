const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "ShieldNet Node API",
      version: "1.0.0",
      description:
        "API REST P2P de defense collaborative contre les attaques DDoS",
    },
    servers: [
      {
        url: "/api/v1",
        description: "API v1",
      },
    ],
    tags: [
      { name: "Discovery", description: "Gestion des pairs" },
      { name: "Capacity", description: "Capacites de scrubbing" },
      {
        name: "Coalition",
        description: "Sessions d'aide et redirections de trafic",
      },
      { name: "Trust", description: "Scores de confiance et violations" },
      { name: "Monitoring", description: "Metriques et logs" },
      { name: "Simulation", description: "Simulation d'attaques" },
    ],
    components: {
      schemas: {
        Peer: {
          type: "object",
          properties: {
            peer_id: { type: "string", format: "uuid" },
            peer_name: { type: "string" },
            organization_name: { type: "string" },
            organization_type: {
              type: "string",
              enum: ["UNIVERSITY", "PME", "ISP", "DATACENTER", "GOVERNMENT", "STARTUP", "NGO", "OTHER"],
            },
            tier: { type: "string", enum: ["T1", "T2", "T3"] },
            country_code: { type: "string" },
            asn_number: { type: "integer", nullable: true },
            api_endpoint_url: { type: "string" },
            public_key: { type: "string" },
            certificate_fingerprint: { type: "string", nullable: true },
            max_scrubbing_capacity_gbps: { type: "number" },
            declared_available_gbps: { type: "number" },
            measured_latency_ms: { type: "number", nullable: true },
            status: {
              type: "string",
              enum: ["ACTIVE", "INACTIVE", "MAINTENANCE", "SUSPECTED", "BANNED"],
            },
            membership_status: {
              type: "string",
              enum: ["PROBATION", "CONFIRMED", "SUSPENDED", "EXPELLED"],
            },
            relationship_type: {
              type: "string",
              enum: ["DIRECT_NEIGHBOR", "KNOWN_PEER", "DISCOVERED"],
            },
            first_seen: { type: "string", format: "date-time" },
            last_heartbeat: { type: "string", format: "date-time", nullable: true },
            consecutive_missed_heartbeats: { type: "integer" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        Attack: {
          type: "object",
          properties: {
            attack_id: { type: "string", format: "uuid" },
            attack_type: {
              type: "string",
              enum: ["UDP_FLOOD", "SYN_FLOOD", "HTTP_FLOOD", "DNS_AMPLIFICATION", "NTP_AMPLIFICATION", "SLOWLORIS", "MULTI_VECTOR", "UNKNOWN"],
            },
            detected_at: { type: "string", format: "date-time" },
            ended_at: { type: "string", format: "date-time", nullable: true },
            duration_seconds: { type: "integer", nullable: true },
            status: {
              type: "string",
              enum: ["DETECTED", "ANALYZING", "MITIGATING_LOCAL", "ESCALATED_TO_COALITION", "MITIGATED", "ENDED", "UNMITIGATED"],
            },
            peak_volume_gbps: { type: "number" },
            local_capacity_at_detection: { type: "number", nullable: true },
            overflow_volume_gbps: { type: "number" },
            target_ip_range: { type: "string", nullable: true },
            target_service: { type: "string", nullable: true },
            target_port: { type: "integer", nullable: true },
            target_protocol: { type: "integer", nullable: true },
            escalation_triggered: { type: "boolean" },
            escalation_triggered_at: { type: "string", format: "date-time", nullable: true },
            coalition_helped: { type: "boolean" },
            nb_peers_involved: { type: "integer" },
            severity: {
              type: "string",
              enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
            },
            created_at: { type: "string", format: "date-time" },
          },
        },
        HelpSession: {
          type: "object",
          properties: {
            session_id: { type: "string", format: "uuid" },
            attack_id: { type: "string", format: "uuid" },
            requesting_node_id: { type: "string", format: "uuid" },
            helping_peer_id: { type: "string", format: "uuid" },
            direction: {
              type: "string",
              enum: ["OUTBOUND_REQUEST", "INBOUND_REQUEST", "OUTBOUND_OFFER", "INBOUND_OFFER"],
            },
            status: {
              type: "string",
              enum: ["REQUESTED", "OFFERED", "NEGOTIATING", "ACCEPTED", "REJECTED", "ACTIVE", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"],
            },
            requested_volume_gbps: { type: "number" },
            accepted_volume_gbps: { type: "number", nullable: true },
            actual_volume_gbps: { type: "number", nullable: true },
            requested_at: { type: "string", format: "date-time" },
            responded_at: { type: "string", format: "date-time", nullable: true },
            activated_at: { type: "string", format: "date-time", nullable: true },
            completed_at: { type: "string", format: "date-time", nullable: true },
            response_time_ms: { type: "number", nullable: true },
            rejection_reason: { type: "string", nullable: true },
            failure_reason: { type: "string", nullable: true },
            tunnel_type: {
              type: "string",
              enum: ["GRE", "VXLAN", "IPSEC", "BGP_FLOWSPEC"],
              nullable: true,
            },
            quality_rating: { type: "number", nullable: true },
            credits_exchanged: { type: "number" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
        },
      },
    },
  },
  apis: ["./routes/*.js"],
};

module.exports = swaggerJsdoc(options);
