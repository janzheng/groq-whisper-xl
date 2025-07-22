  import { apiLogger, processingLogger, formatBytes } from '../../core/logger.js';

/**
 * Parent Job Manager for Chunked Upload Streaming
 * Handles lifecycle of parent jobs that coordinate multiple chunk sub-jobs
 */

export class ParentJobManager {
  constructor(env) {
    this.env = env;
    this.kv = env.GROQ_JOBS_KV;
  }

  /**
   * Create a new parent job for chunked upload streaming
   */
  async createParentJob({
    filename,
    total_size,
    chunk_size_mb = 10,
    use_llm = false,
    llm_mode = 'per_chunk',
    model = 'whisper-large-v3',
    webhook_url = null,
    debug_save_chunks = false
  }) {
    const job_id = crypto.randomUUID();
    const chunk_size_bytes = chunk_size_mb * 1024 * 1024;
    const total_chunks = Math.ceil(total_size / chunk_size_bytes);

    const parentJob = {
      job_id,
      type: 'chunked_upload_streaming',
      status: 'uploading',
      filename,
      total_size,
      chunk_size_bytes,
      chunk_size_mb,
      total_chunks,
      completed_chunks: 0,
      uploaded_chunks: 0,
      failed_chunks: 0,
      sub_jobs: [],
      
      // Track which specific chunks have been uploaded (fix race condition)
      uploaded_chunk_flags: new Array(total_chunks).fill(false),
      // Track which specific chunks have been counted as completed (fix double-counting)
      completed_chunk_flags: new Array(total_chunks).fill(false),
      
      // Results that will be assembled
      final_transcript: '',
      raw_transcript: '',
      corrected_transcript: '',
      transcripts: [], // ordered array of chunk results
      total_segments: 0,
      groq_traces: [], // Store all Groq API responses for debugging
      
      // Processing settings
      use_llm,
      llm_mode,
      model,
      webhook_url,
      debug_save_chunks,
      
      // Progress tracking
      progress: 0,
      upload_progress: 0,
      processing_progress: 0,
      
      // Timing
      created_at: new Date().toISOString(),
      upload_started_at: new Date().toISOString(),
      first_chunk_completed_at: null,
      processing_started_at: null,
      completed_at: null,
      
      // Metadata
      processing_method: 'chunked_upload_streaming',
      success_rate: 0
    };

    await this.kv.put(job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });

    processingLogger.info('create', 'Created parent job for chunked upload streaming', {
      parent_job_id: job_id,
      filename,
      total_size: formatBytes(total_size),
      chunk_size_mb,
      total_chunks,
      use_llm,
      llm_mode,
      model
    });

