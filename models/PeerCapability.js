const { CAPABILITY_ATTACK_TYPES } = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const PeerCapability = sequelize.define(
    "PeerCapability",
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      peer_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: "PEERS",
          key: "peer_id",
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      attack_type: {
        type: DataTypes.ENUM(...CAPABILITY_ATTACK_TYPES),
        allowNull: false,
      },
      declared_capacity_gbps: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      verified: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      verified_at: {
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
      tableName: "PEER_CAPABILITIES",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          unique: true,
          fields: ["peer_id", "attack_type"],
        },
      ],
    },
  );

  PeerCapability.associate = (db) => {
    PeerCapability.belongsTo(db.Peer, {
      foreignKey: "peer_id",
      targetKey: "peer_id",
      as: "peer",
    });
  };

  return PeerCapability;
};
