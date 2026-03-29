const { RECIPROCITY_TRANSACTION_TYPES } = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const ReciprocityTransaction = sequelize.define(
    "ReciprocityTransaction",
    {
      transaction_id: {
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
      session_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: "HELP_SESSIONS",
          key: "session_id",
        },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      transaction_type: {
        type: DataTypes.ENUM(...RECIPROCITY_TRANSACTION_TYPES),
        allowNull: false,
      },
      credit_amount: {
        type: DataTypes.FLOAT,
        allowNull: false,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "RECIPROCITY_TRANSACTIONS",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          fields: ["peer_id"],
        },
        {
          fields: ["session_id"],
        },
      ],
    },
  );

  ReciprocityTransaction.associate = (db) => {
    ReciprocityTransaction.belongsTo(db.Peer, {
      foreignKey: "peer_id",
      targetKey: "peer_id",
      as: "peer",
    });
    ReciprocityTransaction.belongsTo(db.HelpSession, {
      foreignKey: "session_id",
      targetKey: "session_id",
      as: "session",
    });
  };

  return ReciprocityTransaction;
};
