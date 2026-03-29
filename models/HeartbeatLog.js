const { HEARTBEAT_REPORTED_STATUSES } = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const HeartbeatLog = sequelize.define(
    "HeartbeatLog",
    {
      heartbeat_id: {
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
      received_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      reported_status: {
        type: DataTypes.ENUM(...HEARTBEAT_REPORTED_STATUSES),
        allowNull: false,
      },
      reported_load_pct: {
        type: DataTypes.FLOAT,
        allowNull: false,
        validate: {
          min: 0,
          max: 100,
        },
      },
      reported_available_gbps: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0,
        },
      },
      round_trip_time_ms: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: 0,
        },
      },
    },
    {
      tableName: "HEARTBEAT_LOG",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          fields: ["peer_id"],
        },
        {
          fields: ["received_at"],
        },
      ],
    },
  );

  HeartbeatLog.associate = (db) => {
    HeartbeatLog.belongsTo(db.Peer, {
      foreignKey: "peer_id",
      targetKey: "peer_id",
      as: "peer",
    });
  };

  return HeartbeatLog;
};
