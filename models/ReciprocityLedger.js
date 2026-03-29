module.exports = (sequelize, DataTypes) => {
  const ReciprocityLedger = sequelize.define(
    "ReciprocityLedger",
    {
      ledger_id: {
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
      credits_received: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      credits_given: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      balance: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      last_transaction_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "RECIPROCITY_LEDGER",
      freezeTableName: true,
      timestamps: false,
    },
  );

  ReciprocityLedger.associate = (db) => {
    ReciprocityLedger.belongsTo(db.Peer, {
      foreignKey: "peer_id",
      targetKey: "peer_id",
      as: "peer",
    });
  };

  return ReciprocityLedger;
};
