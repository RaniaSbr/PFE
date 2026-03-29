const { ORGANIZATION_TYPES, NODE_TIERS, LOCAL_NODE_STATUSES } = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const LocalNodeConfig = sequelize.define(
    "LocalNodeConfig",
    {
      node_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      node_name: {
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
      region: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      asn_number: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      ip_range_protected: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      api_endpoint_url: {
        type: DataTypes.STRING(2048),
        allowNull: false,
      },
      api_port: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 8443,
        validate: {
          min: 1,
          max: 65535,
        },
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
      current_load_percent: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
          max: 100,
        },
      },
      status: {
        type: DataTypes.ENUM(...LOCAL_NODE_STATUSES),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      coalition_join_date: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      last_updated: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "LOCAL_NODE_CONFIG",
      freezeTableName: true,
      timestamps: false,
    },
  );

  LocalNodeConfig.associate = (db) => {
    LocalNodeConfig.hasMany(db.ScrubbingCapability, {
      foreignKey: "node_id",
      sourceKey: "node_id",
      as: "scrubbing_capabilities",
    });
    LocalNodeConfig.hasMany(db.PolicyConfig, {
      foreignKey: "node_id",
      sourceKey: "node_id",
      as: "policies",
    });
    LocalNodeConfig.hasMany(db.HelpSession, {
      foreignKey: "requesting_node_id",
      sourceKey: "node_id",
      as: "help_sessions",
    });
  };

  return LocalNodeConfig;
};
