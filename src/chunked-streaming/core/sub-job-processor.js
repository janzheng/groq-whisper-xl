import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { transcribeChunk, applyPerChunkLLMCorrection } from '../../core/streaming.js';
import { processingLogger, formatBytes, withExponentialRetry } from '../../core/logger.js';
import { withTranscriptionLimits, withLLMLimits } from '../../core/rate-limiter.js';

/**
 * Sub-job Processor for individual chunks in chunked upload streaming
 * Handles the processing of individual audio chunks with streaming feedback
 */

export class SubJobProcessor {
  constructor(env) {
    this.env = env;
    this.kv = env.GROQ_JOBS_KV;
    this.s3Client = this.createS3Client();
  }

  createS3Client() {
    return new S3Client({
      region: 'auto',
      endpoint: `https://${this.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { 
        accessKeyId: this.env.R2_ACCESS_KEY_ID, 
        secretAccessKey: this.env.R2_SECRET_ACCESS_KEY 
      },
    });
  }

  /**
   * Create a sub-job for a specific chunk
   */
  async createSubJob({
    parent_job_id,
    chunk_index,
    chunk_range,
    filename,
    size
  }) {
    const sub_job_id = crypto.randomUUID();
    const key = `uploads/${parent_job_id}/chunk.${chunk_index}.${this.getExtension(filename)}`;

    const subJob = {
      job_id: sub_job_id,
      parent_job_id,
      type: 'chunk_sub_job',
      chunk_index,
      chunk_range, // [start_byte, end_byte]
      
      status: 'pending', // pending -> uploaded -> processing -> done/failed
      filename: `${filename}.chunk.${chunk_index}`,
      original_filename: filename,
      size,
      key,
      
      // Results
      final_transcript: '',
      raw_transcript: '',
      corrected_transcript: '',
      transcripts: [],
      segments: [],
      
      // Timing
      created_at: new Date().toISOString(),
      uploaded_at: null,
      processing_started_at: null,
      completed_at: null,
      failed_at: null,
      
      // Error tracking
      error: null,
      retry_count: 0,
      max_retries: 3
    };

    await this.kv.put(sub_job_id, JSON.stringify(subJob), { expirationTtl: 86400 });
    
    processingLogger.info('create', `Created sub-job for chunk ${chunk_index}`, {
      sub_job_id,
      parent_job_id,
      chunk_index,
      size: formatBytes(size)
    });

    return subJob;
  }

  /**
   * Get sub-job by ID
   */
  async getSubJob(sub_job_id) {
    const jobData = await this.kv.get(sub_job_id);
    if (!jobData) {
      throw new Error(`Sub-job ${sub_job_id} not found`);
    }
    return JSON.parse(jobData);
  }

  /**
   * Update sub-job status and data
   */
  async updateSubJob(sub_job_id, updates) {
    const subJob = await this.getSubJob(sub_job_id);
    const updatedSubJob = { ...subJob, ...updates };
    await this.kv.put(sub_job_id, JSON.stringify(updatedSubJob), { expirationTtl: 86400 });
    return updatedSubJob;
  }

  /**
   * Mark sub-job as uploaded and ready for processing
   */
  async markChunkUploaded(sub_job_id, actual_size) {
    const subJob = await this.updateSubJob(sub_job_id, {
      status: 'uploaded',
      actual_size,
      uploaded_at: new Date().toISOString()
    });

    processingLogger.info('upload', `Chunk ${subJob.chunk_index} uploaded`, {
      sub_job_id,
      parent_job_id: subJob.parent_job_id,
      chunk_index: subJob.chunk_index,
      actual_size: formatBytes(actual_size)
    });

    return subJob;
  }

  /**
   * Process a chunk with streaming support and automatic retry logic
   */
  async processChunk(sub_job_id, streamController = null, use_llm = false, llm_mode = 'per_chunk', model = 'whisper-large-v3') {
    const processingStartTime = Date.now();
    
    try {
      // Get sub-job details
      const subJobData = await this.kv.get(sub_job_id);
      if (!subJobData) {
        throw new Error(`Sub-job ${sub_job_id} not found`);
      }
      
      const subJob = JSON.parse(subJobData);
      const isChunk0 = subJob.chunk_index === 0;
      
      // Enhanced debugging for chunk 0
      if (isChunk0) {
        processingLogger.info('chunk0', 'Starting chunk 0 processing', {
          sub_job_id,
          parent_job_id: subJob.parent_job_id,
          chunk_index: subJob.chunk_index,
          size: subJob.size,
          model,
          r2_key: subJob.key
        });
      }

      // Retrieve the chunk from R2
      const s3Client = this.createS3Client();
      const getCmd = new GetObjectCommand({
        Bucket: this.env.R2_BUCKET_NAME || 
        (this.env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio'),
        Key: subJob.key
      });

      processingLogger.debug(`Downloading chunk from R2`, {
        sub_job_id,
        r2_key: subJob.key,
        model
      });

      const s3Response = await s3Client.send(getCmd);

      // Read the stream into a buffer
      const chunks = [];
      const reader = s3Response.Body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const audioBuffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        audioBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      // Enhanced validation for chunk 0
      if (isChunk0) {
        processingLogger.info('chunk0', 'Chunk 0 R2 download completed, validating content', {
          downloaded_size: totalLength,
          expected_size: subJob.size,
          size_match: totalLength === subJob.size,
          first_16_bytes: Array.from(audioBuffer.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '),
          last_16_bytes: totalLength > 16 ? Array.from(audioBuffer.slice(-16)).map(b => b.toString(16).padStart(2, '0')).join(' ') : 'N/A',
          model
        });
        
        // Check for obvious issues
        const zeroCount = Array.from(audioBuffer.slice(0, Math.min(1024, audioBuffer.length))).filter(b => b === 0).length;
        const zeroPercentage = (zeroCount / Math.min(1024, audioBuffer.length)) * 100;
        
        processingLogger.info('chunk0', 'Chunk 0 content analysis', {
          zero_bytes_in_first_kb: zeroCount,
          zero_percentage_first_kb: zeroPercentage.toFixed(1),
          total_zero_bytes: Array.from(audioBuffer).filter(b => b === 0).length,
          total_zero_percentage: ((Array.from(audioBuffer).filter(b => b === 0).length / audioBuffer.length) * 100).toFixed(1)
        });
      }

      processingLogger.transcribe(`Starting transcription for chunk ${subJob.chunk_index}`, {
        sub_job_id,
        chunk_index: subJob.chunk_index,
        size: formatBytes(totalLength),
        model
      });

      // Transcribe the chunk with retry logic and enhanced logging
      const ext = this.getExtension(subJob.original_filename);
      const transcript = await this.transcribeWithRetryAndDiagnostics(audioBuffer, ext, this.env.GROQ_API_KEY, subJob, model);

      // Enhanced logging for chunk 0 results
      if (isChunk0) {
        processingLogger.info('chunk0', 'Chunk 0 transcription completed', {
          transcript_length: transcript.text?.length || 0,
          has_text: !!transcript.text,
          has_segments: !!(transcript.segments && transcript.segments.length > 0),
          segment_count: transcript.segments?.length || 0,
          transcript_preview: transcript.text ? `"${transcript.text.substring(0, 100)}..."` : 'EMPTY',
          model
        });
      }

      // Apply LLM correction if enabled
      let correctedText = transcript.text;
      let llmApplied = false;

      if (use_llm && llm_mode === 'per_chunk' && transcript.text) {
        try {
          const { applyPerChunkLLMCorrection } = await import('../../core/streaming.js');
          correctedText = await applyPerChunkLLMCorrection(transcript.text, this.env.GROQ_API_KEY);
          llmApplied = true;
        } catch (llmError) {
          processingLogger.warn('LLM correction failed, using raw transcript', llmError);
          correctedText = transcript.text;
        }
      }

      // Calculate processing time
      const processingTime = Date.now() - processingStartTime;

      // Prepare the result
      const result = {
        text: transcript.text || '',
        raw_text: transcript.text || '',
        corrected_text: llmApplied ? correctedText : null,
        segments: transcript.segments || [],
        start: subJob.chunk_range[0],
        end: subJob.chunk_range[1],
        duration: transcript.duration || 0,
        chunk_index: subJob.chunk_index,
        processing_time: processingTime,
        llm_applied: llmApplied,
        model,
        groq_response: transcript // Preserve full Groq API response
      };

      // Update sub-job status
      await this.updateSubJob(sub_job_id, {
        status: 'done',
        completed_at: new Date().toISOString(),
        final_transcript: transcript.text || '',
        raw_transcript: transcript.text || '',
        corrected_transcript: llmApplied ? correctedText : null,
        transcripts: [result],
        segments: transcript.segments || [],
        processing_time: processingTime
      });

      if (streamController) {
        this.sendStreamEvent(streamController, 'chunk_complete', {
          chunk_index: subJob.chunk_index,
          parent_job_id: subJob.parent_job_id,
          text: transcript.text || '',
          raw_text: transcript.text || '',
          corrected_text: llmApplied ? correctedText : null,
          segments: transcript.segments || [],
          processing_time: processingTime,
          llm_applied: llmApplied
        });
      }

      processingLogger.complete(`Chunk ${subJob.chunk_index} processing completed`, {
        sub_job_id,
        chunk_index: subJob.chunk_index,
        transcript_length: transcript.text?.length || 0,
        processing_time: processingTime,
        llm_applied: llmApplied
      });

      return result;

    } catch (error) {
      // Enhanced error logging for chunk 0
      if (subJob.chunk_index === 0) {
        processingLogger.error('Chunk 0 processing failed with detailed context', error, {
          sub_job_id,
          parent_job_id: subJob.parent_job_id,
          chunk_index: subJob.chunk_index,
          error_type: this.categorizeError(error),
          error_message: error.message,
          retry_count: subJob.retry_count || 0
        });
      }
      
      return await this.handleChunkProcessingFailure(sub_job_id, error, streamController, use_llm, llm_mode);
    }
  }

  /**
   * Enhanced version with diagnostics for chunk 0
   */
  async transcribeWithRetryAndDiagnostics(audioBuffer, ext, apiKey, subJob, model = 'whisper-large-v3') {
    const isChunk0 = subJob.chunk_index === 0;
    
    try {
      return await this.transcribeWithRetry(audioBuffer, ext, apiKey, subJob, model);
    } catch (error) {
      if (isChunk0) {
        // For chunk 0, run comprehensive diagnostics before giving up
        processingLogger.error('Chunk 0 failed all retry attempts, running diagnostics', error, {
          sub_job_id: subJob.job_id,
          original_filename: subJob.original_filename,
          chunk_size: audioBuffer.length,
          file_extension: ext,
          model,
          error_details: this.extractGroqErrorDetails(error)
        });
        
        // Run audio format diagnostics
        const diagnostics = await this.runAudioDiagnostics(audioBuffer, ext);
        processingLogger.info('chunk0', 'Audio format diagnostics', {
          ...diagnostics,
          model
        });
        
        // If this looks like a format issue, try a fallback approach
        if (diagnostics.likely_format_issue) {
          processingLogger.info('chunk0', 'Attempting format fallback for chunk 0');
          try {
            // Try with a different extension or minimal processing
            const fallbackResult = await this.transcribeWithFallback(audioBuffer, ext, apiKey, model);
            processingLogger.info('chunk0', 'Fallback transcription succeeded for chunk 0', {
              transcript_length: fallbackResult.text?.length || 0,
              model
            });
            return fallbackResult;
          } catch (fallbackError) {
            processingLogger.error('Chunk 0 fallback also failed', fallbackError, { model });
          }
        }
      }
      
      throw error;
    }
  }

  /**
   * Transcribe with automatic retry logic using centralized retry utility
   */
  async transcribeWithRetry(audioBuffer, ext, apiKey, subJob, model = 'whisper-large-v3', maxRetries = 5) {
    const isChunk0 = subJob.chunk_index === 0;
    
    // Apply smart preprocessing for chunk 0 and problematic chunks
    const preprocessedBuffer = await this.preprocessAudioChunk(audioBuffer, subJob.chunk_index, ext);
    
    if (isChunk0) {
      processingLogger.info('chunk0', 'Chunk 0 preprocessing completed', {
        original_size: audioBuffer.length,
        preprocessed_size: preprocessedBuffer.length,
        size_changed: audioBuffer.length !== preprocessedBuffer.length,
        bytes_removed: audioBuffer.length - preprocessedBuffer.length,
        model
      });
    }
    
    const result = await withExponentialRetry(async () => {
      if (isChunk0) {
        processingLogger.info('chunk0', 'Attempting chunk 0 transcription', {
          chunk_size: preprocessedBuffer.length,
          model
        });
      }
      
      const { transcribeChunk } = await import('../../core/streaming.js');
      const transcriptionResult = await transcribeChunk(preprocessedBuffer, ext, apiKey, model);
      
      if (isChunk0) {
        processingLogger.info('chunk0', 'Chunk 0 transcription successful', {
          transcript_length: transcriptionResult.text?.length || 0,
          has_text: !!transcriptionResult.text,
          segments_count: transcriptionResult.segments?.length || 0,
          model
        });
      }
      
      return transcriptionResult;
    }, {
      maxRetries,
      baseDelay: 1000,
      maxDelay: 30000,
      // Aggressive retry logic for chunked processing - audio issues are often transient
      retryableErrors: ['rate_limit', 'temporary_failure', 'network_error', 'timeout', 'client_error']
    });
    
    return result;
  }

  /**
   * Extract specific details from Groq API errors
   */
  extractGroqErrorDetails(error) {
    try {
      const errorMessage = error.message || '';
      const errorString = error.toString() || '';
      
      // Look for specific Groq error patterns
      const patterns = {
        audio_format: /invalid audio format|unsupported format|audio format not supported/i,
        audio_empty: /no audio found|audio file is empty|no valid audio stream/i,
        audio_corrupted: /corrupted|malformed|invalid audio data/i,
        file_size: /file too large|file too small|invalid file size/i,
        rate_limit: /rate limit|too many requests|quota exceeded/i,
        auth_error: /unauthorized|invalid api key|authentication/i,
        server_error: /internal server error|service unavailable|502|503|504/i
      };
      
      const details = {
        error_message: errorMessage,
        error_category: 'unknown'
      };
      
      for (const [category, pattern] of Object.entries(patterns)) {
        if (pattern.test(errorMessage) || pattern.test(errorString)) {
          details.error_category = category;
          break;
        }
      }
      
      // Extract HTTP status if available
      if (error.status) {
        details.http_status = error.status;
      }
      
      // Extract response body if available
      if (error.response && typeof error.response === 'string') {
        details.response_body = error.response.substring(0, 500); // Limit to 500 chars
      }
      
      return details;
    } catch (e) {
      return { error_message: 'Could not extract error details', extraction_error: e.message };
    }
  }

  /**
   * Smart audio chunk preprocessing to handle metadata and format issues
   */
  async preprocessAudioChunk(audioBuffer, chunkIndex, ext) {
    // For chunk 0, apply very minimal preprocessing
    if (chunkIndex === 0) {
      return this.preprocessFirstChunkConservative(audioBuffer, ext);
    }
    
    // For other chunks, do minimal validation only
    return this.validateGeneralChunk(audioBuffer);
  }

  /**
   * Very conservative preprocessing for first chunk - only handle obvious corruption
   */
  preprocessFirstChunkConservative(audioBuffer, ext) {
    // Check for obviously corrupted data (all zeros, etc.)
    const zeroCount = Array.from(audioBuffer.slice(0, Math.min(1024, audioBuffer.length)))
                        .filter(byte => byte === 0).length;
    
    if (zeroCount > 512) { // More than 50% zeros in first 1KB
      processingLogger.warn('⚠️ [PROCESSING] Chunk 0 appears to have corrupted header, but keeping original data', {
        zero_bytes_in_first_kb: zeroCount,
        total_size: audioBuffer.length
      });
    }
    
    // For MP3s, handle ID3 tags more intelligently
    if (ext.toLowerCase() === 'mp3' && audioBuffer.length >= 10) {
      const id3Header = new TextDecoder('ascii').decode(audioBuffer.slice(0, 3));
      if (id3Header === 'ID3') {
        const view = new DataView(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength);
        const tagSize = ((view.getUint8(6) & 0x7F) << 21) |
                       ((view.getUint8(7) & 0x7F) << 14) |
                       ((view.getUint8(8) & 0x7F) << 7) |
                       (view.getUint8(9) & 0x7F);
        
        const tagOffset = 10 + tagSize;
        const tagPercentage = (tagOffset / audioBuffer.length) * 100;
        
        // More intelligent handling based on tag size and remaining audio
        if (tagOffset >= audioBuffer.length) {
          processingLogger.warn('ID3 tag is entire chunk - chunk likely contains only metadata', {
            tag_size: tagSize,
            chunk_size: audioBuffer.length,
            audio_remaining: 0
          });
          // Keep the chunk as-is, but mark it for special handling
          return audioBuffer;
        } else if (tagPercentage > 50 && audioBuffer.length - tagOffset > 1000) {
          // Large tag but significant audio remains - remove tag for better transcription
          processingLogger.info('audio', 'Large ID3 tag detected, removing for transcription', {
            tag_size: tagSize,
            tag_percentage: tagPercentage.toFixed(1),
            remaining_audio: audioBuffer.length - tagOffset
          });
          return audioBuffer.slice(tagOffset);
        } else {
          // Normal or small tag - keep entire chunk
          processingLogger.info('audio', 'Normal ID3 tag detected, keeping entire chunk for transcription', {
            tag_size: tagSize,
            tag_percentage: tagPercentage.toFixed(1)
          });
          return audioBuffer;
        }
      }
    }
    
    // For other formats, do minimal validation
    return audioBuffer;
  }

  /**
   * Minimal validation for non-first chunks
   */
  validateGeneralChunk(audioBuffer) {
    // Just do basic sanity checks without modifying the audio
    if (audioBuffer.length === 0) {
      processingLogger.error('Chunk is completely empty');
      throw new Error('Audio chunk is empty');
    }
    
    return audioBuffer;
  }

  /**
   * Categorize errors for retry decision making
   */
  categorizeError(error) {
    const message = error.message?.toLowerCase() || '';
    
    if (message.includes('rate limit') || message.includes('429')) {
      return 'rate_limit';
    }
    if (message.includes('timeout') || message.includes('ECONNRESET')) {
      return 'network_timeout';
    }
    if (message.includes('500') || message.includes('502') || message.includes('503')) {
      return 'server_error';
    }
    if (message.includes('invalid') || message.includes('400') || message.includes('format')) {
      return 'client_error';
    }
    if (message.includes('authentication') || message.includes('401')) {
      return 'auth_error';
    }
    
    return 'unknown';
  }

  /**
   * Determine if we should retry based on error type
   */
  shouldRetryBasedOnError(errorType, attempt, maxRetries) {
    // Don't retry if we've hit max attempts
    if (attempt >= maxRetries) {
      return false;
    }
    
    switch (errorType) {
      case 'rate_limit':
      case 'network_timeout':
      case 'server_error':
        return true; // Always retry these
      case 'unknown':
        return attempt < 2; // Limited retries for unknown errors
      case 'client_error':
      case 'auth_error':
        return false; // Don't retry these - they won't succeed
      default:
        return attempt < 1; // One retry for other errors
    }
  }

  /**
   * Handle chunk processing failure with intelligent retry logic and chunk 0 fallbacks
   */
  async handleChunkProcessingFailure(sub_job_id, error, streamController, use_llm, llm_mode) {
    const subJob = await this.getSubJob(sub_job_id);
    const errorType = this.categorizeError(error);
    const currentRetryCount = (subJob.retry_count || 0) + 1;
    
    // Special handling for chunk 0 failures
    const isChunk0 = subJob.chunk_index === 0;
    let maxRetries = this.getMaxRetriesForChunk(errorType, isChunk0);
    
    // Update retry count and error info
    await this.updateSubJob(sub_job_id, {
      retry_count: currentRetryCount,
      last_error: error.message,
      last_error_type: errorType,
      last_failed_at: new Date().toISOString()
    });
    
    // Check if we should retry immediately
    if (currentRetryCount <= maxRetries && this.shouldRetryBasedOnError(errorType, currentRetryCount - 1, maxRetries)) {
      const delay = Math.min(2000 * Math.pow(1.5, currentRetryCount - 1), 10000); // Cap at 10 seconds
      
      processingLogger.warn(`Chunk ${subJob.chunk_index} failed, attempting immediate retry ${currentRetryCount}/${maxRetries}`, {
        sub_job_id,
        error: error.message,
        error_type: errorType,
        retry_delay: delay,
        is_chunk_0: isChunk0
      });
      
      // Wait before retry (use Promise for better serverless compatibility)
      await new Promise(resolve => setTimeout(resolve, delay));
      
      try {
        // Immediate retry in the same execution context
        return await this.processChunk(sub_job_id, streamController, use_llm, llm_mode);
      } catch (retryError) {
        processingLogger.error(`Immediate retry ${currentRetryCount} failed for chunk ${subJob.chunk_index}`, retryError);
        // If immediate retry fails, fall through to handle as final failure
        return await this.handleChunkProcessingFailure(sub_job_id, retryError, streamController, use_llm, llm_mode);
      }
    }
    
    // Max retries exceeded - handle chunk 0 differently
    if (isChunk0) {
      return await this.handleChunk0PersistentFailure(sub_job_id, error, errorType, currentRetryCount, streamController);
    }
    
    // Regular chunk failure handling
    await this.updateSubJob(sub_job_id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      error: error.message,
      error_type: errorType,
      final_retry_count: currentRetryCount
    });

    if (streamController) {
      this.sendStreamEvent(streamController, 'chunk_error', {
        chunk_index: subJob.chunk_index,
        parent_job_id: subJob.parent_job_id,
        error: error.message,
        error_type: errorType,
        retry_count: currentRetryCount
      });
    }

    processingLogger.error(`Chunk ${subJob.chunk_index} processing failed permanently after ${currentRetryCount} attempts`, error, {
      sub_job_id,
      chunk_index: subJob.chunk_index,
      error_type: errorType
    });

    throw error;
  }

  /**
   * Get max retries based on error type and whether it's chunk 0
   */
  getMaxRetriesForChunk(errorType, isChunk0) {
    // Chunk 0 gets more retries due to metadata complexity
    const chunk0Bonus = isChunk0 ? 2 : 0;
    
    switch (errorType) {
      case 'rate_limit':
      case 'network_timeout':
        return 5 + chunk0Bonus; // More retries for transient errors
      case 'server_error':
        return 3 + chunk0Bonus;
      case 'client_error':
      case 'auth_error':
        return 0; // No retries for permanent failures
      default:
        return 2 + chunk0Bonus;
    }
  }

  /**
   * Handle persistent chunk 0 failures with very conservative fallback strategies
   */
  async handleChunk0PersistentFailure(sub_job_id, error, errorType, retryCount, streamController) {
    const subJob = await this.getSubJob(sub_job_id);
    
    // Only skip chunk 0 in specific cases - most podcast files should have audio in chunk 0
    const shouldSkipChunk0 = this.shouldSkipChunk0BasedOnError(error, errorType, retryCount);
    
    if (!shouldSkipChunk0) {
      // Don't skip - let it fail normally and be counted as a failure
      processingLogger.error(`Chunk 0 failed permanently after ${retryCount} attempts - NOT skipping (likely contains audio)`, error, {
        sub_job_id,
        parent_job_id: subJob.parent_job_id,
        error_type: errorType,
        error: error.message,
        recommendation: 'Try converting file to MP3 or adjusting chunk size'
      });
      
      await this.updateSubJob(sub_job_id, {
        status: 'failed',
        failed_at: new Date().toISOString(),
        error: `Chunk 0 processing failed after ${retryCount} attempts: ${error.message}`,
        error_type: errorType,
        final_retry_count: retryCount,
        user_message: 'Chunk 0 transcription failed. This often happens with complex audio formats. Try converting to MP3 or reducing chunk size.'
      });

      if (streamController) {
        this.sendStreamEvent(streamController, 'chunk_error', {
          chunk_index: subJob.chunk_index,
          parent_job_id: subJob.parent_job_id,
          error: `Chunk 0 failed after ${retryCount} attempts. Try converting to MP3 format.`,
          error_type: errorType,
          retry_count: retryCount,
          user_friendly: true
        });
      }

      throw error; // Let it fail normally
    }
    
    // Only in specific cases - skip chunk 0 with helpful messaging
    processingLogger.warn(`Chunk 0 contains no transcribable audio after ${retryCount} attempts, skipping (metadata-only)`, {
      sub_job_id,
      parent_job_id: subJob.parent_job_id,
      error_type: errorType,
      error: error.message,
      skip_reason: 'Contains only file metadata/headers'
    });

    await this.updateSubJob(sub_job_id, {
      status: 'skipped',
      failed_at: new Date().toISOString(),
      error: `Chunk 0 skipped after ${retryCount} failures: ${error.message}`,
      error_type: errorType,
      final_retry_count: retryCount,
      fallback_strategy: 'skip_metadata_chunk',
      fallback_reason: 'Chunk contains only file metadata/headers with no transcribable audio'
    });

    const fallbackResult = {
      text: '',
      raw_text: '',
      corrected_text: null,
      segments: [],
      start: subJob.chunk_range[0],
      end: subJob.chunk_range[1],
      duration: 0,
      chunk_index: subJob.chunk_index,
      processing_time: 0,
      llm_applied: false,
      skipped: true,
      skip_reason: 'Metadata-only chunk (common for MP3 files with ID3 tags)'
    };

    if (streamController) {
      this.sendStreamEvent(streamController, 'chunk_skipped', {
        chunk_index: subJob.chunk_index,
        parent_job_id: subJob.parent_job_id,
        reason: 'Chunk 0 contains only file metadata/headers (this is normal)',
        strategy: 'skip_metadata_only',
        retry_count: retryCount,
        user_message: 'Chunk 0 skipped - contains only file metadata. This is normal for MP3 files.'
      });
    }

    return fallbackResult;
  }

  /**
   * Manual retry method for explicit chunk retry calls
   */
  async retryChunkProcessing(sub_job_id, streamController = null, use_llm = false, llm_mode = 'per_chunk') {
    const subJob = await this.getSubJob(sub_job_id);
    
    if (subJob.status !== 'failed') {
      throw new Error(`Cannot retry chunk ${subJob.chunk_index} - current status: ${subJob.status}`);
    }
    
    processingLogger.info('processing', `Manual retry initiated for chunk ${subJob.chunk_index}`, {
      sub_job_id,
      chunk_index: subJob.chunk_index,
      previous_retry_count: subJob.retry_count || 0
    });
    
    // Reset status and retry count for manual retry
    await this.updateSubJob(sub_job_id, {
      status: 'pending',
      retry_count: 0,
      last_error: null,
      last_error_type: null,
      last_failed_at: null,
      failed_at: null
    });
    
    // Process the chunk again
    return await this.processChunk(sub_job_id, streamController, use_llm, llm_mode);
  }

  /**
   * Get all sub-jobs for a parent job
   */
  async getSubJobsForParent(parent_job_id) {
    // This is a simplified version - in production you might want to optimize this
    // by storing sub-job IDs in the parent job or using a more efficient query method
    const listResult = await this.kv.list({ limit: 1000 });
    const subJobs = [];
    
    for (const key of listResult.keys) {
      try {
        const jobData = await this.kv.get(key.name);
        if (jobData) {
          const job = JSON.parse(jobData);
          if (job.type === 'chunk_sub_job' && job.parent_job_id === parent_job_id) {
            subJobs.push(job);
          }
        }
      } catch (error) {
        // Skip invalid entries
        continue;
      }
    }
    
    // Sort by chunk index
    return subJobs.sort((a, b) => a.chunk_index - b.chunk_index);
  }

  /**
   * Cleanup sub-job and its associated files
   */
  async cleanupSubJob(sub_job_id) {
    try {
      const subJob = await this.getSubJob(sub_job_id);
      
      // Delete chunk file from R2 if it exists
      if (subJob.key) {
        try {
          const bucketName = this.env.R2_BUCKET_NAME || 
            (this.env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
          
          const deleteCmd = new DeleteObjectCommand({ 
            Bucket: bucketName, 
            Key: subJob.key 
          });
          await this.s3Client.send(deleteCmd);
          
          processingLogger.info('cleanup', `Deleted chunk file from R2`, {
            sub_job_id,
            key: subJob.key
          });
        } catch (error) {
          processingLogger.warn('Failed to delete chunk file from R2', {
            sub_job_id,
            key: subJob.key,
            error: error.message
          });
        }
      }
      
      // Delete sub-job from KV
      await this.kv.delete(sub_job_id);
      
      processingLogger.info('cleanup', `Cleaned up sub-job`, {
        sub_job_id,
        chunk_index: subJob.chunk_index
      });
      
    } catch (error) {
      processingLogger.error('Failed to cleanup sub-job', error, { sub_job_id });
      throw error;
    }
  }

  /**
   * Helper methods
   */
  getExtension(filename) {
    return filename.split('.').pop() || 'mp3';
  }

  sendStreamEvent(controller, type, data) {
    if (controller) {
      const eventData = `data: ${JSON.stringify({ type, ...data })}\n\n`;
      controller.enqueue(new TextEncoder().encode(eventData));
    }
  }

  /**
   * Determine if chunk 0 should be skipped based on error patterns
   * Only skip in very specific cases where it's clearly just metadata
   */
  shouldSkipChunk0BasedOnError(error, errorType, retryCount) {
    const errorMessage = error.message.toLowerCase();
    
    // Only skip for very specific error patterns that indicate no audio content
    const noAudioPatterns = [
      'no audio found',
      'invalid audio format',
      'audio file is empty',
      'no valid audio stream',
      'file appears to be corrupted',
      'audio track not found',
      'invalid audio data',
      'no speech detected',
      'audio too short',
      'unsupported audio format'
    ];
    
    const hasNoAudioError = noAudioPatterns.some(pattern => errorMessage.includes(pattern));
    
    // More lenient criteria for chunk 0:
    // 1. We've tried many times (5+ attempts for chunk 0)
    // 2. AND the error specifically indicates no audio content
    // 3. AND it's not a network/rate limit issue
    // 4. OR chunk is very small (likely just metadata)
    const isSmallChunk = error.message.includes('too short') || error.message.includes('empty');
    
    return (retryCount >= 5 && hasNoAudioError && errorType !== 'rate_limit' && errorType !== 'network_timeout') ||
           (retryCount >= 3 && isSmallChunk);
  }
} 