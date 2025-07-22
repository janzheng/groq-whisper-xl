import { Semaphore, createRateLimit } from './semaphore.js';
import { apiLogger } from './logger.js';

// ============================================================================
// RATE LIMITING AND CONCURRENCY CONTROL
// ============================================================================

/**
 * Global semaphores and rate limiters for different API operations
 * This helps prevent rate limiting from Groq API and manages resource usage
 */

// Transcription API rate limiting
const TRANSCRIPTION_CONCURRENCY = 4; // Max 4 concurrent transcription calls
const TRANSCRIPTION_RPS = 10; // Max 10 requests per second

// LLM API rate limiting  
const LLM_CONCURRENCY = 3; // Max 3 concurrent LLM calls
const LLM_RPS = 8; // Max 8 requests per second

// Job spawning and processing rate limiting
const JOB_SPAWN_CONCURRENCY = 2; // Max 2 concurrent job spawning operations
const CHUNK_PROCESSING_CONCURRENCY = 3; // Max 3 chunks can start processing simultaneously

// Global semaphores for concurrency control
export const transcriptionSemaphore = new Semaphore(TRANSCRIPTION_CONCURRENCY);

export const llmSemaphore = new Semaphore(LLM_CONCURRENCY);

// Job management semaphores
export const jobSpawnSemaphore = new Semaphore(JOB_SPAWN_CONCURRENCY);

export const chunkProcessingSemaphore = new Semaphore(CHUNK_PROCESSING_CONCURRENCY);

// Rate limiters for requests per second control
export const transcriptionRateLimit = createRateLimit(TRANSCRIPTION_RPS, {
  timeUnit: 1000, // 1 second
  uniformDistribution: true // Spread requests evenly over time
});

export const llmRateLimit = createRateLimit(LLM_RPS, {
  timeUnit: 1000, // 1 second 
  uniformDistribution: true // Spread requests evenly over time
});

// ============================================================================
// WRAPPER FUNCTIONS
// ============================================================================

/**
 * Wrapper for transcription API calls with concurrency and rate limiting
 * @param {Function} operation - The transcription API call function
 * @param {Object} context - Context for logging
 * @returns {Promise} - Result of the operation
 */
export async function withTranscriptionLimits(operation, context = {}) {
  const startTime = Date.now();
  
  // Apply rate limiting first
  await transcriptionRateLimit();
  
  // Then acquire semaphore for concurrency control
  const release = await transcriptionSemaphore.acquire();
  
  try {
    apiLogger.info('rate_limit', 'Starting transcription API call', {
      ...context,
      waiting_transcription: transcriptionSemaphore.waiting,
      concurrency_used: TRANSCRIPTION_CONCURRENCY - transcriptionSemaphore.waiting,
      rate_limited_ms: Date.now() - startTime
    });
    
    const result = await operation();
    
    apiLogger.info('rate_limit', 'Transcription API call completed', {
      ...context,
      duration_ms: Date.now() - startTime,
      waiting_transcription: transcriptionSemaphore.waiting
    });
    
    return result;
  } finally {
    release();
  }
}

/**
 * Wrapper for LLM API calls with concurrency and rate limiting
 * @param {Function} operation - The LLM API call function
 * @param {Object} context - Context for logging
 * @returns {Promise} - Result of the operation
 */
export async function withLLMLimits(operation, context = {}) {
  const startTime = Date.now();
  
  // Apply rate limiting first
  await llmRateLimit();
  
  // Then acquire semaphore for concurrency control
  const release = await llmSemaphore.acquire();
  
  try {
    apiLogger.info('rate_limit', 'Starting LLM API call', {
      ...context,
      waiting_llm: llmSemaphore.waiting,
      concurrency_used: LLM_CONCURRENCY - llmSemaphore.waiting,
      rate_limited_ms: Date.now() - startTime
    });
    
    const result = await operation();
    
    apiLogger.info('rate_limit', 'LLM API call completed', {
      ...context,
      duration_ms: Date.now() - startTime,
      waiting_llm: llmSemaphore.waiting
    });
    
    return result;
  } finally {
    release();
  }
}

