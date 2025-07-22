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
      
      // For retry warnings, also log detailed breakdown
      if (message.includes('Categorized error as:') && data) {
        console.warn(`🔍 [${this.context}] Detailed error breakdown:`, {
          error_message: data.error_message,
          status_code: data.status_code,
          error_details: data.error_details,
          attempt: data.attempt,
          will_retry: data.will_retry,
          full_data: data
        });
      }
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
      
      // Also log the full error object for comprehensive debugging
      if (error) {
        console.error(`🔍 [${this.context}] Full error details:`, {
          name: error.name,
          message: error.message,
          status: error.status,
          response: error.response,
          details: error.details,
          stack: error.stack,
          ...data
        });
      }
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

/**
 * Comprehensive error logging utility for API errors
 * Use this when you need to log complex errors with full context
 */
export function logAPIError(context, error, additionalData = {}) {
  const timestamp = new Date().toISOString();
  
  console.error(`🚨 [${context.toUpperCase()}] API Error at ${timestamp}:`);
  console.error(`📍 Error Message: ${error.message}`);
  console.error(`🏷️  Error Type: ${error.name || 'Unknown'}`);
  
  if (error.status || error.response?.status) {
    console.error(`📊 HTTP Status: ${error.status || error.response?.status}`);
  }
  
  if (error.details) {
    console.error(`📋 Error Details:`, error.details);
  }
  
  if (error.response) {
    console.error(`🌐 Response Info:`, {
      status: error.response.status,
      statusText: error.response.statusText,
      headers: error.response.headers ? Object.fromEntries(error.response.headers.entries?.() || []) : null
    });
  }
  
  if (additionalData && Object.keys(additionalData).length > 0) {
    console.error(`📎 Additional Context:`, additionalData);
  }
  
  console.error(`🔍 Full Error Object:`, error);
  console.error(`📚 Stack Trace:`, error.stack);
  
  return {
    timestamp,
    context,
    error_message: error.message,
    error_type: error.name,
    status_code: error.status || error.response?.status,
    details: error.details,
    additional_data: additionalData,
    full_error: error
  };
}

/**
 * Exponential retry utility with jitter for Groq API calls
 * Handles rate limits, temporary failures, and network issues
 */
export async function withExponentialRetry(
  operation, 
  {
    maxRetries = 5,
    baseDelay = 1000,
    maxDelay = 30000,
    jitter = true,
    retryableErrors = ['rate_limit', 'temporary_failure', 'network_error', 'timeout']
  } = {}
) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      
      // Log successful retry if this wasn't the first attempt
      if (attempt > 0) {
        apiLogger.info('retry', `Operation succeeded after ${attempt} retries`);
      }
      
      return result;
    } catch (error) {
      lastError = error;
      
      // Don't retry on the last attempt
      if (attempt === maxRetries) {
        break;
      }
      
      // Categorize the error to decide if it's retryable
      const errorType = categorizeGroqError(error);
      
      // Enhanced logging for debugging
      apiLogger.warn('retry', `Categorized error as: ${errorType}`, {
        error_message: error.message,
        status_code: error.status || error.response?.status,
        error_details: error.details,
        attempt: attempt + 1,
        will_retry: retryableErrors.includes(errorType)
      });
      
      // Additional comprehensive error logging for better debugging
      console.error(`🚨 [RETRY-DEBUG] Full error context:`, {
        error_type: errorType,
        error_name: error.name,
        error_message: error.message,
        status_code: error.status || error.response?.status,
        response_status: error.response?.status,
        error_details: error.details,
        error_string: error.toString(),
        attempt: attempt + 1,
        max_retries: maxRetries,
        will_retry: retryableErrors.includes(errorType),
        retryable_errors: retryableErrors,
        full_error: error,
        // Include response data if available
        response_data: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          headers: error.response.headers ? Object.fromEntries(error.response.headers.entries?.() || []) : null
        } : null
      });
      
      if (!retryableErrors.includes(errorType)) {
        apiLogger.warn('retry', `Non-retryable error: ${errorType}`, { 
          error: error.message,
          attempt: attempt + 1
        });
        throw error;
      }
      
      // Calculate delay with exponential backoff
      let delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      
      // Add jitter to prevent thundering herd
      if (jitter) {
        delay = delay * (0.5 + Math.random() * 0.5);
      }
      
      apiLogger.warn('retry', `Attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${Math.round(delay)}ms`, {
        error: error.message,
        error_type: errorType,
        delay: Math.round(delay),
        attempt: attempt + 1,
        max_attempts: maxRetries + 1
      });
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // All retries exhausted
  apiLogger.error('retry', `All ${maxRetries + 1} attempts failed`, {
    final_error: lastError.message,
    error_type: categorizeGroqError(lastError)
  });
  
  // Comprehensive final error logging
  console.error(`💥 [RETRY-FINAL] All retry attempts exhausted:`, {
    max_attempts: maxRetries + 1,
    final_error_type: categorizeGroqError(lastError),
    final_error_name: lastError.name,
    final_error_message: lastError.message,
    final_status_code: lastError.status || lastError.response?.status,
    final_error_details: lastError.details,
    final_error_string: lastError.toString(),
    retry_config: {
      maxRetries,
      baseDelay,
      maxDelay,
      retryableErrors
    },
    full_final_error: lastError
  });
  
  throw lastError;
}

/**
 * Categorize Groq API errors for retry decisions
 */
function categorizeGroqError(error) {
  const message = error.message?.toLowerCase() || '';
  const status = error.status || error.response?.status;
  
  // Rate limiting
  if (status === 429 || message.includes('rate limit') || message.includes('too many requests')) {
    return 'rate_limit';
  }
  
  // Server errors (5xx) - usually temporary
  if (status >= 500 && status < 600) {
    return 'temporary_failure';
  }
  
  // Specific server error messages
  if (message.includes('internal server error') || 
      message.includes('service unavailable') ||
      message.includes('bad gateway') ||
      message.includes('gateway timeout')) {
    return 'temporary_failure';
  }
  
  // Network/connection issues
  if (message.includes('network') || 
      message.includes('connection') ||
      message.includes('timeout') ||
      message.includes('fetch')) {
    return 'network_error';
  }
  
  // Timeout errors
  if (message.includes('timeout') || error.name === 'AbortError') {
    return 'timeout';
  }
  
  // Authentication/authorization errors (4xx) - usually not retryable
  if (status === 401 || status === 403) {
    return 'auth_error';
  }
  
  // For Groq API, 400 errors can often be transient issues with audio processing
  // Let's be more permissive and retry them, especially for transcription
  if (status === 400) {
    // Check if it's likely a permanent client error
    if (message.includes('invalid api key') || 
        message.includes('unauthorized') ||
        message.includes('forbidden') ||
        message.includes('quota exceeded') ||
        message.includes('invalid model')) {
      return 'client_error';
    }
    
    // For other 400 errors (likely audio/format related), treat as temporary
    return 'temporary_failure';
  }
  
  // Other 4xx errors - usually not retryable
  if (status >= 400 && status < 500) {
    return 'client_error';
  }
  
  // Unknown error - be conservative and retry it
  return 'temporary_failure';
} 