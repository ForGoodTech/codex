'use strict';

const appSurfaceTransportLogRoot = 'surestinfo.app-surface';

function utf8MessageLength(value) {
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  return Buffer.byteLength(value === undefined || value === null ? '' : String(value), 'utf8');
}

function formatAppSurfaceMessageLengthLog(stage, length, now = new Date()) {
  const normalizedStage =
    String(stage ?? '')
      .replace(/[\r\n]/g, '')
      .replace(/^[.\s]+|[.\s]+$/g, '') || 'unknown';
  const normalizedLength = Number.isSafeInteger(length) && length >= 0 ? length : 0;
  return `${now.toISOString()} - ${appSurfaceTransportLogRoot}.${normalizedStage} - ${normalizedLength} bytes`;
}

function logAppSurfaceMessageLength(stage, length, logger = console.log) {
  logger(formatAppSurfaceMessageLengthLog(stage, length));
}

module.exports = {
  formatAppSurfaceMessageLengthLog,
  logAppSurfaceMessageLength,
  utf8MessageLength,
};
