const Sequelize = require("sequelize");
const sequelize = require("../config/database");

const db = {
  Sequelize,
  sequelize,
};

db.LocalNodeConfig = require("./LocalNodeConfig")(
  sequelize,
  Sequelize.DataTypes,
);
db.ScrubbingCapability = require("./ScrubbingCapability")(
  sequelize,
  Sequelize.DataTypes,
);
db.PolicyConfig = require("./PolicyConfig")(sequelize, Sequelize.DataTypes);
db.Peer = require("./Peer")(sequelize, Sequelize.DataTypes);
db.PeerCapability = require("./PeerCapability")(sequelize, Sequelize.DataTypes);
db.HeartbeatLog = require("./HeartbeatLog")(sequelize, Sequelize.DataTypes);
db.Attack = require("./Attack")(sequelize, Sequelize.DataTypes);
db.TrustScore = require("./TrustScore")(sequelize, Sequelize.DataTypes);
db.ReciprocityLedger = require("./ReciprocityLedger")(
  sequelize,
  Sequelize.DataTypes,
);
db.ReciprocityTransaction = require("./ReciprocityTransaction")(
  sequelize,
  Sequelize.DataTypes,
);
db.TrustViolation = require("./TrustViolation")(sequelize, Sequelize.DataTypes);
db.HelpSession = require("./HelpSession")(sequelize, Sequelize.DataTypes);
db.MessageLog = require("./MessageLog")(sequelize, Sequelize.DataTypes);
db.AuditLog = require("./AuditLog")(sequelize, Sequelize.DataTypes);

Object.values(db).forEach((value) => {
  if (value && typeof value.associate === "function") {
    value.associate(db);
  }
});

async function initDatabase() {
  await sequelize.authenticate();
  try {
    await sequelize.sync({ alter: false });
  } catch (err) {
    // 42P07 = index/relation already exists — DB already initialized, skip sync
    if (err.parent?.code !== "42P07") throw err;
  }
  return db;
}

db.initDatabase = initDatabase;

module.exports = db;