    return parentJob;
  }

  /**
   * Get parent job by ID
   */
  async getParentJob(job_id) {
    const jobData = await this.kv.get(job_id);
    if (!jobData) {
      throw new Error(`Parent job ${job_id} not found`);
    }
    return JSON.parse(jobData);
  }

  /**
   * Update parent job data
   */
  async updateParentJob(job_id, updates) {
    const job = await this.getParentJob(job_id);
    const updatedJob = { ...job, ...updates };
    await this.kv.put(job_id, JSON.stringify(updatedJob), { expirationTtl: 86400 });
    return updatedJob;
  }

  /**
   * Add a sub-job to the parent job
   * @deprecated Use atomic sub-job creation in UploadCoordinator instead
   */
  async addSubJob(parent_job_id, sub_job_id, chunk_index) {
    console.warn('addSubJob is deprecated - use atomic sub-job creation instead');
    const parentJob = await this.getParentJob(parent_job_id);
    
    // Ensure the sub_jobs array has enough slots
    while (parentJob.sub_jobs.length <= chunk_index) {
      parentJob.sub_jobs.push(null);
    }
    
    // Store the sub_job_id at the correct chunk index position
    parentJob.sub_jobs[chunk_index] = sub_job_id;
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    apiLogger.debug('Added sub-job to parent', {
      parent_job_id,
      sub_job_id,
      chunk_index,
      total_sub_jobs: parentJob.sub_jobs.filter(id => id !== null).length
    });
    
    return parentJob;
  }

  /**
   * Update chunk upload progress
   */
  async updateChunkUploaded(parent_job_id, chunk_index) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    // Ensure we have the uploaded_chunk_flags array (for backward compatibility)
    if (!parentJob.uploaded_chunk_flags) {
      parentJob.uploaded_chunk_flags = new Array(parentJob.total_chunks).fill(false);
    }
    
    // Mark this specific chunk as uploaded
    if (chunk_index >= 0 && chunk_index < parentJob.uploaded_chunk_flags.length) {
      parentJob.uploaded_chunk_flags[chunk_index] = true;
    }
    
    // Calculate accurate upload count and progress
    const actualUploadedCount = parentJob.uploaded_chunk_flags.filter(uploaded => uploaded).length;
    parentJob.uploaded_chunks = actualUploadedCount;
    parentJob.upload_progress = Math.round((actualUploadedCount / parentJob.total_chunks) * 100);
    
    // Transition to processing if not already
    if (parentJob.status === 'uploading' && parentJob.uploaded_chunks > 0) {
      parentJob.status = 'processing';
      parentJob.processing_started_at = new Date().toISOString();
    }
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    apiLogger.info('upload', `Chunk ${chunk_index} uploaded`, {
      parent_job_id,
      chunk_index,
      uploaded_chunks: actualUploadedCount,
      total_chunks: parentJob.total_chunks,
      upload_progress: parentJob.upload_progress
    });
    
    return parentJob;
  }

  /**
   * Update chunk completion progress
   */
  async updateChunkCompleted(parent_job_id, chunk_index, chunk_result) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    // Ensure we have the completed_chunk_flags array (for backward compatibility)
    if (!parentJob.completed_chunk_flags) {
      parentJob.completed_chunk_flags = new Array(parentJob.total_chunks).fill(false);
    }
    
    // Check if this chunk has already been counted to prevent double-counting during retries
    const alreadyCounted = parentJob.completed_chunk_flags[chunk_index];
    if (alreadyCounted) {
      apiLogger.info('chunk', `Chunk ${chunk_index} already counted, updating result only`, {
        parent_job_id,
        chunk_index,
        current_completed_count: parentJob.completed_chunks
      });
      
      // Still update the transcript result but don't change counters
      while (parentJob.transcripts.length <= chunk_index) {
        parentJob.transcripts.push(null);
      }
      parentJob.transcripts[chunk_index] = chunk_result;
      
      await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
      return parentJob;
    }
    
    // Check if chunk has valid text or is intentionally skipped
    const hasValidText = chunk_result && chunk_result.text && chunk_result.text.trim().length > 0;
    const isSkipped = chunk_result && chunk_result.skipped === true;
    
    if (hasValidText || isSkipped) {
      parentJob.completed_chunks++;
      parentJob.completed_chunk_flags[chunk_index] = true;
      
      // Log different messages for regular vs skipped chunks
      if (isSkipped) {
        apiLogger.info('chunk', `Chunk ${chunk_index + 1}/${parentJob.total_chunks} skipped (${chunk_result.skip_reason || 'Unknown reason'})`, {
          parent_job_id,
          chunk_index,
          progress: parentJob.progress,
          transcript_length: 0,
          has_valid_text: false,
          is_skipped: true,
          skip_reason: chunk_result.skip_reason
        });
      }
    } else {
      // Chunk processed but produced no text and wasn't intentionally skipped - count as failed
      parentJob.failed_chunks++;
      parentJob.completed_chunk_flags[chunk_index] = true; // Mark as counted to prevent retry double-counting
    }
    
    // Calculate success rate after updating counters
    const totalProcessed = parentJob.completed_chunks + parentJob.failed_chunks;
    if (totalProcessed > 0) {
      parentJob.success_rate = Math.round((parentJob.completed_chunks / totalProcessed) * 100);
    }
    
    parentJob.processing_progress = Math.round((parentJob.completed_chunks / parentJob.total_chunks) * 100);
    parentJob.progress = Math.round((parentJob.processing_progress + parentJob.upload_progress) / 2);
    
    // Track first completion
    if (!parentJob.first_chunk_completed_at) {
      parentJob.first_chunk_completed_at = new Date().toISOString();
    }
    
    // Store chunk result in ordered array
    while (parentJob.transcripts.length <= chunk_index) {
      parentJob.transcripts.push(null);
    }
    
    // Store the chunk result appropriately
    if (hasValidText || isSkipped) {
      parentJob.transcripts[chunk_index] = chunk_result;
    } else {
      // Mark as failed for assembly
      parentJob.transcripts[chunk_index] = {
        ...chunk_result,
        failed: true,
        error: 'No transcribed text produced',
        chunk_index
      };
    }
    
    // Update totals
    if (chunk_result.segments) {
      parentJob.total_segments += chunk_result.segments.length;
    }
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    // Log with accurate status (only for non-skipped chunks since skipped are logged above)
    if (!isSkipped) {
      apiLogger.info('chunk', `Chunk ${chunk_index + 1}/${parentJob.total_chunks} ${hasValidText ? 'completed' : 'processed (no text)'}`, {
        parent_job_id,
        chunk_index,
        progress: parentJob.progress,
        transcript_length: chunk_result?.text?.length || 0,
        has_valid_text: hasValidText,
        total_completed: parentJob.completed_chunks,
        total_failed: parentJob.failed_chunks
      });
    }
    
    return parentJob;
  }

  /**
   * Mark a chunk as failed
   */
  async updateChunkFailed(parent_job_id, chunk_index, error) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    parentJob.failed_chunks++;
    parentJob.success_rate = Math.round(((parentJob.completed_chunks) / (parentJob.completed_chunks + parentJob.failed_chunks)) * 100);
    
    // Store failure in transcripts array
    while (parentJob.transcripts.length <= chunk_index) {
      parentJob.transcripts.push(null);
    }
    parentJob.transcripts[chunk_index] = {
      error: error.message,
      failed: true,
      chunk_index
    };
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    apiLogger.error(`Chunk ${chunk_index + 1} failed`, error, {
      parent_job_id,
      chunk_index,
      failed_chunks: parentJob.failed_chunks
    });
    
    return parentJob;
  }

  /**
   * Check if job is ready for final assembly
   */
  async checkAndStartAssembly(parent_job_id) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    const totalProcessed = parentJob.completed_chunks + parentJob.failed_chunks;
    const isComplete = totalProcessed >= parentJob.total_chunks;
    
    if (isComplete && parentJob.status !== 'assembling' && parentJob.status !== 'done') {
      parentJob.status = 'assembling';
      parentJob.assembly_started_at = new Date().toISOString();
      
      await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
      
      apiLogger.info('assembly', 'Starting final assembly of chunked upload', {
        parent_job_id,
        completed_chunks: parentJob.completed_chunks,
        failed_chunks: parentJob.failed_chunks,
        success_rate: parentJob.success_rate
      });
      
      return true; // Ready for assembly
    }
    
    return false; // Not ready yet
  }

  /**
   * Complete the parent job with final assembled results
   */
  async completeParentJob(parent_job_id, assembledResults) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    parentJob.status = 'done';
    parentJob.completed_at = new Date().toISOString();
    parentJob.progress = 100;
    
    // Store assembled results
    parentJob.final_transcript = assembledResults.final_transcript;
    parentJob.raw_transcript = assembledResults.raw_transcript;
    parentJob.corrected_transcript = assembledResults.corrected_transcript;
    
    // Calculate final success rate (successful chunks with actual text)
    const totalProcessed = parentJob.completed_chunks + parentJob.failed_chunks;
    if (totalProcessed > 0) {
      parentJob.success_rate = Math.round((parentJob.completed_chunks / totalProcessed) * 100);
    } else {
      parentJob.success_rate = 0;
    }
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    apiLogger.complete('Chunked upload streaming job completed', {
      parent_job_id,
      filename: parentJob.filename,
      total_chunks: parentJob.total_chunks,
      completed_chunks: parentJob.completed_chunks,
      failed_chunks: parentJob.failed_chunks,
      success_rate: parentJob.success_rate,
      transcript_length: assembledResults.final_transcript?.length || 0,
      assembly_successful_chunks: assembledResults.successful_chunks,
      assembly_failed_chunks: assembledResults.failed_chunks
    });
    
    return parentJob;
  }

  /**
   * Process a completed chunk result and update parent job
   */
  async processCompletedChunk(parent_job_id, chunk_result, streamController = null) {
    const parentJob = await this.getParentJob(parent_job_id);
    if (!parentJob) {
      throw new Error(`Parent job ${parent_job_id} not found`);
    }

    const chunk_index = chunk_result.chunk_index;
    
    // Prevent double-counting using flags
    if (parentJob.completed_chunk_flags[chunk_index]) {
      processingLogger.warn('Attempted to process already completed chunk', {
        parent_job_id,
        chunk_index,
        current_completed_chunks: parentJob.completed_chunks
      });
      return parentJob;
    }

    // Mark this chunk as completed
    parentJob.completed_chunk_flags[chunk_index] = true;
    parentJob.completed_chunks++;

    // Store the chunk result with all trace information
    const enrichedChunkResult = {
      ...chunk_result,
      completed_at: new Date().toISOString(),
      model: chunk_result.model || parentJob.model || 'whisper-large-v3'
    };
    
    parentJob.transcripts[chunk_index] = enrichedChunkResult;
    
    // Store Groq API trace if available
    if (chunk_result.groq_response) {
      parentJob.groq_traces.push({
        chunk_index,
        timestamp: new Date().toISOString(),
        response: chunk_result.groq_response
      });
    }

    // Update progress
    parentJob.processing_progress = Math.round((parentJob.completed_chunks / parentJob.total_chunks) * 100);
    parentJob.progress = Math.round((parentJob.upload_progress + parentJob.processing_progress) / 2);

    // Log processing details
    processingLogger.info('process', `Chunk ${chunk_index} completed`, {
      parent_job_id,
      chunk_index,
      completed_chunks: parentJob.completed_chunks,
      total_chunks: parentJob.total_chunks,
      processing_progress: parentJob.processing_progress,
      model: enrichedChunkResult.model,
      transcript_length: chunk_result.text?.length || 0
    });

    // Send streaming update
    if (streamController) {
      this.sendStreamEvent(streamController, 'chunk_completed', {
        parent_job_id,
        chunk_index,
        chunk_result: enrichedChunkResult,
        progress: {
          completed_chunks: parentJob.completed_chunks,
          total_chunks: parentJob.total_chunks,
          processing_progress: parentJob.processing_progress,
          overall_progress: parentJob.progress
        }
      });
    }

    // Check if all chunks are complete
    if (parentJob.completed_chunks === parentJob.total_chunks) {
      processingLogger.info('complete', 'All chunks completed, assembling final transcript', {
        parent_job_id,
        total_chunks: parentJob.total_chunks,
        model: parentJob.model
      });

      // Import and use the ChunkAssembler
      const { ChunkAssembler } = await import('./chunk-assembly.js');
      const assembler = new ChunkAssembler(this.env);
      await assembler.assembleChunks(parentJob, streamController);

      // Mark as complete
      parentJob.status = 'done';
      parentJob.completed_at = new Date().toISOString();
      parentJob.success_rate = Math.round((parentJob.completed_chunks / parentJob.total_chunks) * 100);

      processingLogger.complete('Chunked upload streaming job completed', {
        parent_job_id,
        filename: parentJob.filename,
        total_chunks: parentJob.total_chunks,
        success_rate: parentJob.success_rate,
        model: parentJob.model,
        final_transcript_length: parentJob.final_transcript?.length || 0
      });

      // Send final completion event
      if (streamController) {
        this.sendStreamEvent(streamController, 'job_complete', {
          parent_job_id,
          final_transcript: parentJob.final_transcript,
          processing_completed: true,
          success_rate: parentJob.success_rate,
          model: parentJob.model
        });
      }

      // Send webhook if configured
      if (parentJob.webhook_url) {
        await this.sendWebhook(parentJob.webhook_url, parentJob);
      }
    }

    // Save updated parent job
    await this.updateParentJob(parent_job_id, parentJob);
    return parentJob;
  }

  /**
   * Get job summary for listings (without large transcript data)
   */
  getJobSummary(parentJob) {
    return {
      job_id: parentJob.job_id,
      type: parentJob.type,
      status: parentJob.status,
      filename: parentJob.filename,
      total_size: parentJob.total_size,
      total_chunks: parentJob.total_chunks,
      completed_chunks: parentJob.completed_chunks,
      failed_chunks: parentJob.failed_chunks,
      progress: parentJob.progress,
      upload_progress: parentJob.upload_progress,
      processing_progress: parentJob.processing_progress,
      success_rate: parentJob.success_rate,
      use_llm: parentJob.use_llm,
      llm_mode: parentJob.llm_mode,
      model: parentJob.model,
      processing_method: parentJob.processing_method,
      created_at: parentJob.created_at,
      upload_started_at: parentJob.upload_started_at,
      first_chunk_completed_at: parentJob.first_chunk_completed_at,
      processing_started_at: parentJob.processing_started_at,
      completed_at: parentJob.completed_at,
      total_segments: parentJob.total_segments
    };
  }

  /**
   * Cleanup orphaned chunks and sub-jobs
   */
  async cleanupParentJob(parent_job_id) {
    try {
      const parentJob = await this.getParentJob(parent_job_id);
      
      // Delete sub-jobs from KV
      for (const sub_job_id of parentJob.sub_jobs) {
        try {
          await this.kv.delete(sub_job_id);
        } catch (error) {
          apiLogger.warn('Failed to cleanup sub-job', { sub_job_id, error: error.message });
        }
      }
      
      // Delete parent job
      await this.kv.delete(parent_job_id);
      
      apiLogger.info('cleanup', 'Cleaned up parent job and sub-jobs', {
        parent_job_id,
        sub_jobs_deleted: parentJob.sub_jobs.length
      });
      
    } catch (error) {
      apiLogger.error('Failed to cleanup parent job', error, { parent_job_id });
      throw error;
    }
  }

  /**
   * Cleanup only sub-jobs while keeping parent job with results
   */
  async cleanupSubJobs(parent_job_id) {
    try {
      const parentJob = await this.getParentJob(parent_job_id);
      
      let cleanedCount = 0;
      
      // Delete sub-jobs from KV but keep parent job
      for (const sub_job_id of parentJob.sub_jobs || []) {
        if (sub_job_id) {
          try {
            await this.kv.delete(sub_job_id);
            cleanedCount++;
          } catch (error) {
            apiLogger.warn('Failed to cleanup sub-job', { sub_job_id, error: error.message });
          }
        }
      }
      
      // Clear sub_jobs array in parent job since they're no longer needed
      parentJob.sub_jobs = [];
      await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
      
      apiLogger.info('cleanup', 'Cleaned up sub-jobs only, kept parent job', {
        parent_job_id,
        sub_jobs_deleted: cleanedCount
      });
      
      return cleanedCount;
      
    } catch (error) {
      apiLogger.error('Failed to cleanup sub-jobs', error, { parent_job_id });
      throw error;
    }
  }
} 