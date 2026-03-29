const { SANCTION_TYPES, VIOLATION_SEVERITIES, VIOLATION_TYPES } = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const TrustViolation = sequelize.define(
    "TrustViolation",
    {
      violation_id: {
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
      violation_type: {
        type: DataTypes.ENUM(...VIOLATION_TYPES),
        allowNull: false,
      },
      severity: {
        type: DataTypes.ENUM(...VIOLATION_SEVERITIES),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      sanction_applied: {
        type: DataTypes.ENUM(...SANCTION_TYPES),
        allowNull: false,
        defaultValue: "NONE",
      },
      sanction_until: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      detected_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "TRUST_VIOLATIONS",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          fields: ["peer_id"],
        },
        {
          fields: ["detected_at"],
        },
      ],
    },
  );

  TrustViolation.associate = (db) => {
    TrustViolation.belongsTo(db.Peer, {
      foreignKey: "peer_id",
      targetKey: "peer_id",
      as: "peer",
    });
  };

  return TrustViolation;
};
