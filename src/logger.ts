export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function formatLog(level: LogLevel, source: string, msg: string, fields?: LogFields): string {
  const logEntry = {
    ts: new Date().toISOString(),
    level,
    source,
    msg,
    ...fields,
  };
  return JSON.stringify(logEntry);
}

export function createLogger(source: string): Logger {
  const baseFields: LogFields = { source };

  function log(level: LogLevel, msg: string, fields?: LogFields): void {
    const mergedFields = fields ? { ...baseFields, ...fields } : baseFields;
    console.log(formatLog(level, source, msg, mergedFields));
  }

  return {
    info: (msg: string, fields?: LogFields) => log("info", msg, fields),
    warn: (msg: string, fields?: LogFields) => log("warn", msg, fields),
    error: (msg: string, fields?: LogFields) => log("error", msg, fields),
    child: (fields: LogFields) => {
      const childLogger = createLogger(source);
      const originalLog = childLogger.info;
      const baseLog = (level: LogLevel) => (msg: string, extraFields?: LogFields) => {
        const mergedFields = extraFields ? { ...baseFields, ...fields, ...extraFields } : { ...baseFields, ...fields };
        console.log(formatLog(level, source, msg, mergedFields));
      };
      childLogger.info = baseLog("info");
      childLogger.warn = baseLog("warn");
      childLogger.error = baseLog("error");
      childLogger.child = (extraFields: LogFields) => childLogger.child({ ...fields, ...extraFields });
      return childLogger;
    },
  };
}