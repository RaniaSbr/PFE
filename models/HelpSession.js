const { HELP_DIRECTIONS, HELP_STATUSES, TUNNEL_TYPES } = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const HelpSession = sequelize.define(
    "HelpSession",
    {
      session_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      attack_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: "ATTACKS",
          key: "attack_id",
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      requesting_node_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: "LOCAL_NODE_CONFIG",
          key: "node_id",
        },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      helping_peer_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: "PEERS",
          key: "peer_id",
        },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      direction: {
        type: DataTypes.ENUM(...HELP_DIRECTIONS),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM(...HELP_STATUSES),
        allowNull: false,
        defaultValue: "REQUESTED",
      },
      requested_volume_gbps: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      accepted_volume_gbps: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
        },
      },
      actual_volume_gbps: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
        },
      },
      requested_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      responded_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      activated_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      completed_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      response_time_ms: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
        },
      },
      rejection_reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      failure_reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      tunnel_type: {
        type: DataTypes.ENUM(...TUNNEL_TYPES),
        allowNull: true,
      },
      quality_rating: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
          max: 5,
        },
      },
      credits_exchanged: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
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
      tableName: "HELP_SESSIONS",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          fields: ["attack_id"],
        },
        {
          fields: ["helping_peer_id"],
        },
        {
          fields: ["status"],
        },
      ],
    },
  );

  HelpSession.associate = (db) => {
    HelpSession.belongsTo(db.Attack, {
      foreignKey: "attack_id",
      targetKey: "attack_id",
      as: "attack",
    });
    HelpSession.belongsTo(db.LocalNodeConfig, {
      foreignKey: "requesting_node_id",
      targetKey: "node_id",
      as: "requesting_node",
    });
    HelpSession.belongsTo(db.Peer, {
      foreignKey: "helping_peer_id",
      targetKey: "peer_id",
      as: "helping_peer",
    });
    HelpSession.hasMany(db.ReciprocityTransaction, {
      foreignKey: "session_id",
      sourceKey: "session_id",
      as: "transactions",
    });
  };

  return HelpSession;
};
