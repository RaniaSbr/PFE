module.exports = (sequelize, DataTypes) => {
  const PolicyConfig = sequelize.define(
    "PolicyConfig",
    {
      policy_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      node_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: "LOCAL_NODE_CONFIG",
          key: "node_id",
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      min_trust_score_to_help: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0.4,
        validate: {
          min: 0,
          max: 1,
        },
      },
      max_capacity_share_pct: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 70,
        validate: {
          min: 0,
          max: 100,
        },
      },
      heartbeat_interval_sec: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 30,
        validate: {
          min: 1,
        },
      },
      auto_offer_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      is_current: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "POLICY_CONFIG",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          fields: ["node_id"],
        },
        {
          fields: ["node_id", "is_current"],
        },
      ],
    },
  );

  PolicyConfig.associate = (db) => {
    PolicyConfig.belongsTo(db.LocalNodeConfig, {
      foreignKey: "node_id",
      targetKey: "node_id",
      as: "node",
    });
  };

  return PolicyConfig;
};
