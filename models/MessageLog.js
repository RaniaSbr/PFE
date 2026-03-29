const {
  MESSAGE_DIRECTIONS,
  MESSAGE_PRIORITIES,
  MESSAGE_PROCESSING_RESULTS,
  MESSAGE_TYPES,
} = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const MessageLog = sequelize.define(
    "MessageLog",
    {
      message_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      message_type: {
        type: DataTypes.ENUM(...MESSAGE_TYPES),
        allowNull: false,
      },
      direction: {
        type: DataTypes.ENUM(...MESSAGE_DIRECTIONS),
        allowNull: false,
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
      priority: {
        type: DataTypes.ENUM(...MESSAGE_PRIORITIES),
        allowNull: false,
        defaultValue: "NORMAL",
      },
      signature_valid: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      processing_result: {
        type: DataTypes.ENUM(...MESSAGE_PROCESSING_RESULTS),
        allowNull: false,
        defaultValue: "PROCESSED",
      },
      rejection_reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      response_to_message: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: "MESSAGE_LOG",
          key: "message_id",
        },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      timestamp: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "MESSAGE_LOG",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          fields: ["peer_id"],
        },
        {
          fields: ["timestamp"],
        },
      ],
    },
  );

  MessageLog.associate = (db) => {
    MessageLog.belongsTo(db.Peer, {
      foreignKey: "peer_id",
      targetKey: "peer_id",
      as: "peer",
    });
    MessageLog.belongsTo(db.MessageLog, {
      foreignKey: "response_to_message",
      targetKey: "message_id",
      as: "response_to",
    });
    MessageLog.hasMany(db.MessageLog, {
      foreignKey: "response_to_message",
      sourceKey: "message_id",
      as: "responses",
    });
  };

  return MessageLog;
};
