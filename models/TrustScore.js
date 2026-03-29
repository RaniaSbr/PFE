const { TRUST_LEVELS } = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const TrustScore = sequelize.define(
    "TrustScore",
    {
      trust_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      peer_id: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        references: {
          model: "PEERS",
          key: "peer_id",
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      overall_score: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 1,
        validate: {
          min: 0,
          max: 1,
        },
      },
      trust_level: {
        type: DataTypes.ENUM(...TRUST_LEVELS),
        allowNull: false,
        defaultValue: "GOLD",
      },
      reliability_score: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 1,
        validate: {
          min: 0,
          max: 1,
        },
      },
      performance_score: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 1,
        validate: {
          min: 0,
          max: 1,
        },
      },
      reciprocity_score: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 1,
        validate: {
          min: 0,
          max: 1,
        },
      },
      stability_score: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 1,
        validate: {
          min: 0,
          max: 1,
        },
      },
      total_help_requests_received: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      total_help_requests_accepted: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      total_help_requests_rejected: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      total_proactive_offers: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      avg_response_time_ms: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
        },
      },
      capacity_promise_kept_ratio: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
        },
      },
      uptime_ratio_30d: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
          max: 1,
        },
      },
      false_alert_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      last_calculated: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "TRUST_SCORES",
      freezeTableName: true,
      timestamps: false,
    },
  );

  TrustScore.associate = (db) => {
    TrustScore.belongsTo(db.Peer, {
      foreignKey: "peer_id",
      targetKey: "peer_id",
      as: "peer",
    });
  };

  return TrustScore;
};
