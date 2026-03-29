const { MessageLog, AuditLog } = require("../models");

async function logMessage({ message_type, direction, peer_id, priority = "NORMAL", signature_valid = false, processing_result = "PROCESSED", rejection_reason = null, response_to_message = null }) {
  try {
    await MessageLog.create({
      message_type,
      direction,
      peer_id,
      priority,
      signature_valid,
      processing_result,
      rejection_reason,
      response_to_message,
    });
  } catch (_) {
    // non-bloquant — ne pas faire échouer la requête principale
  }
}

async function logAudit({ event_type, severity = "INFO", actor, target = null, description }) {
  try {
    await AuditLog.create({
      event_type,
      severity,
      actor,
      target,
      description,
    });
  } catch (_) {
    // non-bloquant
  }
}

module.exports = { logMessage, logAudit };
