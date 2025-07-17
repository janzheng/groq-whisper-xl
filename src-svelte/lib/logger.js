// ============================================================================
// UNIFIED LOGGING SYSTEM (BROWSER VERSION)
// ============================================================================

/**
 * Browser-compatible version of the unified logging system
 * Maintains consistency with CLI and API logging
 */
export class UnifiedLogger {
  static levels = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  };

  static emojis = {
    start: '🚀', processing: '🔄', complete: '✅', failed: '❌',
    upload: '📤', download: '📥', file: '📁', delete: '🗑️',
    audio: '🎵', transcribe: '🎤', chunk: '🧩', stream: '🌊', llm: '🧠',
    api: '📡', webhook: '🔗', url: '🌐',
    info: 'ℹ️', warning: '⚠️', error: '❌', debug: '🔍', 
    stats: '📊', time: '⏱️', progress: '📈'
  };

  constructor(context = 'WEB', level = UnifiedLogger.levels.INFO) {
    this.context = context;
    this.level = level;
  }

  _formatMessage(emoji, message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `${emoji} [${this.context}]`;
    
    if (data && Object.keys(data).length > 0) {
      return `${prefix} ${message}`;
    }
    return `${prefix} ${message}`;
  }

  debug(message, data = null) {
    if (this.level <= UnifiedLogger.levels.DEBUG) {
      const formatted = this._formatMessage(UnifiedLogger.emojis.debug, message, data);
      console.log(formatted, data);
    }
  }

  info(emoji, message, data = null) {
    if (this.level <= UnifiedLogger.levels.INFO) {
      const emojiSymbol = UnifiedLogger.emojis[emoji] || emoji;
      const formatted = this._formatMessage(emojiSymbol, message, data);
      console.log(formatted, data);
    }
  }

  warn(message, data = null) {
    if (this.level <= UnifiedLogger.levels.WARN) {
      const formatted = this._formatMessage(UnifiedLogger.emojis.warning, message, data);
      console.warn(formatted, data);
    }
  }

  error(message, error = null, data = null) {
    if (this.level <= UnifiedLogger.levels.ERROR) {
      const formatted = this._formatMessage(UnifiedLogger.emojis.error, message, data);
      console.error(formatted, error, data);
    }
  }

  // Convenience methods for common operations
  upload(message, data = null) { this.info('upload', message, data); }
  download(message, data = null) { this.info('download', message, data); }
  processing(message, data = null) { this.info('processing', message, data); }
  complete(message, data = null) { this.info('complete', message, data); }
  chunk(message, data = null) { this.info('chunk', message, data); }
  transcribe(message, data = null) { this.info('transcribe', message, data); }
  llm(message, data = null) { this.info('llm', message, data); }
  api(message, data = null) { this.info('api', message, data); }
  stats(message, data = null) { this.info('stats', message, data); }
  stream(message, data = null) { this.info('stream', message, data); }
}

// Create web logger instances
export const webLogger = new UnifiedLogger('WEB', UnifiedLogger.levels.INFO);
export const streamLogger = new UnifiedLogger('STREAM', UnifiedLogger.levels.INFO); 