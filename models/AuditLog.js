const { AUDIT_EVENT_TYPES, AUDIT_SEVERITIES } = require("./enums");

module.exports = (sequelize, DataTypes) => {
  const AuditLog = sequelize.define(
    "AuditLog",
    {
      audit_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      event_type: {
        type: DataTypes.ENUM(...AUDIT_EVENT_TYPES),
        allowNull: false,
      },
      severity: {
        type: DataTypes.ENUM(...AUDIT_SEVERITIES),
        allowNull: false,
        defaultValue: "INFO",
      },
      actor: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      target: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      timestamp: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "AUDIT_LOG",
      freezeTableName: true,
      timestamps: false,
      indexes: [
        {
          fields: ["severity"],
        },
        {
          fields: ["timestamp"],
        },
      ],
    },
  );

  return AuditLog;
};
