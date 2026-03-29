const {
  MEMBERSHIP_STATUSES,
  NODE_TIERS,
  ORGANIZATION_TYPES,
  PEER_STATUSES,
  RELATIONSHIP_TYPES,
} = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const Peer = sequelize.define(
    "Peer",
    {
      peer_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      peer_name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      organization_name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      organization_type: {
        type: DataTypes.ENUM(...ORGANIZATION_TYPES),
        allowNull: false,
      },
      tier: {
        type: DataTypes.ENUM(...NODE_TIERS),
        allowNull: false,
      },
      country_code: {
        type: DataTypes.STRING(3),
        allowNull: false,
      },
      asn_number: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      api_endpoint_url: {
        type: DataTypes.STRING(2048),
        allowNull: false,
      },
      public_key: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      certificate_fingerprint: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      max_scrubbing_capacity_gbps: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      declared_available_gbps: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      measured_latency_ms: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
        },
      },
      status: {
        type: DataTypes.ENUM(...PEER_STATUSES),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      membership_status: {
        type: DataTypes.ENUM(...MEMBERSHIP_STATUSES),
        allowNull: false,
        defaultValue: "PROBATION",
      },
      relationship_type: {
        type: DataTypes.ENUM(...RELATIONSHIP_TYPES),
        allowNull: false,
        defaultValue: "DISCOVERED",
      },
      first_seen: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      last_heartbeat: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      consecutive_missed_heartbeats: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "PEERS",
      freezeTableName: true,
      timestamps: false,
    },
  );

  Peer.associate = (db) => {
    Peer.hasMany(db.PeerCapability, {
      foreignKey: "peer_id",
      sourceKey: "peer_id",
      as: "capabilities",
    });
    Peer.hasMany(db.HeartbeatLog, {
      foreignKey: "peer_id",
      sourceKey: "peer_id",
      as: "heartbeats",
    });
    Peer.hasOne(db.TrustScore, {
      foreignKey: "peer_id",
      sourceKey: "peer_id",
      as: "trust_score",
    });
    Peer.hasOne(db.ReciprocityLedger, {
      foreignKey: "peer_id",
      sourceKey: "peer_id",
      as: "reciprocity_ledger",
    });
    Peer.hasMany(db.ReciprocityTransaction, {
      foreignKey: "peer_id",
      sourceKey: "peer_id",
      as: "reciprocity_transactions",
    });
    Peer.hasMany(db.TrustViolation, {
      foreignKey: "peer_id",
      sourceKey: "peer_id",
      as: "trust_violations",
    });
    Peer.hasMany(db.HelpSession, {
      foreignKey: "helping_peer_id",
      sourceKey: "peer_id",
      as: "help_sessions",
    });
    Peer.hasMany(db.MessageLog, {
      foreignKey: "peer_id",
      sourceKey: "peer_id",
      as: "messages",
    });
  };

  return Peer;
};