/**
 * Wrapper for job spawning operations with concurrency control
 * @param {Function} operation - The job spawning function
 * @param {Object} context - Context for logging
 * @returns {Promise} - Result of the operation
 */
export async function withJobSpawnLimits(operation, context = {}) {
  const startTime = Date.now();
  
  // Acquire semaphore for job spawning control
  const release = await jobSpawnSemaphore.acquire();
  
  try {
    apiLogger.info('rate_limit', 'Starting job spawn operation', {
      ...context,
      waiting_job_spawn: jobSpawnSemaphore.waiting,
      concurrency_used: JOB_SPAWN_CONCURRENCY - jobSpawnSemaphore.waiting,
      queued_ms: Date.now() - startTime
    });
    
    const result = await operation();
    
    apiLogger.info('rate_limit', 'Job spawn operation completed', {
      ...context,
      duration_ms: Date.now() - startTime,
      waiting_job_spawn: jobSpawnSemaphore.waiting
    });
    
    return result;
  } finally {
    release();
  }
}

/**
 * Wrapper for chunk processing initiation with concurrency control
 * @param {Function} operation - The chunk processing function
 * @param {Object} context - Context for logging
 * @returns {Promise} - Result of the operation
 */
export async function withChunkProcessingLimits(operation, context = {}) {
  const startTime = Date.now();
  
  // Acquire semaphore for chunk processing control
  const release = await chunkProcessingSemaphore.acquire();
  
  try {
    apiLogger.info('rate_limit', 'Starting chunk processing operation', {
      ...context,
      waiting_chunk_processing: chunkProcessingSemaphore.waiting,
      concurrency_used: CHUNK_PROCESSING_CONCURRENCY - chunkProcessingSemaphore.waiting,
      queued_ms: Date.now() - startTime
    });
    
    const result = await operation();
    
    apiLogger.info('rate_limit', 'Chunk processing operation completed', {
      ...context,
      duration_ms: Date.now() - startTime,
      waiting_chunk_processing: chunkProcessingSemaphore.waiting
    });
    
    return result;
  } finally {
    release();
  }
}

/**
 * Get current status of rate limiters for monitoring
 * @returns {Object} Current status
 */
export function getRateLimitStatus() {
  return {
    transcription: {
      waiting: transcriptionSemaphore.waiting,
      concurrency_limit: TRANSCRIPTION_CONCURRENCY,
      rate_limit_rps: TRANSCRIPTION_RPS,
      active_slots: transcriptionSemaphore.active
    },
    llm: {
      waiting: llmSemaphore.waiting,
      concurrency_limit: LLM_CONCURRENCY,
      rate_limit_rps: LLM_RPS,
      active_slots: llmSemaphore.active
    },
    job_spawn: {
      waiting: jobSpawnSemaphore.waiting,
      concurrency_limit: JOB_SPAWN_CONCURRENCY,
      active_slots: jobSpawnSemaphore.active
    },
    chunk_processing: {
      waiting: chunkProcessingSemaphore.waiting,
      concurrency_limit: CHUNK_PROCESSING_CONCURRENCY,
      active_slots: chunkProcessingSemaphore.active
    }
  };
}

/**
 * Adjust rate limits dynamically (useful for different environments)
 * @param {Object} config - New configuration
 */
export function configureRateLimits(config = {}) {
  if (config.transcription_concurrency) {
    apiLogger.info('rate_limit', 'Updating transcription concurrency', {
      from: TRANSCRIPTION_CONCURRENCY,
      to: config.transcription_concurrency
    });
    // Note: async-sema doesn't support dynamic resizing, 
    // so this would require recreating the semaphores
  }
  
  if (config.llm_concurrency) {
    apiLogger.info('rate_limit', 'Updating LLM concurrency', {
      from: LLM_CONCURRENCY,
      to: config.llm_concurrency
    });
  }
} 