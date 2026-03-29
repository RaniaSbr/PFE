const { ATTACK_SEVERITIES, ATTACK_STATUSES, ATTACK_TYPES } = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const Attack = sequelize.define(
    "Attack",
    {
      attack_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      attack_type: {
        type: DataTypes.ENUM(...ATTACK_TYPES),
        allowNull: false,
      },
      detected_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      ended_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      duration_seconds: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: {
          min: 0,
        },
      },
      status: {
        type: DataTypes.ENUM(...ATTACK_STATUSES),
        allowNull: false,
        defaultValue: "DETECTED",
      },
      peak_volume_gbps: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      local_capacity_at_detection: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
        },
      },
      overflow_volume_gbps: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      target_ip_range: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      target_service: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      target_port: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: {
          min: 0,
          max: 65535,
        },
      },
      target_protocol: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: {
          min: 0,
          max: 255,
        },
      },
      escalation_triggered: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      escalation_triggered_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      coalition_helped: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      nb_peers_involved: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      severity: {
        type: DataTypes.ENUM(...ATTACK_SEVERITIES),
        allowNull: false,
        defaultValue: "LOW",
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "ATTACKS",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          fields: ["status"],
        },
        {
          fields: ["detected_at"],
        },
      ],
    },
  );

  Attack.associate = (db) => {
    Attack.hasMany(db.HelpSession, {
      foreignKey: "attack_id",
      sourceKey: "attack_id",
      as: "help_sessions",
    });
  };

  return Attack;
};
