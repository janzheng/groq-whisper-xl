// ============================================================================
// UNIFIED LOGGING SYSTEM
// ============================================================================

/**
 * Standardized logging system for consistent output across CLI, Web, and API
 * Provides emoji-based categorization and multiple log levels
 */
export class UnifiedLogger {
  static levels = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  };

  static emojis = {
    // Process states
    start: '🚀',
    processing: '🔄',
    complete: '✅',
    failed: '❌',
    
    // File operations
    upload: '📤',
    download: '📥',
    file: '📁',
    delete: '🗑️',
    
    // Audio/transcription
    audio: '🎵',
    transcribe: '🎤',
    chunk: '🧩',
    stream: '🌊',
    llm: '🧠',
    
    // Network/API
    api: '📡',
    webhook: '🔗',
    url: '🌐',
    
    // Status/info
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌',
    debug: '🔍',
    stats: '📊',
    time: '⏱️',
    progress: '📈'
  };

  constructor(context = 'SYSTEM', level = UnifiedLogger.levels.INFO) {
    this.context = context;
    this.level = level;
    this.isServer = typeof window === 'undefined';
  }

  _formatMessage(emoji, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = `${emoji} [${this.context}]`;
    
    if (data) {
      return `${prefix} ${message} | ${JSON.stringify(data)}`;
    }
    return `${prefix} ${message}`;
  }

  debug(message, data = null) {
    if (this.level <= UnifiedLogger.levels.DEBUG) {
      const formatted = this._formatMessage(UnifiedLogger.emojis.debug, message, data);
      console.log(formatted);
    }
  }

  info(emoji, message, data = null) {
    if (this.level <= UnifiedLogger.levels.INFO) {
      const emojiSymbol = UnifiedLogger.emojis[emoji] || emoji;
      const formatted = this._formatMessage(emojiSymbol, message, data);
      console.log(formatted);
    }
  }

  warn(message, data = null) {
    if (this.level <= UnifiedLogger.levels.WARN) {
      const formatted = this._formatMessage(UnifiedLogger.emojis.warning, message, data);
      console.warn(formatted);
    }
  }

  error(message, error = null, data = null) {
    if (this.level <= UnifiedLogger.levels.ERROR) {
      const errorData = error ? { 
        message: error.message, 
        stack: error.stack?.substring(0, 200),
        ...data 
      } : data;
      const formatted = this._formatMessage(UnifiedLogger.emojis.error, message, errorData);
      console.error(formatted);
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
}

// Create pre-configured loggers for different contexts
export const apiLogger = new UnifiedLogger('API', UnifiedLogger.levels.INFO);
export const processingLogger = new UnifiedLogger('PROCESSING', UnifiedLogger.levels.INFO);
export const streamLogger = new UnifiedLogger('STREAM', UnifiedLogger.levels.INFO);

// Helper function to format bytes consistently
export function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
} 