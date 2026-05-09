module.exports = (sequelize, DataTypes) => {
  const ScrubbingCapability = sequelize.define(
    "ScrubbingCapability",
    {
      capability_id: {
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
      max_capacity_gbps: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      filtering_accuracy: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
          max: 1,
        },
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "SCRUBBING_CAPABILITIES",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          unique: true,
          fields: ["node_id"],
        },
      ],
    },
  );

  ScrubbingCapability.associate = (db) => {
    ScrubbingCapability.belongsTo(db.LocalNodeConfig, {
      foreignKey: "node_id",
      targetKey: "node_id",
      as: "node",
    });
  };

  return ScrubbingCapability;
};
